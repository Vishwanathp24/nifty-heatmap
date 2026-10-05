"""Scanner tab: Trending Stocks (indicator table on 15-minute and 1-hour candles)
plus Bullish Intraday, Bearish Intraday and BTST condition scans (daily + 1-hour).

Indicators (standard settings, as on TradingView):
  VWAP           session VWAP from today's candles (typical price x volume)
  EMA 5, EMA 9   exponential moving averages of close
  Supertrend     ATR 10, multiplier 3
  RSI 14         Wilder smoothing
  ADX / DI+ / DI-  14, Wilder smoothing

NSE publishes no intraday OHLC history, so candles come from Yahoo Finance
15-minute data (last month); 1-hour candles are built from them on NSE's
09:15-aligned hours (09:15, 10:15, ... 15:15), like chart platforms. The last
candle is the one still forming, so values move during the session.
Pass/fail thresholds are applied in the browser.
"""
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import sources

OPEN, CLOSE = 9 * 60 + 15, 15 * 60 + 30


def _ema(vals, n):
    if len(vals) < n:
        return None
    e = sum(vals[:n]) / n
    k = 2 / (n + 1)
    for v in vals[n:]:
        e = v * k + e * (1 - k)
    return e


def _wilder(vals, n):
    """Wilder's running average (RMA), seeded with the first n-value mean."""
    if len(vals) < n:
        return []
    out = [sum(vals[:n]) / n]
    for v in vals[n:]:
        out.append((out[-1] * (n - 1) + v) / n)
    return out  # aligned to vals[n-1:]


def _rsi(closes, n=14):
    if len(closes) <= n:
        return None
    gains = [max(b - a, 0) for a, b in zip(closes, closes[1:])]
    losses = [max(a - b, 0) for a, b in zip(closes, closes[1:])]
    g, l = _wilder(gains, n)[-1], _wilder(losses, n)[-1]
    return 100.0 if l == 0 else 100 - 100 / (1 + g / l)


def _true_ranges(c):
    return [c[0]["h"] - c[0]["l"]] + [max(b["h"] - b["l"], abs(b["h"] - a["c"]), abs(b["l"] - a["c"])) for a, b in zip(c, c[1:])]


def _adx(c, n=14):
    if len(c) < 2 * n + 1:
        return None, None, None
    tr = _true_ranges(c)[1:]
    pdm, mdm = [], []
    for a, b in zip(c, c[1:]):
        up, down = b["h"] - a["h"], a["l"] - b["l"]
        pdm.append(up if up > down and up > 0 else 0.0)
        mdm.append(down if down > up and down > 0 else 0.0)
    atr, sp, sm = _wilder(tr, n), _wilder(pdm, n), _wilder(mdm, n)
    dip = [100 * p / a if a else 0 for p, a in zip(sp, atr)]
    dim = [100 * m / a if a else 0 for m, a in zip(sm, atr)]
    dx = [100 * abs(p - m) / (p + m) if p + m else 0 for p, m in zip(dip, dim)]
    adx = _wilder(dx, n)
    return (adx[-1] if adx else None), dip[-1], dim[-1]


def _supertrend(c, n=10, mult=3.0):
    if len(c) < n + 1:
        return None, None
    atr = _wilder(_true_ranges(c), n)
    st = direction = None
    fub = flb = None
    for i, a in enumerate(atr):
        k = i + n - 1
        hl2 = (c[k]["h"] + c[k]["l"]) / 2
        ub, lb = hl2 + mult * a, hl2 - mult * a
        prev_close = c[k - 1]["c"] if k else c[k]["c"]
        fub = ub if fub is None or ub < fub or prev_close > fub else fub
        flb = lb if flb is None or lb > flb or prev_close < flb else flb
        if direction is None:
            direction = 1 if c[k]["c"] > fub else -1
        elif direction == -1 and c[k]["c"] > fub:
            direction = 1
        elif direction == 1 and c[k]["c"] < flb:
            direction = -1
        st = flb if direction == 1 else fub
    return st, direction


def _vwap(c):
    day = c[-1]["d"]
    pv = vol = 0.0
    for b in c:
        if b["d"] == day and b["v"]:
            pv += (b["h"] + b["l"] + b["c"]) / 3 * b["v"]
            vol += b["v"]
    return pv / vol if vol else None


def indicators(c):
    if len(c) < 30:
        return None
    closes = [b["c"] for b in c]
    st, sd = _supertrend(c)
    adx, dip, dim = _adx(c)
    r = lambda v, d=2: round(v, d) if v is not None else None
    return {"close": r(closes[-1]), "vwap": r(_vwap(c)), "ema5": r(_ema(closes, 5)), "ema9": r(_ema(closes, 9)),
            "st": r(st), "st_dir": sd, "rsi": r(_rsi(closes), 1), "adx": r(adx, 1), "dip": r(dip, 1), "dim": r(dim, 1),
            "candle": c[-1]["t"], "bars": len(c)}


def yahoo_15m(symbol):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/" + quote(symbol + ".NS", safe="")
           + "?interval=15m&range=1mo")
    r = sources.yahoo.get(url, timeout=12)["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    out = []
    for t, o, h, l, c, v in zip(r.get("timestamp") or [], q["open"], q["high"], q["low"], q["close"], q["volume"]):
        if None in (o, h, l, c):
            continue
        ist = datetime.fromtimestamp(t, timezone.utc) + timedelta(hours=5, minutes=30)
        m = ist.hour * 60 + ist.minute
        if OPEN <= m < CLOSE:
            out.append({"d": ist.date().isoformat(), "m": m, "t": f"{m // 60:02d}:{m % 60:02d}",
                        "o": o, "h": h, "l": l, "c": c, "v": v or 0})
    return out


def yahoo_daily(symbol):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/" + quote(symbol + ".NS", safe="")
           + "?interval=1d&range=2y")
    r = sources.yahoo.get(url, timeout=12)["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    out = []
    for t, o, h, l, c, v in zip(r.get("timestamp") or [], q["open"], q["high"], q["low"], q["close"], q["volume"]):
        if None in (o, h, l, c):
            continue
        d = (datetime.fromtimestamp(t, timezone.utc) + timedelta(hours=5, minutes=30)).date().isoformat()
        out.append({"d": d, "o": o, "h": h, "l": l, "c": c, "v": v or 0})
    return out


def with_today(daily, c15, nse_quote=None):
    """Daily history (fetched once a day) + today's candle: NSE's official open / high /
    low / last price / volume when available (as Chartink uses), else rebuilt from the
    15-min data."""
    if not c15:
        return daily
    day = c15[-1]["d"]
    bars = [b for b in c15 if b["d"] == day]
    today = {"d": day, "o": bars[0]["o"], "h": max(b["h"] for b in bars), "l": min(b["l"] for b in bars),
             "c": bars[-1]["c"], "v": sum(b["v"] for b in bars)}
    q = nse_quote or {}
    if q.get("ltp") and q.get("open") and q.get("high") and q.get("low"):
        today.update(o=q["open"], h=q["high"], l=q["low"], c=q["ltp"], v=q.get("volume") or today["v"])
    return [b for b in daily if b["d"] < day] + [today]


def _sma(vals, n):
    return sum(vals[-n:]) / n if len(vals) >= n else None


def daily_metrics(d):
    """Values for the Chartink-style daily conditions (latest bar = today)."""
    if len(d) < 25:
        return None
    c = [b["c"] for b in d]
    r = lambda v, k=2: round(v, k) if v is not None else None
    prev5 = d[-6:-1]
    return {"date": d[-1]["d"], "close": r(c[-1]), "open": r(d[-1]["o"]), "prev_open": r(d[-2]["o"]),
            "prev_close": r(c[-2]), "sma20": r(_sma(c, 20)), "rsi": r(_rsi(c), 1),
            "hi5": r(max(b["h"] for b in prev5)), "lo5": r(min(b["l"] for b in prev5)),
            "vol": d[-1]["v"], "vol_sma5": r(_sma([b["v"] for b in d], 5), 0),
            "high250": r(max(b["h"] for b in d[-250:])), "days": len(d)}


def hourly_metrics(h):
    if len(h) < 25:
        return None
    c = [b["c"] for b in h]
    r = lambda v, k=2: round(v, k) if v is not None else None
    prev5 = h[-6:-1]
    return {"close": r(c[-1]), "sma20": r(_sma(c, 20)), "rsi": r(_rsi(c), 1),
            "hi5": r(max(b["h"] for b in prev5)), "lo5": r(min(b["l"] for b in prev5)), "candle": h[-1]["t"]}


def to_hourly_clock(c15):
    """1-hour candles on clock hours (09:15-10:00, 10:00-11:00, ... 15:00-15:30), as
    Chartink builds them; used by the Bullish / Bearish Intraday scans."""
    out = []
    for b in c15:
        slot = max(b["m"] // 60 * 60, OPEN)
        if out and out[-1]["d"] == b["d"] and out[-1]["m"] == slot:
            h = out[-1]
            h["h"], h["l"], h["c"], h["v"] = max(h["h"], b["h"]), min(h["l"], b["l"]), b["c"], h["v"] + b["v"]
        else:
            out.append({**b, "m": slot, "t": f"{slot // 60:02d}:{slot % 60:02d}"})
    return out


def to_hourly(c15):
    out = []
    for b in c15:
        slot = OPEN + (b["m"] - OPEN) // 60 * 60
        if out and out[-1]["d"] == b["d"] and out[-1]["m"] == slot:
            h = out[-1]
            h["h"], h["l"], h["c"], h["v"] = max(h["h"], b["h"]), min(h["l"], b["l"]), b["c"], h["v"] + b["v"]
        else:
            out.append({**b, "m": slot, "t": f"{slot // 60:02d}:{slot % 60:02d}"})
    return out


def scan_flags(t15, t60, d, h):
    """Which scans a stock passes, with the app's default thresholds (Trending:
    RSI 60, ADX 25, both 15-min and 1-hour; the other three are fixed rules)."""
    def trend_ok(t, bull):
        if not t or t.get("vwap") is None:
            return False
        c = t["close"]
        above = (lambda v: v is not None and (c > v if bull else c < v))
        return (above(t["vwap"]) and above(t["ema5"]) and above(t["ema9"]) and t["st_dir"] == (1 if bull else -1)
                and t["rsi"] is not None and (t["rsi"] > 60 if bull else t["rsi"] < 40)
                and t["adx"] is not None and t["adx"] > 25 and (t["dip"] > t["dim"] if bull else t["dim"] > t["dip"]))
    f = {"trend_bull": trend_ok(t15, True) and trend_ok(t60, True),
         "trend_bear": trend_ok(t15, False) and trend_ok(t60, False), "bull": False, "bear": False, "btst": False}
    if d and h and None not in (d["sma20"], d["rsi"], h["sma20"], h["rsi"]):
        f["bull"] = (d["close"] > d["sma20"] and d["close"] > d["hi5"] and h["close"] > h["sma20"]
                     and h["close"] > h["hi5"] and d["rsi"] > 60 and h["rsi"] > 60)
        f["bear"] = (d["close"] < d["sma20"] and d["close"] < d["lo5"] and h["close"] < h["sma20"]
                     and h["close"] < h["lo5"] and d["rsi"] < 40 and h["rsi"] < 40)
    if d and d["vol_sma5"] and d["rsi"] is not None:
        f["btst"] = (d["vol"] > 3 * d["vol_sma5"] and d["rsi"] > 65 and d["open"] > d["prev_open"]
                     and d["close"] > d["prev_close"] and d["close"] >= 0.85 * d["high250"])
    return f


def radar_times(c15, daily, now_min):
    """Replay today's 15-minute candles: for each scan, the time the stock's current
    run of meeting every condition began ("on radar since"), as the close time of the
    first qualifying candle (capped at now for the candle still forming)."""
    if not c15:
        return {}
    day = c15[-1]["d"]
    first = next(i for i, b in enumerate(c15) if b["d"] == day)
    hist = [b for b in daily if b["d"] < day]
    since, steps = {}, []
    pack = lambda t: [t[k] for k in STEP_KEYS] if t else None
    for i in range(first, len(c15)):
        part = c15[:i + 1]
        h1 = to_hourly(part)
        t15, t60 = indicators(part), indicators(h1)
        flags = scan_flags(t15, t60, daily_metrics(with_today(hist, part)), hourly_metrics(to_hourly_clock(part)))
        end = min(c15[i]["m"] + 15, now_min, CLOSE)
        hhmm = f"{end // 60:02d}:{end % 60:02d}"
        steps.append([hhmm, pack(t15), pack(t60)])
        for k, ok in flags.items():
            if ok:
                since.setdefault(k, hhmm)
            else:
                since.pop(k, None)
    since["steps"] = steps  # per-candle indicator values, so the page can time any settings
    return since


STEP_KEYS = ("close", "vwap", "ema5", "ema9", "st_dir", "rsi", "adx", "dip", "dim")


def fill_tail(c15, day_bars, session):
    """Yahoo sometimes lacks the last 15-min candle(s) of the session (e.g. 15:15-15:30).
    Rebuild any missing candles after Yahoo's last one from NSE's per-minute bars
    ({minute: [o, h, l, c, ...]}) that the engine keeps for the current session."""
    if not day_bars or not session:
        return c15
    today = [b for b in c15 if b["d"] == session]
    if not today and c15 and c15[-1]["d"] > session:
        return c15
    last = today[-1]["m"] if today else OPEN - 15
    out = list(c15)
    for slot in range(last + 15, CLOSE, 15):
        ms = [day_bars[m] for m in range(slot, slot + 15) if m in day_bars]
        if ms:
            out.append({"d": session, "m": slot, "t": f"{slot // 60:02d}:{slot % 60:02d}", "o": ms[0][0],
                        "h": max(b[1] for b in ms), "l": min(b[2] for b in ms), "c": ms[-1][3], "v": 0})
    return out


def yahoo_1m_today(symbol):
    """Latest session's 1-minute OHLCV from Yahoo: (date, {minute: (o, h, l, c, v)})."""
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/" + quote(symbol + ".NS", safe="")
           + "?interval=1m&range=1d")
    r = sources.yahoo.get(url, timeout=12)["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    out, day = {}, None
    for t, o, h, l, c, v in zip(r.get("timestamp") or [], q["open"], q["high"], q["low"], q["close"], q["volume"]):
        if None in (o, h, l, c):
            continue
        ist = datetime.fromtimestamp(t, timezone.utc) + timedelta(hours=5, minutes=30)
        m = ist.hour * 60 + ist.minute
        if OPEN <= m < CLOSE:
            day = ist.date().isoformat()
            out[m] = (o, h, l, c, v or 0)
    return day, out


def today_from_minutes(session, y1m, nse_bars, ltp=None):
    """Today's 15-min candles built minute by minute: Yahoo 1-min OHLCV where present
    (true intra-minute high/low), NSE's per-minute bars for minutes Yahoo lacks (it
    often drops the last 15 minutes), and the final close set to NSE's price (the
    official close after 15:30), as Chartink and charts show it."""
    mins = dict(y1m)
    for m, b in (nse_bars or {}).items():
        if m not in mins and OPEN <= m < CLOSE:
            mins[m] = (b[0], b[1], b[2], b[3], 0)
    out = []
    for m in sorted(mins):
        o, h, l, c, v = mins[m]
        slot = OPEN + (m - OPEN) // 15 * 15
        if out and out[-1]["m"] == slot:
            b = out[-1]
            b["h"], b["l"], b["c"], b["v"] = max(b["h"], h), min(b["l"], l), c, b["v"] + v
        else:
            out.append({"d": session, "m": slot, "t": f"{slot // 60:02d}:{slot % 60:02d}", "o": o, "h": h, "l": l, "c": c, "v": v})
    if out and ltp:
        b = out[-1]
        b["c"], b["h"], b["l"] = ltp, max(b["h"], ltp), min(b["l"], ltp)
    return out


class TrendScan:
    def __init__(self, engine):
        self.engine = engine
        self.lock = threading.Lock()
        self.rows = {}  # sym -> {"15": {...}, "60": {...}, "daily": {...}, "hourly": {...}, "at": epoch}
        self.daily = {}  # sym -> (fetched_on_date, [daily bars]) — history refreshed once a day
        self.cycle = {"state": "starting", "done": 0, "total": 0, "started": None, "finished": None}
        self.thread = None

    def ensure_started(self):
        if self.thread is None or not self.thread.is_alive():
            self.thread = threading.Thread(target=self._loop, name="trend-scan", daemon=True)
            self.thread.start()

    def _market_hours(self):
        now = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
        m = now.hour * 60 + now.minute
        return now.weekday() < 5 and OPEN <= m <= CLOSE + 5

    def _loop(self):
        while True:
            uni = self.engine.uni
            if not uni:
                time.sleep(5)
                continue
            if self.engine.backfill.get("state") != "idle" or not self.engine.backfill.get("at") or not self.engine.quotes:
                time.sleep(5)  # wait for NSE's per-minute bars + quotes (used to complete today's candles)
                continue
            syms = sorted(uni["scan"])
            self.cycle = {"state": "running", "done": 0, "total": len(syms),
                          "started": datetime.now(timezone.utc).isoformat(), "finished": self.cycle.get("finished")}
            for s in syms:
                try:
                    with self.engine.lock:
                        day_bars, session = dict(self.engine.bars.get(s) or {}), self.engine.session
                        ltp = ((self.engine.quotes or {}).get(s) or {}).get("ltp")
                    c15 = yahoo_15m(s)
                    y_day, y1m = yahoo_1m_today(s)
                    if session and y_day in (session, None) and (y1m or day_bars):
                        # history from 15-min candles, today rebuilt from 1-minute data
                        c15 = [b for b in c15 if b["d"] < session] + today_from_minutes(session, y1m, day_bars, ltp)
                    else:
                        c15 = fill_tail(c15, day_bars, session)
                    h1 = to_hourly(c15)
                    today = datetime.now(timezone.utc).date().isoformat()
                    if self.daily.get(s, (None,))[0] != today:
                        self.daily[s] = (today, yahoo_daily(s))
                    q = (self.engine.quotes or {}).get(s)
                    nse_q = q if q and self.engine.session == (c15[-1]["d"] if c15 else None) else None
                    d1 = with_today(self.daily[s][1], c15, nse_q)
                    row = {"15": indicators(c15), "60": indicators(h1), "daily": daily_metrics(d1),
                           "hourly": hourly_metrics(to_hourly_clock(c15)), "at": time.time()}
                    now = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
                    row["since"] = radar_times(c15, self.daily[s][1], now.hour * 60 + now.minute
                                               if now.date().isoformat() == (c15[-1]["d"] if c15 else "") else CLOSE)
                    with self.lock:
                        self.rows[s] = row
                except Exception:
                    traceback.print_exc(limit=1)
                self.cycle["done"] += 1
            self.cycle["state"] = "idle"
            self.cycle["finished"] = datetime.now(timezone.utc).isoformat()
            # Continuous refresh in market hours (one pass takes a couple of minutes); else every 30 min.
            time.sleep(15 if self._market_hours() else 1800)

    def snapshot(self):
        self.ensure_started()
        eng = self.engine
        out = []
        with eng.lock:
            stocks = dict(eng.uni["stocks"]) if eng.uni else {}
            quotes = dict(eng.quotes or {})
        with self.lock:
            rows = dict(self.rows)
        for s, row in rows.items():
            meta = stocks.get(s)
            if not meta:
                continue
            q = quotes.get(s) or {}
            prev = q.get("prev")
            ltp = q.get("ltp")
            out.append({"symbol": s, "company": meta.get("company"), "sector": meta.get("sector"),
                        "sectors": meta.get("sectors", []), "fo": meta.get("fo"),
                        "ltp": ltp, "pct_prev": round((ltp - prev) / prev * 100, 2) if ltp and prev else None,
                        "tf15": row["15"], "tf60": row["60"], "daily": row.get("daily"), "hourly": row.get("hourly"),
                        "since": {k: v for k, v in row.get("since", {}).items() if k != "steps"},
                        "steps": row.get("since", {}).get("steps", [])})
        return {"rows": out, "cycle": self.cycle, "fetched_at": datetime.now(timezone.utc).isoformat()}
