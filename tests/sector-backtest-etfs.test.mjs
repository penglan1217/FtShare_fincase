import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const configPath = fileURLToPath(new URL('../config/sector-backtest-etfs.json', import.meta.url));
const scriptPath = fileURLToPath(new URL('../scripts/collect-sector-backtest-etfs.mjs', import.meta.url));
const config = JSON.parse(await readFile(configPath, 'utf8'));

test('sector backtest universe contains 15 uniquely identified Chinese ETFs', () => {
  assert.equal(config.funds.length, 15);
  assert.equal(new Set(config.funds.map(fund => fund.symbol)).size, 15);
  for (const fund of config.funds) {
    assert.match(fund.symbol, /^\d{6}\.(SH|SZ)$/);
    assert.match(fund.code, /^\d{6}$/);
    assert.equal(fund.symbol.slice(0, 6), fund.code);
    assert.match(fund.full_name, /[\u4e00-\u9fff]/);
    assert.match(fund.display_name, /[\u4e00-\u9fff]/);
    assert.match(fund.industry, /[\u4e00-\u9fff]/);
    assert.match(fund.source_url, /^https:\/\//);
    assert.ok(fund.inception_date <= fund.listed_date);
    assert.ok(fund.listed_date >= '2013-01-01');
  }
});

test('sector ETF history starts in 2020 and uses forward-adjusted daily candles', () => {
  assert.equal(config.range.start, '2020-01-01');
  assert.equal(config.collection.interval_unit, 'Day');
  assert.equal(config.collection.adjust_kind, 'Forward');
  assert.deepEqual(config.strategy.ma_periods, [5, 10, 20, 60]);
  assert.equal(config.strategy.initial_capital_per_fund_cny, 20000);
  assert.equal(config.strategy.execution, 'next_trading_day_open');
});

test('sector ETF collector parses without making network requests', () => {
  const result = spawnSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
