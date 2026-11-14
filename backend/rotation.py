"""Sector Heatmap -> Sector Rotation: daily closes of the sector indices (NSE index history), so the
page can rank sectors for the previous day / week / month and compare with the current rank.
One NSE call per sector, cached for 3 hours in memory and refreshed in a background thread."""
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import sources
from config import SECTORS

TTL = 3 * 3600
IST = timezone(timedelta(hours=5, minutes=30))
_cache = {"at": 0, "data": None}
_lock = threading.Lock()
_busy = False


def _history(sym, start, end):
    url = (sources.NSE_API + "historicalOR/indicesHistory?indexType=" + quote(sym)
           + f"&from={start:%d-%m-%Y}&to={end:%d-%m-%Y}")
    rows = sources.nse.get(url).get("data") or []
    out = {}
    for r in rows:
        try:
            d = datetime.strptime(r["EOD_TIMESTAMP"], "%d-%b-%Y").date().isoformat()
        except (KeyError, ValueError):
            continue
        c = sources.f(r.get("EOD_CLOSE_INDEX_VAL"))
        if c:
            out[d] = c
    return sorted(out.items())


def _refresh():
    global _busy
    end = datetime.now(IST).date()
    start = end - timedelta(days=100)
    try:  # NSE history wants the full index name (e.g. NIFTY PRIVATE BANK for NIFTY PVT BANK)
        names = {k: v.get("name") for k, v in sources.all_indices().items()}
    except sources.SourceError:
        names = {}
    data = {}
    for sym, _ in SECTORS:
        try:
            data[sym] = _history(names.get(sym) or sym, start, end)
        except (sources.SourceError, KeyError, TypeError, ValueError):
            data[sym] = (_cache["data"] or {}).get(sym) or []
    with _lock:
        _cache.update(at=time.time(), data=data)
        _busy = False


def closes():
    """{sector symbol: [[date, close], ...]} oldest first (may include today after the close)."""
    global _busy
    with _lock:
        stale = time.time() - _cache["at"] > TTL
        if stale and not _busy:
            _busy = True
            threading.Thread(target=_refresh, name="rotation", daemon=True).start()
        data = _cache["data"]
    return {"loading": data is None, "closes": data or {}}


# ---- Median stock: rank sectors by the median % move of their constituent stocks ---------------
# Every stock counts equally (an index is weighted by company size), so this shows how broad a
# sector's move is. Members + live prices: NSE market-watch per sector (refreshed every 2 min).
# Daily closes per stock: Yahoo 1d bars (~3 months), cached next to the DB, refreshed twice a day.
import json
import statistics

from store import DB_PATH

CLOSE_FILE = DB_PATH.parent / "rotation_closes.json"
MEMBERS_TTL = 120
CLOSE_MAX_AGE = 12 * 3600
PERIODS = {"day": 1, "week": 5, "month": 21}
_mem = {"at": 0, "data": None, "busy": False}
_want, _worker = [], {"t": None}
try:
    _closes = json.loads(CLOSE_FILE.read_text())
except (OSError, ValueError):
    _closes = {}


def _members_refresh():
    data = {}
    for sym, _ in SECTORS:
        try:
            _, stocks = sources.constituents(sym)
            data[sym] = stocks
        except sources.SourceError:
            data[sym] = ((_mem["data"] or {}).get(sym)) or {}
    with _lock:
        _mem.update(at=time.time(), data=data, busy=False)


def _stock_closes(sym):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/" + quote(sym + ".NS", safe="")
           + "?interval=1d&range=3mo")
    r = sources.yahoo.get(url, timeout=15)["chart"]["result"][0]
    out = {}
    for t, c in zip(r.get("timestamp") or [], r["indicators"]["quote"][0].get("close") or []):
        if c:
            out[datetime.fromtimestamp(t, IST).strftime("%Y-%m-%d")] = round(c, 2)
    return {"c": sorted(out.items()), "at": time.time()}


def _save():
    try:
        CLOSE_FILE.write_text(json.dumps(_closes))
    except OSError:
        pass


def _work():
    done = 0
    while True:
        with _lock:
            if not _want:
                _worker["t"] = None
                break
            sym = _want.pop(0)
        try:
            row = _stock_closes(sym)
        except (sources.SourceError, KeyError, IndexError, TypeError, ValueError):
            row = {"c": (_closes.get(sym) or {}).get("c") or [], "at": time.time() - CLOSE_MAX_AGE + 3600}
        with _lock:
            _closes[sym] = row
        done += 1
        if done % 25 == 0:
            _save()
    _save()


def _pct(a, b):
    return (a - b) / b * 100 if a and b else None


def _median(vals):
    vals = [v for v in vals if v is not None]
    return round(statistics.median(vals), 2) if vals else None


def median():
    """{loading, pending, sectors: {sym: {count, adv, dec, day|week|month: {now, prev}}}}"""
    with _lock:
        if time.time() - _mem["at"] > MEMBERS_TTL and not _mem["busy"]:
            _mem["busy"] = True
            threading.Thread(target=_members_refresh, name="rotation-members", daemon=True).start()
        members = _mem["data"]
        if members is None:
            return {"loading": True, "pending": None, "sectors": {}}
        syms = {s for stocks in members.values() for s in stocks}
        for s in syms:
            row = _closes.get(s)
            if (not row or time.time() - row.get("at", 0) > CLOSE_MAX_AGE) and s not in _want:
                _want.append(s)
        if _want and _worker["t"] is None:
            _worker["t"] = threading.Thread(target=_work, name="rotation-closes", daemon=True)
            _worker["t"].start()
        pending = len(_want)
        out = {}
        for sec, stocks in members.items():
            moves = {p: ([], []) for p in PERIODS}
            adv = dec = 0
            for s, q in stocks.items():
                ltp = q.get("ltp")
                session = (q.get("updated") or "")[:10]
                hist = [c for d, c in ((_closes.get(s) or {}).get("c") or []) if not session or d < session]
                day = _pct(ltp, q.get("prev"))
                if day is not None:
                    adv += day > 0
                    dec += day < 0
                L = len(hist)
                for p, n in PERIODS.items():
                    now = day if p == "day" else (_pct(ltp, hist[L - n]) if L >= n else None)
                    prev = _pct(hist[L - n], hist[L - 2 * n]) if L >= 2 * n else None
                    moves[p][0].append(now)
                    moves[p][1].append(prev)
            out[sec] = {"count": len(stocks), "adv": adv, "dec": dec,
                        **{p: {"now": _median(a), "prev": _median(b)} for p, (a, b) in moves.items()}}
    return {"loading": False, "pending": pending, "sectors": out}


def add_30d(stocks, session=None):
    """Sector drawer: % change of each stock over the last 30 days (LTP vs the close on or before
    the date 30 days ago), from the cached daily closes. Queues any stock not cached yet."""
    with _lock:
        for s in stocks:
            sym, ltp = s.get("symbol"), s.get("ltp")
            row = _closes.get(sym)
            if (not row or time.time() - row.get("at", 0) > CLOSE_MAX_AGE) and sym not in _want:
                _want.append(sym)
            session = session or (s.get("updated") or "")[:10] or datetime.now(IST).date().isoformat()
            try:
                cut = (datetime.fromisoformat(session) - timedelta(days=30)).date().isoformat()
            except ValueError:
                continue
            ref = [c for d, c in (row or {}).get("c") or [] if d <= cut]
            s["pct_30d"] = round(_pct(ltp, ref[-1]), 2) if ref and ltp else None
            cut7 = (datetime.fromisoformat(session) - timedelta(days=7)).date().isoformat()
            ref7 = [c for d, c in (row or {}).get("c") or [] if d <= cut7]
            s["pct_1w"] = round(_pct(ltp, ref7[-1]), 2) if ref7 and ltp else None
            # day-by-day % change for the last 30 sessions (today first), keyed by date
            hist = [(d, c) for d, c in (row or {}).get("c") or [] if d < session]
            days = {session: round(_pct(ltp, hist[-1][1]), 2)} if hist and ltp else {}
            for i in range(len(hist) - 1, max(len(hist) - 30, 0), -1):
                days[hist[i][0]] = round(_pct(hist[i][1], hist[i - 1][1]), 2)
            s["daily"] = days
        if _want and _worker["t"] is None:
            _worker["t"] = threading.Thread(target=_work, name="rotation-closes", daemon=True)
            _worker["t"].start()


def history(symbols):
    """Top 20 Gainers / Losers: the last ~45 daily closes per stock (queues any not cached yet)."""
    out = {}
    with _lock:
        for sym in symbols:
            row = _closes.get(sym)
            if (not row or time.time() - row.get("at", 0) > CLOSE_MAX_AGE) and sym not in _want:
                _want.append(sym)
            out[sym] = ((row or {}).get("c") or [])[-45:]
        if _want and _worker["t"] is None:
            _worker["t"] = threading.Thread(target=_work, name="rotation-closes", daemon=True)
            _worker["t"].start()
    return {"closes": out, "pending": len(_want)}
