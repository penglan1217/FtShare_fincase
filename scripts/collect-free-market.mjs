import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { chinaDate, dateInt, dateISO, mapLimit } from '../src/server/model.js';
import { collectorClient } from './lib/client.mjs';
import { FREE_INDEX_UNIVERSE, dateWindows, dateToMillis, extractRows, mergeByDate, normalizeCandles, normalizeTradeDate, completedEndDate } from './lib/free-market.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const config = await read('config/collection.json');
const universe = await read('config/universe.json');
const previousFile = process.env.FREE_MARKET_PREVIOUS_FILE || null;
let previous = null;
if (previousFile) {
  const previousBytes = await readFile(resolve(root, previousFile));
  previous = JSON.parse(gunzipSync(previousBytes));
  if (previous.mode !== 'free_tier_market_data' || !previous.range?.end) throw new Error('Previous free-market archive is invalid');
}
const shiftDate = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0,10);
const fullStart = previous?.range?.start || config.market_start;
const start = process.env.FREE_MARKET_START_DATE || (previous?.range?.end ? shiftDate(previous.range.end, -14) : fullStart);
const requestedEnd = process.env.FREE_MARKET_END_DATE || chinaDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(requestedEnd) || start > requestedEnd) throw new Error('Invalid FREE_MARKET_START_DATE / FREE_MARKET_END_DATE');

const client = await collectorClient();
const errors = [];
const calendarResult = await client.call('ft_v1_time_trading_calendar', { market: 'cn', start_date: dateInt(start), end_date: dateInt(requestedEnd) });
const calendarData = Array.isArray(calendarResult.data) ? calendarResult.data[0] : calendarResult.data;
const allCalendarDates = (calendarData?.trade_dates || []).map(dateISO).sort();
const beijingTime = new Date(Date.now() + 8 * 3600000).toISOString().slice(11,16);
const end = completedEndDate(allCalendarDates, chinaDate(), beijingTime, process.env.FREE_MARKET_END_DATE || null);
const currentCalendar = allCalendarDates.filter(d => d >= start && d <= end);
if (currentCalendar.length < 2) throw new Error('Trading calendar returned fewer than two completed dates');
const calendar = [...new Set([...(previous?.calendar || []), ...currentCalendar])].sort();

async function candles(tool, symbol, window) {
  const args = {
    symbol, interval_unit: 'Day', adjust_kind: 'none',
    since_ts_millis: dateToMillis(window.start),
    until_ts_millis: dateToMillis(window.end, true),
    limit: 400
  };
  const result = await client.call(tool, args);
  return normalizeCandles(extractRows(result), symbol);
}
async function collectSeries(instrument, kind) {
  const eligibleStart = [start, instrument.listed_date, instrument.inception_date].filter(Boolean).sort().at(-1);
  const windows = dateWindows(eligibleStart, end, 12);
  let all = [];
  for (const window of windows) {
    let rows;
    if (kind === 'index') {
      let firstError;
      try { rows = await candles('ft_v1_index_candlesticks', instrument.symbol, window); } catch (error) { firstError = error; }
      if (!rows?.length) {
        try { rows = await candles('ft_v1_stock_candlesticks', instrument.symbol, window); }
        catch (second) { second.message = '指数 ' + instrument.symbol + '：' + (firstError?.message || second.message); throw second; }
      }
    } else {
      let firstError;
      try { rows = await candles('ft_v1_stock_candlesticks', instrument.symbol, window); } catch (error) { firstError = error; }
      if (!rows?.length) {
        try { rows = await candles('ft_v1_etf_candlesticks', instrument.symbol, window); }
        catch (second) { second.message = 'ETF ' + instrument.symbol + '：' + (firstError?.message || second.message); throw second; }
      }
    }
    if (!rows?.length) throw new Error(kind + ' ' + instrument.symbol + ' has no daily candles for ' + window.start + ' to ' + window.end);
    all = mergeByDate(all, rows);
  }
  if (!all.length) throw new Error(kind + ' ' + instrument.symbol + ' returned no daily candles');
  return { ...instrument, history: all };
}

const etfUniverse = universe.funds.filter(f => f.is_core_basket).map(f => ({
  symbol: f.symbol, name: f.name, bucket: f.bucket,
  inception_date: f.inception_date, listed_date: f.listed_date
}));
if (etfUniverse.length !== 20) throw new Error('Expected 20 core ETFs, got ' + etfUniverse.length);

console.log('Collecting free-tier daily ETF candles: ' + etfUniverse.length + ' symbols');
const etfs = await mapLimit(etfUniverse, 2, async (fund, i) => {
  const result = await collectSeries(fund, 'etf');
  console.log('ETF ' + (i + 1) + '/' + etfUniverse.length + ' ' + fund.symbol + ' ' + result.history.length + ' days');
  return result;
});
console.log('Collecting free-tier daily index candles: ' + FREE_INDEX_UNIVERSE.length + ' indices');
const indices = await mapLimit(FREE_INDEX_UNIVERSE, 2, async (index, i) => {
  try {
    const result = await collectSeries({ ...index, listed_date: start }, 'index');
    console.log('Index ' + (i + 1) + '/' + FREE_INDEX_UNIVERSE.length + ' ' + index.symbol + ' ' + result.history.length + ' days');
    return result;
  } catch (error) {
    if (index.required) throw error;
    errors.push({ source: 'index', symbol: index.symbol, message: String(error.message).slice(0, 240) });
    console.log('Optional index unavailable: ' + index.symbol);
    return { ...index, history: [] };
  }
});

const mergedIndices = Object.fromEntries(indices.map(item => [item.symbol, {
  name: item.name, required: Boolean(item.required),
  history: mergeByDate(previous?.indices?.[item.symbol]?.history || [], item.history)
}]));
const mergedEtfs = Object.fromEntries(etfs.map(item => [item.symbol, {
  name: item.name, bucket: item.bucket, inception_date: item.inception_date,
  listed_date: item.listed_date,
  history: mergeByDate(previous?.etfs?.[item.symbol]?.history || [], item.history)
}]));

// Eastmoney ETF order-flow is a separate free-tier series. It is NOT ETF creation/redemption.
async function optionalPaged(tool, args, label, pageSize = 1000) {
  const records = [];
  try {
    for (let page = 1; page <= 20; page++) {
      const result = await client.call(tool, { ...args, page, page_size: pageSize });
      const rows = extractRows(result);
      records.push(...rows);
      const pageInfo = result.data && !Array.isArray(result.data) ? result.data : {};
      const pages = Number(pageInfo.pages ?? pageInfo.total_pages ?? result.metadata?.pagination?.total_pages);
      if (!rows.length || Number.isFinite(pages) && pages > 0 && page >= pages || rows.length < pageSize) break;
    }
    return { status: 'available', records };
  } catch (error) {
    errors.push({ source: label, code: error.upstreamCode || error.code || 'upstream_error', message: String(error.message).slice(0, 240) });
    console.log('Optional source unavailable: ' + label);
    return { status: 'unavailable', records: [] };
  }
}
function normalizeEtfFlow(rows, symbol) {
  return rows.map(row => ({
    symbol, date: normalizeTradeDate(row.trade_date),
    close: row.close == null ? null : Number(row.close),
    change_pct: row.change_pct == null ? null : Number(row.change_pct),
    main_net: row.main_net == null ? null : Number(row.main_net),
    main_pct: row.main_pct == null ? null : Number(row.main_pct),
    xl_net: row.xl_net == null ? null : Number(row.xl_net),
    xl_pct: row.xl_pct == null ? null : Number(row.xl_pct),
    l_net: row.l_net == null ? null : Number(row.l_net),
    l_pct: row.l_pct == null ? null : Number(row.l_pct),
    m_net: row.m_net == null ? null : Number(row.m_net),
    m_pct: row.m_pct == null ? null : Number(row.m_pct),
    s_net: row.s_net == null ? null : Number(row.s_net),
    s_pct: row.s_pct == null ? null : Number(row.s_pct)
  })).filter(row => row.date);
}
const flowStart = start < '2026-03-16' ? '20260316' : start.replaceAll('-', '');
const flowEnd = end.replaceAll('-', '');
let etfOrderFlow = { status: 'not_configured', records: [] };
if (flowStart <= flowEnd) {
  const first = etfUniverse[0];
  const firstResult = await optionalPaged('ft_v1_eastmoney_etf_flow', {
    symbol: first.symbol.slice(0, 6), start_date: flowStart, end_date: flowEnd
  }, 'eastmoney-etf-flow');
  if (firstResult.status === 'available') {
    etfOrderFlow = { status: 'available', records: normalizeEtfFlow(firstResult.records, first.symbol) };
    const remaining = await mapLimit(etfUniverse.slice(1), 2, async fund => {
      const result = await optionalPaged('ft_v1_eastmoney_etf_flow', {
        symbol: fund.symbol.slice(0, 6), start_date: flowStart, end_date: flowEnd
      }, 'eastmoney-etf-flow:' + fund.symbol);
      return normalizeEtfFlow(result.records, fund.symbol);
    });
    etfOrderFlow.records.push(...remaining.flat());
  } else etfOrderFlow = firstResult;
}

const dapanFlow = await optionalPaged('ft_v1_eastmoney_dapan_flow', {
  start_date: flowStart, end_date: flowEnd
}, 'eastmoney-dapan-flow', 500);
const mergeRecords = (oldRows = [], newRows = [], key = row => row.date) => {
  const map = new Map();
  for (const row of oldRows || []) map.set(key(row), row);
  for (const row of newRows || []) map.set(key(row), row);
  return [...map.values()].sort((a,b) => String(a.date).localeCompare(String(b.date)));
};
const mergedEtfFlow = {
  meaning: '东方财富ETF交易资金流（主力/超大单/大单等）；不是ETF份额净申购/赎回',
  available_from: '2026-03-16',
  status: etfOrderFlow.status === 'available' ? 'available' : (previous?.eastmoney_etf_order_flow?.records?.length ? 'stale_preserved' : etfOrderFlow.status),
  records: mergeRecords(previous?.eastmoney_etf_order_flow?.records || [], etfOrderFlow.records || [], row => row.symbol + '|' + row.date)
};
const mergedDapanFlow = {
  meaning: '东方财富大盘资金流；独立于ETF份额净申购/赎回',
  status: dapanFlow.status === 'available' ? 'available' : (previous?.eastmoney_market_flow?.records?.length ? 'stale_preserved' : dapanFlow.status),
  records: mergeRecords(previous?.eastmoney_market_flow?.records || [], dapanFlow.records || [], row => normalizeTradeDate(row.trade_date) || row.date)
};

const data = {
  schema: 1,
  mode: 'free_tier_market_data',
  provider: 'FtShare',
  plan: 'free',
  generated_at: new Date().toISOString(),
  range: { start: fullStart, end, trading_days: calendar.length, collection_start: start },
  calendar,
  indices: mergedIndices,
  etfs: mergedEtfs,
  eastmoney_etf_order_flow: mergedEtfFlow,
  eastmoney_market_flow: mergedDapanFlow,
  source_audit: {
    endpoints: ['ft_v1_time_trading_calendar', 'ft_v1_stock_candlesticks', 'ft_v1_index_candlesticks', 'ft_v1_eastmoney_etf_flow', 'ft_v1_eastmoney_dapan_flow'],
    premium_endpoints_used: [],
    requests: client.stats(),
    optional_errors: errors,
    collection_window: { start, end }, previous_snapshot_at: previous?.generated_at || null,
    index_coverage: Object.fromEntries(Object.entries(mergedIndices).map(([s,x]) => [s, x.history.length])),
    etf_coverage: Object.fromEntries(Object.entries(mergedEtfs).map(([s,x]) => [s, x.history.length]))
  }
};

const json = JSON.stringify(data);
const compressed = gzipSync(Buffer.from(json));
const manifest = {
  schema: 1,
  generated_at: data.generated_at,
  provider: data.provider,
  plan: data.plan,
  range: data.range,
  indices: Object.keys(data.indices).length,
  etfs: Object.keys(data.etfs).length,
  etf_order_flow_records: data.eastmoney_etf_order_flow.records.length,
  market_flow_records: data.eastmoney_market_flow.records.length,
  json_bytes: Buffer.byteLength(json),
  gzip_bytes: compressed.length,
  json_sha256: createHash('sha256').update(json).digest('hex'),
  gzip_sha256: createHash('sha256').update(compressed).digest('hex')
};
const out = resolve(root, 'data/private');
await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'free-market.json.gz'), compressed, { mode: 0o600 });
await writeFile(resolve(out, 'free-market.manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({
  status: 'collected',
  range: data.range,
  indices: manifest.indices,
  etfs: manifest.etfs,
  etf_order_flow_records: manifest.etf_order_flow_records,
  market_flow_records: manifest.market_flow_records,
  requests: client.stats(),
  optional_errors: errors.length,
  manifest
}, null, 2));
