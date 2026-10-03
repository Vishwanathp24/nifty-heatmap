"""IPO tab: upcoming / open issues and recently listed IPOs, from NSE's public
IPO feeds (mainboard + NSE SME; BSE-only SME issues are not covered).

  all-upcoming-issues?category=ipo  -> open + forthcoming issues
  ipo-current-issue                 -> live subscription ("times") for open issues
  public-past-issues                -> listing date + final issue price
  getSymbolData (per symbol)        -> current price of recent listings

Recent-listing prices are refreshed by a background thread (one quote call per
stock) so the endpoint itself stays fast.
"""
import csv
import io
import json
import threading
import time
import zipfile
from datetime import date, datetime, timedelta

from zoneinfo import ZoneInfo

import sources
from store import DB_PATH

IST = ZoneInfo("Asia/Kolkata")
RECENT_DAYS = 120
UPCOMING_TTL, PAST_TTL, PRICE_TTL = 300, 1800, 300
_SERIES = {"SME": ("ST", "SM"), "EQ": ("EQ", "BE"), "BE": ("BE", "EQ")}
# Listing-day open/close per symbol, from NSE bhavcopies; cached on disk because
# past days never change (one ~200 KB download per listing date otherwise).
LISTING_CACHE = DB_PATH.parent / "ipo_listing_prices.json"


def _d(v):
    for fmt in ("%d-%b-%Y", "%d-%B-%Y"):
        try:
            return datetime.strptime((v or "").strip().title(), fmt).date()
        except ValueError:
            continue
    return None


def _num(v):
    try:
        return float(str(v).replace(",", "").replace("Rs.", "").strip())
    except (TypeError, ValueError):
        return None


class IpoData:
    def __init__(self):
        self.lock = threading.Lock()
        self.upcoming, self.past = (None, 0.0), (None, 0.0)
        self.prices = {}      # symbol -> {"ltp", "pct_day", "at"}
        self.thread = None
        try:
            self.listing = json.loads(LISTING_CACHE.read_text())  # "YYYY-MM-DD" -> {symbol: [open, close]}
        except (OSError, ValueError):
            self.listing = {}

    # ---- feeds ----------------------------------------------------------------------

    def _get_upcoming(self):
        rows, at = self.upcoming
        if rows is not None and time.time() - at < UPCOMING_TTL:
            return rows
        issues = sources.nse.get(sources.NSE_API + "all-upcoming-issues?category=ipo")
        try:
            subs = {x.get("symbol"): _num(x.get("noOfTime")) for x in sources.nse.get(sources.NSE_API + "ipo-current-issue")
                    if (x.get("category") or "Total") == "Total"}
        except sources.SourceError:
            subs = {}
        out = []
        for x in issues:
            series = (x.get("series") or "").upper()
            if series == "DEBT":
                continue
            start, end = _d(x.get("issueStartDate")), _d(x.get("issueEndDate"))
            out.append({
                "symbol": x.get("symbol"), "company": x.get("companyName"),
                "board": "NSE SME" if series == "SME" else "Mainboard",
                "status": "Open" if (x.get("status") or "").lower() == "active" else "Upcoming",
                "open": start.isoformat() if start else None, "close": end.isoformat() if end else None,
                "price_band": (x.get("priceBand") or x.get("issuePrice") or "").replace("Rs.", "₹").strip() or None,
                "lot_size": int(_num(x.get("lotSize"))) if _num(x.get("lotSize")) else None,
                "issue_shares": int(_num(x.get("issueSize"))) if _num(x.get("issueSize")) else None,
                "subscription": round(subs[x.get("symbol")], 2) if subs.get(x.get("symbol")) is not None else None,
            })
        out.sort(key=lambda r: (r["status"] != "Open", r["open"] or "9999", r["company"] or ""))
        self.upcoming = (out, time.time())
        return out

    def _get_past(self):
        rows, at = self.past
        if rows is not None and time.time() - at < PAST_TTL:
            return rows
        cutoff = date.today() - timedelta(days=RECENT_DAYS)
        out = []
        for x in sources.nse.get(sources.NSE_API + "public-past-issues", timeout=30):
            kind = (x.get("securityType") or "").upper()
            listed = _d(x.get("listingDate"))
            if kind not in _SERIES or not listed or listed < cutoff:
                continue
            out.append({
                "symbol": x.get("symbol"), "company": x.get("company"),
                "board": "NSE SME" if kind == "SME" else "Mainboard", "kind": kind,
                "listing_date": listed.isoformat(), "issue_price": _num(x.get("issuePrice")),
                "price_band": (x.get("priceRange") or "").replace("Rs.", "₹").strip() or None,
            })
        out.sort(key=lambda r: (r["listing_date"], r["company"] or ""), reverse=True)
        self.past = (out, time.time())
        return out

    # ---- background price refresh for recent listings ----------------------------------

    def _quote(self, symbol, kind):
        for series in _SERIES[kind]:
            url = (sources.NEXT + "GetQuoteApi?functionName=getSymbolData&marketType=N&series=" + series
                   + "&symbol=" + symbol)
            d = sources.nse.get(url)
            m = (d.get("equityResponse") or [{}])[0]
            md = m.get("metaData") or {}
            # closePrice is NSE's official close (0 while the market is open);
            # during the session use the last traded price.
            ltp = _num(md.get("closePrice")) or _num((m.get("orderBook") or {}).get("lastPrice"))
            if md.get("symbol") and ltp:
                return {"ltp": ltp, "pct_day": _num(md.get("pChange")), "at": time.time()}
        return None

    def _listing_prices(self, day):
        """{symbol: [open, close]} on `day` for equity / SME series, from NSE's bhavcopy."""
        url = f"https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{day.replace('-', '')}_F_0000.csv.zip"
        content = sources.nse.get(url, timeout=30, raw=True)
        out = {}
        with zipfile.ZipFile(io.BytesIO(content)) as z, z.open(z.namelist()[0]) as fh:
            for r in csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8")):
                if r.get("SctySrs") in ("EQ", "BE", "SM", "ST"):
                    out[r["TckrSymb"]] = [_num(r.get("OpnPric")), _num(r.get("ClsPric"))]
        return out

    def _fill_listing_prices(self):
        changed = False
        for day in sorted({r["listing_date"] for r in self._get_past()}):
            if day in self.listing or day >= date.today().isoformat():
                continue  # cached, or today's bhavcopy isn't published until evening
            try:
                prices = self._listing_prices(day)
            except sources.SourceError:
                continue
            wanted = {r["symbol"] for r in self._get_past() if r["listing_date"] == day}
            with self.lock:
                self.listing[day] = {s: prices[s] for s in wanted if s in prices}
            changed = True
        if changed:
            try:
                LISTING_CACHE.parent.mkdir(parents=True, exist_ok=True)
                LISTING_CACHE.write_text(json.dumps(self.listing))
            except OSError:
                pass

    def _price_loop(self):
        while True:
            try:
                self._fill_listing_prices()
            except Exception:
                pass
            try:
                for r in list(self._get_past()):
                    p = self.prices.get(r["symbol"])
                    if p and time.time() - p["at"] < PRICE_TTL:
                        continue
                    try:
                        q = self._quote(r["symbol"], r["kind"])
                    except sources.SourceError:
                        q = None
                    if q:
                        with self.lock:
                            self.prices[r["symbol"]] = q
            except Exception:
                pass
            time.sleep(30)

    def ensure_started(self):
        if self.thread is None or not self.thread.is_alive():
            self.thread = threading.Thread(target=self._price_loop, name="ipo-prices", daemon=True)
            self.thread.start()

    # ---- endpoint payload -------------------------------------------------------------------

    def snapshot(self):
        self.ensure_started()
        upcoming = self._get_upcoming()
        recent = []
        with self.lock:
            for r in self._get_past():
                p = self.prices.get(r["symbol"]) or {}
                ltp, ip = p.get("ltp"), r["issue_price"]
                lp = (self.listing.get(r["listing_date"]) or {}).get(r["symbol"]) or [None, None]
                listing_price = lp[0]  # None until that day's bhavcopy is fetched
                recent.append({k: v for k, v in r.items() if k != "kind"} | {
                    "ltp": ltp, "pct_day": p.get("pct_day"),
                    "listing_price": listing_price, "listing_close": lp[1],
                    "listing_gain": round((listing_price - ip) / ip * 100, 2) if listing_price and ip else None,
                    "pct_since_listing": round((ltp - listing_price) / listing_price * 100, 2) if ltp and listing_price else None,
                    "pct_vs_issue": round((ltp - ip) / ip * 100, 2) if ltp and ip else None,
                })
            priced = sum(1 for r in recent if r["ltp"] is not None)
        return {"upcoming": upcoming, "recent": recent, "recent_days": RECENT_DAYS,
                "prices_loaded": priced, "fetched_at": datetime.now(IST).isoformat()}
