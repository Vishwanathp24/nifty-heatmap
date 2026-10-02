"""HTTP access to public market-data endpoints. No login, no API keys.

NSE (nseindia.com)  : indices, index constituents with live quotes, per-minute
                      price series, market status, FII/DII, GIFT Nifty
NSE archives        : daily CM bhavcopy (per-stock daily volume history)
BSE (bseindia.com)  : Sensex (a BSE index — NSE does not publish it)
Yahoo Finance       : overseas indices for the Global Cues panel only

All of these are the exchanges' own public website feeds, not contracted APIs,
so every call is rate-limited, retried once, and failures surface as
SourceError for the caller to degrade gracefully.
"""
import csv
import io
import threading
import time
import zipfile
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote

import requests
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


class SourceError(Exception):
    pass


class _Client:
    def __init__(self, referer, min_gap):
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept": "application/json, text/plain, */*", "Referer": referer})
        self.min_gap, self.lock, self.last = min_gap, threading.Lock(), 0.0

    def get(self, url, timeout=15, raw=False):
        err = None
        for attempt in range(2):
            with self.lock:  # global pacing across threads
                wait = self.min_gap - (time.time() - self.last)
                if wait > 0:
                    time.sleep(wait)
                self.last = time.time()
            try:
                r = self.s.get(url, timeout=timeout)
                if r.status_code == 404:
                    raise SourceError(f"404 {url}")
                r.raise_for_status()
                return r.content if raw else r.json()
            except SourceError:
                raise
            except (requests.RequestException, ValueError) as exc:
                err = exc
                self._fresh_session()  # a failed pooled connection can stay broken; retry on a new one
                time.sleep(0.6 * (attempt + 1))
        raise SourceError(f"{type(err).__name__}: {url}")

    def _fresh_session(self):
        headers = dict(self.s.headers)
        self.s.close()
        self.s = requests.Session()
        self.s.headers.clear()
        self.s.headers.update(headers)


nse = _Client("https://www.nseindia.com/", 0.22)   # ~4.5 req/s ceiling
bse = _Client("https://www.bseindia.com/", 0.5)
bse.s.headers["Origin"] = "https://www.bseindia.com"  # BSE API rejects requests without it
yahoo = _Client("https://finance.yahoo.com/", 0.3)
# Yahoo answers 429 to the full browser signature; a plain UA without Referer is accepted.
yahoo.s.headers = requests.utils.default_headers()
yahoo.s.headers["User-Agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

NSE_API = "https://www.nseindia.com/api/"
NEXT = NSE_API + "NextApi/apiClient/"


def f(v):
    try:
        return float(str(v).replace(",", "")) if v not in (None, "", "-") else None
    except ValueError:
        return None


def all_indices():
    """{indexSymbol: {last, open, high, low, prev, pct, adv, dec, unch}}"""
    out = {}
    for x in nse.get(NSE_API + "allIndices").get("data", []):
        out[x.get("indexSymbol") or x.get("index")] = {
            "name": x.get("index"), "last": f(x.get("last")), "open": f(x.get("open")), "high": f(x.get("high")),
            "low": f(x.get("low")), "prev": f(x.get("previousClose")),
            "adv": int(f(x.get("advances")) or 0), "dec": int(f(x.get("declines")) or 0), "unch": int(f(x.get("unchanged")) or 0),
        }
    if not out:
        raise SourceError("allIndices returned no data")
    return out


def _nse_time(v):
    """NSE feeds mix '2026-09-25 16:00:28' and '25-Sep-2026 16:00:28'; normalise to ISO (IST, naive)."""
    for fmt in ("%Y-%m-%d %H:%M:%S", "%d-%b-%Y %H:%M:%S"):
        try:
            return datetime.strptime(v, fmt).isoformat()
        except (TypeError, ValueError):
            continue
    return None


def constituents(index_symbol):
    """(index_row, {symbol: quote}) for one NSE index, from the market-watch API."""
    d = nse.get(NEXT + "marketWatchApi?functionName=getIndicesData&symbol=" + quote(index_symbol)).get("data") or {}
    rows = d.get("data") or []
    if not rows:
        raise SourceError("no constituents for " + index_symbol)
    index_row, stocks = None, {}
    for r in rows:
        if not r.get("series"):
            index_row = r
            continue
        sym = r.get("symbol")
        stocks[sym] = {
            "symbol": sym, "company": (r.get("companyName") or sym).title(),
            "ltp": f(r.get("lastPrice")), "open": f(r.get("open")), "high": f(r.get("dayHigh")), "low": f(r.get("dayLow")),
            "prev": f(r.get("previousClose")), "volume": f(r.get("totalTradedVolume")), "ffmc": f(r.get("ffmc")),
            "updated": _nse_time(r.get("lastUpdateTime")),
        }
    return index_row, stocks


def minute_series(symbol):
    """Today's (or the last session's) normal-market per-minute prices:
    [(date, minute_of_day, price)]. NSE encodes IST clock time as a UTC epoch."""
    d = nse.get(NEXT + "GetQuoteApi?functionName=getSymbolChartData&symbol=" + quote(symbol + "EQN") + "&days=1D")
    out = []
    for p in d.get("grapthData") or []:
        if len(p) < 3 or p[2] != "NM" or p[1] is None:
            continue
        t = datetime.fromtimestamp(p[0] / 1000, timezone.utc)
        out.append((t.date(), t.hour * 60 + t.minute, float(p[1])))
    return out


def market_status():
    for row in nse.get(NSE_API + "marketStatus").get("marketState", []):
        if row.get("market") == "Capital Market":
            return {"status": row.get("marketStatus"), "message": row.get("marketStatusMessage"), "trade_date": row.get("tradeDate")}
    raise SourceError("no Capital Market status")


def fii_dii():
    out = {}
    for row in nse.get(NSE_API + "fiidiiTradeReact"):
        key = {"FII/FPI": "fii", "DII": "dii"}.get(row.get("category"))
        if key:
            out[key] = {"date": row.get("date"), "buy": f(row.get("buyValue")), "sell": f(row.get("sellValue")), "net": f(row.get("netValue"))}
    if not out:
        raise SourceError("no FII/DII rows")
    return out


def gift_nifty():
    g = (nse.get(NSE_API + "NextApi/apiClient?functionName=getGiftNifty").get("data") or {}).get("giftNifty") or {}
    if not g.get("lastprice"):
        raise SourceError("no GIFT Nifty")
    as_of = None
    try:
        as_of = datetime.strptime(g.get("timestmp", ""), "%d-%b-%Y %H:%M").replace(tzinfo=IST).isoformat()
    except ValueError:
        pass
    return {"label": "GIFT Nifty", "last": f(g["lastprice"]), "change": f(g.get("daychange")), "pct": f(g.get("perchange")),
            "status": "Futures", "as_of": as_of, "note": "NSE IX · exp " + (g.get("expirydate") or "")}


def sensex():
    """BSE's own feed first; BSE's bot protection blocks some networks (403), so
    fall back to Yahoo Finance's daily Sensex candles (same OHLC values)."""
    try:
        return _sensex_bse()
    except SourceError:
        return _sensex_yahoo()


def _sensex_yahoo():
    r = yahoo.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EBSESN?interval=1d&range=5d", timeout=8)["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    rows = [(o, h, l, c) for o, h, l, c in zip(q["open"], q["high"], q["low"], q["close"]) if c is not None]
    if len(rows) < 2:
        raise SourceError("no Sensex from Yahoo")
    (o, h, l, c), prev = rows[-1], rows[-2][3]
    last = r["meta"].get("regularMarketPrice") or c
    t = r["meta"].get("regularMarketTime")
    return {"last": round(last, 2), "open": round(o, 2), "high": round(h, 2), "low": round(l, 2), "prev": round(prev, 2),
            "as_of": datetime.fromtimestamp(t, IST).strftime("%d %b %y | %H:%M") if t else None, "source": "Yahoo Finance"}


def _sensex_bse():
    rows = bse.get("https://api.bseindia.com/RealTimeBseIndiaAPI/api/GetSensexData/w")
    x = rows[0] if isinstance(rows, list) and rows else {}
    last = f(x.get("ltp"))
    if not last:
        raise SourceError("no Sensex")
    return {"last": last, "open": f(x.get("I_open")), "high": f(x.get("High")), "low": f(x.get("Low")),
            "prev": f(x.get("Prev_Close")), "as_of": x.get("dttm")}


def bhavcopy_volumes(day):
    """{symbol: total traded volume} for EQ-series stocks on `day`, from NSE's archive."""
    url = f"https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{day:%Y%m%d}_F_0000.csv.zip"
    content = nse.get(url, timeout=30, raw=True)
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        with z.open(z.namelist()[0]) as fh:
            rows = csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8"))
            return {r["TckrSymb"]: int(float(r["TtlTradgVol"] or 0)) for r in rows if r.get("SctySrs") == "EQ"}


GLOBAL_SYMBOLS = [("Dow Jones", "^DJI"), ("S&P 500", "^GSPC"), ("Nasdaq", "^IXIC"), ("Nikkei 225", "^N225"), ("Hang Seng", "^HSI")]


def global_index(label, symbol):
    meta = yahoo.get("https://query1.finance.yahoo.com/v8/finance/chart/" + quote(symbol), timeout=8)["chart"]["result"][0]["meta"]
    price, prev = meta.get("regularMarketPrice"), meta.get("chartPreviousClose") or meta.get("previousClose")
    if not price:
        raise SourceError("no price for " + symbol)
    period, now, status = meta.get("currentTradingPeriod") or {}, time.time(), "Closed"
    for key, name in (("regular", "Open"), ("pre", "Pre-market"), ("post", "Post-market")):
        p = period.get(key) or {}
        if p.get("start", 0) <= now < p.get("end", 0):
            status = name
            break
    t = meta.get("regularMarketTime")
    return {"label": label, "last": round(price, 2), "change": round(price - prev, 2) if prev else None,
            "pct": round((price - prev) / prev * 100, 2) if prev else None, "status": status,
            "as_of": datetime.fromtimestamp(t, IST).isoformat() if t else None, "note": "Yahoo Finance"}
