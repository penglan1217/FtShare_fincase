import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { chinaDate, dateInt, dateISO, mapLimit } from '../src/server/model.js';
import { collectorClient } from './lib/client.mjs';
import { dateWindows, dateToMillis, extractRows, mergeByDate, normalizeCandles, completedEndDate } from './lib/free-market.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) &&
  new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;

if (process.argv.includes('--help')) {
  console.log([
    'Collect daily history for the 15 configured sector ETFs.',
    'Usage: npm run collect:sector-etfs -- [--end YYYY-MM-DD]',
    'Requires FTSHARE_API_KEY (or FTSHARE_API_KEY_FILE) in .env.',
    'Writes data/private/sector-etf-backtest.json.gz and its manifest.',
    'The configured period begins 2020-01-01; each ETF begins no earlier than its verified listing date.'
  ].join('\n'));
} else {
  const config = await readJson('config/sector-backtest-etfs.json');
  if (config.schema !== 1 || config.funds.length !== 15) throw new Error('Sector ETF configuration must contain exactly 15 funds');
  const symbols = config.funds.map(fund => fund.symbol);
  if (new Set(symbols).size !== symbols.length) throw new Error('Duplicate ETF symbols in sector backtest configuration');
  if (!validDate(config.range.start)) throw new Error('Invalid sector ETF start date');

  const endIndex = process.argv.indexOf('--end');
  const explicitEnd = endIndex >= 0 ? process.argv[endIndex + 1] : (process.env.SECTOR_ETF_END_DATE || null);
  if (explicitEnd && !validDate(explicitEnd)) throw new Error('Invalid --end / SECTOR_ETF_END_DATE');
  const requestedEnd = explicitEnd || chinaDate();

  const outputRelative = process.env.SECTOR_ETF_OUTPUT_FILE || 'data/private/sector-etf-backtest.json.gz';
  const previousRelative = process.env.SECTOR_ETF_PREVIOUS_FILE || outputRelative;
  const outputPath = resolve(root, outputRelative);
  let previous = null;
  try {
    const bytes = await readFile(resolve(root, previousRelative));
    previous = JSON.parse(gunzipSync(bytes));
    if (previous.mode !== 'sector_etf_backtest_history' || previous.schema !== 1) {
      throw new Error('Existing sector ETF archive has an unsupported schema');
    }
    if (previous.collection?.adjust_kind !== config.collection.adjust_kind) {
      throw new Error('Existing archive uses a different adjustment basis; use a separate output file to avoid mixing prices');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const client = await collectorClient();
  const calendarResult = await client.call('ft_v1_time_trading_calendar', {
    market: 'cn',
    start_date: dateInt(config.range.start),
    end_date: dateInt(requestedEnd)
  });
  const calendarData = Array.isArray(calendarResult.data) ? calendarResult.data[0] : calendarResult.data;
  const fetchedCalendar = (calendarData?.trade_dates || []).map(dateISO).filter(validDate).sort();
  if (fetchedCalendar.length < 2) throw new Error('FtShare returned fewer than two completed China trading dates');

  const beijingTime = new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 16);
  const end = completedEndDate(fetchedCalendar, chinaDate(), beijingTime, explicitEnd);
  if (explicitEnd && !fetchedCalendar.includes(end)) throw new Error('--end must be an actual China trading date returned by FtShare');
  if (end < config.range.start) throw new Error('End date is earlier than the configured start date');

  const calendar = [...new Set([...(previous?.calendar || []), ...fetchedCalendar.filter(date => date <= end)])].sort();
  const toolsUsed = new Set();

  async function fetchCandles(tool, symbol, window) {
    const result = await client.call(tool, {
      symbol,
      interval_unit: config.collection.interval_unit,
      adjust_kind: config.collection.adjust_kind,
      since_ts_millis: dateToMillis(window.start),
      until_ts_millis: dateToMillis(window.end, true),
      limit: 400
    });
    return normalizeCandles(extractRows(result), symbol);
  }

  async function collectFund(fund, index) {
    const eligibleStart = [config.range.start, fund.inception_date, fund.listed_date].sort().at(-1);
    if (!validDate(eligibleStart) || eligibleStart > end) {
      throw new Error(fund.symbol + ' has no eligible collection window before ' + end);
    }
    const windows = dateWindows(eligibleStart, end, config.collection.window_months);
    let fresh = [];
    const usedTools = new Set();

    for (const window of windows) {
      let rows = [];
      let firstError = null;
      try {
        rows = await fetchCandles('ft_v1_stock_candlesticks', fund.symbol, window);
        if (rows.length) usedTools.add('ft_v1_stock_candlesticks');
      } catch (error) {
        firstError = error;
      }
      if (!rows.length) {
        try {
          rows = await fetchCandles('ft_v1_etf_candlesticks', fund.symbol, window);
          if (rows.length) usedTools.add('ft_v1_etf_candlesticks');
        } catch (error) {
          error.message = fund.symbol + ' ' + window.start + ' to ' + window.end +
            ': ' + (firstError?.message || error.message);
          throw error;
        }
      }
      if (!rows.length) {
        throw new Error(fund.symbol + ' returned no daily candles for ' + window.start + ' to ' + window.end);
      }
      fresh = mergeByDate(fresh, rows);
    }

    const priorHistory = previous?.funds?.[fund.symbol]?.history || [];
    const history = mergeByDate(priorHistory, fresh).filter(row =>
      row.date >= eligibleStart && row.date <= end
    );
    if (!history.length) throw new Error(fund.symbol + ' has no usable history after normalization');

    const historyDates = new Set(history.map(row => row.date));
    const expectedDates = calendar.filter(date => date >= eligibleStart && date <= end);
    const missingDates = expectedDates.filter(date => !historyDates.has(date));
    for (const tool of usedTools) toolsUsed.add(tool);

    console.log(
      'ETF ' + (index + 1) + '/15 ' + fund.symbol + ' ' + fund.display_name +
      ' ' + history.length + ' bars; missing trading dates: ' + missingDates.length
    );

    return {
      ...fund,
      history,
      coverage: {
        start: history[0].date,
        end: history[history.length - 1].date,
        records: history.length,
        expected_trading_days: expectedDates.length,
        missing_trading_days: missingDates.length,
        missing_dates: missingDates,
        status: missingDates.length ? 'incomplete' : 'complete'
      },
      endpoints_used: [...usedTools]
    };
  }

  console.log('Collecting 15 sector ETFs from ' + config.range.start + ' through ' + end);
  const collected = await mapLimit(config.funds, config.collection.concurrency, collectFund);
  const funds = Object.fromEntries(collected.map(fund => [fund.symbol, fund]));
  const incomplete = collected.filter(fund => fund.coverage.status !== 'complete').length;

  const data = {
    schema: 1,
    mode: 'sector_etf_backtest_history',
    provider: 'FtShare',
    generated_at: new Date().toISOString(),
    range: {
      start: config.range.start,
      end,
      collection_start: config.range.start,
      trading_days: calendar.filter(date => date >= config.range.start && date <= end).length
    },
    collection: config.collection,
    strategy: config.strategy,
    calendar,
    funds,
    source_audit: {
      endpoints_used: [...toolsUsed],
      premium_endpoints_used: [],
      requests: client.stats(),
      incomplete_funds: incomplete,
      coverage: Object.fromEntries(collected.map(fund => [fund.symbol, fund.coverage]))
    }
  };

  const json = JSON.stringify(data);
  const compressed = gzipSync(Buffer.from(json));
  const manifest = {
    schema: 1,
    mode: data.mode,
    provider: data.provider,
    generated_at: data.generated_at,
    range: data.range,
    fund_count: collected.length,
    complete_funds: collected.length - incomplete,
    incomplete_funds: incomplete,
    funds: collected.map(fund => ({
      symbol: fund.symbol,
      display_name: fund.display_name,
      industry: fund.industry,
      records: fund.coverage.records,
      first_date: fund.coverage.start,
      last_date: fund.coverage.end,
      missing_trading_days: fund.coverage.missing_trading_days
    })),
    json_bytes: Buffer.byteLength(json),
    gzip_bytes: compressed.length,
    json_sha256: createHash('sha256').update(json).digest('hex'),
    gzip_sha256: createHash('sha256').update(compressed).digest('hex')
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath + '.tmp', compressed, { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(outputPath + '.tmp', outputPath);
  await writeFile(outputPath.replace(/\.json\.gz$/, '.manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

  console.log(JSON.stringify({
    status: incomplete ? 'collected_with_gaps' : 'collected_complete',
    output: outputRelative,
    range: data.range,
    funds: collected.length,
    complete_funds: collected.length - incomplete,
    incomplete_funds: incomplete,
    requests: client.stats()
  }, null, 2));
}
