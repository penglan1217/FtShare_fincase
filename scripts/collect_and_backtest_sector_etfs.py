#!/usr/bin/env python3
"""Collect public Eastmoney QFQ ETF candles and run the 4-MA backtest."""
from __future__ import annotations

import argparse
import csv
import gzip
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config" / "sector-backtest-etfs.json"
OUT = ROOT / "artifacts" / "sector-etf-backtest"
CAPITAL = 20_000.0
MA_WINDOWS = (5, 10, 20, 60)
BASE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
FIELDS1 = "f1,f2,f3,f4,f5,f6"
FIELDS2 = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63"
UT = "fa5fd1943c7b386f172d6893dbbd1d0c"


def number(value: str) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else 0.0
    except (TypeError, ValueError):
        return 0.0


def fetch_etf(fund: dict, start: str, end: str, retries: int = 2) -> list[dict]:
    exchange, code = fund["symbol"].split(".")
    ticker = ("sh" if exchange == "SH" else "sz") + code
    # Tencent's public QFQ endpoint is queried in calendar-year slices to stay below its row cap.
    first_year = max(int(start[:4]), int(fund["listed_date"][:4]), 2019)
    last_year = int(end[:4])
    rows = []
    errors = []
    for year in range(first_year, last_year + 1):
        window_start = max(f"{year}-01-01", fund["listed_date"], start)
        window_end = min(f"{year}-12-31", end)
        if window_start > window_end:
            continue
        param = f"{ticker},day,{window_start},{window_end},500,qfq"
        url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?" + urllib.parse.urlencode({"param": param})
        request = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
            "Referer": "https://gu.qq.com/",
            "Accept": "application/json,text/plain,*/*",
        })
        last_error = None
        for attempt in range(retries):
            try:
                with urllib.request.urlopen(request, timeout=15) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                data = payload.get("data") or {}
                item = data.get(ticker) or {}
                klines = item.get("qfqday") or item.get("day") or []
                if not klines:
                    raise RuntimeError("Tencent returned no qfqday: " + json.dumps(payload, ensure_ascii=False)[:400])
                for bar in klines:
                    p = bar.split(",") if isinstance(bar, str) else bar
                    if len(p) < 6:
                        continue
                    d = str(p[0])
                    if d < fund["listed_date"] or d > end:
                        continue
                    o, c = number(p[1]), number(p[2])
                    if o <= 0 or c <= 0:
                        continue
                    rows.append({
                        "date": d, "open": o, "close": c,
                        "high": number(p[3]), "low": number(p[4]),
                        "volume": number(p[5]),
                        "amount": number(p[6]) if len(p) > 6 else 0.0,
                    })
                last_error = None
                break
            except Exception as exc:
                last_error = exc
                if attempt + 1 < retries:
                    time.sleep(1.0 * (attempt + 1))
        if last_error is not None:
            errors.append(f"{year}: {last_error}")
        time.sleep(0.1)
    if not rows:
        # Eastmoney is a secondary public fallback; no user key is required.
        params = {
            "secid": ("1." if exchange == "SH" else "0.") + code, "klt": "101", "fqt": "1",
            "beg": start.replace("-", ""), "end": end.replace("-", ""),
            "lmt": "10000", "fields1": FIELDS1, "fields2": FIELDS2, "ut": UT,
        }
        url = BASE_URL + "?" + urllib.parse.urlencode(params)
        request = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
            "Referer": "https://quote.eastmoney.com/", "Accept": "application/json,text/plain,*/*",
        })
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
            klines = (payload.get("data") or {}).get("klines") or []
            for item in klines:
                p = item.split(",")
                if len(p) < 6:
                    continue
                d = p[0]
                if d < fund["listed_date"] or d > end:
                    continue
                o, c = number(p[1]), number(p[2])
                if o > 0 and c > 0:
                    rows.append({
                        "date": d, "open": o, "close": c,
                        "high": number(p[3]), "low": number(p[4]),
                        "volume": number(p[5]), "amount": number(p[6]) if len(p) > 6 else 0.0,
                    })
        except Exception as exc:
            errors.append("Eastmoney fallback: " + str(exc))
    dedup = {r["date"]: r for r in rows}
    result = [dedup[k] for k in sorted(dedup)]
    if len(result) < 60:
        raise RuntimeError(f"{fund['symbol']} insufficient history ({len(result)} bars); " + "; ".join(errors))
    return result

def moving_average(values: list[float], end_index: int, period: int) -> float:
    return sum(values[end_index - period + 1:end_index + 1]) / period


def year_end_values(rows: list[dict], daily_pnl: dict[str, float], start_year: int, end_year: int) -> dict[int, float]:
    result = {}
    by_year: dict[int, list[str]] = defaultdict(list)
    for row in rows:
        y = int(row["date"][:4])
        if start_year <= y <= end_year:
            by_year[y].append(row["date"])
    last_value = 0.0
    for y in range(start_year, end_year + 1):
        dates = by_year.get(y)
        if dates:
            last_value = daily_pnl.get(dates[-1], last_value)
        result[y] = last_value
    return result


def max_drawdown(equity_values: list[float]) -> float:
    peak = -float("inf")
    worst = 0.0
    for value in equity_values:
        peak = max(peak, value)
        if peak > 0:
            worst = min(worst, value / peak - 1.0)
    return worst * 100.0


def run_strategy(fund: dict, rows: list[dict], start: str, end: str) -> dict:
    closes = [r["close"] for r in rows]
    start_index = next((i for i, r in enumerate(rows) if r["date"] >= start), None)
    if start_index is None:
        raise RuntimeError(f"{fund['symbol']} has no data from {start}")
    position = None
    pending = None
    realized = 0.0
    trades = []
    daily_pnl = {}
    equity = []
    for i, row in enumerate(rows):
        if row["date"] > end:
            break
        if pending is not None:
            if pending["action"] == "buy":
                position = {
                    "signal_date": pending["signal_date"],
                    "entry_date": row["date"],
                    "entry_price": row["open"],
                    "entry_index": i,
                }
            elif pending["action"] == "sell" and position is not None:
                exit_price = row["open"]
                profit = CAPITAL * (exit_price / position["entry_price"] - 1.0)
                realized += profit
                trades.append({
                    "symbol": fund["symbol"], "name": fund["display_name"], "industry": fund["industry"],
                    "signal_buy_date": position["signal_date"],
                    "buy_date": position["entry_date"], "buy_price": round(position["entry_price"], 6),
                    "signal_sell_date": pending["signal_date"], "sell_date": row["date"],
                    "sell_price": round(exit_price, 6), "profit_cny": round(profit, 2),
                    "return_pct": round((exit_price / position["entry_price"] - 1.0) * 100.0, 3),
                    "holding_trading_days": i - position["entry_index"],
                })
                position = None
            pending = None

        if i >= max(MA_WINDOWS) - 1 and row["date"] >= start and i + 1 < len(rows):
            ma = [moving_average(closes, i, p) for p in MA_WINDOWS]
            above = all(row["close"] > v for v in ma)
            below = all(row["close"] < v for v in ma)
            if position is None and above:
                pending = {"action": "buy", "signal_date": row["date"]}
            elif position is not None and below:
                pending = {"action": "sell", "signal_date": row["date"]}

        unrealized = CAPITAL * (row["close"] / position["entry_price"] - 1.0) if position else 0.0
        daily_pnl[row["date"]] = realized + unrealized
        equity.append(CAPITAL + realized + unrealized)

    effective_rows = [r for r in rows if r["date"] <= end]
    years = range(int(start[:4]), int(end[:4]) + 1)
    cumulative = year_end_values(effective_rows, daily_pnl, years.start, years.stop - 1)
    annual = {}
    previous = 0.0
    for y, value in cumulative.items():
        annual[y] = value - previous
        previous = value

    wins = [t["profit_cny"] for t in trades if t["profit_cny"] > 0]
    losses = [t["profit_cny"] for t in trades if t["profit_cny"] < 0]
    profit_factor = (sum(wins) / abs(sum(losses))) if losses else (None if not wins else "inf")
    final_pnl = list(daily_pnl.values())[-1] if daily_pnl else 0.0
    open_position = None
    if position is not None:
        last = effective_rows[-1]
        open_profit = CAPITAL * (last["close"] / position["entry_price"] - 1.0)
        open_position = {
            "buy_date": position["entry_date"], "buy_price": round(position["entry_price"], 6),
            "last_date": last["date"], "last_close": round(last["close"], 6),
            "unrealized_pnl_cny": round(open_profit, 2),
            "unrealized_return_pct": round(open_profit / CAPITAL * 100.0, 3),
        }

    # Buy-and-hold starts at the first trading day's open on/after the backtest start.
    bh_rows = [r for r in effective_rows if r["date"] >= start]
    if not bh_rows:
        raise RuntimeError(f"{fund['symbol']} has no buy-and-hold data from {start}")
    bh_entry = bh_rows[0]
    bh_daily = {}
    bh_equity = [CAPITAL]
    for row in bh_rows:
        pnl = CAPITAL * (row["close"] / bh_entry["open"] - 1.0)
        bh_daily[row["date"]] = pnl
        bh_equity.append(CAPITAL + pnl)
    bh_cumulative = year_end_values(effective_rows, bh_daily, years.start, years.stop - 1)
    bh_annual = {}
    previous = 0.0
    for y, value in bh_cumulative.items():
        bh_annual[y] = value - previous
        previous = value
    bh_final = list(bh_daily.values())[-1] if bh_daily else 0.0

    return {
        "summary": {
            "symbol": fund["symbol"], "name": fund["display_name"], "industry": fund["industry"],
            "coverage_start": effective_rows[0]["date"], "coverage_end": effective_rows[-1]["date"],
            "bars": len(effective_rows), "closed_trades": len(trades),
            "wins": len(wins), "losses": len(losses),
            "win_rate_pct": round(len(wins) / len(trades) * 100.0, 2) if trades else 0.0,
            "profit_factor": round(profit_factor, 3) if isinstance(profit_factor, (int, float)) else profit_factor,
            "strategy_pnl_cny": round(final_pnl, 2),
            "strategy_return_pct": round(final_pnl / CAPITAL * 100.0, 2),
            "buy_hold_pnl_cny": round(bh_final, 2),
            "buy_hold_return_pct": round(bh_final / CAPITAL * 100.0, 2),
            "excess_vs_buy_hold_cny": round(final_pnl - bh_final, 2),
            "strategy_max_drawdown_pct": round(max_drawdown(equity), 2),
            "buy_hold_max_drawdown_pct": round(max_drawdown(bh_equity), 2),
            "open_position": open_position,
        },
        "annual_strategy_pnl": annual,
        "annual_buy_hold_pnl": bh_annual,
        "daily_strategy_pnl": daily_pnl,
        "daily_buy_hold_pnl": bh_daily,
        "trades": trades,
    }


def portfolio_drawdown(results: list[dict], key: str, capital_per_fund: float, all_dates: list[str]) -> float:
    total_capital = capital_per_fund * len(results)
    latest = [0.0] * len(results)
    maps = [r[key] for r in results]
    equity = []
    for d in all_dates:
        total_pnl = 0.0
        for i, mapping in enumerate(maps):
            if d in mapping:
                latest[i] = mapping[d]
            total_pnl += latest[i]
        equity.append(total_capital + total_pnl)
    return max_drawdown(equity)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2020-01-01")
    parser.add_argument("--end", default=None)
    args = parser.parse_args()
    start = args.start
    end = args.end or datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
    date.fromisoformat(start)
    date.fromisoformat(end)
    if end < start:
        raise ValueError("--end must not be earlier than --start")

    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    funds = config["funds"]
    OUT.mkdir(parents=True, exist_ok=True)
    collected, errors = {}, []
    print(f"Fetching {len(funds)} ETFs concurrently (max 4 connections) ...", flush=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(fetch_etf, fund, fund["listed_date"], end): fund for fund in funds}
        completed = 0
        for future in as_completed(futures):
            fund = futures[future]
            completed += 1
            try:
                rows = future.result()
                collected[fund["symbol"]] = rows
                print(f"[{completed}/15] {fund['symbol']} {len(rows)} bars: {rows[0]['date']} -> {rows[-1]['date']}", flush=True)
            except Exception as exc:
                errors.append({"symbol": fund["symbol"], "error": str(exc)})
                print(f"[{completed}/15] ERROR {fund['symbol']}: {exc}", flush=True)

    results = []
    for fund in funds:
        rows = collected.get(fund["symbol"])
        if rows:
            results.append(run_strategy(fund, rows, start, end))
    if not results:
        raise RuntimeError("No ETF history was collected. See request errors above.")

    years = list(range(int(start[:4]), int(end[:4]) + 1))
    annual_portfolio = []
    for y in years:
        strat = sum(r["annual_strategy_pnl"].get(y, 0.0) for r in results)
        bh = sum(r["annual_buy_hold_pnl"].get(y, 0.0) for r in results)
        annual_portfolio.append({
            "year": y,
            "strategy_pnl_all_funds_cny": round(strat, 2),
            "buy_hold_pnl_all_funds_cny": round(bh, 2),
            "excess_pnl_all_funds_cny": round(strat - bh, 2),
            "strategy_pnl_20k_total_cny": round(strat / len(funds), 2),
            "buy_hold_pnl_20k_total_cny": round(bh / len(funds), 2),
        })

    all_dates = sorted({d for r in results for d in r["daily_strategy_pnl"]})
    total_strategy = sum(r["summary"]["strategy_pnl_cny"] for r in results)
    total_bh = sum(r["summary"]["buy_hold_pnl_cny"] for r in results)
    total_capital = CAPITAL * len(results)
    all_trades = [t for r in results for t in r["trades"]]
    portfolio = {
        "fund_count_expected": len(funds),
        "fund_count_collected": len(results),
        "total_initial_capital_cny": round(total_capital, 2),
        "strategy_pnl_cny": round(total_strategy, 2),
        "strategy_return_pct": round(total_strategy / total_capital * 100.0, 2),
        "buy_hold_pnl_cny": round(total_bh, 2),
        "buy_hold_return_pct": round(total_bh / total_capital * 100.0, 2),
        "excess_vs_buy_hold_cny": round(total_strategy - total_bh, 2),
        "strategy_pnl_20k_total_equal_weight_cny": round(total_strategy / len(funds), 2),
        "buy_hold_pnl_20k_total_equal_weight_cny": round(total_bh / len(funds), 2),
        "strategy_max_drawdown_pct": round(portfolio_drawdown(results, "daily_strategy_pnl", CAPITAL, all_dates), 2),
        "buy_hold_max_drawdown_pct": round(portfolio_drawdown(results, "daily_buy_hold_pnl", CAPITAL, all_dates), 2),
        "closed_trades": len(all_trades),
        "win_rate_pct": round(sum(1 for t in all_trades if t["profit_cny"] > 0) / len(all_trades) * 100.0, 2) if all_trades else 0.0,
        "profit_factor": round(sum(t["profit_cny"] for t in all_trades if t["profit_cny"] > 0) /
                               abs(sum(t["profit_cny"] for t in all_trades if t["profit_cny"] < 0)), 3)
                          if any(t["profit_cny"] < 0 for t in all_trades) else None,
    }

    summary_rows = [r["summary"] for r in results]
    summary_rows.sort(key=lambda x: x["strategy_pnl_cny"], reverse=True)
    report_lines = [
        "# 15只行业ETF四线趋势回测",
        "",
        f"- 数据源：腾讯公开日K接口，前复权（qfqday）；东方财富作为备用；抓取时间：{datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds')}",
        f"- 回测区间：{start} 至 {end}；实际数据截止日以每只ETF coverage_end 为准。",
        f"- 样本：{len(results)}/{len(funds)} 只ETF；缺失：{len(errors)} 只。",
        "- 规则：收盘价同时高于MA5/10/20/60，次日开盘买入；收盘价同时低于四条均线，次日开盘卖出。",
        "- 资金：每只ETF固定2万元，每次买入仍使用2万元本金，盈利不复投；15只全额并行的初始本金为30万元。另提供2万元总资金等权分配结果。",
        "- 买入持有：每只ETF从2020-01-01之后首个有效交易日开盘买入并持有至截止日收盘。",
        "- 不计佣金、滑点、冲击成本；回测为前复权价格口径的毛收益。信号均使用当日收盘后可得数据。",
        "",
        "## 组合结果",
        "",
        "| 指标 | 四线策略 | 买入持有 |",
        "|---|---:|---:|",
        f"| {portfolio['total_initial_capital_cny']:,.0f}元总本金累计盈亏 | {portfolio['strategy_pnl_cny']:,.2f}元 | {portfolio['buy_hold_pnl_cny']:,.2f}元 |",
        f"| {portfolio['total_initial_capital_cny']:,.0f}元总本金收益率 | {portfolio['strategy_return_pct']:.2f}% | {portfolio['buy_hold_return_pct']:.2f}% |",
        f"| 2万元总本金等权盈亏 | {portfolio['strategy_pnl_20k_total_equal_weight_cny']:,.2f}元 | {portfolio['buy_hold_pnl_20k_total_equal_weight_cny']:,.2f}元 |",
        f"| 最大回撤 | {portfolio['strategy_max_drawdown_pct']:.2f}% | {portfolio['buy_hold_max_drawdown_pct']:.2f}% |",
        f"| 已平仓交易数 | {portfolio['closed_trades']} | — |",
        f"| 胜率 | {portfolio['win_rate_pct']:.2f}% | — |",
        f"| 盈亏比（盈利总额/亏损总额） | {portfolio['profit_factor']} | — |",
        "",
        "## 各ETF表现（每只初始本金2万元）",
        "",
        "| 排名 | ETF | 行业 | 四线策略盈亏 | 四线收益率 | 买入持有盈亏 | 买入持有收益率 | 交易次数 | 胜率 | 最大回撤 |",
        "|---:|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for i, s in enumerate(summary_rows, 1):
        report_lines.append(
            f"| {i} | {s['name']}（{s['symbol'][:6]}） | {s['industry']} | {s['strategy_pnl_cny']:,.2f} | "
            f"{s['strategy_return_pct']:.2f}% | {s['buy_hold_pnl_cny']:,.2f} | {s['buy_hold_return_pct']:.2f}% | "
            f"{s['closed_trades']} | {s['win_rate_pct']:.1f}% | {s['strategy_max_drawdown_pct']:.2f}% |"
        )
    report_lines += [
        "",
        "## 组合逐年盈亏",
        "",
        "| 年份 | 四线策略（30万元本金） | 买入持有（30万元本金） | 四线策略（2万元总本金） | 买入持有（2万元总本金） |",
        "|---:|---:|---:|---:|---:|",
    ]
    for y in annual_portfolio:
        report_lines.append(
            f"| {y['year']} | {y['strategy_pnl_all_funds_cny']:,.2f} | {y['buy_hold_pnl_all_funds_cny']:,.2f} | "
            f"{y['strategy_pnl_20k_total_cny']:,.2f} | {y['buy_hold_pnl_20k_total_cny']:,.2f} |"
        )
    if errors:
        report_lines += ["", "## 未能采集的ETF", ""]
        report_lines += [f"- {e['symbol']}：{e['error']}" for e in errors]
    report_lines += [
        "",
        "## 口径说明",
        "",
        "东方财富接口返回的前复权日K用于均线和次日开盘成交模拟。年度盈亏为每年末策略累计权益相对上一年末的变化；未平仓持仓按当年最后一个交易日收盘价计入浮动盈亏。每笔交易固定使用2万元本金，不将历史盈利滚入下一笔。买入持有同样以每只2万元本金计算。",
        "",
        "数据源说明：腾讯公开 QFQ 日K接口；若该接口无数据，则尝试东方财富公开日K接口。",
    ]
    report = "\n".join(report_lines) + "\n"

    output = {
        "schema": 1, "source": "Tencent public QFQ API (Eastmoney fallback)",
        "adjustment": "qfq / forward adjusted (fqt=1)",
        "start": start, "end_requested": end,
        "generated_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
        "capital_per_etf_cny": CAPITAL, "ma_windows": MA_WINDOWS,
        "execution": "signal at close, fill at next trading-day open",
        "transaction_cost_bps": 0, "portfolio": portfolio,
        "annual_portfolio": annual_portfolio, "funds": summary_rows,
        "trades": all_trades, "errors": errors,
    }
    (OUT / "report.md").write_text(report, encoding="utf-8")
    (OUT / "backtest.json").write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "history.json.gz").write_bytes(gzip.compress(json.dumps(collected, ensure_ascii=False, separators=(",", ":")).encode("utf-8")))
    (OUT / "manifest.json").write_text(json.dumps({
        "source": "Tencent public daily QFQ K-line API; Eastmoney fallback", "adjustment": "qfq",
        "requested_start": start, "requested_end": end,
        "funds_expected": len(funds), "funds_collected": len(results), "errors": errors,
        "fund_coverage": {sym: {"start": rows[0]["date"], "end": rows[-1]["date"], "bars": len(rows)}
                         for sym, rows in collected.items()},
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    with (OUT / "summary.csv").open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(summary_rows[0].keys()))
        writer.writeheader()
        writer.writerows([{**s, "open_position": json.dumps(s["open_position"], ensure_ascii=False) if s["open_position"] else ""} for s in summary_rows])
    with (OUT / "annual.csv").open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(annual_portfolio[0].keys()))
        writer.writeheader()
        writer.writerows(annual_portfolio)
    trade_fields = list(all_trades[0].keys()) if all_trades else [
        "symbol", "name", "industry", "signal_buy_date", "buy_date", "buy_price",
        "signal_sell_date", "sell_date", "sell_price", "profit_cny", "return_pct", "holding_trading_days"
    ]
    with (OUT / "trades.csv").open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=trade_fields)
        writer.writeheader()
        writer.writerows(all_trades)

    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_file:
        with open(summary_file, "a", encoding="utf-8") as f:
            f.write(report)
    print(json.dumps({"status": "complete" if not errors else "partial",
                      "funds_collected": len(results), "funds_expected": len(funds),
                      "asof": {sym: rows[-1]["date"] for sym, rows in collected.items()},
                      "portfolio": portfolio, "annual": annual_portfolio, "errors": errors},
                     ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
