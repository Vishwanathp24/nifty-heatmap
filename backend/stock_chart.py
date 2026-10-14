"""Intraday Scanner -> Live Chart: NSE stock candles (Yahoo Finance) on 1m ... 1M, older history
for dragging the chart back, and the same multi-timeframe indicator table as the crypto chart.

Yahoo intervals: 1m (last ~30 days, 7-day windows), 5m / 15m / 30m / 60m (last 60 days),
1d / 1wk / 1mo (years). 3m is built from 1m; 2h / 3h / 4h from 60m bars inside each session
(9:15 IST start, like NSE charts). Market data only.
"""
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import sources

IST = timedelta(hours=5, minutes=30)
OPEN, CLOSE = 9 * 60 + 15, 15 * 60 + 30
# tf -> (Yahoo interval, bars merged, history window per request in days; None = no paging)
TFS = {"1m": ("1m", 1, 5), "3m": ("1m", 3, 5), "5m": ("5m", 1, 15), "15m": ("15m", 1, 30), "30m": ("30m", 1, 45),
       "1h": ("60m", 1, 120), "2h": ("60m", 2, 120), "3h": ("60m", 3, 120), "4h": ("60m", 4, 120),
       "1D": ("1d", 1, 730), "1W": ("1wk", 1, 3650), "1M": ("1mo", 1, None)}
LIMIT_DAYS = {"1m": 29, "5m": 59, "15m": 59, "30m": 59, "60m": 729}  # how far back Yahoo serves each interval
FIRST = {"1m": 5, "5m": 8, "15m": 20, "30m": 40, "60m": 90, "1d": 400, "1wk": 2000, "1mo": 20000}  # first load, days


def _yahoo(symbol, interval, p1, p2):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol + '.NS', safe='')}"
           f"?interval={interval}&period1={int(p1)}&period2={int(p2)}")
    r = sources.yahoo.get(url, timeout=15)["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    intraday = interval[-1] == "m"
    out = []
    for t, o, h, l, c, v in zip(r.get("timestamp") or [], q["open"], q["high"], q["low"], q["close"], q["volume"]):
        if None in (o, h, l, c):
            continue
        ist = datetime.fromtimestamp(t, timezone.utc) + IST
        m = ist.hour * 60 + ist.minute
        if intraday and not OPEN <= m < CLOSE:
            continue
        if not intraday and not v and o == h == l == c:
            continue  # holiday placeholder row
        out.append({"t": t * 1000, "o": o, "h": h, "l": l, "c": c, "v": v or 0, "d": ist.date().isoformat(), "m": m})
    return out


def _merge(rows, k, minutes):
    """k consecutive bars -> one, restarting at each session open (bucket = minutes since 9:15)."""
    if k == 1:
        return rows
    out = []
    for b in rows:
        key = (b["d"], (b["m"] - OPEN) // (minutes * k))
        if out and out[-1]["_k"] == key:
            o = out[-1]
            o.update(h=max(o["h"], b["h"]), l=min(o["l"], b["l"]), c=b["c"], v=o["v"] + b["v"])
        else:
            out.append({**b, "_k": key})
    for o in out:
        o.pop("_k", None)
    return out


def _bars(symbol, tf, p1, p2):
    interval, k, _ = TFS[tf]
    rows = _yahoo(symbol, interval, p1, p2)
    return _merge(rows, k, 1 if interval == "1m" else 60)


class StockChart:
    def __init__(self):
        self.lock = threading.Lock()
        self.cache = {}

    def _cached(self, key, ttl, build):
        with self.lock:
            hit = self.cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        data = build()
        with self.lock:
            self.cache[key] = (time.time(), data)
        return data

    def candles(self, symbol, tf, before=None):
        symbol = symbol.upper().strip()
        if tf not in TFS:
            raise ValueError("tf must be one of " + ", ".join(TFS))
        interval, _, window = TFS[tf]
        now = time.time()
        if before:
            p2 = int(before) / 1000
            limit = LIMIT_DAYS.get(interval)
            if window is None or (limit and p2 < now - limit * 86400):
                return {"symbol": symbol, "tf": tf, "candles": [], "end": True}
            p1 = max(p2 - window * 86400, now - limit * 86400 + 3600) if limit else p2 - window * 86400
            rows = self._cached(f"h:{symbol}:{tf}:{before}", 600, lambda: _bars(symbol, tf, p1, p2 - 1))
            rows = [b for b in rows if b["t"] < int(before)]
            return {"symbol": symbol, "tf": tf, "candles": rows, "end": not rows}
        p1 = now - FIRST[interval] * 86400
        rows = self._cached(f"c:{symbol}:{tf}", 15, lambda: _bars(symbol, tf, p1, now + 60))
        if not rows:
            raise LookupError(f"No chart data for {symbol} from Yahoo Finance.")
        return {"symbol": symbol, "tf": tf, "candles": rows[-400:], "source": "Yahoo",
                "fetched_at": datetime.now(timezone.utc).isoformat()}

    def indicators(self, symbol):
        """VWAP / EMA 5 / EMA 9 / Supertrend / RSI / ADX / DI on every timeframe (same rules as crypto)."""
        from crypto_live import _vwap_anchored
        from trend import indicators
        symbol = symbol.upper().strip()

        def one(tf):
            try:
                rows = self.candles(symbol, tf)["candles"]
                c = [{**b, "t": f"{b['m'] // 60:02d}:{b['m'] % 60:02d}"} for b in rows]
                if len(c) < 30:
                    return tf, None
                r = indicators(c)
                if r:
                    v = _vwap_anchored(tf, c)
                    r["vwap"] = round(v, 2) if v else None
                    if tf in ("1D", "1W", "1M"):
                        r["candle"] = c[-1]["d"]
                return tf, r
            except Exception:
                return tf, None

        def build():
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=4) as ex:
                res = dict(ex.map(one, list(TFS)))
            return {"symbol": symbol, "tfs": list(TFS), "rows": res, "fetched_at": datetime.now(timezone.utc).isoformat()}

        return self._cached("ind:" + symbol, 30, build)
