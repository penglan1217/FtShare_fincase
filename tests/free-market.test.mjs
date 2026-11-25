import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dateWindows, extractRows, normalizeCandles, normalizeTradeDate, mergeByDate, dateToMillis, completedEndDate } from '../scripts/lib/free-market.mjs';

test('free market date windows stay within the 12-month provider limit and do not overlap', () => {
  const windows = dateWindows('2023-10-09', '2026-11-25');
  assert.deepEqual(windows, [
    { start: '2023-10-09', end: '2024-10-08' },
    { start: '2024-10-09', end: '2025-10-08' },
    { start: '2025-10-09', end: '2026-10-08' },
    { start: '2026-10-09', end: '2026-11-25' }
  ]);
  assert.throws(() => dateWindows('2026-02-01', '2026-01-01'));
  assert.throws(() => dateWindows('2026-01-01', '2026-02-01', 13));
});

test('response rows support direct arrays and paginated records without inventing values', () => {
  assert.deepEqual(extractRows({ data: [{ x: 1 }] }), [{ x: 1 }]);
  assert.deepEqual(extractRows({ data: { records: [{ x: 2 }] } }), [{ x: 2 }]);
  assert.deepEqual(extractRows({ data: { items: [{ x: 3 }] } }), [{ x: 3 }]);
  assert.deepEqual(extractRows({ data: null }), []);
});

test('candles are normalized to Beijing dates, deduplicated and sorted', () => {
  const rows = normalizeCandles([
    { ts_millis: Date.parse('2026-11-24T07:00:00Z'), open: '10', high: '11', low: '9', close: '10.5', turnover: '1000', volume: 100 },
    { ts_millis: Date.parse('2026-11-25T07:00:00Z'), open: '10.5', high: '12', low: '10', close: '11', turnover: '2000', volume: 200 },
    { ts_millis: Date.parse('2026-11-25T07:00:00Z'), open: '10.5', high: '12', low: '10', close: '11.2', turnover: '2100', volume: 210 },
    { ts_millis: Date.parse('2026-11-26T07:00:00Z'), open: '1', close: null }
  ], '510300.SH');
  assert.deepEqual(rows.map(r => r.date), ['2026-11-24', '2026-11-25']);
  assert.equal(rows[1].close, 11.2);
  assert.equal(rows[1].turnover, 2100);
  assert.equal(rows[0].high, 11);
});

test('flow dates normalize only valid calendar date shapes', () => {
  assert.equal(normalizeTradeDate(20261125), '2026-11-25');
  assert.equal(normalizeTradeDate('2026-11-25'), '2026-11-25');
  assert.equal(normalizeTradeDate('bad'), null);
  assert.equal(dateToMillis('2026-11-25'), Date.parse('2026-11-24T16:00:00Z'));
});

test('newer overlapping market candles replace older rows by date', () => {
  const old = [{ date: '2026-11-24', close: 10 }, { date: '2026-11-25', close: 11 }];
  const fresh = [{ date: '2026-11-25', close: 12 }, { date: '2026-11-26', close: 13 }];
  assert.deepEqual(mergeByDate(old, fresh), [
    { date: '2026-11-24', close: 10 },
    { date: '2026-11-25', close: 12 },
    { date: '2026-11-26', close: 13 }
  ]);
});

test('free-tier daily archive excludes the unfinished current session before the close', () => {
  const calendar = ['2026-11-23', '2026-11-24', '2026-11-25'];
  assert.equal(completedEndDate(calendar, '2026-11-25', '13:00', null), '2026-11-24');
  assert.equal(completedEndDate(calendar, '2026-11-25', '15:15', null), '2026-11-25');
  assert.equal(completedEndDate(calendar, '2026-11-25', '13:00', '2026-11-24'), '2026-11-24');
});

test('free-tier collector script parses without executing network calls', () => {
  const script = fileURLToPath(new URL('../scripts/collect-free-market.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
