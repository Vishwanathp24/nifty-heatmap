"""1-year (52-week) high / low per NSE stock (Sector Heatmap -> stock table).

Yahoo's daily history for the last year (range=1y, split/bonus-adjusted) gives the highest
high and lowest low. Each symbol is fetched by one background worker and refreshed daily as
the window rolls; results are saved next to the DB so restarts don't refetch. Today's live
high / low is folded in by `levels`, so a stock making a new high shows 0% straight away.
"""
import json
import threading
import time
from urllib.parse import quote

import sources
from store import DB_PATH

FILE = DB_PATH.parent / "year_hl.json"
MAX_AGE = 12 * 3600   # history refresh (the 1-year window moves daily)
RETRY = 3600          # after a failed fetch (unknown on Yahoo, network error)

_lock = threading.Lock()
_want = []
_thread = None
try:
    _cache = json.loads(FILE.read_text())
except (OSError, ValueError):
    _cache = {}


def _fetch(sym):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/" + quote(sym + ".NS", safe="")
           + "?interval=1d&range=1y")
    r = sources.yahoo.get(url, timeout=15)["chart"]["result"][0]
    q, ts = r["indicators"]["quote"][0], r.get("timestamp") or []
    hi = [(h, t) for h, t in zip(q.get("high") or [], ts) if h]
    lo = [(v, t) for v, t in zip(q.get("low") or [], ts) if v]
    if not hi or not lo:
        return {"at": time.time()}
    (h, ht), (low, lt) = max(hi), min(lo)
    return {"hi": round(h, 2), "hi_t": ht, "lo": round(low, 2), "lo_t": lt, "at": time.time()}


def _save():
    try:
        FILE.write_text(json.dumps(_cache))
    except OSError:
        pass


def _work():
    global _thread
    done = 0
    while True:
        with _lock:
            if not _want:
                _thread = None
                break
            sym = _want.pop(0)
        try:
            row = _fetch(sym)
        except (sources.SourceError, KeyError, IndexError, TypeError):
            row = {"at": time.time() - MAX_AGE + RETRY}
        with _lock:
            _cache[sym] = row
        done += 1
        if done % 20 == 0:
            _save()
    _save()


def _stale(row):
    return not row or time.time() - row.get("at", 0) > MAX_AGE


def levels(stocks):
    """Add the 1-year high / low and % from each (vs LTP) to the stock rows; queue missing ones."""
    global _thread
    with _lock:
        for s in stocks:
            row = _cache.get(s["symbol"])
            if _stale(row) and s["symbol"] not in _want:
                _want.append(s["symbol"])
            if not row or row.get("hi") is None:
                continue
            ltp = s.get("ltp")
            hi = max(row["hi"], s.get("high") or 0, ltp or 0)
            lo = min([row["lo"], *(v for v in (s.get("low"), ltp) if v)])
            s["y_high"], s["y_low"] = hi, lo
            if ltp:
                s["pct_y_high"] = round((ltp - hi) / hi * 100, 2)
                s["pct_y_low"] = round((ltp - lo) / lo * 100, 2)
        if _want and _thread is None:
            _thread = threading.Thread(target=_work, name="year-hl", daemon=True)
            _thread.start()
    return stocks
