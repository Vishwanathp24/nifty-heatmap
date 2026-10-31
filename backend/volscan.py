"""Intraday Scanner > Volume Spike: Daily Volume > Daily SMA(volume, 20) x 3 (Chartink style:
the 20-day average includes today's candle), for F&O, Nifty 50, Nifty 500, Midcap 150 or Smallcap 250.

Today's volume and price come from NSE's index lists (one call per list returns every member);
the 19 earlier daily volumes come from Yahoo daily candles, fetched once a day per stock in the
background and kept next to the DB so a restart doesn't refetch them.
"""
import json
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import sources
from config import FO_INDEX
from store import DB_PATH

LISTS = {"fo": FO_INDEX, "n50": "NIFTY 50", "n500": "NIFTY 500", "mid": "NIFTY MIDCAP 150", "small": "NIFTY SMLCAP 250"}
FILE = DB_PATH.parent / "vol_history.json"
DAYS = 20
QUOTES_EVERY = 120  # seconds, in market hours


def _ist():
    return datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)


def _daily_volumes(symbol):
    """[(date, volume)] for the last ~2 months of daily candles (holiday rows skipped)."""
    url = "https://query1.finance.yahoo.com/v8/finance/chart/" + quote(symbol + ".NS", safe="") + "?interval=1d&range=3mo"
    r = sources.yahoo.get(url, timeout=12)["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    out = []
    for t, o, h, l, c, v in zip(r.get("timestamp") or [], q["open"], q["high"], q["low"], q["close"], q["volume"]):
        if None in (o, h, l, c) or (not v and o == h == l == c):
            continue
        out.append(((datetime.fromtimestamp(t, timezone.utc) + timedelta(hours=5, minutes=30)).date().isoformat(), v or 0))
    return out


class VolumeScan:
    def __init__(self):
        self.lock = threading.Lock()
        self.members = {}   # list key -> set of symbols
        self.quotes = {}    # symbol -> NSE quote (today's / last session's volume and price)
        self.lists_on = None
        self.quotes_at = 0.0
        try:
            self.hist = json.loads(FILE.read_text())  # symbol -> {"on": fetch date, "v": [[date, vol], ...]}
        except (OSError, ValueError):
            self.hist = {}
        self.progress = {"done": 0, "total": 0}
        self.thread = None

    def ensure_started(self):
        if self.thread is None or not self.thread.is_alive():
            self.thread = threading.Thread(target=self._loop, name="vol-scan", daemon=True)
            self.thread.start()

    def _refresh_quotes(self):
        members, quotes = {}, {}
        for key, name in LISTS.items():
            try:
                _, rows = sources.constituents(name)
            except sources.SourceError:
                rows = {}
            members[key] = set(rows)
            quotes.update(rows)
        with self.lock:
            if quotes:
                self.members, self.quotes, self.quotes_at = members, quotes, time.time()
                self.lists_on = _ist().date()

    def _loop(self):
        while True:
            try:
                now = _ist()
                live = now.weekday() < 5 and 9 * 60 + 15 <= now.hour * 60 + now.minute <= 15 * 60 + 35
                if not self.quotes or self.lists_on != now.date() or (live and time.time() - self.quotes_at > QUOTES_EVERY):
                    self._refresh_quotes()
                today = now.date().isoformat()
                todo = [s for s in self.quotes if (self.hist.get(s) or {}).get("on") != today]
                self.progress = {"done": len(self.quotes) - len(todo), "total": len(self.quotes)}
                for i, s in enumerate(todo):
                    try:
                        v = _daily_volumes(s)
                        with self.lock:
                            self.hist[s] = {"on": today, "v": v[-(DAYS + 5):]}
                    except Exception:
                        pass
                    self.progress["done"] += 1
                    if i % 50 == 49:
                        self._save()
                    if live and time.time() - self.quotes_at > QUOTES_EVERY:
                        self._refresh_quotes()
                if todo:
                    self._save()
            except Exception:
                traceback.print_exc(limit=1)
            time.sleep(20)

    def _save(self):
        try:
            with self.lock:
                FILE.write_text(json.dumps(self.hist))
        except OSError:
            pass

    def snapshot(self):
        self.ensure_started()
        with self.lock:
            quotes, members, hist = dict(self.quotes), {k: set(v) for k, v in self.members.items()}, dict(self.hist)
        rows = []
        for s, q in quotes.items():
            vol = q.get("volume")
            day = (q.get("updated") or "")[:10]
            past = [v for d, v in (hist.get(s) or {}).get("v", []) if d < day][-(DAYS - 1):]
            if not vol or len(past) < DAYS - 1:
                continue
            sma = (sum(past) + vol) / DAYS  # SMA(volume, 20) including today's candle, as on Chartink
            ltp, prev = q.get("ltp"), q.get("prev")
            rows.append({"symbol": s, "company": q.get("company"), "ltp": ltp,
                         "pct_prev": round((ltp - prev) / prev * 100, 2) if ltp and prev else None,
                         "vol": vol, "sma20": round(sma), "ratio": round(vol / sma, 2) if sma else None,
                         "lists": [k for k, m in members.items() if s in m]})
        return {"rows": rows, "progress": self.progress, "quotes_at": self.quotes_at and datetime.fromtimestamp(self.quotes_at, timezone.utc).isoformat(),
                "session": max(((q.get("updated") or "")[:10] for q in quotes.values()), default=None)}
