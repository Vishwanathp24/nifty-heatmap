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
# NSE drops an issue from "upcoming" when bidding ends and adds it to "past" only once it lists, so
# for ~3 days it is in neither. Remember every issue seen as upcoming and keep it as "Closed" until it lists.
SEEN_CACHE = DB_PATH.parent / "ipo_seen_upcoming.json"
CLOSED_KEEP_DAYS = 10
# shortcut: Jio Platforms closed before SEEN_CACHE existed (added by hand, NSE symbol JPL); drops out once it lists
_SEED = {"JIO PLATFORMS": {"symbol": "JPL", "company": "Jio Platforms Limited", "board": "Mainboard", "status": "Upcoming",
                           "open": "2026-10-21", "close": "2026-10-23", "price_band": "₹1065 to ₹1119", "lot_size": 12,
                           "issue_shares": None, "subscription": None}}


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
        out += self._closed_not_listed(out)
        out.sort(key=lambda r: ({"Open": 0, "Upcoming": 1}.get(r["status"], 2), r["open"] or "9999", r["company"] or ""))
        self.upcoming = (out, time.time())
        return out

    def _closed_not_listed(self, current):
        """Issues seen earlier as upcoming whose bidding has ended but which have not listed yet."""
        try:
            seen = json.loads(SEEN_CACHE.read_text())
        except (OSError, ValueError):
            seen = dict(_SEED)
        for k, v in _SEED.items():  # fill the symbol into an entry saved before it was known
            if k in seen and not seen[k].get("symbol"):
                seen[k]["symbol"] = v["symbol"]
        key = lambda r: r.get("symbol") or (r.get("company") or "").upper().replace(" LIMITED", "").strip()
        for r in current:
            seen[key(r)] = r
        try:
            past = self._get_past()
        except sources.SourceError:
            past = []
        listed = {r["symbol"] for r in past} | {(r["company"] or "").upper().replace(" LIMITED", "").strip() for r in past}
        today, oldest = date.today().isoformat(), (date.today() - timedelta(days=CLOSED_KEEP_DAYS)).isoformat()
        cur = {key(r) for r in current}
        out = []
        for k, r in list(seen.items()):
            if k in cur:
                continue
            if k in listed or (r.get("company") or "").upper().replace(" LIMITED", "").strip() in listed or not r.get("close") or r["close"] < oldest:
                seen.pop(k)
            elif r["close"] < today:
                out.append({**r, "status": "Closed", "subscription": r.get("subscription")})
        try:
            SEEN_CACHE.parent.mkdir(parents=True, exist_ok=True)
            SEEN_CACHE.write_text(json.dumps(seen))
        except OSError:
            pass
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


# ---- IPO detail (Upcoming IPOs -> click a company) -----------------------------------------
# From NSE's ipo-detail feed: issue facts, live subscription by category and document links,
# plus a fact-based checklist (👍 / 👎 per factor). No overall invest / don't-invest verdict.
import re

_DETAIL = {}
_DETAIL_LOCK = threading.Lock()
DETAIL_TTL = 120


def _clean(v):
    v = re.sub(r"<[^>]+>", " ", str(v or "")).strip().strip('"').strip()
    return re.sub(r"\s+", " ", v)


def _shares(text, label):
    m = re.search(label + r"[^0-9]{0,40}([\d,]{4,})\s*Equity Shares", text, re.I)
    return int(m.group(1).replace(",", "")) if m else 0


def _part(text, kind, price):
    """Value in ₹ crore of the fresh-issue or offer-for-sale part (given as ₹ amount or a share count)."""
    other = "offer for sale" if kind == "fresh issue" else "fresh issue"
    m = re.search(kind + r"(.*?)(?:" + other + r"|\(|$)", text, re.I)
    if not m:
        return None
    seg = m.group(1)
    amt = re.search(r"Rs\.?\s*([\d,]+(?:\.\d+)?)\s*(million|crore|cr|lakh)", seg, re.I)
    if amt:
        v = float(amt.group(1).replace(",", ""))
        return round(v / 10 if amt.group(2).lower() == "million" else v / 100 if amt.group(2).lower() == "lakh" else v, 1)
    sh = re.search(r"([\d,]{4,})\s*Equity Shares", seg, re.I)
    if sh and price:
        return round(int(sh.group(1).replace(",", "")) * price / 1e7, 1)
    return 0.0 if seg is not None else None


def _check(key, label, verdict, detail):
    return {"key": key, "label": label, "verdict": verdict, "detail": detail}


def ipo_detail(symbol, series="EQ"):
    symbol, series = symbol.upper().strip(), (series or "EQ").upper().strip()
    if not re.fullmatch(r"[A-Z0-9&-]{1,20}", symbol) or not re.fullmatch(r"[A-Z]{1,5}", series):
        raise ValueError("invalid symbol / series")
    key = symbol + ":" + series
    with _DETAIL_LOCK:
        hit = _DETAIL.get(key)
    if hit and time.time() - hit[0] < DETAIL_TTL:
        return hit[1]
    try:
        d = sources.nse.get(sources.NSE_API + f"ipo-detail?symbol={symbol}&series={series}", timeout=25)
    except sources.SourceError:
        snap = _saved_detail(key)
        if snap:
            return snap
        raise
    info = {(x.get("title") or "").strip(): _clean(x.get("value")) for x in (d.get("issueInfo") or {}).get("dataList", []) if x.get("title")}
    raw = {(x.get("title") or "").strip(): str(x.get("value") or "") for x in (d.get("issueInfo") or {}).get("dataList", []) if x.get("title")}
    link = lambda t: (re.search(r"https?://\S+?\.(?:zip|pdf)", raw.get(t, "")) or [None])[0]

    # subscription by category (latest "times subscribed")
    subs, total = {}, None
    names = {"1": "qib", "2": "nii", "2.1": "bnii", "2.2": "snii", "3": "rii", "4": "emp"}
    for r in (d.get("activeCat") or {}).get("dataList", []):
        sr, cat = str(r.get("srNo") or ""), (r.get("category") or "")
        x = _num(r.get("noOfTotalMeant"))
        if sr in names and x is not None:
            subs[names[sr]] = {"label": cat, "times": round(x, 2), "offered": _num(r.get("noOfShareOffered")), "bid": _num(r.get("noOfSharesBid"))}
        if cat.strip().lower() == "total":
            total = round(x, 2) if x is not None else None

    size_text = info.get("Issue Size", "")
    pr = [float(x.replace(",", "")) for x in re.findall(r"([\d,]+(?:\.\d+)?)", info.get("Price Range", ""))][:2]
    lo, hi = (pr + pr)[:2] if pr else (None, None)
    fresh = _part(size_text, "fresh issue", hi) or 0   # ₹ crore
    ofs = _part(size_text, "offer for sale", hi) or 0
    lot = (re.search(r"(\d+)\s*Equity Shares", info.get("Bid Lot", "")) or [None, None])[1]
    lot = int(lot) if lot else None
    size_cr = round(fresh + ofs, 1) if fresh or ofs else None
    sme = series in ("SM", "ST") or "SME" in series

    checks = []
    q = (subs.get("qib") or {}).get("times")
    if q is None:
        checks.append(_check("qib", "Institutional (QIB) demand", "neutral", "No QIB bids yet — usually most QIB bidding comes on the last day."))
    elif q >= 10:
        checks.append(_check("qib", "Institutional (QIB) demand", "up", f"QIBs bid {q}× their quota — strong demand from institutions."))
    elif q >= 1:
        checks.append(_check("qib", "Institutional (QIB) demand", "neutral", f"QIBs bid {q}× their quota — covered, not heavy (watch the last day)."))
    else:
        checks.append(_check("qib", "Institutional (QIB) demand", "down", f"QIBs bid only {q}× their quota — institutions not fully in yet."))
    if total is not None:
        checks.append(_check("total", "Overall subscription", "up" if total >= 5 else "down" if total < 1 else "neutral",
                             f"Total {total}× — " + ("strong overall demand." if total >= 5 else "not yet fully subscribed." if total < 1 else "fully subscribed, moderate demand.")))
    rii = (subs.get("rii") or {}).get("times")
    if rii is not None and rii >= 10:
        checks.append(_check("rii", "Retail allotment chance", "neutral", f"Retail {rii}× oversubscribed — allotment is by lottery, so the chance of getting shares is low."))
    if fresh and not ofs:
        checks.append(_check("structure", "Issue structure", "up", "100% fresh issue — all money raised goes to the company."))
    elif ofs and not fresh:
        checks.append(_check("structure", "Issue structure", "down", "100% offer for sale — existing shareholders are selling; the company gets no new money."))
    elif fresh and ofs:
        f = round(fresh / (fresh + ofs) * 100)
        checks.append(_check("structure", "Issue structure", "up" if f >= 50 else "neutral", f"{f}% fresh issue, {100 - f}% offer for sale (existing holders selling)."))
    if size_cr is not None:
        checks.append(_check("size", "Issue size / liquidity", "up" if size_cr >= 500 else "down" if size_cr < 100 else "neutral",
                             f"≈ ₹{size_cr:,.0f} Cr at the upper band — " + ("large issue, usually good trading liquidity after listing." if size_cr >= 500 else "small issue, thinner trading after listing." if size_cr < 100 else "mid-sized issue.")))
    if sme:
        checks.append(_check("sme", "Board", "down", "SME platform — higher risk, bigger lot sizes and lower liquidity than the main board."))
    else:
        checks.append(_check("board", "Board", "up", "Main board listing (NSE / BSE)."))
    if link("Anchor Allocation Report") or "anchor" in size_text.lower():
        checks.append(_check("anchor", "Anchor investors", "up", "Anchor investors took a portion before the issue opened (see the anchor allocation report)."))

    out = {
        "symbol": symbol, "series": series, "company": next((k for k in info if k and not info[k] and k not in ("Symbol",)), None) or d.get("companyName"),
        "period": info.get("Issue Period"), "price_range": info.get("Price Range"), "price_lo": lo, "price_hi": hi,
        "face_value": info.get("Face Value"), "lot": lot, "min_investment": round(lot * hi) if lot and hi else None,
        "issue_type": info.get("Issue Type"), "issue_size_text": size_text, "fresh_cr": fresh or None, "ofs_cr": ofs or None,
        "size_cr": size_cr, "employee_discount": info.get("Discount"), "lead_managers": info.get("Book Running Lead Managers"),
        "registrar": info.get("Name of the Registrar"), "upi_cutoff": (info.get("Cut-off time for UPI Mandate Confirmation") or "")[:60],
        "links": {"rhp": link("Red Herring Prospectus"), "ratios": link("Ratios / Basis of Issue Price"), "anchor": link("Anchor Allocation Report")},
        "subscription": subs, "total_times": total, "checks": checks, "sme": sme,
        "fetched_at": datetime.now(IST).isoformat(),
    }
    if out.get("period"):
        _save_detail(key, out)
    else:  # NSE no longer serves this issue: show the last details we saved for it
        out = _saved_detail(key) or out
    with _DETAIL_LOCK:
        _DETAIL[key] = (time.time(), out)
    return out


# Last good NSE details per issue, so a closed IPO keeps its final subscription / checklist.
DETAIL_SAVE = DB_PATH.parent / "ipo_details.json"


def _saved_detail(key):
    try:
        snap = json.loads(DETAIL_SAVE.read_text()).get(key)
    except (OSError, ValueError):
        return None
    return {**snap, "snapshot": True} if snap else None


def _save_detail(key, out):
    try:
        saved = json.loads(DETAIL_SAVE.read_text())
    except (OSError, ValueError):
        saved = {}
    cutoff = (datetime.now(IST) - timedelta(days=RECENT_DAYS)).isoformat()
    saved = {k: v for k, v in saved.items() if (v.get("fetched_at") or "") >= cutoff}
    saved[key] = out
    try:
        DETAIL_SAVE.parent.mkdir(parents=True, exist_ok=True)
        DETAIL_SAVE.write_text(json.dumps(saved))
    except OSError:
        pass


_YT = {}  # query -> (fetched_at, [video ids])


def youtube_top(query, n=4):
    """Top n YouTube search results for an IPO (no API key: reads the public results page).
    shortcut: scrapes YouTube's page, so a layout change returns no ids (the app then links to a search);
    switch to the YouTube Data API if that starts happening."""
    import requests
    q = " ".join(str(query).split())[:120]
    hit = _YT.get(q)
    if hit and time.time() - hit[0] < 6 * 3600:
        return {"query": q, "ids": hit[1]}
    ids = []
    try:
        r = requests.get("https://www.youtube.com/results", params={"search_query": q, "hl": "en"},
                         headers={"User-Agent": "Mozilla/5.0", "Accept-Language": "en"}, timeout=10)
        for v in re.findall(r'"videoId":"([A-Za-z0-9_-]{11})"', r.text):
            if v not in ids:
                ids.append(v)
        ids = ids[:n]
    except Exception:
        pass
    _YT[q] = (time.time(), ids)
    return {"query": q, "ids": ids}
