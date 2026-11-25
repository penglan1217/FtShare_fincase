const DAY = 86400000;
const iso = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && new Date(String(value) + 'T00:00:00Z').toISOString().slice(0,10) === value;
const n = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

export const FREE_INDEX_UNIVERSE = [
  { symbol: '000001.SH', name: '上证综指', required: true },
  { symbol: '399001.SZ', name: '深证成指', required: true },
  { symbol: '000300.SH', name: '沪深300', required: true },
  { symbol: '399006.SZ', name: '创业板指', required: true },
  { symbol: '000688.SH', name: '科创50', required: true },
  { symbol: '000905.SH', name: '中证500', required: false },
  { symbol: '000852.SH', name: '中证1000', required: false },
  { symbol: '000016.SH', name: '上证50', required: false }
];

export function dateWindows(start, end, months = 12) {
  if (!iso(start) || !iso(end) || start > end || !Number.isInteger(months) || months < 1 || months > 12) throw new Error('Invalid date window');
  const addMonths = (date, count) => {
    const [y,m,d] = date.split('-').map(Number);
    const target = new Date(Date.UTC(y, m - 1 + count, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d, last));
    return target.toISOString().slice(0,10);
  };
  const addDays = (date, count) => new Date(Date.parse(date + 'T00:00:00Z') + count * DAY).toISOString().slice(0,10);
  const windows = [];
  let cursor = start;
  while (cursor <= end) {
    const next = addMonths(cursor, months);
    const until = addDays(next, -1) < end ? addDays(next, -1) : end;
    windows.push({ start: cursor, end: until });
    cursor = addDays(until, 1);
  }
  return windows;
}

export function extractRows(result) {
  const data = result?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(result?.records)) return result.records;
  return [];
}

export function normalizeCandles(rows, symbol) {
  const byDate = new Map();
  for (const row of rows || []) {
    const ts = Number(row.ts_millis);
    if (!Number.isFinite(ts)) continue;
    const date = new Date(ts + 8 * 3600000).toISOString().slice(0,10);
    const item = {
      date, open: n(row.open), high: n(row.high), low: n(row.low), close: n(row.close),
      volume: n(row.volume), turnover: n(row.turnover)
    };
    if (item.close === null) continue;
    byDate.set(date, item);
  }
  return [...byDate.values()].sort((a,b) => a.date.localeCompare(b.date));
}

export function normalizeTradeDate(value) {
  const s = String(value ?? '').replaceAll('-', '');
  if (!/^\d{8}$/.test(s)) return null;
  return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
}

export function mergeByDate(...groups) {
  const map = new Map();
  for (const group of groups) for (const row of group || []) map.set(row.date, row);
  return [...map.values()].sort((a,b) => a.date.localeCompare(b.date));
}

export function dateToMillis(date, endOfDay = false) {
  if (!iso(date)) throw new Error('Invalid ISO date: ' + date);
  return Date.parse(date + (endOfDay ? 'T23:59:59+08:00' : 'T00:00:00+08:00'));
}
export function completedEndDate(calendar, today, beijingTime, explicitEnd) {
  if (explicitEnd) {
    if (!iso(explicitEnd) || explicitEnd > today) throw new Error('Invalid explicit end date');
    return explicitEnd;
  }
  if (!iso(today) || !/^\\d{2}:\\d{2}$/.test(beijingTime || '')) throw new Error('Invalid market clock');
  if (beijingTime < '15:10') return calendar.filter(d => d < today).at(-1) || today;
  return calendar.filter(d => d <= today).at(-1) || today;
}
