"""Thin client for "global cues" - the overnight US session plus the
same-morning Asian session (Dow, Nasdaq, S&P 500, Nikkei 225, Hang Seng,
Shanghai Composite) that most Indian market dashboards lead with as
pre-market context. A separate site from NSE, so this is a separate small
client, same pattern as screener_client.py/fyers_client.py.

Uses Yahoo Finance's undocumented chart/quote API. query1.finance.yahoo.com
(the commonly-referenced host) aggressively rate-limits anonymous requests
from this environment - confirmed live: persistent HTTP 429 even after a
session warm-up (a real limitation get_market_overview's docstring already
noted, which is why global indices weren't included there).
query2.finance.yahoo.com serves the identical API and worked cleanly in
the same test, so that's the host used here.

Not an official/stable API and could stop working without notice - kept
deliberately simple (one small function, no auth, no heavy dependency) so
a break is easy to spot and fix.
"""

from __future__ import annotations

import time

import requests

BASE = "https://query2.finance.yahoo.com"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

# (Yahoo ticker, display name) - US session first (most recently closed
# relative to an Indian morning), then Asia (open around/after NSE's own
# session start). Deliberately a short, well-known list rather than every
# index Yahoo has - this mirrors what a "global cues" widget usually shows.
GLOBAL_CUES = [
    ("^DJI", "Dow Jones"),
    ("^IXIC", "Nasdaq"),
    ("^GSPC", "S&P 500"),
    ("^N225", "Nikkei 225"),
    ("^HSI", "Hang Seng"),
    ("000001.SS", "Shanghai Composite"),
]

CACHE_TTL_SEC = 5 * 60  # global indices don't need by-the-minute freshness for pre-market context


class GlobalMarketsFetchError(RuntimeError):
    """Raised when Yahoo Finance can't be reached or its response shape changed unexpectedly."""


class GlobalMarketsClient:
    def __init__(self):
        self._session = requests.Session()
        self._session.headers.update(HEADERS)
        self._cache: tuple[float, list[dict]] | None = None

    def _fetch_one(self, symbol: str, name: str) -> dict:
        try:
            resp = self._session.get(f"{BASE}/v8/finance/chart/{symbol}", timeout=10)
        except requests.RequestException as exc:
            raise GlobalMarketsFetchError(f"Yahoo Finance fetch failed for {symbol}: {exc}") from exc
        if resp.status_code != 200:
            raise GlobalMarketsFetchError(f"Yahoo Finance fetch failed for {symbol}: HTTP {resp.status_code}")
        try:
            meta = resp.json()["chart"]["result"][0]["meta"]
            last = meta["regularMarketPrice"]
            prev_close = meta["previousClose"]
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise GlobalMarketsFetchError(f"Yahoo Finance response shape changed for {symbol}: {exc}") from exc
        change = last - prev_close
        return {
            "symbol": symbol.lstrip("^"),
            "name": name,
            "last": last,
            "change": change,
            "pChange": (change / prev_close * 100) if prev_close else None,
        }

    def get_global_cues(self) -> list[dict]:
        if self._cache is not None:
            ts, cached_rows = self._cache
            if time.time() - ts < CACHE_TTL_SEC:
                return cached_rows

        rows: list[dict] = []
        errors: list[str] = []
        for symbol, name in GLOBAL_CUES:
            try:
                rows.append(self._fetch_one(symbol, name))
            except GlobalMarketsFetchError as exc:
                errors.append(str(exc))  # one index failing shouldn't blank out the rest

        if not rows:
            raise GlobalMarketsFetchError(errors[0] if errors else "no global indices returned data")

        self._cache = (time.time(), rows)
        return rows


client = GlobalMarketsClient()
