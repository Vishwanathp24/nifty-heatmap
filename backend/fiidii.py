"""FII / DII page: NSE participant-wise open interest in equity derivatives (FII, DII, Pro, Client),
published by NSE after each session as fao_participant_oi_DDMMYYYY.csv, plus Nifty closes and the
cash-market FII / DII net (NSE provisional, saved one row per day as it arrives).
A published day never changes, so each parsed day is kept on disk; only missing days are fetched."""
import csv
import io
import json
import threading
import time
from datetime import datetime, timedelta, timezone

import sources
from store import DB_PATH

IST = timezone(timedelta(hours=5, minutes=30))
FILE = DB_PATH.parent / "fiidii_oi.json"
CASH_FILE = DB_PATH.parent / "fiidii_cash.json"
URL = "https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_{:%d%m%Y}.csv"
DAYS = 30           # trading sessions shown
REFRESH = 30 * 60   # look for a new day every 30 min
PARTIES = ("FII", "DII", "Pro", "Client")
COLS = {"Future Index Long": "fil", "Future Index Short": "fis", "Future Stock Long": "fsl", "Future Stock Short": "fss",
        "Option Index Call Long": "icl", "Option Index Put Long": "ipl", "Option Index Call Short": "ics",
        "Option Index Put Short": "ips", "Option Stock Call Long": "scl", "Option Stock Put Long": "spl",
        "Option Stock Call Short": "scs", "Option Stock Put Short": "sps"}

_lock = threading.Lock()
_state = {"at": 0, "busy": False, "days": None, "missing": set()}


def _load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def _parse(text):
    rows = list(csv.reader(io.StringIO(text)))
    head = next((i for i, r in enumerate(rows) if r and r[0].strip() == "Client Type"), None)
    if head is None:
        return None
    names = [c.strip() for c in rows[head]]
    out = {}
    for r in rows[head + 1:]:
        if not r or r[0].strip() not in PARTIES:
            continue
        rec = {}
        for name, val in zip(names[1:], r[1:]):
            if name in COLS:
                try:
                    rec[COLS[name]] = int(float(val.replace(",", "")))
                except ValueError:
                    rec[COLS[name]] = 0
        out[r[0].strip()] = rec
    return out if len(out) == len(PARTIES) else None


def _nse_closes(name, start, end):
    from rotation import _history
    try:
        return dict(_history(name, start, end))
    except (sources.SourceError, KeyError, TypeError, ValueError):
        return {}


def _sensex_closes():
    """Sensex daily closes (BSE index; NSE does not publish it) from Yahoo, ~3 months."""
    try:
        r = sources.yahoo.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EBSESN?interval=1d&range=3mo", timeout=10)["chart"]["result"][0]
        out = {}
        for t, c in zip(r["timestamp"], r["indicators"]["quote"][0]["close"]):
            if c:
                out[datetime.fromtimestamp(t, IST).date().isoformat()] = round(c, 2)
        return out
    except (sources.SourceError, KeyError, IndexError, TypeError, ValueError):
        return {}


def _refresh():
    now = datetime.now(IST)
    days = _load(FILE)
    missing = set(_state["missing"])
    d, tried = now.date(), 0
    if now.hour < 17:  # today's file is published in the evening
        d -= timedelta(days=1)
    have = 0
    while have < DAYS + 1 and tried < 60:
        tried += 1
        key = d.isoformat()
        if d.weekday() < 5 and key not in missing:
            if key in days:
                have += 1
            else:
                try:
                    parsed = _parse(sources.nse.get(URL.format(d), raw=True).decode("utf-8", "replace"))
                except sources.SourceError:
                    parsed = None
                if parsed:
                    days[key] = parsed
                    have += 1
                elif d < now.date() - timedelta(days=3):
                    missing.add(key)  # holiday: don't ask again
        d -= timedelta(days=1)
    keep = sorted(days)[-(DAYS + 5):]
    days = {k: days[k] for k in keep}
    try:
        FILE.write_text(json.dumps(days))
    except OSError:
        pass
    if keep:
        start = datetime.fromisoformat(keep[0]).date() - timedelta(days=7)
        series = {"nifty": _nse_closes("NIFTY 50", start, now.date()), "banknifty": _nse_closes("NIFTY BANK", start, now.date()),
                  "sensex": _sensex_closes()}
        for k in keep:
            for name, closes in series.items():
                if k in closes:
                    days[k][name] = closes[k]
    with _lock:
        _state.update(at=time.time(), busy=False, days=days, missing=missing)


def _views(p):
    """Net long contracts per segment for one participant on one day."""
    return {
        "idx_fut": p["fil"] - p["fis"],
        "stk_fut": p["fsl"] - p["fss"],
        "call": p["icl"] - p["ics"],          # net long index calls
        "put": p["ipl"] - p["ips"],           # net long index puts
        "idx_opt": (p["icl"] - p["ics"]) - (p["ipl"] - p["ips"]),  # bullish side (long calls, short puts) minus bearish side
        "fut_long_pct": round(100 * p["fil"] / (p["fil"] + p["fis"]), 1) if p["fil"] + p["fis"] else None,
        "opt_bull_pct": round(100 * (p["icl"] + p["ips"]) / (p["icl"] + p["ips"] + p["ipl"] + p["ics"]), 1)
        if p["icl"] + p["ips"] + p["ipl"] + p["ics"] else None,
        "raw": p,
    }


def _cash_history(cash):
    """Save today's cash-market FII / DII net (NSE only gives the latest day) and return the saved rows."""
    hist = _load(CASH_FILE)
    try:
        fii, dii = cash.get("fii") or {}, cash.get("dii") or {}
        key = datetime.strptime(fii.get("date") or dii.get("date"), "%d-%b-%Y").date().isoformat()
        row = {"fii": fii.get("net"), "dii": dii.get("net"), "fii_buy": fii.get("buy"), "fii_sell": fii.get("sell"),
               "dii_buy": dii.get("buy"), "dii_sell": dii.get("sell")}
        if hist.get(key) != row:
            hist[key] = row
            hist = {k: hist[k] for k in sorted(hist)[-90:]}
            CASH_FILE.write_text(json.dumps(hist))
    except (AttributeError, TypeError, ValueError, OSError):
        pass
    return [{"date": k, **v} for k, v in sorted(hist.items(), reverse=True)]


def snapshot(cash=None):
    with _lock:
        if time.time() - _state["at"] > REFRESH and not _state["busy"]:
            _state["busy"] = True
            threading.Thread(target=_refresh, name="fiidii", daemon=True).start()
        days = _state["days"]
    if days is None:
        return {"loading": True}
    keys = sorted(days)
    rows = []
    for i, k in enumerate(keys):
        if i == 0:
            continue  # first day only serves as the "previous" for the change
        prev, cur = days[keys[i - 1]], days[k]
        row = {"date": k, "p": {}}
        for name in ("nifty", "banknifty", "sensex"):
            row[name], row[name + "_prev"] = cur.get(name), prev.get(name)
        for who in PARTIES:
            now_v, prev_v = _views(cur[who]), _views(prev[who])
            row["p"][who] = {**now_v, "chg": {s: now_v[s] - prev_v[s] for s in ("idx_fut", "stk_fut", "call", "put", "idx_opt")}}
        rows.append(row)
    rows.reverse()  # newest first
    out = {"loading": False, "days": rows[:DAYS], "cash": _cash_history(cash) if cash else []}
    out["read"] = read(out)
    return out


def _n(v):
    return f"{abs(v) / 1e5:.2f}L" if abs(v) >= 1e5 else f"{abs(v):,}"


def read(snap=None):
    """Plain-language read of the latest FII F&O positions: a lean from the day's change in index futures and
    index options, with the points behind it. Describes positioning only; it is not a forecast."""
    snap = snap or snapshot()
    if snap.get("loading") or not snap.get("days"):
        return None
    d = snap["days"][0]
    f, c = d["p"]["FII"], d["p"]["Client"]
    fut, opt = f["chg"]["idx_fut"], f["chg"]["idx_opt"]
    vf = 1 if fut >= 5000 else -1 if fut <= -5000 else 0
    vo = 1 if opt >= 50000 else -1 if opt <= -50000 else 0
    score = vf + vo
    key = "bull" if score > 0 else "bear" if score < 0 else "neutral"
    label = {2: "Bullish", 1: "Leans bullish", 0: "Mixed", -1: "Leans bearish", -2: "Bearish"}[score]
    pts = []
    side = "long" if f["idx_fut"] >= 0 else "short"
    pts.append(f"FII index futures: net {side} {_n(f['idx_fut'])} contracts ({f['fut_long_pct']}% long); "
               + (f"added {_n(fut)} on the long side" if fut > 0 else f"added {_n(fut)} on the short side" if fut < 0 else "no change")
               + ("" if vf else " (small change)"))
    calls, puts = f["chg"]["call"], f["chg"]["put"]
    pts.append(f"FII index options: {'bought' if calls >= 0 else 'sold'} {_n(calls)} net calls and "
               f"{'bought' if puts >= 0 else 'sold'} {_n(puts)} net puts, "
               + (f"{_n(opt)} contracts to the bullish side" if opt > 0 else f"{_n(opt)} contracts to the bearish side" if opt < 0 else "no net change")
               + ("" if vo else " (small change)"))
    if c["chg"]["idx_opt"] * opt < 0:
        pts.append(f"Clients (mostly retail) moved the other way in options ({'+' if c['chg']['idx_opt'] > 0 else '−'}{_n(c['chg']['idx_opt'])}).")
    if f["fut_long_pct"] is not None and f["fut_long_pct"] <= 25:
        pts.append("FII futures are heavily short: a sharp rise can force short covering.")
    return {"date": d["date"], "key": key, "label": label, "score": score, "points": pts}
