"""Option Selling tab: daily + hourly regime readings for the indices (Nifty, Bank Nifty, Sensex).

The stock scanner (trend.py) only covers stocks, so the same daily metrics (close, 20-day average, RSI)
and hourly indicators (ADX, EMA 9 / 21, Supertrend) are worked out here from Yahoo Finance index charts.
"""
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import sources
import trend

INDICES = (("NIFTY", "^NSEI"), ("BANKNIFTY", "^NSEBANK"), ("SENSEX", "^BSESN"))
TTL = 300
_cache = {"at": 0, "data": None}


def _bars(ysym, interval, rng):
    url = "https://query1.finance.yahoo.com/v8/finance/chart/" + quote(ysym, safe="") + f"?interval={interval}&range={rng}"
    r = sources.yahoo.get(url, timeout=12)["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    out = []
    for t, o, h, l, c in zip(r.get("timestamp") or [], q["open"], q["high"], q["low"], q["close"]):
        if None in (o, h, l, c):
            continue
        ist = datetime.fromtimestamp(t, timezone.utc) + timedelta(hours=5, minutes=30)
        out.append({"d": ist.date().isoformat(), "m": ist.hour * 60 + ist.minute, "t": ist.strftime("%H:%M"),
                    "o": o, "h": h, "l": l, "c": c, "v": 0})
    return out


def regime():
    if _cache["data"] is not None and time.time() - _cache["at"] < TTL:
        return _cache["data"]
    out = {}
    for key, ysym in INDICES:
        try:
            daily = _bars(ysym, "1d", "6mo")
            hourly = _bars(ysym, "60m", "1mo")
            out[key] = {"daily": trend.daily_metrics(daily), "tf60": trend.indicators(hourly)}
        except (sources.SourceError, KeyError, IndexError, TypeError, ValueError):
            out[key] = None
    _cache.update(at=time.time(), data=out)
    return out
