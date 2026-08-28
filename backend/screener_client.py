"""Thin client for screener.in's public IPO pages - "Recent IPOs"
(screener.in/ipo/recent/, already-listed) and "Upcoming IPOs"
(screener.in/ipo/, open-for-subscription/listing-soon) - a separate site
from NSE, so this is a separate small client, same pattern as
fyers_client.py.

Unlike nseindia.com, screener.in needs no session-bootstrap/cookie dance
- a plain GET with a normal browser User-Agent works directly, confirmed
live. The page is server-rendered HTML (not an SPA calling a JSON API),
so this scrapes its table directly: Name, Listing Date, IPO Market Cap
(Rs Cr), IPO Price, Current Price, % Change since listing. Also derives
days-since-listing from that same listing-date text (screener.in doesn't
show this itself) - and pages through screener's list until that value
walks past IPO_LOOKBACK_YEARS, so the app covers the last 3 years of
listings rather than just the newest page or two.

That 3-year walk is ~40-70 paged requests, and screener.in starts
returning HTTP 429 after a handful of back-to-back requests (confirmed
live), so it can't just run inline inside a request handler - it's done
by its own background thread (PAGE_DELAY_SEC between pages, backoff-and-
retry on 429), same warmed-cache pattern NSEClient uses for its long
daily-history walk. get_recent_ipos() just hands back whatever that
thread has most recently finished, and only falls back to a single
synchronous page fetch on a cold start with no cache yet.

Not an official API and could break if screener.in changes their page
markup - kept deliberately simple (plain regex over the HTML, no heavy
parser dependency) so a break is easy to spot and fix.
"""

from __future__ import annotations

import datetime as dt
import re
import threading
import time
from zoneinfo import ZoneInfo

import requests

IST = ZoneInfo("Asia/Kolkata")

BASE = "https://www.screener.in"
IPO_URL = f"{BASE}/ipo/recent/"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml",
}

# "Recent" = last IPO_LOOKBACK_YEARS years, not screener's full multi-year
# archive (42 pages, 25 rows each, at last check). Rows are sorted newest
# first (URL already sorts by listdate desc), so pages are fetched one at
# a time until a page's oldest row falls outside the window - MAX_IPO_PAGES
# is just a safety backstop against an unbounded loop if the page's markup
# ever breaks in a way that stops reporting daysSinceListing.
IPO_LOOKBACK_YEARS = 3
MAX_IPO_PAGES = 80
PAGE_DELAY_SEC = 1.2  # pacing between pages within one walk - screener.in 429s/times out on unpaced bursts
MAX_429_RETRIES = 5
RETRY_BACKOFF_BASE_SEC = 2.0
# A full walk is slow and IPO listing data barely changes hour to hour, so
# re-walk infrequently rather than on every cache-expiry-driven request.
REFRESH_INTERVAL_SEC = 3 * 60 * 60
# Floor between cold-start fallback attempts (see get_recent_ipos) - without
# this, the frontend's own auto-refresh polling would retry the single-page
# fetch (with its own multi-attempt backoff) on every poll while the
# background walk has nothing cached yet, piling more load onto screener.in
# right when it's already rate-limiting us.
COLD_START_RETRY_INTERVAL_SEC = 60

_ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
_CELL_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_LINK_RE = re.compile(r'href="(/company/[^"]+)"')
_PCT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%")

# screener.in/ipo/ ("Upcoming IPOs") - a single short page (~15 rows, no
# pagination seen), but its table isn't a plain <tr>/<td> grid the way
# /ipo/recent/'s is: each row also carries a "Subscription Status" popup
# with its own nested <table>, whose rows share the SAME stripe/stripe-
# light/"" classes as the outer rows - so splitting on row class (like
# _ROW_RE above) picks up nested rows too. The one reliable per-row
# anchor is the company name link itself (never appears inside the
# nested modal), so rows are split on THAT instead - see _fetch_upcoming.
UPCOMING_IPO_URL = f"{BASE}/ipo/"
UPCOMING_IPO_CACHE_TTL_SEC = 15 * 60
_UPCOMING_NAME_RE = re.compile(r'<td class="text">\s*<a class="font-weight-500"\s*href="(/company/[^"]+)"[^>]*>([^<]+)</a>')
_UPCOMING_SUBPERIOD_RE = re.compile(r'<span class="font-weight-500">([^<]+)</span>\s*-\s*<span class="font-weight-500">([^<]+)</span>')
_UPCOMING_PRICE_RE = re.compile(r"<td>(₹[^<]+)</td>")
_UPCOMING_LISTDATE_RE = re.compile(r'<td class="sub text-align-center">([^<]+)</td>')
_UPCOMING_MCAP_RE = re.compile(r"<td>([\d,]+)</td>")
_UPCOMING_SUBMULT_RE = re.compile(r'data-title="Subscription Status"[^>]*>\s*([^<]+?)\s*<i')
# PE and ROCE are the two plain <td> cells right after the Subscription
# cell's nested modal finally closes - matched from the tail of the row
# (</tr> anchors it) since counting the modal's own many <td>s from the
# front isn't reliable with plain regex.
_UPCOMING_TAIL_RE = re.compile(r"</td>\s*<td>([^<]*)</td>\s*<td>([^<]*)</td>\s*</tr>", re.S)
_ORDINAL_SUFFIX_RE = re.compile(r"(\d+)(?:st|nd|rd|th)")


class ScreenerFetchError(RuntimeError):
    """Raised when screener.in can't be reached or its page shape changed unexpectedly."""


def _clean(html_fragment: str) -> str:
    return re.sub(r"\s+", " ", _TAG_RE.sub(" ", html_fragment)).strip()


def _parse_money(text: str) -> float | None:
    text = text.replace("₹", "").replace(",", "").strip()
    try:
        return float(text)
    except ValueError:
        return None


def _parse_pct(text: str) -> float | None:
    # e.g. "⇡ 8%" (up), "⇣ 6%" (down), "" (not listed yet - no price to compare)
    m = _PCT_RE.search(text)
    if not m:
        return None
    value = float(m.group(1))
    return -value if "⇣" in text else value


def _parse_listing_date(text: str) -> dt.date | None:
    """screener.in's own listing-date text: "today" for the current
    trading day, otherwise "DD Mon YYYY" (e.g. "26 Aug 2026")."""
    text = text.strip()
    if text.lower() == "today":
        return dt.datetime.now(IST).date()
    try:
        return dt.datetime.strptime(text, "%d %b %Y").date()
    except ValueError:
        return None


def _days_since_listing(listing_date: dt.date | None) -> int | None:
    if listing_date is None:
        return None
    days = (dt.datetime.now(IST).date() - listing_date).days
    return days if days >= 0 else None  # a future date is an upcoming IPO, not "since listing"


def _clean_ordinal_date(text: str) -> str | None:
    """screener.in's /ipo/ page writes dates as "25th Aug"/"2nd Sep" (no
    year - these are all near-term) - strips the ordinal suffix (25 Aug),
    None for the empty/whitespace-only cell a not-yet-scheduled IPO has."""
    text = _ORDINAL_SUFFIX_RE.sub(r"\1", text).strip()
    return text or None


def _parse_multiple(text: str) -> float | None:
    """"152 times" -> 152.0, "0.1 times" -> 0.1; None once subscription
    hasn't opened yet (no "Subscription Status" popup on that row at all,
    so _UPCOMING_SUBMULT_RE just never matches)."""
    m = re.search(r"[\d.]+", text)
    return float(m.group(0)) if m else None


def _parse_roce(text: str) -> float | None:
    text = text.replace("%", "").strip()
    try:
        return float(text)
    except ValueError:
        return None


class ScreenerClient:
    def __init__(self):
        self._session = requests.Session()
        self._session.headers.update(HEADERS)
        self._lock = threading.Lock()
        self._cache: list[dict] = []  # last completed 3-year walk; empty until the first one finishes
        self._cold_lock = threading.Lock()  # serializes cold-start attempts - see get_recent_ipos
        self._last_cold_attempt = 0.0
        self._last_cold_error: ScreenerFetchError | None = None
        threading.Thread(target=self._refresh_loop, daemon=True, name="screener-ipo-refresh").start()
        self._upcoming_cache: tuple[float, list[dict]] | None = None

    def _fetch_page(self, page: int) -> list[dict]:
        params = {"sort": "listdate", "order": "desc"}
        if page > 1:
            params["page"] = page

        attempt = 0
        while True:
            try:
                resp = self._session.get(IPO_URL, params=params, timeout=20)
            except requests.RequestException as exc:
                # A slow/dropped connection here is usually the same rate-limiting
                # showing up as a timeout instead of a 429 - retry it the same way.
                if attempt < MAX_429_RETRIES:
                    time.sleep(RETRY_BACKOFF_BASE_SEC * (2**attempt))
                    attempt += 1
                    continue
                raise ScreenerFetchError(f"screener.in IPO page fetch failed: {exc}") from exc
            if resp.status_code == 429 and attempt < MAX_429_RETRIES:
                # Honor Retry-After when screener.in sends one, otherwise back off ourselves.
                wait = float(resp.headers.get("Retry-After", 0) or 0) or RETRY_BACKOFF_BASE_SEC * (2**attempt)
                time.sleep(wait)
                attempt += 1
                continue
            if resp.status_code != 200:
                raise ScreenerFetchError(f"screener.in IPO page fetch failed: HTTP {resp.status_code}")
            break

        tbody_match = re.search(r"<tbody[^>]*>(.*?)</tbody>", resp.text, re.S)
        if not tbody_match:
            return []

        rows = []
        for raw_row in _ROW_RE.findall(tbody_match.group(1)):
            cells = _CELL_RE.findall(raw_row)
            if len(cells) < 6:
                continue
            name = _clean(cells[0])
            link_match = _LINK_RE.search(cells[0])
            current_price = _parse_money(_clean(cells[4]))
            listing_date_text = _clean(cells[1])
            rows.append(
                {
                    "name": name,
                    "screenerUrl": f"{BASE}{link_match.group(1)}" if link_match else None,
                    "listingDate": listing_date_text,
                    "daysSinceListing": _days_since_listing(_parse_listing_date(listing_date_text)),
                    "ipoMarketCapCr": _parse_money(_clean(cells[2])),
                    "ipoPrice": _parse_money(_clean(cells[3])),
                    "currentPrice": current_price,
                    "pctChange": _parse_pct(_clean(cells[5])),
                    "listed": current_price is not None,
                }
            )
        return rows

    def _refresh_loop(self):
        while True:
            try:
                self._refresh_once()
            except Exception:
                pass  # keep the loop alive - the next cycle just tries again
            time.sleep(REFRESH_INTERVAL_SEC)

    def _refresh_once(self) -> None:
        max_days = 365 * IPO_LOOKBACK_YEARS
        rows: list[dict] = []
        page = 1
        while page <= MAX_IPO_PAGES:
            try:
                page_rows = self._fetch_page(page)
            except ScreenerFetchError:
                break  # a page failed mid-walk - keep whatever this walk already gathered
            if not page_rows:
                break  # ran past the end of screener's IPO list
            rows.extend(page_rows)
            oldest_days_on_page = max(
                (r["daysSinceListing"] for r in page_rows if r["daysSinceListing"] is not None), default=None
            )
            if oldest_days_on_page is not None and oldest_days_on_page > max_days:
                break  # this page already reaches past the lookback window - later pages only get older
            page += 1
            time.sleep(PAGE_DELAY_SEC)

        # A page can straddle the cutoff (mainboard + SME listings mixed by
        # date, not by page boundary) - trim anything older than the window.
        rows = [r for r in rows if r["daysSinceListing"] is None or r["daysSinceListing"] <= max_days]

        if rows:  # don't clobber a previously-good cache with an empty/partial walk
            with self._lock:
                self._cache = rows

    def get_recent_ipos(self) -> list[dict]:
        with self._lock:
            cache = self._cache
        if cache:
            return cache

        # Cold start - the background walk hasn't finished its first pass
        # yet (can take a minute or more, paced to avoid screener.in's rate
        # limit). Serve just the first page synchronously so the page isn't
        # empty in the meantime; the background thread fills in the rest.
        #
        # A single attempt already takes up to ~60s once its own 429/timeout
        # retries are counted, and the frontend polls every 20s while this
        # view is open - without _cold_lock, a second poll landing mid-retry
        # would start its own overlapping attempt (self._last_cold_error is
        # still None until the first one finishes), doubling load on
        # screener.in for every concurrent viewer. _cold_lock serializes
        # that: a request that arrives while one is already in flight gets
        # the last known outcome immediately instead of piling on another
        # retry sequence.
        if not self._cold_lock.acquire(blocking=False):
            if self._last_cold_error is not None:
                raise self._last_cold_error
            raise ScreenerFetchError("Recent IPOs data is still loading - try again in a moment.")
        try:
            now = time.time()
            if now - self._last_cold_attempt < COLD_START_RETRY_INTERVAL_SEC and self._last_cold_error is not None:
                raise self._last_cold_error
            self._last_cold_attempt = now
            try:
                rows = self._fetch_page(1)
            except ScreenerFetchError as exc:
                self._last_cold_error = exc
                raise
            self._last_cold_error = None
            return rows
        finally:
            self._cold_lock.release()

    def _fetch_upcoming_ipos(self) -> list[dict]:
        try:
            resp = self._session.get(UPCOMING_IPO_URL, timeout=20)
        except requests.RequestException as exc:
            raise ScreenerFetchError(f"screener.in Upcoming IPOs fetch failed: {exc}") from exc
        if resp.status_code != 200:
            raise ScreenerFetchError(f"screener.in Upcoming IPOs fetch failed: HTTP {resp.status_code}")

        html = resp.text
        name_matches = list(_UPCOMING_NAME_RE.finditer(html))
        rows = []
        for i, m in enumerate(name_matches):
            start = m.start()
            end = name_matches[i + 1].start() if i + 1 < len(name_matches) else len(html)
            row_html = html[start:end]

            subperiod = _UPCOMING_SUBPERIOD_RE.search(row_html)
            price = _UPCOMING_PRICE_RE.search(row_html)
            listdate_matches = _UPCOMING_LISTDATE_RE.findall(row_html)
            mcap = _UPCOMING_MCAP_RE.search(row_html)
            submult = _UPCOMING_SUBMULT_RE.search(row_html)
            tail = _UPCOMING_TAIL_RE.search(row_html)

            rows.append(
                {
                    "name": m.group(2).strip(),
                    "screenerUrl": f"{BASE}{m.group(1)}",
                    "subscriptionOpen": _clean_ordinal_date(subperiod.group(1)) if subperiod else None,
                    "subscriptionClose": _clean_ordinal_date(subperiod.group(2)) if subperiod else None,
                    "priceBand": price.group(1).strip() if price else None,
                    # The 2nd "sub text-align-center" cell is Listing Date - the
                    # 1st is the Subscription Period cell, which never matches
                    # here since it contains nested <span> tags this pattern
                    # (deliberately, [^<]+) doesn't allow through.
                    "listingDate": _clean_ordinal_date(listdate_matches[0]) if listdate_matches else None,
                    "ipoMarketCapCr": _parse_money(mcap.group(1)) if mcap else None,
                    "subscriptionTimes": _parse_multiple(submult.group(1)) if submult else None,
                    "pe": _parse_money(tail.group(1)) if tail else None,
                    "roce": _parse_roce(tail.group(2)) if tail else None,
                }
            )
        if not rows and name_matches == []:
            raise ScreenerFetchError("screener.in Upcoming IPOs page markup may have changed - no rows found")
        return rows

    def get_upcoming_ipos(self) -> list[dict]:
        """Companies currently open for subscription or listing over the
        next few days (screener.in/ipo/) - subscription window, price
        band, expected listing date, market cap, and (once subscription
        has opened) the live oversubscription multiple. A separate, much
        smaller page from /ipo/recent/ above, single request/no pagination
        seen, so no background-walk machinery needed here."""
        if self._upcoming_cache is not None:
            ts, cached_rows = self._upcoming_cache
            if time.time() - ts < UPCOMING_IPO_CACHE_TTL_SEC:
                return cached_rows
        rows = self._fetch_upcoming_ipos()
        self._upcoming_cache = (time.time(), rows)
        return rows


client = ScreenerClient()
