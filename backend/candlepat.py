"""Candlestick patterns on the F&O stocks (Intraday Scanner -> Candlestick tab).

Daily candles: the last ~3 months from Yahoo (interval=1d, one background worker, cached next to the DB
and refreshed twice a day), plus TODAY's candle built from the live NSE feed (open / high / low / LTP), so
a pattern shows while it forms during the session and is final after the close.

Patterns on the latest candle (and the 1-2 before it for the two- and three-candle ones). "Trend" is the
close against the close 5 sessions earlier; hammers and stars only count after the move they reverse.
A candle smaller than a third of the stock's average range (14 sessions) is too small to mean much and
is skipped, except for a doji. These are chart shapes, not buy / sell signals.
"""
import json
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import sources
from store import DB_PATH

FILE = DB_PATH.parent / "candles_daily.json"
MAX_AGE = 12 * 3600
RETRY = 3600
IST = timezone(timedelta(hours=5, minutes=30))

_lock = threading.Lock()
_want = []
_thread = None
try:
    _cache = json.loads(FILE.read_text())
except (OSError, ValueError):
    _cache = {}


def _fetch(sym):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/" + quote(sym + ".NS", safe="")
           + "?interval=1d&range=3mo")
    r = sources.yahoo.get(url, timeout=15)["chart"]["result"][0]
    q, ts = r["indicators"]["quote"][0], r.get("timestamp") or []
    bars = []
    for t, o, h, lo, c in zip(ts, q.get("open") or [], q.get("high") or [], q.get("low") or [], q.get("close") or []):
        if None in (o, h, lo, c):
            continue
        d = datetime.fromtimestamp(t, IST).strftime("%Y-%m-%d")  # NSE's 9:15 AM bar -> its IST trading date
        bars.append([d, round(o, 2), round(h, 2), round(lo, 2), round(c, 2)])
    return {"bars": bars, "at": time.time()}


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
        except (sources.SourceError, KeyError, IndexError, TypeError, ValueError):
            row = {"at": time.time() - MAX_AGE + RETRY}
        with _lock:
            _cache[sym] = row
        done += 1
        if done % 25 == 0:
            _save()
    _save()


# ---- pattern rules -------------------------------------------------------------------------
def _parts(b):
    o, h, lo, c = b
    body, rng = abs(c - o), h - lo
    return body, rng, h - max(o, c), min(o, c) - lo  # body, range, upper shadow, lower shadow


def detect(bars):
    """bars: [[date, open, high, low, close], ...] oldest first, the last one is the candle to read.
    Returns (patterns, trend) with patterns as [{name, side, note}]."""
    if len(bars) < 7:
        return [], None
    ohlc = [b[1:5] for b in bars]
    cur, prev, prev2 = ohlc[-1], ohlc[-2], ohlc[-3]
    o, h, lo, c = cur
    body, rng, up, dn = _parts(cur)
    if rng <= 0:
        return [], None
    ranges = [x[1] - x[2] for x in ohlc[-15:-1] if x[1] > x[2]]
    avg = sum(ranges) / len(ranges) if ranges else rng
    ref = ohlc[-6][3]  # close 5 sessions before
    move = (prev[3] - ref) / ref * 100 if ref else 0
    trend = "up" if move >= 2 else "down" if move <= -2 else "flat"
    big = rng >= avg / 3
    out = []

    def add(name, side, note):
        out.append({"name": name, "side": side, "note": note})

    # one candle
    if body <= 0.1 * rng:
        if up >= 0.6 * rng and dn <= 0.1 * rng:
            add("Gravestone Doji", "bear" if trend == "up" else "neutral", "Opened and closed near the low, long upper shadow: buyers were pushed back.")
        elif dn >= 0.6 * rng and up <= 0.1 * rng:
            add("Dragonfly Doji", "bull" if trend == "down" else "neutral", "Opened and closed near the high, long lower shadow: sellers were pushed back.")
        else:
            add("Doji", "neutral", "Open and close almost equal: buyers and sellers in balance, indecision.")
    elif big and body >= 0.9 * rng:
        add("Bullish Marubozu" if c > o else "Bearish Marubozu", "bull" if c > o else "bear",
            "A full-body candle with almost no shadows: " + ("buyers in control all session." if c > o else "sellers in control all session."))
    elif big and body > 0 and dn >= 2 * body and up <= 0.5 * body:
        if trend == "down":
            add("Hammer", "bull", "Long lower shadow after a fall: sellers pushed it down, buyers pushed it back up.")
        elif trend == "up":
            add("Hanging Man", "bear", "Hammer shape after a rise: a warning that selling pressure is showing up.")
    elif big and body > 0 and up >= 2 * body and dn <= 0.5 * body:
        if trend == "up":
            add("Shooting Star", "bear", "Long upper shadow after a rise: buyers pushed it up, sellers pushed it back down.")
        elif trend == "down":
            add("Inverted Hammer", "bull", "Long upper shadow after a fall: buyers are starting to try.")

    # two candles
    po, ph, pl, pc = prev
    pbody = abs(pc - po)
    if big and pbody >= avg * 0.3 and body > pbody:  # yesterday's body must be a real one, not a doji
        if pc < po and c > o and o <= pc and c >= po and trend != "up":
            add("Bullish Engulfing", "bull", "A green body that covers all of yesterday's red body.")
        elif pc > po and c < o and o >= pc and c <= po and trend != "down":
            add("Bearish Engulfing", "bear", "A red body that covers all of yesterday's green body.")
    if pbody >= avg * 0.6 and 0 < body <= 0.5 * pbody and max(o, c) <= max(po, pc) and min(o, c) >= min(po, pc):
        if pc < po and trend != "up":
            add("Bullish Harami", "bull", "A small candle inside yesterday's big red body: the selling is slowing.")
        elif pc > po and trend != "down":
            add("Bearish Harami", "bear", "A small candle inside yesterday's big green body: the buying is slowing.")

    # three candles
    o2, h2, l2, c2 = prev2
    b2 = abs(c2 - o2)
    if b2 >= avg * 0.6 and pbody <= 0.35 * b2 and body >= 0.5 * b2:
        mid2 = (o2 + c2) / 2
        if c2 < o2 and c > o and c >= mid2:
            add("Morning Star", "bull", "Big red, small candle, then a green close above the middle of the red one.")
        elif c2 > o2 and c < o and c <= mid2:
            add("Evening Star", "bear", "Big green, small candle, then a red close below the middle of the green one.")
    return out, trend


_SIZE = {"Morning Star": 3, "Evening Star": 3, "Bullish Engulfing": 2, "Bearish Engulfing": 2, "Bullish Harami": 2, "Bearish Harami": 2}


def read(bars, pats, trend, vol_ratio=None):
    """Plain-language read of a pattern: its direction, the level that confirms it, the level where it
    fails, how far that is, and whether the stock is stretched. Information, never a buy / sell call."""
    sides = {p["side"] for p in pats}
    side = "bull" if "bull" in sides and "bear" not in sides else "bear" if "bear" in sides and "bull" not in sides else "neutral"
    n = max(_SIZE.get(p["name"], 1) for p in pats)
    grp = bars[-n:]
    hi, lo, c = max(b[2] for b in grp), min(b[3] for b in grp), bars[-1][4]
    closes = [b[4] for b in bars[-20:]]
    sma = sum(closes) / len(closes)
    stretch = (c - sma) / sma * 100 if sma else 0
    vol = f" on {vol_ratio:.1f}× normal volume" if vol_ratio and vol_ratio >= 1.5 else (" on below-normal volume" if vol_ratio and vol_ratio < 0.8 else "")
    if side == "bull":
        confirm, fail = round(hi, 2), round(lo, 2)
        risk = (c - fail) / c * 100 if c else None
        kind = ("Reversal after a fall" if trend == "down" else "Continuation of the uptrend" if trend == "up" else "Break from a sideways range")
        warn = []
        if stretch >= 6:
            warn.append(f"already {stretch:.1f}% above its 20-day average (stretched)")
        if risk and risk >= 5:
            warn.append(f"the fail level is {risk:.1f}% away (wide)")
        text = f"Bullish {kind.lower()}{vol}. Confirmation: a close above {confirm:,.2f}. Fails below {fail:,.2f}."
    elif side == "bear":
        confirm, fail = round(lo, 2), round(hi, 2)
        risk = (fail - c) / c * 100 if c else None
        kind = ("Reversal after a rise" if trend == "up" else "Continuation of the downtrend" if trend == "down" else "Break from a sideways range")
        warn = []
        if stretch <= -6:
            warn.append(f"already {abs(stretch):.1f}% below its 20-day average (stretched)")
        if risk and risk >= 5:
            warn.append(f"the fail level is {risk:.1f}% away (wide)")
        text = f"Bearish {kind.lower()}{vol}. Confirmation: a close below {confirm:,.2f}. Fails above {fail:,.2f}."
    else:
        confirm = fail = risk = None
        warn = []
        text = f"Indecision{vol}: a close above {hi:,.2f} would tilt it up, below {lo:,.2f} down."
    if warn:
        text += " Caution: " + "; ".join(warn) + "."
    return {"bias": side, "read": text, "confirm": confirm, "fail": fail, "risk_pct": round(risk, 1) if risk is not None else None,
            "stretch": round(stretch, 1), "pat_hi": round(hi, 2), "pat_lo": round(lo, 2)}


def _stale(row):
    return not row or time.time() - row.get("at", 0) > MAX_AGE


def scan(live):
    """Run the patterns on every F&O stock; today's candle comes from the live feed."""
    global _thread
    stocks = [s for s in (live or {}).get("stocks") or [] if s.get("fo")]
    session = (live or {}).get("session_date")
    rows, waiting = [], 0
    with _lock:
        for s in stocks:
            sym = s["symbol"]
            row = _cache.get(sym)
            if _stale(row) and sym not in _want:
                _want.append(sym)
            if not row or not row.get("bars"):
                waiting += 1
                continue
            bars = [b for b in row["bars"] if not session or b[0] < session]
            if session and all(s.get(k) for k in ("open", "high", "low", "ltp")):
                bars.append([session, s["open"], s["high"], s["low"], s["ltp"]])
            pats, trend = detect(bars)
            if pats:
                rows.append({"symbol": sym, "company": s.get("company"), "sector": s.get("sector"), "sectors": s.get("sectors") or [], "ltp": s.get("ltp"),
                             "pct": s.get("pct_prev"), "trend": trend, "patterns": pats, "date": bars[-1][0],
                             "o": bars[-1][1], "h": bars[-1][2], "l": bars[-1][3], "c": bars[-1][4],
                             **read(bars, pats, trend, s.get("vol_ratio"))})
        if _want and _thread is None:
            _thread = threading.Thread(target=_work, name="candles", daemon=True)
            _thread.start()
    counts = {}
    for r in rows:
        for p in r["patterns"]:
            counts[p["name"]] = counts.get(p["name"], 0) + 1
    return {"session_date": session, "as_of": (live or {}).get("as_of"), "universe": len(stocks), "loading": waiting,
            "rows": rows, "counts": counts}
