"""
Thin client around NSE India's unofficial JSON endpoints.

NSE does not publish a public API. These endpoints are the same ones
nseindia.com's own web pages call under the hood. They are undocumented
and can change or start rate-limiting without notice — this module is
written defensively (session bootstrap + retry-on-failure + short TTL
cache) but if NSE changes a response shape, the affected endpoint will
raise NSEFetchError and the API layer turns that into a clean error
the frontend can show instead of crashing.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import os
import pathlib
import threading
import time
from typing import Any
from zoneinfo import ZoneInfo

import requests
from requests.adapters import HTTPAdapter

IST = ZoneInfo("Asia/Kolkata")

# Where the app persists its self-tracked candle history (intraday_history_*.json).
# Defaults to this file's own directory (matches local dev so far), but is
# overridable via NIFTY_DATA_DIR - point this at a mounted persistent disk
# in production so history survives restarts/redeploys instead of resetting.
DATA_DIR = pathlib.Path(os.environ.get("NIFTY_DATA_DIR", str(pathlib.Path(__file__).resolve().parent)))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Constants

BASE = "https://www.nseindia.com"

# A page that reliably returns 200 and sets the cookies the JSON API needs.
# (The bare homepage "/" returns 403 for a plain requests session.)
BOOTSTRAP_URL = f"{BASE}/market-data/live-market-indices"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": BOOTSTRAP_URL,
}

NIFTY50_INDEX = "NIFTY 50"

# ---------------------------------------------------------------------------
# Sector classification
#
# Every F&O stock, hand-assigned to exactly ONE sector based on what the
# company actually does (not NSE's inconsistent, overlapping index
# memberships - see the history of this file for how many rounds of
# "why does X overlap with Y" that caused). Verified against NSE's live
# F&O securities list: all 208 symbols present, zero typos, zero
# duplicates, zero overlap by construction.
#
# If NSE adds a new F&O stock that isn't in this map yet, it falls back to
# "UNCLASSIFIED" (see _sector_for) rather than crashing - update this map
# when that happens.
FO_SECTOR_MAP: dict[str, str] = {
    # -- AUTO (incl. auto ancillaries) --
    "ASHOKLEY": "AUTO", "BAJAJ-AUTO": "AUTO", "BHARATFORG": "AUTO", "BOSCHLTD": "AUTO",
    "EICHERMOT": "AUTO", "FORCEMOT": "AUTO", "HEROMOTOCO": "AUTO", "HYUNDAI": "AUTO",
    "M&M": "AUTO", "MARUTI": "AUTO", "MOTHERSON": "AUTO", "SONACOMS": "AUTO",
    "TIINDIA": "AUTO", "TMPV": "AUTO", "TVSMOTOR": "AUTO", "UNOMINDA": "AUTO",

    # -- BANKING --
    "AUBANK": "BANKING", "AXISBANK": "BANKING", "BANDHANBNK": "BANKING",
    "BANKBARODA": "BANKING", "BANKINDIA": "BANKING", "CANBK": "BANKING",
    "FEDERALBNK": "BANKING", "HDFCBANK": "BANKING", "ICICIBANK": "BANKING",
    "IDFCFIRSTB": "BANKING", "INDIANB": "BANKING", "INDUSINDBK": "BANKING",
    "KOTAKBANK": "BANKING", "PNB": "BANKING", "RBLBANK": "BANKING", "SBIN": "BANKING",
    "UNIONBANK": "BANKING", "YESBANK": "BANKING",

    # -- FINANCIAL SERVICES (NBFC / insurance / AMC / broking / exchanges) --
    "360ONE": "FINANCIAL SERVICES", "ABCAPITAL": "FINANCIAL SERVICES",
    "ANGELONE": "FINANCIAL SERVICES", "BAJAJFINSV": "FINANCIAL SERVICES",
    "BAJAJHLDNG": "FINANCIAL SERVICES", "BAJFINANCE": "FINANCIAL SERVICES",
    "BSE": "FINANCIAL SERVICES", "CAMS": "FINANCIAL SERVICES", "CDSL": "FINANCIAL SERVICES",
    "CHOLAFIN": "FINANCIAL SERVICES", "HDFCAMC": "FINANCIAL SERVICES",
    "HDFCLIFE": "FINANCIAL SERVICES", "ICICIGI": "FINANCIAL SERVICES",
    "ICICIPRULI": "FINANCIAL SERVICES", "IREDA": "FINANCIAL SERVICES",
    "IRFC": "FINANCIAL SERVICES", "JIOFIN": "FINANCIAL SERVICES", "KFINTECH": "FINANCIAL SERVICES",
    "LICHSGFIN": "FINANCIAL SERVICES", "LICI": "FINANCIAL SERVICES", "LTF": "FINANCIAL SERVICES",
    "MANAPPURAM": "FINANCIAL SERVICES", "MCX": "FINANCIAL SERVICES", "MFSL": "FINANCIAL SERVICES",
    "MOTILALOFS": "FINANCIAL SERVICES", "MUTHOOTFIN": "FINANCIAL SERVICES",
    "NAM-INDIA": "FINANCIAL SERVICES", "PFC": "FINANCIAL SERVICES", "PNBHOUSING": "FINANCIAL SERVICES",
    "RECLTD": "FINANCIAL SERVICES", "SBICARD": "FINANCIAL SERVICES", "SBILIFE": "FINANCIAL SERVICES",
    "SHRIRAMFIN": "FINANCIAL SERVICES",

    # -- IT --
    "COFORGE": "IT", "HCLTECH": "IT", "INFY": "IT", "KPITTECH": "IT", "LTM": "IT",
    "MPHASIS": "IT", "OFSS": "IT", "PERSISTENT": "IT", "TATAELXSI": "IT", "TCS": "IT",
    "TECHM": "IT", "WIPRO": "IT",

    # -- PHARMA --
    "ALKEM": "PHARMA", "AUROPHARMA": "PHARMA", "BIOCON": "PHARMA", "CIPLA": "PHARMA",
    "DIVISLAB": "PHARMA", "DRREDDY": "PHARMA", "GLENMARK": "PHARMA", "LAURUSLABS": "PHARMA",
    "LUPIN": "PHARMA", "MANKIND": "PHARMA", "SUNPHARMA": "PHARMA", "TORNTPHARM": "PHARMA",
    "ZYDUSLIFE": "PHARMA",

    # -- HEALTHCARE (hospitals / diagnostics) --
    "APOLLOHOSP": "HEALTHCARE", "FORTIS": "HEALTHCARE", "MAXHEALTH": "HEALTHCARE",

    # -- FMCG --
    "BRITANNIA": "FMCG", "COLPAL": "FMCG", "DABUR": "FMCG", "GODFRYPHLP": "FMCG",
    "GODREJCP": "FMCG", "HINDUNILVR": "FMCG", "ITC": "FMCG", "MARICO": "FMCG",
    "NESTLEIND": "FMCG", "PATANJALI": "FMCG", "RADICO": "FMCG", "TATACONSUM": "FMCG",
    "UNITDSPR": "FMCG", "VBL": "FMCG",

    # -- CONSUMER DURABLES --
    "AMBER": "CONSUMER DURABLES", "ASIANPAINT": "CONSUMER DURABLES", "ASTRAL": "CONSUMER DURABLES",
    "BLUESTARCO": "CONSUMER DURABLES", "CROMPTON": "CONSUMER DURABLES", "DIXON": "CONSUMER DURABLES",
    "HAVELLS": "CONSUMER DURABLES", "PAGEIND": "CONSUMER DURABLES", "PGEL": "CONSUMER DURABLES",
    "SUPREMEIND": "CONSUMER DURABLES", "TITAN": "CONSUMER DURABLES", "VOLTAS": "CONSUMER DURABLES",

    # -- RETAIL --
    "DMART": "RETAIL", "KALYANKJIL": "RETAIL", "TRENT": "RETAIL", "VMM": "RETAIL",

    # -- CONSUMER SERVICES (hospitality / QSR) --
    "INDHOTEL": "CONSUMER SERVICES", "JUBLFOOD": "CONSUMER SERVICES",

    # -- METALS & MINING --
    "APLAPOLLO": "METALS", "COALINDIA": "METALS", "HINDALCO": "METALS", "HINDZINC": "METALS",
    "JINDALSTEL": "METALS", "JSWSTEEL": "METALS", "NATIONALUM": "METALS", "NMDC": "METALS",
    "SAIL": "METALS", "TATASTEEL": "METALS", "VEDL": "METALS",

    # -- OIL & GAS --
    "BPCL": "OIL & GAS", "GAIL": "OIL & GAS", "HINDPETRO": "OIL & GAS", "IOC": "OIL & GAS",
    "OIL": "OIL & GAS", "ONGC": "OIL & GAS", "PETRONET": "OIL & GAS", "RELIANCE": "OIL & GAS",

    # -- POWER (generation / transmission / renewables) --
    "ADANIENSOL": "POWER", "ADANIGREEN": "POWER", "ADANIPOWER": "POWER", "IEX": "POWER",
    "INOXWIND": "POWER", "JSWENERGY": "POWER", "NHPC": "POWER", "NTPC": "POWER",
    "POWERGRID": "POWER", "PREMIERENE": "POWER", "SUZLON": "POWER", "TATAPOWER": "POWER",
    "WAAREEENER": "POWER",

    # -- CEMENT --
    "AMBUJACEM": "CEMENT", "DALBHARAT": "CEMENT", "SHREECEM": "CEMENT", "ULTRACEMCO": "CEMENT",

    # -- CHEMICALS --
    "PIDILITIND": "CHEMICALS", "PIIND": "CHEMICALS", "SRF": "CHEMICALS", "UPL": "CHEMICALS",

    # -- INFRASTRUCTURE & CONSTRUCTION --
    "ADANIPORTS": "INFRASTRUCTURE", "LT": "INFRASTRUCTURE", "NBCC": "INFRASTRUCTURE",
    "RVNL": "INFRASTRUCTURE",

    # -- REALTY --
    "DLF": "REALTY", "GODREJPROP": "REALTY", "LODHA": "REALTY", "OBEROIRLTY": "REALTY",
    "PHOENIXLTD": "REALTY", "PRESTIGE": "REALTY",

    # -- TELECOM --
    "BHARTIARTL": "TELECOM", "IDEA": "TELECOM", "INDUSTOWER": "TELECOM",

    # -- CAPITAL GOODS (industrial / electrical equipment) --
    "ABB": "CAPITAL GOODS", "BEL": "CAPITAL GOODS", "BHEL": "CAPITAL GOODS",
    "CGPOWER": "CAPITAL GOODS", "CUMMINSIND": "CAPITAL GOODS", "GVT&D": "CAPITAL GOODS",
    "KAYNES": "CAPITAL GOODS", "KEI": "CAPITAL GOODS", "POLYCAB": "CAPITAL GOODS",
    "POWERINDIA": "CAPITAL GOODS", "SIEMENS": "CAPITAL GOODS",

    # -- DEFENCE --
    "BDL": "DEFENCE", "COCHINSHIP": "DEFENCE", "HAL": "DEFENCE", "MAZDOCK": "DEFENCE",
    "SOLARINDS": "DEFENCE",

    # -- LOGISTICS --
    "CONCOR": "LOGISTICS", "DELHIVERY": "LOGISTICS",

    # -- AVIATION --
    "GMRAIRPORT": "AVIATION", "INDIGO": "AVIATION",

    # -- INTERNET / NEW AGE --
    "ETERNAL": "INTERNET / NEW AGE", "NAUKRI": "INTERNET / NEW AGE", "NYKAA": "INTERNET / NEW AGE",
    "PAYTM": "INTERNET / NEW AGE", "POLICYBZR": "INTERNET / NEW AGE", "SWIGGY": "INTERNET / NEW AGE",

    # -- DIVERSIFIED (genuine multi-industry conglomerates) --
    "ADANIENT": "DIVERSIFIED", "GRASIM": "DIVERSIFIED",
}

UNCLASSIFIED_LABEL = "UNCLASSIFIED"

# Distinct sector names, biggest (most stocks) first - used to label the
# F&O Gainers/Losers/Volume/Advance-Decline panels' "Sector" column and
# filter dropdown (via _sector_for below). NOT used for the heatmap grid -
# see HEATMAP_SECTOR_SYMBOLS for that.
SECTOR_LIST: list[str] = sorted(
    set(FO_SECTOR_MAP.values()),
    key=lambda name: -sum(1 for v in FO_SECTOR_MAP.values() if v == name),
)

# The Sectoral Heatmap grid itself mirrors NSE's own "Sectoral Indices"
# tab exactly - all 23 of NSE's published sectoral indices, unfiltered
# (F&O and non-F&O stocks alike) and with no cross-sector dedup, matching
# what NSE's own site shows tile-for-tile. This deliberately does NOT use
# FO_SECTOR_MAP above - that clean, F&O-only, zero-overlap classification
# is a good fit for the F&O mover tables, but for the heatmap itself the
# raw, familiar NSE view was preferred over the cleaned-up one.
HEATMAP_SECTOR_SYMBOLS: list[str] = [
    "NIFTY AUTO",
    "NIFTY BANK",
    "NIFTY FIN SERVICE",
    "NIFTY FINSRV25 50",
    "NIFTY FMCG",
    "NIFTY IT",
    "NIFTY MEDIA",
    "NIFTY METAL",
    "NIFTY PHARMA",
    "NIFTY PSU BANK",
    "NIFTY PVT BANK",
    "NIFTY REALTY",
    "NIFTY HEALTHCARE",
    "NIFTY CONSR DURBL",
    "NIFTY OIL AND GAS",
    "NIFTY MIDSML HLTH",
    "NIFTY FINSEREXBNK",
    "NIFTY MS FIN SERV",
    "NIFTY MS IT TELCM",
    "NIFTY CHEMICALS",
    "NIFTY500 HEALTH",
    "NIFTY REITS REALTY",
    "NIFTY CEMENT",
]

# ---------------------------------------------------------------------------
# Opening Range Breakout (ORB) scanner
#
# NSE has no accessible endpoint for historical intraday candles (tried
# chart-databyindex - returns empty; quote-equity - hard 403 blocked) or
# previous-day OHLC (historical endpoints errored). So this is self-tracked:
# a background thread polls the F&O universe's snapshot every ~20s during
# market hours, and NSE's own "dayHigh"/"dayLow" fields are ALREADY the
# cumulative intraday high/low since market open - so capturing those two
# numbers at each window's cutoff moment (9:20/9:30/9:45/10:00/10:15 IST) IS the
# opening range for that window. No previous-day-range (PRB) variant - no
# reliable source found for previous-day high/low.
MARKET_OPEN_HOUR, MARKET_OPEN_MINUTE = 9, 15
MARKET_CLOSE_HOUR, MARKET_CLOSE_MINUTE = 15, 30
ORB_WINDOWS_MIN = (5, 15, 30, 45, 60)


# ---------------------------------------------------------------------------
# Buy/Sell Scanner (Bullish/Bearish Intraday, daily + hourly SMA/RSI/range)
#
# Two very different data needs, solved two different ways:
#
# - DAILY timeframe (SMA20, RSI14, vs each of the last 5 days' high/low):
#   NSE's per-day "Bhavcopy" (EOD settlement) archive files turned out to be
#   real, working, and NOT behind the same bot-protection as the JSON APIs -
#   confirmed live. Fetching ~40 calendar days of these gives genuine daily
#   OHLC history immediately, no self-tracking or warm-up needed.
#
# - INTRADAY timeframes (same conditions, on 15/30/45/60-min bars): there's
#   no bhavcopy equivalent for intraday data, so this reuses the same tick
#   history the ORB tracker already builds (_tick_history / _bucket_candles),
#   bucketed at whichever of the 4 sizes is selected. Completed candles at
#   EVERY size are persisted to disk (one file per size) so history survives
#   a restart and keeps accumulating across trading days. A 20-period SMA/RSI
#   needs ~20 bars: 15-min bars alone reach that within a single ~6.25-hour
#   session, but 30/45/60-min need several trading days of the server having
#   run before they're fully real.
BHAVCOPY_URL_TMPL = "https://archives.nseindia.com/products/content/sec_bhavdata_full_{:%d%m%Y}.csv"
DAILY_SMA_PERIOD = 20
DAILY_RSI_PERIOD = 14
DAILY_LOOKBACK_DAYS = 5  # "1 day ago" .. "5 days ago" high/low

# Dead zone (in % net move over the last DAILY_SMA_PERIOD (20) days) around
# zero that counts as "Neutral" rather than Uptrend/Downtrend for the
# Market Breadth table's trend read - same idea as SECTOR_BIAS_NEUTRAL_BAND,
# just sized for a 20-day price move instead of a same-day % change.
TREND_20D_NEUTRAL_BAND_PCT = 2.0

# Daily Average True Range period - the risk unit "R-Factor" is expressed in
# (see the "Entered at" tracking comment below). 14 is the standard ATR
# period; needs 15 daily bars, comfortably covered by DAILY_HISTORY_TARGET_DAYS.
DAILY_ATR_PERIOD = 14

# How many real trading days of Bhavcopy history to build - 30 is enough
# for RSI(14)/SMA(20) (the Buy/Sell scanner's daily leg, the only consumer
# of this history now that the F&O Screener has been removed).
DAILY_HISTORY_TARGET_DAYS = 30
DAILY_HISTORY_MAX_CHECKED = 100  # calendar days to scan looking for that many trading days

INTRADAY_TIMEFRAMES = (15, 30, 45, 60)
INTRADAY_SMA_PERIOD = 20
INTRADAY_RSI_PERIOD = 14
INTRADAY_LOOKBACK_BARS = 5  # "[-1] .. [-5]" high/low
INTRADAY_HISTORY_MAX_BARS = 60  # per symbol, per timeframe
INTRADAY_HISTORY_PATH_TMPL = str(DATA_DIR / "intraday_history_{}m.json")

# ---------------------------------------------------------------------------
# 15-Min Breakout Scanner ("15 MINUTE STOCK BREAKOUTS" / "15 MIN BEARISH
# BREAKOUT" - two published Chartink scanners, replicated exactly) -
# independent of the Bullish/Bearish Intraday scanner above: pure 15-min,
# no daily leg at all. Reuses the same persisted 15-min candle store
# (INTRADAY_HISTORY_PATH_TMPL for tf=15) - no new tracking needed.
#
# Buy:  [0] close > [-1] rolling-20-bar max(close)   AND  [0] volume > [0] SMA(volume, 20)
# Sell: [0] close < [-1] rolling-20-bar max(close)   AND  [0] volume < [0] SMA(volume, 20)
#
# The volume condition is deliberately asymmetric between the two directions
# (bullish wants a volume spike; the published bearish scanner wants BELOW-
# average volume, not a spike) - that's not a typo here, it's exactly what
# the source scanner specifies, kept as-is rather than "corrected" to match.
BREAKOUT_TIMEFRAME_MIN = 15
BREAKOUT_LOOKBACK_PERIOD = 20

# ---------------------------------------------------------------------------
# "Entered at" tracking - what clock-time a stock first started qualifying
# for a scanner today, so the UI can show e.g. "since 10:05" instead of just
# a pass/fail flag (a signal that's been true for 2 hours reads very
# differently from one that just turned true). Recomputed every ~20s tick in
# _track_scanner_entries below, using the exact same pass/fail logic the
# get_orb / get_scanner / get_breakout_scanner methods use, so the timestamp
# always matches what the API is actually reporting.
#
# Each entry also snapshots the LTP (and daily ATR(14)) at the moment the
# stock first qualified, so the API can additionally report:
#   - "signalPct": % move from that entry price to the current LTP.
#   - "rFactor": that same move expressed in units of the entry-time daily
#     ATR(14) - a rough stand-in for the classic trading "R" (risk unit,
#     normally entry-price minus a manual stop-loss; here ATR(14) plays that
#     role since there's no user-set stop). Both are raw (not sign-flipped
#     for sell/bearish signals) - a bearish stock that kept falling shows a
#     negative signalPct/rFactor, matching how these numbers read on the
#     third-party scanners this was modeled after.
#
# In-memory only, reset at day-rollover - NOT persisted to disk like the
# intraday candle history is. A backend restart during market hours loses
# today's "first seen" clocks (and their entry price/ATR snapshots) and they
# start fresh from the restart time; a lower-stakes gap than losing candle
# history, so not worth the extra persistence machinery.
FIRST_SEEN_DIRECTIONS = ("buy", "sell")

# ---------------------------------------------------------------------------
# F&O Stock List (Volume & RSI) - a published screener's liquidity/valuation
# filter, with Volume and daily RSI(14) shown for reference (RSI isn't
# actually one of the filter conditions, despite the name). 4 of its 5
# conditions use data we already have (ffmc = free-float market cap, price,
# volume, yearLow - all from the same NIFTY 500 snapshot used everywhere
# else). The 5th - ROCE vs its 3-year average - needs financial-statement
# data (EBIT / Capital Employed, 3 years of it) with no accessible NSE
# source, so it's intentionally NOT applied - see get_fo_stock_list.
FO_STOCK_LIST_MCAP_CR_MIN = 30000
FO_STOCK_LIST_LIQUIDITY_MAX = 3000
FO_STOCK_LIST_TURNOVER_MIN = 500_000_000
FO_STOCK_LIST_UP_FROM_LOW_MAX = 200


class NSEFetchError(RuntimeError):
    """Raised when NSE can't be reached or returns something unparseable."""


class _TTLCache:
    """A tiny in-memory cache so many browser tabs polling every ~20s don't
    each trigger a fresh NSE round trip. Not thread-safe beyond the GIL,
    which is fine for this use."""

    def __init__(self):
        self._store: dict[str, tuple[float, Any]] = {}

    def get(self, key: str, ttl: float):
        hit = self._store.get(key)
        if hit is None:
            return None
        ts, value = hit
        if time.time() - ts > ttl:
            return None
        return value

    def set(self, key: str, value: Any):
        self._store[key] = (time.time(), value)


class NSEClient:
    def __init__(self):
        self._session = requests.Session()
        self._session.headers.update(HEADERS)
        adapter = HTTPAdapter(pool_connections=20, pool_maxsize=20)
        self._session.mount("https://", adapter)
        self._bootstrapped_at = 0.0
        self._lock = threading.Lock()
        self._cache = _TTLCache()

        # ORB tracker state: window (minutes) -> symbol -> captured range.
        self._orb_lock = threading.Lock()
        self._orb_date: dt.date | None = None
        self._orb_ranges: dict[int, dict[str, dict]] = {w: {} for w in ORB_WINDOWS_MIN}

        # Tick history: symbol -> [(epoch_seconds, lastPrice, cumulativeVolume), ...],
        # one sample per poll (~20s) during market hours. This is the raw
        # material the Buy/Sell scanner's hourly candles are bucketed from -
        # NSE has no accessible intraday-candle endpoint, so we make our own.
        self._tick_lock = threading.Lock()
        self._tick_date: dt.date | None = None
        self._tick_history: dict[str, list[tuple[float, float, float]]] = {}

        # Intraday candle history (one series per timeframe in
        # INTRADAY_TIMEFRAMES), persisted to disk so it survives restarts
        # and accumulates across trading days.
        self._intraday_lock = threading.Lock()
        self._intraday_history: dict[int, dict[str, list[dict]]] = {
            tf: self._load_intraday_history(tf) for tf in INTRADAY_TIMEFRAMES
        }
        self._intraday_persisted_today: dict[int, dict[str, int]] = {
            tf: {} for tf in INTRADAY_TIMEFRAMES
        }
        self._intraday_persisted_date: dt.date | None = None

        # "Entered at" tracking (see FIRST_SEEN_DIRECTIONS above) - symbol ->
        # "HH:MM:SS" (IST) it first started qualifying today, per scanner.
        self._first_seen_lock = threading.Lock()
        self._first_seen_date: dt.date | None = None
        self._orb_first_seen: dict[int, dict[str, str]] = {w: {} for w in ORB_WINDOWS_MIN}
        self._buysell_first_seen: dict[tuple[str, int], dict[str, str]] = {
            (d, tf): {} for d in FIRST_SEEN_DIRECTIONS for tf in INTRADAY_TIMEFRAMES
        }
        self._breakout_first_seen: dict[str, dict[str, str]] = {d: {} for d in FIRST_SEEN_DIRECTIONS}

        threading.Thread(target=self._orb_loop, daemon=True, name="orb-tracker").start()

    @staticmethod
    def _intraday_history_path(tf: int) -> pathlib.Path:
        return pathlib.Path(INTRADAY_HISTORY_PATH_TMPL.format(tf))

    @staticmethod
    def _load_intraday_history(tf: int) -> dict[str, list[dict]]:
        try:
            with open(NSEClient._intraday_history_path(tf)) as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}

    def _save_intraday_history(self, tf: int):
        try:
            path = self._intraday_history_path(tf)
            tmp = path.with_suffix(".tmp")
            with open(tmp, "w") as f:
                json.dump(self._intraday_history[tf], f)
            tmp.replace(path)
        except OSError:
            pass  # persistence is best-effort - losing a write just delays warm-up

    # -- ORB background tracker ----------------------------------------------

    def _orb_loop(self):
        while True:
            try:
                self._orb_tick()
            except Exception:
                pass  # never let a bad NSE response kill the tracker thread
            time.sleep(20)

    def _orb_tick(self):
        now = dt.datetime.now(IST)
        if now.weekday() >= 5:  # Sat/Sun - no session (holidays aren't handled)
            return
        market_open = now.replace(
            hour=MARKET_OPEN_HOUR, minute=MARKET_OPEN_MINUTE, second=0, microsecond=0
        )
        market_close = now.replace(
            hour=MARKET_CLOSE_HOUR, minute=MARKET_CLOSE_MINUTE, second=0, microsecond=0
        )
        if now < market_open or now > market_close:
            return

        with self._orb_lock:
            if self._orb_date != now.date():
                self._orb_ranges = {w: {} for w in ORB_WINDOWS_MIN}
                self._orb_date = now.date()
            pending = [
                w
                for w in ORB_WINDOWS_MIN
                if now >= market_open + dt.timedelta(minutes=w) and not self._orb_ranges[w]
            ]

        # Always fetch + record ticks (not just when an ORB window is due) -
        # this is what feeds the EMA/VWAP scanner's self-built candles.
        fo_symbols = self._fo_universe()
        rows = {r.get("symbol"): r for r in self._fo_quote_rows()}

        with self._tick_lock:
            if self._tick_date != now.date():
                self._tick_history = {}
                self._tick_date = now.date()
            ts = now.timestamp()
            for sym in fo_symbols:
                row = rows.get(sym)
                if row is None:
                    continue
                price, vol = row.get("lastPrice"), row.get("totalTradedVolume")
                if price is None or vol is None:
                    continue
                self._tick_history.setdefault(sym, []).append((ts, price, vol))

        self._persist_completed_intraday_candles(now, market_open)
        self._track_scanner_entries(now, rows)

        if not pending:
            return

        with self._orb_lock:
            for w in pending:
                if self._orb_ranges[w]:
                    continue  # captured by a concurrent tick already
                cutoff = market_open + dt.timedelta(minutes=w)
                label = f"{market_open:%H:%M}–{cutoff:%H:%M}"
                captured = {}
                for sym in fo_symbols:
                    row = rows.get(sym)
                    if row is None or row.get("dayHigh") is None or row.get("dayLow") is None:
                        continue
                    captured[sym] = {
                        "orbHigh": row["dayHigh"],
                        "orbLow": row["dayLow"],
                        "orbTime": label,
                    }
                if captured:
                    self._orb_ranges[w] = captured

    def _persist_completed_intraday_candles(self, now: dt.datetime, market_open: dt.datetime):
        """Bucket today's ticks into candles at every INTRADAY_TIMEFRAMES
        size and append any newly-completed ones to each size's on-disk
        history. Runs every tick (~20s) but only actually writes on the
        handful of occasions per day each timeframe's bar completes."""
        with self._intraday_lock:
            if self._intraday_persisted_date != now.date():
                self._intraday_persisted_today = {tf: {} for tf in INTRADAY_TIMEFRAMES}
                self._intraday_persisted_date = now.date()

        with self._tick_lock:
            snapshot = {sym: list(v) for sym, v in self._tick_history.items()}

        market_open_ts = market_open.timestamp()
        for tf in INTRADAY_TIMEFRAMES:
            changed = False
            with self._intraday_lock:
                for sym, ticks in snapshot.items():
                    candles = self._bucket_candles(ticks, tf, market_open_ts)
                    done = self._intraday_persisted_today[tf].get(sym, 0)
                    if len(candles) <= done:
                        continue
                    bucket = self._intraday_history[tf].setdefault(sym, [])
                    for c in candles[done:]:
                        bucket.append({"date": now.date().isoformat(), **c})
                    if len(bucket) > INTRADAY_HISTORY_MAX_BARS:
                        del bucket[: len(bucket) - INTRADAY_HISTORY_MAX_BARS]
                    self._intraday_persisted_today[tf][sym] = len(candles)
                    changed = True
                if changed:
                    self._save_intraday_history(tf)

    # -- "Entered at" tracking (see FIRST_SEEN_DIRECTIONS above) -------------

    def _reset_first_seen_if_new_day(self, today: dt.date):
        with self._first_seen_lock:
            if self._first_seen_date != today:
                self._orb_first_seen = {w: {} for w in ORB_WINDOWS_MIN}
                self._buysell_first_seen = {
                    (d, tf): {} for d in FIRST_SEEN_DIRECTIONS for tf in INTRADAY_TIMEFRAMES
                }
                self._breakout_first_seen = {d: {} for d in FIRST_SEEN_DIRECTIONS}
                self._first_seen_date = today

    @staticmethod
    def _atr(bars: list[dict], period: int) -> float | None:
        """Average True Range over the last `period` bars of an ascending
        (oldest-first) OHLC series - needs `period + 1` bars (one extra for
        the first bar's "previous close"). Returns None if there isn't
        enough history yet."""
        if len(bars) < period + 1:
            return None
        window = bars[-period:]
        trs = []
        for i, bar in enumerate(window):
            prev_close = bars[-period - 1 + i]["close"]
            trs.append(
                max(
                    bar["high"] - bar["low"],
                    abs(bar["high"] - prev_close),
                    abs(bar["low"] - prev_close),
                )
            )
        return sum(trs) / period

    @staticmethod
    def _update_first_seen(
        bucket: dict[str, dict], qualifying: set[str], now_str: str, prices: dict[str, float], atrs: dict[str, float]
    ):
        """`bucket` (symbol -> {"time": "HH:MM:SS", "entryPrice": float,
        "entryAtr": float | None} it first qualified today) is mutated in
        place: drop any symbol that stopped qualifying (so a later re-entry
        gets a fresh timestamp/price instead of its earlier one), then stamp
        any newly-qualifying symbol with `now_str` and its current LTP/ATR."""
        for sym in list(bucket):
            if sym not in qualifying:
                del bucket[sym]
        for sym in qualifying:
            if sym not in bucket and prices.get(sym) is not None:
                bucket[sym] = {"time": now_str, "entryPrice": prices[sym], "entryAtr": atrs.get(sym)}

    @staticmethod
    def _entry_metrics(entry: dict | None, ltp: float | None) -> dict:
        """Given a first-seen entry ({"time", "entryPrice", "entryAtr"} or
        None) and the current LTP, returns the "since" / "signalPct" /
        "rFactor" trio the API rows expose - see the FIRST_SEEN_DIRECTIONS
        comment above for what these mean. All three are None when the
        stock isn't currently qualifying (entry is None)."""
        if entry is None:
            return {"since": None, "signalPct": None, "rFactor": None}
        entry_price = entry.get("entryPrice")
        signal_pct = round((ltp - entry_price) / entry_price * 100, 2) if ltp is not None and entry_price else None
        entry_atr = entry.get("entryAtr")
        r_factor = round((ltp - entry_price) / entry_atr, 2) if ltp is not None and entry_price and entry_atr else None
        return {"since": entry.get("time"), "signalPct": signal_pct, "rFactor": r_factor}

    def _track_scanner_entries(self, now: dt.datetime, rows: dict[str, dict]):
        """Runs every ~20s tick (see _orb_tick) - recomputes which symbols
        currently qualify for the ORB / Buy-Sell / 15-Min Breakout scanners,
        using the exact same pass/fail logic get_orb / get_scanner /
        get_breakout_scanner use below, and records the first clock-time
        each one started qualifying today."""
        self._reset_first_seen_if_new_day(now.date())
        now_str = now.strftime("%H:%M:%S")
        prices = {sym: row.get("lastPrice") for sym, row in rows.items() if row.get("lastPrice") is not None}
        daily_history = self._get_daily_history()
        atrs = {sym: self._atr(bars, DAILY_ATR_PERIOD) for sym, bars in daily_history.items()}

        # -- ORB: reuse the ranges this same tick already captured ------------
        with self._orb_lock:
            ranges_by_window = {w: dict(self._orb_ranges[w]) for w in ORB_WINDOWS_MIN}
        with self._first_seen_lock:
            for w, ranges in ranges_by_window.items():
                qualifying = set()
                for sym, rng in ranges.items():
                    row = rows.get(sym)
                    ltp = row.get("lastPrice") if row else None
                    if ltp is None:
                        continue
                    if ltp > rng["orbHigh"] or ltp < rng["orbLow"]:
                        qualifying.add(sym)
                self._update_first_seen(self._orb_first_seen[w], qualifying, now_str, prices, atrs)

        # -- Buy/Sell + 15-Min Breakout: share the same per-timeframe candles -
        fo_symbols = self._fo_universe()
        buysell_qualifying: dict[tuple[str, int], set[str]] = {
            (d, tf): set() for d in FIRST_SEEN_DIRECTIONS for tf in INTRADAY_TIMEFRAMES
        }
        breakout_qualifying: dict[str, set[str]] = {d: set() for d in FIRST_SEEN_DIRECTIONS}

        for sym in fo_symbols:
            if sym not in rows:
                continue
            daily_signals = {
                d: self._timeframe_signal(
                    daily_history.get(sym, []), d, DAILY_SMA_PERIOD, DAILY_RSI_PERIOD, DAILY_LOOKBACK_DAYS
                )
                for d in FIRST_SEEN_DIRECTIONS
            }
            for tf in INTRADAY_TIMEFRAMES:
                candles = self._intraday_candles_for(sym, tf)
                for d in FIRST_SEEN_DIRECTIONS:
                    daily = daily_signals[d]
                    if daily is None or not daily["pass"]:
                        continue
                    intraday = self._timeframe_signal(
                        candles, d, INTRADAY_SMA_PERIOD, INTRADAY_RSI_PERIOD, INTRADAY_LOOKBACK_BARS
                    )
                    if intraday is not None and intraday["pass"]:
                        buysell_qualifying[(d, tf)].add(sym)
                if tf == BREAKOUT_TIMEFRAME_MIN:
                    for d in FIRST_SEEN_DIRECTIONS:
                        signal = self._breakout_signal(candles, d, BREAKOUT_LOOKBACK_PERIOD)
                        if signal is not None and signal["pass"]:
                            breakout_qualifying[d].add(sym)

        with self._first_seen_lock:
            for key, qualifying in buysell_qualifying.items():
                self._update_first_seen(self._buysell_first_seen[key], qualifying, now_str, prices, atrs)
            for d, qualifying in breakout_qualifying.items():
                self._update_first_seen(self._breakout_first_seen[d], qualifying, now_str, prices, atrs)

    def get_orb_status(self) -> list[dict]:
        """Whether each window's range has formed yet today, and its
        clock-time label - shown even before/without any captured data."""
        now = dt.datetime.now(IST)
        market_open = now.replace(
            hour=MARKET_OPEN_HOUR, minute=MARKET_OPEN_MINUTE, second=0, microsecond=0
        )
        with self._orb_lock:
            captured_today = self._orb_date == now.date()
            out = []
            for w in ORB_WINDOWS_MIN:
                cutoff = market_open + dt.timedelta(minutes=w)
                out.append(
                    {
                        "window": w,
                        "label": f"{market_open:%H:%M}–{cutoff:%H:%M}",
                        "formed": captured_today and bool(self._orb_ranges[w]),
                    }
                )
        return out

    def get_orb(self, window: int) -> dict:
        if window not in ORB_WINDOWS_MIN:
            raise ValueError(f"unknown ORB window {window!r}")

        with self._orb_lock:
            captured_today = self._orb_date == dt.datetime.now(IST).date()
            ranges = dict(self._orb_ranges[window]) if captured_today else {}

        if not ranges:
            return {"window": window, "formed": False, "demo": False, "stocks": []}

        rows = {r.get("symbol"): r for r in self._fo_quote_rows()}
        with self._first_seen_lock:
            first_seen = dict(self._orb_first_seen.get(window, {}))
        stocks = []
        for sym, rng in ranges.items():
            row = rows.get(sym)
            if row is None:
                continue
            ltp = row.get("lastPrice")
            orb_high, orb_low = rng["orbHigh"], rng["orbLow"]
            if ltp is None or orb_high is None or orb_low is None:
                continue
            if ltp > orb_high:
                breakout, breakout_price = "up", orb_high
            elif ltp < orb_low:
                breakout, breakout_price = "down", orb_low
            else:
                breakout, breakout_price = "none", None
            entry = first_seen.get(sym) if breakout != "none" else None
            stocks.append(
                {
                    "symbol": sym,
                    "sector": self._sector_for(sym),
                    "orbTime": rng["orbTime"],
                    "orbHigh": orb_high,
                    "orbLow": orb_low,
                    "ltp": ltp,
                    "pChange": row.get("pChange"),
                    "breakout": breakout,
                    "breakoutPrice": breakout_price,
                    # "HH:MM:SS" (IST) this symbol first broke out today, or
                    # None if it's inside range or the background tracker
                    # hasn't caught up yet (e.g. right after a restart). Plus
                    # signalPct/rFactor - see the FIRST_SEEN_DIRECTIONS
                    # comment above (not currently shown in the ORB UI, but
                    # available here like the other two scanners).
                    **self._entry_metrics(entry, ltp),
                }
            )

        # Breakouts first (up before down), then by move size within each group.
        order = {"up": 0, "down": 1, "none": 2}
        stocks.sort(key=lambda s: (order[s["breakout"]], -abs(s.get("pChange") or 0)))
        return {"window": window, "formed": True, "demo": False, "stocks": stocks}

    # -- Buy/Sell scanner: candle building + EMA/VWAP math -------------------

    @staticmethod
    def _bucket_candles(
        ticks: list[tuple[float, float, float]], bucket_minutes: int, market_open_ts: float
    ) -> list[dict]:
        """Bucket (ts, price, cumVol) ticks into OHLCV candles of the given
        size. Only fully-elapsed buckets are returned - a bucket still in
        progress (the current partial bar) is dropped, so [0]/[1] indexing
        always refers to genuinely completed bars."""
        if not ticks:
            return []
        bucket_sec = bucket_minutes * 60
        buckets: dict[int, dict] = {}
        for ts, price, cum_vol in ticks:
            idx = int((ts - market_open_ts) // bucket_sec)
            b = buckets.setdefault(idx, {"prices": [], "cum_vols": []})
            b["prices"].append(price)
            b["cum_vols"].append(cum_vol)

        candles = []
        prev_cum_vol = None
        for idx in sorted(buckets):
            b = buckets[idx]
            last_cum = b["cum_vols"][-1]
            volume = max(last_cum - prev_cum_vol, 0) if prev_cum_vol is not None else last_cum
            prev_cum_vol = last_cum
            candles.append(
                {
                    "idx": idx,
                    "open": b["prices"][0],
                    "high": max(b["prices"]),
                    "low": min(b["prices"]),
                    "close": b["prices"][-1],
                    "volume": volume,
                }
            )

        now_idx = int((time.time() - market_open_ts) // bucket_sec)
        if candles and candles[-1]["idx"] >= now_idx:
            candles.pop()  # still-forming current bar - not a completed candle yet
        return candles

    @staticmethod
    def _rsi(closes: list[float], period: int) -> float | None:
        """RSI over the trailing `period` changes in `closes` (simple
        average gain/loss, not full Wilder smoothing back to inception -
        the standard simplification when only a trailing window of history
        is available, and what most tools show once enough bars exist)."""
        if len(closes) < period + 1:
            return None
        diffs = [closes[i] - closes[i - 1] for i in range(len(closes) - period, len(closes))]
        gains = sum(d for d in diffs if d > 0)
        losses = sum(-d for d in diffs if d < 0)
        avg_gain, avg_loss = gains / period, losses / period
        if avg_loss == 0:
            return 100.0
        rs = avg_gain / avg_loss
        return 100 - (100 / (1 + rs))

    # -- Shared indicator math -------------------------------------------------

    @staticmethod
    def _sma(values: list[float], period: int) -> float | None:
        if len(values) < period:
            return None
        return sum(values[-period:]) / period

    @staticmethod
    def _trend_20d(candles: list[dict]) -> str | None:
        """Uptrend/Downtrend/Neutral read from the last DAILY_SMA_PERIOD
        (20) daily candles: needs BOTH the latest close on the right side
        of its own SMA(20) AND a net % move over that window past
        TREND_20D_NEUTRAL_BAND_PCT - a lone SMA cross without real
        follow-through (or a real move that hasn't crossed the SMA yet)
        reads as Neutral rather than flipping the label on noise. None if
        there isn't a full 20-day window yet."""
        period = DAILY_SMA_PERIOD
        if len(candles) < period:
            return None
        closes = [c["close"] for c in candles[-period:]]
        first, latest = closes[0], closes[-1]
        if not first:
            return None
        sma = sum(closes) / period
        pct_move = ((latest - first) / first) * 100
        if latest > sma and pct_move > TREND_20D_NEUTRAL_BAND_PCT:
            return "Uptrend"
        if latest < sma and pct_move < -TREND_20D_NEUTRAL_BAND_PCT:
            return "Downtrend"
        return "Neutral"

    @staticmethod
    def _ema_series(values: list[float], period: int) -> list[float | None]:
        """Full EMA series, same length as `values` - the first `period - 1`
        entries are None (not enough history yet). Seeded with the SMA of
        the first `period` values, the standard convention when there's no
        earlier history to seed from."""
        if len(values) < period:
            return [None] * len(values)
        k = 2 / (period + 1)
        out: list[float | None] = [None] * (period - 1)
        seed = sum(values[:period]) / period
        out.append(seed)
        prev = seed
        for v in values[period:]:
            prev = v * k + prev * (1 - k)
            out.append(prev)
        return out

    @staticmethod
    def _ema_latest(values: list[float], period: int) -> float | None:
        series = NSEClient._ema_series(values, period)
        return series[-1] if series else None

    def _fetch_bhavcopy_day(self, day: dt.date) -> dict | None:
        """One day's NSE Bhavcopy (EOD settlement) archive: real daily OHLC
        for every EQ-series stock. Unlike NSE's JSON APIs, this static-file
        archive isn't behind bot-protection - confirmed working directly.
        Returns None for non-trading days (weekends/holidays) or dates not
        yet published, so the caller just skips and tries the day before."""
        url = BHAVCOPY_URL_TMPL.format(day)
        try:
            resp = self._session.get(url, timeout=15)
        except requests.RequestException:
            return None
        if resp.status_code != 200 or len(resp.content) < 5000:
            return None
        text = resp.content.decode("utf-8", errors="replace")
        rows: dict[str, dict] = {}
        real_date = None
        for raw_row in csv.DictReader(io.StringIO(text)):
            row = {k.strip(): v.strip() for k, v in raw_row.items() if k}
            if row.get("SERIES") != "EQ":
                continue
            sym = row.get("SYMBOL")
            if not sym:
                continue
            try:
                rows[sym] = {
                    "open": float(row["OPEN_PRICE"]),
                    "high": float(row["HIGH_PRICE"]),
                    "low": float(row["LOW_PRICE"]),
                    "close": float(row["CLOSE_PRICE"]),
                    "volume": int(float(row["TTL_TRD_QNTY"])),
                }
                real_date = row.get("DATE1")
            except (KeyError, ValueError):
                continue
        if not rows or not real_date:
            return None
        return {"date": real_date, "rows": rows}

    def _build_daily_history(self) -> dict[str, list[dict]]:
        """symbol -> ascending list of real daily candles (oldest first),
        built from up to DAILY_HISTORY_MAX_CHECKED calendar days of Bhavcopy
        so DAILY_HISTORY_TARGET_DAYS real trading days are available even
        accounting for weekends and holidays. Cached for hours - a given
        date's file never changes, and a new one only appears after that
        day's session closes."""
        by_date: dict[str, dict[str, dict]] = {}
        day = dt.datetime.now(IST).date()
        checked = 0
        while len(by_date) < DAILY_HISTORY_TARGET_DAYS and checked < DAILY_HISTORY_MAX_CHECKED:
            result = self._fetch_bhavcopy_day(day)
            checked += 1
            if result and result["date"] not in by_date:
                by_date[result["date"]] = result["rows"]
            day -= dt.timedelta(days=1)

        def parse_date(s: str) -> dt.date:
            return dt.datetime.strptime(s, "%d-%b-%Y").date()

        ordered_dates = sorted(by_date.keys(), key=parse_date)
        fo_symbols = self._fo_universe()
        history: dict[str, list[dict]] = {sym: [] for sym in fo_symbols}
        for date_str in ordered_dates:
            day_rows = by_date[date_str]
            for sym in fo_symbols:
                row = day_rows.get(sym)
                if row:
                    history[sym].append({"date": date_str, **row})
        return history

    def _get_daily_history(self) -> dict[str, list[dict]]:
        return self._cached("daily-history", 6 * 3600.0, self._build_daily_history)

    @staticmethod
    def _timeframe_signal(candles: list[dict], direction: str, sma_period: int, rsi_period: int, lookback: int) -> dict | None:
        """Shared SMA/RSI/N-bar-range check for both the daily and hourly
        timeframes - same rule, just applied to whichever candle series is
        passed in. Returns None if there isn't enough history yet."""
        needed = max(sma_period, rsi_period) + 1
        if len(candles) < needed or len(candles) < lookback + 1:
            return None
        closes = [c["close"] for c in candles]
        sma = sum(closes[-sma_period:]) / sma_period
        rsi = NSEClient._rsi(closes, rsi_period)
        if rsi is None:
            return None
        latest_close = closes[-1]
        prior = candles[-1 - lookback : -1]  # the `lookback` bars before today/this-hour
        if direction == "buy":
            sma_pass = latest_close > sma
            range_pass = all(latest_close > c["high"] for c in prior)
            rsi_pass = rsi > 60
        else:
            sma_pass = latest_close < sma
            range_pass = all(latest_close < c["low"] for c in prior)
            rsi_pass = rsi < 40
        return {
            "close": latest_close,
            "sma": round(sma, 2),
            "rsi": round(rsi, 2),
            "smaPass": sma_pass,
            "rangePass": range_pass,
            "rsiPass": rsi_pass,
            "pass": sma_pass and range_pass and rsi_pass,
            "barsAvailable": len(candles),
        }

    def _intraday_candles_for(self, symbol: str, tf: int) -> list[dict]:
        """Persisted history at timeframe `tf` plus today's freshly-rebuilt
        candles (persistence lags the live tick data by up to one ~20s tick)."""
        now = dt.datetime.now(IST)
        today_str = now.date().isoformat()
        market_open = now.replace(
            hour=MARKET_OPEN_HOUR, minute=MARKET_OPEN_MINUTE, second=0, microsecond=0
        )
        with self._intraday_lock:
            history = [
                c for c in self._intraday_history[tf].get(symbol, []) if c.get("date") != today_str
            ]
        with self._tick_lock:
            ticks = list(self._tick_history.get(symbol, []))
        todays = self._bucket_candles(ticks, tf, market_open.timestamp())
        return history + [{"date": today_str, **c} for c in todays]

    def get_scanner_status(self) -> dict:
        """How far along the daily (Bhavcopy-backed, ready almost
        immediately) history is, plus each intraday timeframe's self-tracked
        + persisted history (15-min alone can fill up within one session;
        30/45/60-min need several trading days)."""
        daily_history = self._get_daily_history()
        daily_bars = max((len(v) for v in daily_history.values()), default=0)
        daily_needed = max(DAILY_SMA_PERIOD, DAILY_RSI_PERIOD) + 1
        intraday_needed = max(INTRADAY_SMA_PERIOD, INTRADAY_RSI_PERIOD) + 1
        timeframes = {}
        with self._intraday_lock:
            for tf in INTRADAY_TIMEFRAMES:
                bars = max((len(v) for v in self._intraday_history[tf].values()), default=0)
                timeframes[str(tf)] = {
                    "barsAvailable": bars,
                    "barsNeeded": intraday_needed,
                    "ready": bars >= intraday_needed,
                }
        return {
            "dailyBarsAvailable": daily_bars,
            "dailyBarsNeeded": daily_needed,
            "dailyReady": daily_bars >= daily_needed,
            "timeframes": timeframes,
        }

    def get_scanner(self, direction: str, timeframe: int = 60) -> dict:
        """direction: 'buy' (Bullish Intraday Stock) or 'sell' (Bearish
        Intraday Scanner); timeframe: 15/30/45/60 (minutes) for the intraday
        leg. See module docstring for the exact 14-condition rule (7 daily +
        7 intraday) this implements, sourced from a real third-party
        scanner's published filter definitions."""
        if timeframe not in INTRADAY_TIMEFRAMES:
            raise ValueError(f"unknown timeframe {timeframe!r}")

        daily_history = self._get_daily_history()
        fo_symbols = self._fo_universe()
        rows = {r.get("symbol"): r for r in self._fo_quote_rows()}
        with self._first_seen_lock:
            first_seen = dict(self._buysell_first_seen.get((direction, timeframe), {}))

        results = []
        for sym in fo_symbols:
            row = rows.get(sym)
            if row is None:
                continue
            daily = self._timeframe_signal(
                daily_history.get(sym, []), direction, DAILY_SMA_PERIOD, DAILY_RSI_PERIOD, DAILY_LOOKBACK_DAYS
            )
            if daily is None:
                continue
            intraday = self._timeframe_signal(
                self._intraday_candles_for(sym, timeframe),
                direction,
                INTRADAY_SMA_PERIOD,
                INTRADAY_RSI_PERIOD,
                INTRADAY_LOOKBACK_BARS,
            )
            qualifies = bool(daily["pass"] and intraday and intraday["pass"])
            entry = first_seen.get(sym) if qualifies else None
            results.append(
                {
                    "symbol": sym,
                    "sector": self._sector_for(sym),
                    "ltp": row.get("lastPrice"),
                    "pChange": row.get("pChange"),
                    "dailyClose": daily["close"],
                    "dailySma20": daily["sma"],
                    "dailyRsi14": daily["rsi"],
                    "dailyPass": daily["pass"],
                    "intradayReady": intraday is not None,
                    "intradayClose": intraday["close"] if intraday else None,
                    "intradaySma20": intraday["sma"] if intraday else None,
                    "intradayRsi14": intraday["rsi"] if intraday else None,
                    "intradayPass": intraday["pass"] if intraday else None,
                    "qualifies": qualifies,
                    # "since" ("HH:MM:SS" IST this symbol first qualified today,
                    # both legs passing), "signalPct" (% move since then) and
                    # "rFactor" (that move in daily-ATR(14) units) - see the
                    # FIRST_SEEN_DIRECTIONS comment above. All None if not
                    # currently qualifying or the tracker hasn't caught up yet.
                    **self._entry_metrics(entry, row.get("lastPrice")),
                }
            )

        results.sort(key=lambda r: (not r["qualifies"], not r["dailyPass"], -abs(r.get("pChange") or 0)))
        return {
            "direction": direction,
            "timeframe": timeframe,
            "totalFOSymbols": len(fo_symbols),
            "dailySymbolsWithHistory": sum(1 for r in results),
            "status": self.get_scanner_status(),
            "stocks": results,
        }

    @staticmethod
    def _breakout_signal(candles: list[dict], direction: str, period: int) -> dict | None:
        """[0] close vs the rolling `period`-bar max(close) evaluated ONE
        bar back (candles[-1-period:-1], i.e. excluding the latest bar - the
        "[-1] Max(period, close)" in the source scanner), plus [0] volume
        vs [0] SMA(volume, period) (the last `period` bars INCLUDING the
        latest one - no "[-1]" prefix on that condition in the source)."""
        if len(candles) < period + 1:
            return None
        latest = candles[-1]
        prior_window = candles[-1 - period : -1]
        prior_max_close = max(c["close"] for c in prior_window)
        vol_sma = sum(c["volume"] for c in candles[-period:]) / period
        if direction == "buy":
            close_pass = latest["close"] > prior_max_close
            vol_pass = latest["volume"] > vol_sma
        else:
            close_pass = latest["close"] < prior_max_close
            vol_pass = latest["volume"] < vol_sma
        return {
            "close": latest["close"],
            "priorMaxClose": round(prior_max_close, 2),
            "volume": latest["volume"],
            "volSma": round(vol_sma, 2),
            "closePass": close_pass,
            "volPass": vol_pass,
            "pass": close_pass and vol_pass,
            "barsAvailable": len(candles),
        }

    def get_breakout_scanner_status(self) -> dict:
        with self._intraday_lock:
            bars = max(
                (len(v) for v in self._intraday_history[BREAKOUT_TIMEFRAME_MIN].values()), default=0
            )
        needed = BREAKOUT_LOOKBACK_PERIOD + 1
        return {"barsAvailable": bars, "barsNeeded": needed, "ready": bars >= needed}

    def get_breakout_scanner(self, direction: str) -> dict:
        """direction: 'buy' (15 Minute Stock Breakouts) or 'sell' (15 Min
        Bearish Breakout) - see the module comment above BREAKOUT_TIMEFRAME_MIN
        for the exact rule, replicated from two published Chartink scanners."""
        fo_symbols = self._fo_universe()
        rows = {r.get("symbol"): r for r in self._fo_quote_rows()}
        with self._first_seen_lock:
            first_seen = dict(self._breakout_first_seen.get(direction, {}))

        results = []
        for sym in fo_symbols:
            row = rows.get(sym)
            if row is None:
                continue
            candles = self._intraday_candles_for(sym, BREAKOUT_TIMEFRAME_MIN)
            signal = self._breakout_signal(candles, direction, BREAKOUT_LOOKBACK_PERIOD)
            if signal is None:
                continue
            results.append(
                {
                    "symbol": sym,
                    "sector": self._sector_for(sym),
                    "ltp": row.get("lastPrice"),
                    "pChange": row.get("pChange"),
                    "close15m": signal["close"],
                    "priorMaxClose20": signal["priorMaxClose"],
                    "volume15m": signal["volume"],
                    "volSma20": signal["volSma"],
                    "closePass": signal["closePass"],
                    "volPass": signal["volPass"],
                    "qualifies": signal["pass"],
                    # "since" / "signalPct" / "rFactor" - see the
                    # FIRST_SEEN_DIRECTIONS comment above. All None if not
                    # currently qualifying or the tracker hasn't caught up yet.
                    **self._entry_metrics(first_seen.get(sym) if signal["pass"] else None, row.get("lastPrice")),
                }
            )

        results.sort(key=lambda r: (not r["qualifies"], -abs(r.get("pChange") or 0)))
        return {
            "direction": direction,
            "totalFOSymbols": len(fo_symbols),
            "symbolsWithHistory": len(results),
            "status": self.get_breakout_scanner_status(),
            "stocks": results,
        }

    # -- Stock Verdict ("smart summary") -------------------------------------
    # No external AI call - just combines the signals this app already
    # computes elsewhere (Trend 20D, the Buy/Sell Scanner's daily+60-min
    # combo, the 15-Min Breakout scanner, ORB, and classic floor-trader
    # pivot levels) into one plain-language read for a single symbol,
    # on demand (click-to-open on a stock symbol, anywhere in either
    # frontend). Cheap: reuses cached daily/intraday history, no new
    # data fetching beyond the live quote snapshot already cached.

    @staticmethod
    def _pivot_levels(high: float, low: float, close: float) -> dict:
        """Classic floor-trader pivot points (PP, R1-R3, S1-S3) from the
        prior session's High/Low/Close - the same public, widely-used
        formula every charting site shows, not a guessed proprietary
        one."""
        pp = (high + low + close) / 3
        r1 = 2 * pp - low
        s1 = 2 * pp - high
        r2 = pp + (high - low)
        s2 = pp - (high - low)
        r3 = high + 2 * (pp - low)
        s3 = low - 2 * (high - pp)
        return {
            "pp": round(pp, 2),
            "r1": round(r1, 2),
            "r2": round(r2, 2),
            "r3": round(r3, 2),
            "s1": round(s1, 2),
            "s2": round(s2, 2),
            "s3": round(s3, 2),
        }

    @staticmethod
    def _pivot_position(ltp: float, pivot: dict) -> str:
        """Where the live LTP sits relative to the pivot ladder, as a
        short plain-language range - e.g. 'between Pivot and R1'."""
        if ltp >= pivot["r3"]:
            return "above R3"
        if ltp >= pivot["r2"]:
            return "between R2 and R3"
        if ltp >= pivot["r1"]:
            return "between R1 and R2"
        if ltp >= pivot["pp"]:
            return "between Pivot and R1"
        if ltp >= pivot["s1"]:
            return "between S1 and Pivot"
        if ltp >= pivot["s2"]:
            return "between S2 and S1"
        if ltp >= pivot["s3"]:
            return "between S3 and S2"
        return "below S3"

    def get_stock_verdict(self, symbol: str) -> dict:
        """On-demand smart summary for one symbol. `score` is just the net
        count of bullish-minus-bearish signals below (each +1/-1); +-2 or
        more before it's called Bullish/Bearish rather than Neutral, so a
        single stray signal doesn't flip the headline."""
        rows = {r.get("symbol"): r for r in self._fo_quote_rows()}
        row = rows.get(symbol)
        if row is None:
            raise NSEFetchError(f"no live quote for {symbol!r} (not in the F&O/NIFTY 500 snapshot)")
        ltp = row.get("lastPrice")

        daily_history = self._get_daily_history()
        daily_candles = daily_history.get(symbol, [])
        trend = self._trend_20d(daily_candles)

        buy_daily = self._timeframe_signal(daily_candles, "buy", DAILY_SMA_PERIOD, DAILY_RSI_PERIOD, DAILY_LOOKBACK_DAYS)
        sell_daily = self._timeframe_signal(daily_candles, "sell", DAILY_SMA_PERIOD, DAILY_RSI_PERIOD, DAILY_LOOKBACK_DAYS)
        intraday60_buy = self._timeframe_signal(
            self._intraday_candles_for(symbol, 60), "buy", INTRADAY_SMA_PERIOD, INTRADAY_RSI_PERIOD, INTRADAY_LOOKBACK_BARS
        )
        intraday60_sell = self._timeframe_signal(
            self._intraday_candles_for(symbol, 60), "sell", INTRADAY_SMA_PERIOD, INTRADAY_RSI_PERIOD, INTRADAY_LOOKBACK_BARS
        )
        buy_qualifies = bool(buy_daily and buy_daily["pass"] and intraday60_buy and intraday60_buy["pass"])
        sell_qualifies = bool(sell_daily and sell_daily["pass"] and intraday60_sell and intraday60_sell["pass"])

        breakout_candles = self._intraday_candles_for(symbol, BREAKOUT_TIMEFRAME_MIN)
        breakout_buy = self._breakout_signal(breakout_candles, "buy", BREAKOUT_LOOKBACK_PERIOD)
        breakout_sell = self._breakout_signal(breakout_candles, "sell", BREAKOUT_LOOKBACK_PERIOD)

        orb_status = None
        with self._orb_lock:
            captured_today = self._orb_date == dt.datetime.now(IST).date()
            ranges_by_window = {w: dict(self._orb_ranges[w]) for w in ORB_WINDOWS_MIN} if captured_today else {}
        if ltp is not None:
            for window in ORB_WINDOWS_MIN:
                rng = ranges_by_window.get(window, {}).get(symbol)
                if not rng:
                    continue
                if ltp > rng["orbHigh"]:
                    orb_status = {"window": window, "breakout": "up", "level": rng["orbHigh"]}
                    break
                if ltp < rng["orbLow"]:
                    orb_status = {"window": window, "breakout": "down", "level": rng["orbLow"]}
                    break

        pivot = self._pivot_levels(*[daily_candles[-1][k] for k in ("high", "low", "close")]) if daily_candles else None
        pivot_position = self._pivot_position(ltp, pivot) if (pivot and ltp is not None) else None

        score = 0
        reasons = []
        if trend == "Uptrend":
            score += 1
            reasons.append("Uptrend over the last 20 daily candles - above its 20-day SMA with a real net move up over that window")
        elif trend == "Downtrend":
            score -= 1
            reasons.append("Downtrend over the last 20 daily candles - below its 20-day SMA with a real net move down over that window")
        if buy_qualifies:
            score += 1
            reasons.append("Qualifies on the Buy/Sell Scanner's Bullish read (daily + 60-min SMA/RSI/range combo)")
        if sell_qualifies:
            score -= 1
            reasons.append("Qualifies on the Buy/Sell Scanner's Bearish read (daily + 60-min SMA/RSI/range combo)")
        if breakout_buy and breakout_buy["pass"]:
            score += 1
            reasons.append("Broke above its 20-bar 15-min range high, with volume above average (15-Min Breakout scanner)")
        if breakout_sell and breakout_sell["pass"]:
            score -= 1
            reasons.append("Broke below its 20-bar 15-min range low, with volume below average (15-Min Bearish Breakout rule)")
        if orb_status:
            level = round(orb_status["level"], 2)
            if orb_status["breakout"] == "up":
                score += 1
                reasons.append(f"Broke above its {orb_status['window']}-min Opening Range high (₹{level})")
            else:
                score -= 1
                reasons.append(f"Broke below its {orb_status['window']}-min Opening Range low (₹{level})")
        if pivot_position:
            reasons.append(f"Trading {pivot_position} (Pivot ₹{pivot['pp']})")

        verdict = "Bullish" if score >= 2 else "Bearish" if score <= -2 else "Neutral"

        return {
            "symbol": symbol,
            "sector": self._sector_for(symbol),
            "ltp": ltp,
            "pChange": row.get("pChange"),
            "verdict": verdict,
            "score": score,
            "reasons": reasons,
            "trend20d": trend,
            "buyQualifies": buy_qualifies,
            "sellQualifies": sell_qualifies,
            "breakout15m": {
                "buy": breakout_buy["pass"] if breakout_buy else None,
                "sell": breakout_sell["pass"] if breakout_sell else None,
                "ready": breakout_buy is not None or breakout_sell is not None,
            },
            "orb": orb_status,
            "pivot": pivot,
            "pivotPosition": pivot_position,
        }

    # -- session handling ---------------------------------------------------

    def _bootstrap(self, force: bool = False):
        with self._lock:
            if not force and (time.time() - self._bootstrapped_at) < 240:
                return
            try:
                resp = self._session.get(BOOTSTRAP_URL, timeout=15)
                if resp.status_code != 200:
                    raise NSEFetchError(
                        f"bootstrap failed: HTTP {resp.status_code}"
                    )
                self._bootstrapped_at = time.time()
            except requests.RequestException as exc:
                raise NSEFetchError(f"bootstrap failed: {exc}") from exc

    def _get_json(self, path: str, params: dict | None = None) -> Any:
        self._bootstrap()
        url = f"{BASE}{path}"
        last_exc: Exception | None = None
        for attempt in range(2):
            try:
                resp = self._session.get(url, params=params, timeout=15)
                if resp.status_code in (401, 403) or resp.status_code >= 500:
                    self._bootstrap(force=True)
                    continue
                if resp.status_code == 404:
                    raise NSEFetchError(f"{path} -> 404 (bad index/param?)")
                resp.raise_for_status()
                return resp.json()
            except (requests.RequestException, ValueError) as exc:
                last_exc = exc
                self._bootstrap(force=True)
        raise NSEFetchError(f"failed to fetch {path}: {last_exc}")

    def _cached(self, key: str, ttl: float, fn):
        hit = self._cache.get(key, ttl)
        if hit is not None:
            return hit
        value = fn()
        self._cache.set(key, value)
        return value

    # -- raw endpoint wrappers -----------------------------------------------

    def _all_indices(self) -> list[dict]:
        return self._cached(
            "allIndices",
            8.0,
            lambda: self._get_json("/api/allIndices")["data"],
        )

    def _index_constituents(self, index_symbol: str) -> list[dict]:
        return self._cached(
            f"idx:{index_symbol}",
            8.0,
            lambda: self._get_json(
                "/api/equity-stock-indices", {"index": index_symbol}
            )["data"],
        )

    def _fo_universe(self) -> set[str]:
        # The F&O security list barely changes intraday - cache for longer.
        return set(
            self._cached(
                "master-quote", 21600.0, lambda: self._get_json("/api/master-quote")
            )
        )

    def _variations(self, kind: str) -> dict:
        # kind: "gainers" or "loosers" (NSE's own spelling)
        return self._cached(
            f"variations:{kind}",
            8.0,
            lambda: self._get_json(
                "/api/live-analysis-variations", {"index": kind}
            ),
        )

    def _volume_spurts(self) -> list[dict]:
        return self._cached(
            "volume-spurts",
            20.0,
            lambda: self._get_json("/api/live-analysis-volume-gainers")["data"],
        )

    def _fo_quote_rows(self) -> list[dict]:
        """Live quote rows (price, %change, volume, free-float mcap, ...)
        for the entire F&O universe. Sourced from NIFTY 500 constituents -
        confirmed to fully cover all 208 F&O symbols - since NSE has no
        single bulk endpoint that returns live quotes for exactly the F&O
        list."""
        return self._cached(
            "idx:NIFTY 500", 15.0, lambda: self._index_constituents("NIFTY 500")
        )

    @staticmethod
    def _sector_for(symbol: str) -> str:
        return FO_SECTOR_MAP.get(symbol, UNCLASSIFIED_LABEL)

    @staticmethod
    def _shape_stock_row(r: dict) -> dict:
        return {
            "symbol": r.get("symbol"),
            "open": r.get("open"),
            "lastPrice": r.get("lastPrice"),
            "previousClose": r.get("previousClose"),
            "pChange": r.get("pChange"),
            "dayHigh": r.get("dayHigh"),
            "dayLow": r.get("dayLow"),
            "totalTradedVolume": r.get("totalTradedVolume"),
        }

    # -- public, feature-shaped methods --------------------------------------

    def get_heatmap(self) -> list[dict]:
        """One tile per NSE sectoral index, exactly as NSE's own site shows
        them - unfiltered (F&O and non-F&O stocks alike) and with no
        cross-sector dedup, using each index's own live price/%change
        straight from NSE."""
        rows = self._all_indices()
        wanted = set(HEATMAP_SECTOR_SYMBOLS)
        out = []
        for row in rows:
            sym = row.get("indexSymbol")
            if sym not in wanted:
                continue
            # NSE returns these as strings (e.g. "10", not 10) - and their
            # sum is exactly the index's constituent count, so this gives
            # us a stock count with no extra NSE call needed.
            def as_int(v):
                try:
                    return int(v)
                except (TypeError, ValueError):
                    return 0

            advances = as_int(row.get("advances"))
            declines = as_int(row.get("declines"))
            unchanged = as_int(row.get("unchanged"))
            out.append(
                {
                    "symbol": sym,
                    "stockCount": advances + declines + unchanged,
                    "last": row.get("last"),
                    "change": row.get("variation"),
                    "pChange": row.get("percentChange"),
                    "open": row.get("open"),
                    "advances": advances,
                    "declines": declines,
                    "unchanged": unchanged,
                }
            )
        order = {s: i for i, s in enumerate(HEATMAP_SECTOR_SYMBOLS)}
        out.sort(key=lambda r: order.get(r["symbol"], 999))
        return out

    def get_sector_stocks(self, sector_symbol: str) -> dict:
        if sector_symbol not in HEATMAP_SECTOR_SYMBOLS:
            raise ValueError(f"unknown sector {sector_symbol!r}")
        rows = self._index_constituents(sector_symbol)
        stocks = [r for r in rows if r.get("priority") != 1]
        stocks.sort(key=lambda r: r.get("pChange", 0), reverse=True)
        return {
            "sector": sector_symbol,
            "stocks": [self._shape_stock_row(r) for r in stocks],
        }

    def get_advance_decline(self) -> dict:
        """Advances/declines for Nifty 50 measured against TODAY'S OPEN
        (not previous close, which is what NSE's own 'advances/declines'
        counters on /allIndices measure)."""
        rows = self._index_constituents(NIFTY50_INDEX)
        stocks = [r for r in rows if r.get("priority") != 1]
        daily_history = self._get_daily_history()

        advances = declines = unchanged = 0
        details = []
        for r in stocks:
            open_px = r.get("open")
            last_px = r.get("lastPrice")
            if open_px in (None, 0) or last_px is None:
                continue
            chg_from_open = last_px - open_px
            pct_from_open = (chg_from_open / open_px) * 100
            year_high = r.get("yearHigh")
            year_low = r.get("yearLow")
            # Negative (or zero at the high itself) - LTP is at/below its
            # 52-week high; positive (or zero at the low itself) - LTP is
            # at/above its 52-week low.
            pct_from_year_high = round(((last_px - year_high) / year_high) * 100, 2) if year_high else None
            pct_from_year_low = round(((last_px - year_low) / year_low) * 100, 2) if year_low else None
            if chg_from_open > 0:
                advances += 1
                status = "advance"
            elif chg_from_open < 0:
                declines += 1
                status = "decline"
            else:
                unchanged += 1
                status = "unchanged"
            details.append(
                {
                    "symbol": r.get("symbol"),
                    "sector": self._sector_for(r.get("symbol")),
                    "open": open_px,
                    "lastPrice": last_px,
                    "changeFromOpen": round(chg_from_open, 2),
                    "pctFromOpen": round(pct_from_open, 2),
                    "status": status,
                    "dayHigh": r.get("dayHigh"),
                    "dayLow": r.get("dayLow"),
                    "yearHigh": year_high,
                    "yearLow": year_low,
                    "pctFromYearHigh": pct_from_year_high,
                    "pctFromYearLow": pct_from_year_low,
                    "trend20d": self._trend_20d(daily_history.get(r.get("symbol"), [])),
                }
            )
        details.sort(key=lambda d: d["pctFromOpen"], reverse=True)
        return {
            "advances": advances,
            "declines": declines,
            "unchanged": unchanged,
            "total": advances + declines + unchanged,
            "stocks": details,
        }

    def get_fo_gainers_losers(self) -> dict:
        gainers = self._variations("gainers").get("FOSec", {}).get("data", [])
        losers = self._variations("loosers").get("FOSec", {}).get("data", [])

        def shape(rows):
            return [
                {
                    "symbol": r.get("symbol"),
                    "lastPrice": r.get("ltp"),
                    "open": r.get("open_price"),
                    "previousClose": r.get("prev_price"),
                    "pChange": r.get("perChange", r.get("net_price")),
                    "tradeQuantity": r.get("trade_quantity"),
                    "sector": self._sector_for(r.get("symbol")),
                }
                for r in rows
            ]

        return {"gainers": shape(gainers), "losers": shape(losers)}

    def _most_active(self, kind: str) -> list[dict]:
        # kind: "volume" or "value"
        return self._cached(
            f"most-active:{kind}",
            15.0,
            lambda: self._get_json(
                "/api/live-analysis-most-active-securities", {"index": kind}
            )["data"],
        )

    def get_most_active(self) -> dict:
        """NSE's own "Most Active Equities" (By Volume / By Value),
        filtered to the F&O universe only - matching the rest of this
        dashboard. NSE's raw list is whole-market and capped at its own
        top 20, so filtering down to F&O names can leave relatively few
        rows on any given day (large, liquid F&O names don't always
        dominate NSE's own top-20-by-volume/value cut)."""
        fo_symbols = self._fo_universe()

        def shape(rows):
            return [
                {
                    "symbol": r.get("symbol"),
                    "sector": self._sector_for(r.get("symbol")),
                    "lastPrice": r.get("lastPrice"),
                    "pChange": r.get("pChange"),
                    "totalTradedVolume": r.get("totalTradedVolume"),
                    "totalTradedValue": r.get("totalTradedValue"),
                }
                for r in rows
                if r.get("symbol") in fo_symbols
            ]

        return {
            "byVolume": shape(self._most_active("volume")),
            "byValue": shape(self._most_active("value")),
        }

    def get_volume_gainers(self) -> dict:
        """NSE's own "Volume Gainers" (today's volume vs 1-week average),
        filtered to the F&O universe only. This is frequently empty - that
        NSE list is dominated by illiquid small caps spiking hard vs their
        own (low) average volume, which large, liquid F&O names rarely do -
        so an empty result here is expected, not a bug."""
        fo_symbols = self._fo_universe()
        rows = [r for r in self._volume_spurts() if r.get("symbol") in fo_symbols]
        return {
            "stocks": [
                {
                    "symbol": r.get("symbol"),
                    "sector": self._sector_for(r.get("symbol")),
                    "lastPrice": r.get("ltp"),
                    "pChange": r.get("pChange"),
                    "volume": r.get("volume"),
                    "week1AvgVolume": r.get("week1AvgVolume"),
                    "week1volChange": r.get("week1volChange"),
                }
                for r in rows
            ]
        }

    def _52_week(self, direction: str) -> list[dict]:
        # direction: "high" or "low"
        path = (
            "/api/live-analysis-data-52weekhighstock"
            if direction == "high"
            else "/api/live-analysis-data-52weeklowstock"
        )
        return self._cached(f"52week:{direction}", 300.0, lambda: self._get_json(path)["data"])

    def get_52_week(self) -> dict:
        """Stocks that just hit a new 52-week high/low, filtered to the
        F&O universe only. Large, liquid F&O names are usually less
        volatile than the broader market, so these lists (dominated by
        smaller-cap movers) often only have a handful of F&O matches."""
        fo_symbols = self._fo_universe()

        def shape(rows):
            return [
                {
                    "symbol": r.get("symbol"),
                    "sector": self._sector_for(r.get("symbol")),
                    "companyName": r.get("comapnyName"),  # NSE's own field name (sic)
                    "ltp": r.get("ltp"),
                    "pChange": r.get("pChange"),
                    "level": r.get("new52WHL"),
                    "levelDate": r.get("prevHLDate"),
                }
                for r in rows
                if r.get("symbol") in fo_symbols
            ]

        return {"high": shape(self._52_week("high")), "low": shape(self._52_week("low"))}

    def get_day_level_stocks(self, limit: int = 15) -> dict:
        """Stocks currently trading closest to TODAY's day-high or day-low
        ("Top Level Stocks" / "Low Level Stocks" on other scanner sites) -
        a same-session complement to the 52-week high/low panel above.
        Pure NSE snapshot data (dayHigh/dayLow/lastPrice, already fetched
        for every other panel) - no self-tracking or extra history needed.
        "diff" is dayHigh - LTP for the near-high list (LTP - dayLow for
        near-low) - the smaller it is, the closer the stock is trading to
        that extreme right now; 0.00 means it's sitting right at it."""
        fo_symbols = self._fo_universe()
        near_high, near_low = [], []
        for row in self._fo_quote_rows():
            sym = row.get("symbol")
            if sym not in fo_symbols:
                continue
            ltp = row.get("lastPrice")
            day_high = row.get("dayHigh")
            day_low = row.get("dayLow")
            if ltp is None or day_high is None or day_low is None:
                continue
            base = {
                "symbol": sym,
                "sector": self._sector_for(sym),
                "ltp": ltp,
                "pChange": row.get("pChange"),
                "dayHigh": day_high,
                "dayLow": day_low,
            }
            near_high.append({**base, "diff": round(day_high - ltp, 2)})
            near_low.append({**base, "diff": round(ltp - day_low, 2)})

        near_high.sort(key=lambda r: r["diff"])
        near_low.sort(key=lambda r: r["diff"])
        return {"high": near_high[:limit], "low": near_low[:limit]}

    def get_fo_stock_list(self) -> dict:
        """F&O Stock List (Volume & RSI) - see the module comment above
        FO_STOCK_LIST_MCAP_CR_MIN for what this is and the one condition
        (ROCE) deliberately left out. All 4 applied conditions use real
        data: ffmc (free-float market cap - note this is free-float, not
        total market cap, since that's what NSE's snapshot provides),
        price, volume, and yearLow, all from the F&O universe snapshot;
        RSI(14) is the same real daily-Bhavcopy-backed calculation the
        Bullish/Bearish scanner uses, shown here for reference only."""
        fo_symbols = self._fo_universe()
        daily_history = self._get_daily_history()
        rows = []
        for row in self._fo_quote_rows():
            sym = row.get("symbol")
            if sym not in fo_symbols:
                continue
            ltp = row.get("lastPrice")
            volume = row.get("totalTradedVolume")
            ffmc = row.get("ffmc")
            year_low = row.get("yearLow")
            if not ltp or not volume or not ffmc or not year_low:
                continue

            mcap_cr = ffmc / 1e7
            turnover = ltp * volume
            liquidity_ratio = (ffmc / turnover) if turnover > 0 else None
            up_from_low = ((ltp - year_low) / year_low) * 100

            mcap_pass = mcap_cr > FO_STOCK_LIST_MCAP_CR_MIN
            liquidity_pass = liquidity_ratio is not None and liquidity_ratio < FO_STOCK_LIST_LIQUIDITY_MAX
            turnover_pass = turnover > FO_STOCK_LIST_TURNOVER_MIN
            up_from_low_pass = up_from_low < FO_STOCK_LIST_UP_FROM_LOW_MAX

            closes = [c["close"] for c in daily_history.get(sym, [])]
            rsi14 = self._rsi(closes, DAILY_RSI_PERIOD)

            rows.append(
                {
                    "symbol": sym,
                    "sector": self._sector_for(sym),
                    "ltp": ltp,
                    "pChange": row.get("pChange"),
                    "volume": volume,
                    "rsi14": round(rsi14, 2) if rsi14 is not None else None,
                    "marketCapCr": round(mcap_cr, 1),
                    "liquidityRatio": round(liquidity_ratio, 1) if liquidity_ratio is not None else None,
                    "turnoverCr": round(turnover / 1e7, 2),
                    "upFromLowPct": round(up_from_low, 1),
                    "mcapPass": mcap_pass,
                    "liquidityPass": liquidity_pass,
                    "turnoverPass": turnover_pass,
                    "upFromLowPass": up_from_low_pass,
                    "qualifies": mcap_pass and liquidity_pass and turnover_pass and up_from_low_pass,
                }
            )

        rows.sort(key=lambda r: (not r["qualifies"], -r["marketCapCr"]))
        return {
            "roceApplied": False,
            "totalFOSymbols": len(fo_symbols),
            "symbolsWithData": len(rows),
            "stocks": rows,
        }

    def get_fo_scanner_list(self) -> dict:
        """The full F&O universe, one row per symbol, with everything the
        `/pro` F&O Scanner table shows: LTP, change (%/₹), volume, turnover
        value, sector, previous close, 52-week high/low - all real, no
        self-tracking, straight from the same NIFTY 500 snapshot every
        other panel uses (_fo_quote_rows). Deliberately does NOT include
        Open Interest - NSE has no confirmed-accessible OI endpoint used
        anywhere in this codebase; adding it would need real investigation
        first, not a placeholder/fake number.

        Two quick-filter flags are computed here rather than left to the
        frontend:
        - `highVolume`: symbol appears in NSE's own "Volume Gainers" list
          (today's volume vs 1-week average) - reuses _volume_spurts(),
          the same real data get_volume_gainers already exposes, rather
          than inventing a percentile threshold.
        - `breakout`: LTP is at/above the day's high AND up on the day - a
          simple "still trading at today's fresh high" signal (this app
          has no ORB/ intraday-breakout tracking in the /pro build).

        `marketCapCr` reuses the same `ffmc` (free-float market cap) field
        get_fo_stock_list already relies on - like that feature, it's
        free-float, not total market cap, since that's what NSE's snapshot
        provides; null when NSE doesn't have it for a symbol."""
        fo_symbols = self._fo_universe()
        high_volume_symbols = {r.get("symbol") for r in self._volume_spurts()}

        stocks = []
        advancers = decliners = unchanged = 0
        total_volume = 0
        for row in self._fo_quote_rows():
            sym = row.get("symbol")
            if sym not in fo_symbols:
                continue
            ltp = row.get("lastPrice")
            p_change = row.get("pChange")
            volume = row.get("totalTradedVolume")
            day_high = row.get("dayHigh")
            if ltp is None or p_change is None or volume is None:
                continue

            if p_change > 0:
                advancers += 1
            elif p_change < 0:
                decliners += 1
            else:
                unchanged += 1
            total_volume += volume

            value = row.get("totalTradedValue")
            ffmc = row.get("ffmc")
            stocks.append(
                {
                    "symbol": sym,
                    "sector": self._sector_for(sym),
                    "ltp": ltp,
                    "pChange": p_change,
                    "change": row.get("change"),
                    "volume": volume,
                    "valueCr": round(value / 1e7, 2) if value is not None else None,
                    "prevClose": row.get("previousClose"),
                    "yearHigh": row.get("yearHigh"),
                    "yearLow": row.get("yearLow"),
                    "dayHigh": day_high,
                    "dayLow": row.get("dayLow"),
                    "marketCapCr": round(ffmc / 1e7, 1) if ffmc else None,
                    "highVolume": sym in high_volume_symbols,
                    "breakout": bool(day_high is not None and ltp >= day_high and p_change > 0),
                }
            )

        stocks.sort(key=lambda r: -abs(r["pChange"]))
        return {
            "summary": {
                "total": len(stocks),
                "advancers": advancers,
                "decliners": decliners,
                "unchanged": unchanged,
                "totalVolumeCr": round(total_volume / 1e7, 2),
            },
            "stocks": stocks,
        }

    def get_market_overview(self) -> dict:
        """Top-of-dashboard index strip (NIFTY 50, NIFTY BANK, INDIA VIX)
        plus a same-session "Market Bias" reading built entirely from data
        already computed elsewhere in this app.

        This is NOT a prediction of what the market will do - it's a
        breadth/sentiment summary of the current/most recent session,
        clearly labelled as such in the UI. Two things a real pre-market
        view would normally include are deliberately left out because
        there's no reliable free source for them: SENSEX (BSE has no
        public JSON API the way NSE does) and global indices (Yahoo
        Finance's quote API is currently rate-limiting anonymous
        requests; no other free source was found).
        """
        rows = self._all_indices()
        by_symbol = {row.get("indexSymbol"): row for row in rows}

        def index_card(index_symbol: str) -> dict | None:
            row = by_symbol.get(index_symbol)
            if row is None:
                return None
            return {
                "symbol": index_symbol,
                "last": row.get("last"),
                "change": row.get("variation"),
                "pChange": row.get("percentChange"),
            }

        indices = [
            card
            for card in (
                index_card("NIFTY 50"),
                index_card("NIFTY BANK"),
                index_card("INDIA VIX"),
            )
            if card is not None
        ]

        def signal(value: float, invert: bool = False) -> tuple[str, int]:
            if invert:
                value = -value
            if value > 0:
                return "up", 1
            if value < 0:
                return "down", -1
            return "flat", 0

        factors = []
        score = 0

        nifty = by_symbol.get("NIFTY 50")
        if nifty is not None:
            p = nifty.get("percentChange") or 0
            sig, pts = signal(p)
            score += pts
            factors.append({"name": "Nifty 50", "detail": f"{p:+.2f}%", "signal": sig})

        vix = by_symbol.get("INDIA VIX")
        if vix is not None:
            p = vix.get("percentChange") or 0
            # Rising VIX = rising fear = a bearish signal, and vice versa -
            # "signal" below is the bias contribution (up=bullish), which
            # is the OPPOSITE of VIX's own raw direction, so spell that
            # out in the detail text rather than leaving it implicit.
            sig, pts = signal(p, invert=True)
            score += pts
            note = "falling = bullish" if p < 0 else "rising = bearish" if p > 0 else "flat"
            factors.append(
                {"name": "India VIX", "detail": f"{p:+.2f}% ({note})", "signal": sig}
            )

        ad = self.get_advance_decline()
        adv, dec = ad["advances"], ad["declines"]
        sig, pts = signal(adv - dec)
        score += pts
        factors.append(
            {
                "name": "Nifty 50 breadth (vs open)",
                "detail": f"{adv} up / {dec} down",
                "signal": sig,
            }
        )

        fo_symbols = self._fo_universe()
        fo_rows = [r for r in self._fo_quote_rows() if r.get("symbol") in fo_symbols]
        fo_up = sum(1 for r in fo_rows if (r.get("pChange") or 0) > 0)
        fo_down = sum(1 for r in fo_rows if (r.get("pChange") or 0) < 0)
        sig, pts = signal(fo_up - fo_down)
        score += pts
        factors.append(
            {
                "name": "F&O universe breadth",
                "detail": f"{fo_up} up / {fo_down} down",
                "signal": sig,
            }
        )

        heatmap = self.get_heatmap()
        sec_up = sum(1 for s in heatmap if (s.get("pChange") or 0) > 0)
        sec_down = sum(1 for s in heatmap if (s.get("pChange") or 0) < 0)
        sig, pts = signal(sec_up - sec_down)
        score += pts
        factors.append(
            {
                "name": "Sector breadth",
                "detail": f"{sec_up} up / {sec_down} down",
                "signal": sig,
            }
        )

        if score >= 2:
            label = "Bullish"
        elif score <= -2:
            label = "Bearish"
        else:
            label = "Neutral / Mixed"

        return {
            "indices": indices,
            "bias": {
                "label": label,
                "score": score,
                "maxScore": len(factors),
                "factors": factors,
            },
        }

    def get_sector_labels(self) -> list[str]:
        """Canonical list of every sector label the 'sector' field can
        take, for the frontend's filter dropdown."""
        return sorted(SECTOR_LIST)

    # Dead zone (in average % change) around zero that counts as "Neutral"
    # rather than Bullish/Bearish - avoids a sector flipping label on tiny,
    # directionless moves.
    SECTOR_BIAS_NEUTRAL_BAND = 0.1

    def get_sector_bias(self) -> dict:
        """Self-computed bullish/bearish/neutral read for every sector in
        SECTOR_LIST (the F&O-only, zero-overlap classification via
        FO_SECTOR_MAP - NOT NSE's own sectoral indices, which use a
        different, overlapping grouping - see HEATMAP_SECTOR_SYMBOLS above),
        from the average % change of that sector's own F&O stocks right now.
        Used to flag, next to a scanner row's "sector" column, whether the
        stock's own sector is currently trending with or against the
        signal - deliberately not sourced from the Heatmap's NSE sectoral
        indices, since those don't map 1:1 onto this app's sector buckets."""
        fo_symbols = self._fo_universe()
        rows = self._fo_quote_rows()

        by_sector: dict[str, list[float]] = {name: [] for name in SECTOR_LIST}
        by_sector[UNCLASSIFIED_LABEL] = []
        for row in rows:
            sym = row.get("symbol")
            if sym not in fo_symbols:
                continue
            p = row.get("pChange")
            if p is None:
                continue
            by_sector.setdefault(self._sector_for(sym), []).append(p)

        sectors = {}
        for sector, changes in by_sector.items():
            if not changes:
                sectors[sector] = {"label": "Neutral", "avgPChange": None, "up": 0, "down": 0, "count": 0}
                continue
            avg = sum(changes) / len(changes)
            up = sum(1 for c in changes if c > 0)
            down = sum(1 for c in changes if c < 0)
            if avg > self.SECTOR_BIAS_NEUTRAL_BAND:
                label = "Bullish"
            elif avg < -self.SECTOR_BIAS_NEUTRAL_BAND:
                label = "Bearish"
            else:
                label = "Neutral"
            sectors[sector] = {
                "label": label,
                "avgPChange": round(avg, 2),
                "up": up,
                "down": down,
                "count": len(changes),
            }
        return {"sectors": sectors}


client = NSEClient()
