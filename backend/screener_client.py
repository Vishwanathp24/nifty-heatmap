"""Thin client for screener.in's public "Recent IPOs" page
(screener.in/ipo/recent/) - a separate site from NSE, so this is a
separate small client, same pattern as fyers_client.py.

Unlike nseindia.com, screener.in needs no session-bootstrap/cookie dance
- a plain GET with a normal browser User-Agent works directly, confirmed
live. The page is server-rendered HTML (not an SPA calling a JSON API),
so this scrapes its table directly: Name, Listing Date, IPO Market Cap
(Rs Cr), IPO Price, Current Price, % Change since listing. Also derives
days-since-listing from that same listing-date text (screener.in doesn't
show this itself).

Not an official API and could break if screener.in changes their page
markup - kept deliberately simple (plain regex over the HTML, no heavy
parser dependency) so a break is easy to spot and fix.
"""

from __future__ import annotations

import datetime as dt
import re
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

# "Recent" - not screener's full multi-year archive (42 pages, 25 rows
# each, at last check). 2 pages (~50 most recent IPOs, newest first since
# the URL already sorts by listdate desc) matches what "recent" implies;
# bump this if more history is ever wanted.
RECENT_IPO_PAGES = 2
CACHE_TTL_SEC = 20 * 60  # listing data moves slowly; current price/%chg don't need by-the-minute freshness here

_ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
_CELL_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_LINK_RE = re.compile(r'href="(/company/[^"]+)"')
_PCT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%")


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


class ScreenerClient:
    def __init__(self):
        self._session = requests.Session()
        self._session.headers.update(HEADERS)
        self._cache: tuple[float, list[dict]] | None = None

    def _fetch_page(self, page: int) -> list[dict]:
        params = {"sort": "listdate", "order": "desc"}
        if page > 1:
            params["page"] = page
        try:
            resp = self._session.get(IPO_URL, params=params, timeout=15)
        except requests.RequestException as exc:
            raise ScreenerFetchError(f"screener.in IPO page fetch failed: {exc}") from exc
        if resp.status_code != 200:
            raise ScreenerFetchError(f"screener.in IPO page fetch failed: HTTP {resp.status_code}")

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

    def get_recent_ipos(self) -> list[dict]:
        if self._cache is not None:
            ts, cached_rows = self._cache
            if time.time() - ts < CACHE_TTL_SEC:
                return cached_rows

        rows: list[dict] = []
        for page in range(1, RECENT_IPO_PAGES + 1):
            try:
                rows.extend(self._fetch_page(page))
            except ScreenerFetchError:
                if not rows:
                    raise  # first page failed outright - nothing to show
                break  # later page failed - serve what we already have rather than nothing

        self._cache = (time.time(), rows)
        return rows


client = ScreenerClient()
