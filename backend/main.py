from __future__ import annotations

import pathlib

from dotenv import load_dotenv

# Loads a local .env file if one exists (for local dev - e.g. FYERS_APP_ID/
# FYERS_APP_SECRET). Must run before the imports below, since nse_client
# reads NIFTY_DATA_DIR from the environment at import time. No-op in
# production (Render): no .env file is deployed there, and real env vars
# set in Render's dashboard are already in os.environ regardless.
load_dotenv()

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import fyers_client
from .nse_client import HEATMAP_SECTOR_SYMBOLS, SECTOR_LIST, NSEFetchError, client

FRONTEND_DIR = pathlib.Path(__file__).resolve().parent.parent / "frontend"
FRONTEND_PRO_DIR = pathlib.Path(__file__).resolve().parent.parent / "frontend_pro"

app = FastAPI(title="Nifty Sector Heatmap")
# Compresses JSON/text responses over ~500 bytes - the F&O volume payload
# (~208 stocks) shrinks noticeably over the wire.
app.add_middleware(GZipMiddleware, minimum_size=500)


@app.middleware("http")
async def _no_cache(request, call_next):
    """Neither StaticFiles (app.js/styles.css) nor the index.html FileResponse
    routes set Cache-Control, so browsers fall back to heuristic caching and
    can skip revalidation entirely for a while - editing frontend files and
    reloading doesn't reliably pick up the change, and the stale index.html
    then keeps pointing at whatever script/style URLs it originally loaded.
    Force revalidation on every response instead (still fast: ETag makes it
    a cheap 304 when nothing changed) - this is a live-data dashboard, so
    freshness matters more than shaving a round trip on static assets."""
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache"
    return response


def _wrap(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except NSEFetchError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/market-overview")
def market_overview():
    return _wrap(client.get_market_overview)


@app.get("/api/heatmap")
def heatmap():
    return {"sectors": _wrap(client.get_heatmap)}


@app.get("/api/sector")
def sector(symbol: str = Query(..., description="e.g. 'NIFTY AUTO'")):
    symbol = symbol.strip().upper()
    if symbol not in HEATMAP_SECTOR_SYMBOLS:
        raise HTTPException(status_code=404, detail=f"unknown sector {symbol!r}")
    return _wrap(client.get_sector_stocks, symbol)


@app.get("/api/advance-decline")
def advance_decline():
    return _wrap(client.get_advance_decline)


@app.get("/api/fo/gainers-losers")
def fo_gainers_losers():
    return _wrap(client.get_fo_gainers_losers)


@app.get("/api/most-active")
def most_active():
    """NSE's "Most Active Equities" - by volume and by value, whole
    market (not F&O-restricted)."""
    return _wrap(client.get_most_active)


@app.get("/api/volume-gainers")
def volume_gainers():
    """NSE's "Volume Gainers" (today's volume vs 1-week average), F&O
    stocks only."""
    return _wrap(client.get_volume_gainers)


@app.get("/api/52-week")
def fifty_two_week():
    """Stocks at a new 52-week high or low, F&O stocks only."""
    return _wrap(client.get_52_week)


@app.get("/api/day-level-stocks")
def day_level_stocks():
    """Stocks trading closest to today's day-high or day-low right now
    (same-session complement to /api/52-week's 52-week high/low), F&O
    stocks only."""
    return _wrap(client.get_day_level_stocks)


@app.get("/api/fo-stock-list")
def fo_stock_list():
    """F&O Stock List (Volume & RSI) - a liquidity/valuation screener
    (Market Cap, liquidity ratio, turnover, run-up from 52w low), with
    Volume and daily RSI(14) shown for reference. Does NOT apply the
    source screener's ROCE condition - no accessible data for that."""
    return _wrap(client.get_fo_stock_list)


@app.get("/api/fo-scanner")
def fo_scanner():
    """Full F&O universe, one row per symbol - powers the /pro F&O Scanner
    table. No Open Interest (not fetched anywhere in this app)."""
    return _wrap(client.get_fo_scanner_list)


@app.get("/api/sectors")
def sectors_list():
    return {"sectors": HEATMAP_SECTOR_SYMBOLS}


@app.get("/api/sector-labels")
def sector_labels():
    """Every distinct value the 'sector' field on F&O rows can take -
    for the frontend's sector filter dropdown."""
    return {"labels": _wrap(client.get_sector_labels)}


@app.get("/api/sector-bias")
def sector_bias():
    """Self-computed bullish/bearish/neutral read per sector (see
    NSEClient.get_sector_bias) - shown next to a stock's sector label
    anywhere the app displays one, as a quick "is this stock's sector
    trending with or against it" signal."""
    return _wrap(client.get_sector_bias)


@app.get("/api/orb/status")
def orb_status():
    """Whether each ORB window (5/15/30/45/60 min) has formed yet today."""
    return {"windows": _wrap(client.get_orb_status)}


@app.get("/api/orb")
def orb(window: int = Query(15, description="5, 15, 30, 45, or 60")):
    if window not in (5, 15, 30, 45, 60):
        raise HTTPException(status_code=400, detail="window must be 5, 15, 30, 45, or 60")
    return _wrap(client.get_orb, window)


@app.get("/api/scanner/status")
def scanner_status():
    """How far along the daily (Bhavcopy-backed) and each intraday timeframe
    (self-tracked + persisted) history the Buy/Sell scanner's data is."""
    return _wrap(client.get_scanner_status)


@app.get("/api/scanner")
def scanner(
    direction: str = Query("buy", description="'buy' (Bullish) or 'sell' (Bearish)"),
    timeframe: int = Query(60, description="15, 30, 45, or 60 (minutes)"),
):
    direction = direction.strip().lower()
    if direction not in ("buy", "sell"):
        raise HTTPException(status_code=400, detail="direction must be 'buy' or 'sell'")
    if timeframe not in (15, 30, 45, 60):
        raise HTTPException(status_code=400, detail="timeframe must be 15, 30, 45, or 60")
    return _wrap(client.get_scanner, direction, timeframe)


@app.get("/api/breakout-scanner/status")
def breakout_scanner_status():
    """How far along the 15-min Breakout Scanner's persisted candle
    history is (a fixed 15-min timeframe, independent of /api/scanner)."""
    return _wrap(client.get_breakout_scanner_status)


@app.get("/api/breakout-scanner")
def breakout_scanner(
    direction: str = Query("buy", description="'buy' (15 Min Stock Breakouts) or 'sell' (15 Min Bearish Breakout)")
):
    direction = direction.strip().lower()
    if direction not in ("buy", "sell"):
        raise HTTPException(status_code=400, detail="direction must be 'buy' or 'sell'")
    return _wrap(client.get_breakout_scanner, direction)


@app.get("/api/stock-verdict")
def stock_verdict(symbol: str = Query(..., description="NSE trading symbol, e.g. RELIANCE")):
    """On-demand "smart summary" for one symbol (click-to-open panel, any
    stock table in either frontend) - Bullish/Bearish/Neutral plus why,
    combining Trend 20D, the Buy/Sell Scanner, the 15-Min Breakout
    scanner, ORB, and classic pivot levels. No external AI call - see
    NSEClient.get_stock_verdict."""
    return _wrap(client.get_stock_verdict, symbol.strip().upper())


# ---------------------------------------------------------------------------
# Fyers integration (Phase 1: login flow + raw-quote diagnostic only - see
# fyers_client.py's module docstring for why this isn't wired into the F&O
# Scanner table yet). Requires FYERS_APP_ID / FYERS_APP_SECRET env vars.

@app.get("/api/fyers/status")
def fyers_status():
    return fyers_client.get_connection_status()


@app.get("/fyers/login")
def fyers_login():
    """Sends the browser to Fyers' own login page. Visit this once each
    trading day - the access token Fyers issues is only valid for that
    calendar day."""
    try:
        return RedirectResponse(fyers_client.get_login_url())
    except fyers_client.FyersConfigError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/fyers/callback")
def fyers_callback(code: str | None = None, s: str | None = None):
    """Where Fyers redirects back to after login - exchanges the auth code
    for an access token and persists it."""
    if not code:
        raise HTTPException(status_code=400, detail=f"No auth code in callback (s={s!r})")
    try:
        fyers_client.exchange_auth_code(code)
    except fyers_client.FyersConfigError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return RedirectResponse("/pro")


@app.get("/api/fyers/raw-quote")
def fyers_raw_quote(symbols: str = Query(..., description="comma-separated NSE trading symbols, e.g. RELIANCE,TCS")):
    """Diagnostic only: returns Fyers' quotes response completely unparsed,
    so the real field shape can be inspected before it's mapped into the
    F&O Scanner table."""
    nse_symbols = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    fyers_symbols = [fyers_client.to_fyers_symbol(s) for s in nse_symbols]
    try:
        return fyers_client.get_raw_quotes(fyers_symbols)
    except fyers_client.FyersNotConnected as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except fyers_client.FyersConfigError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Frontend (static single-page apps) - two frontends, same API, for side by
# side comparison: "/" is the original build, "/pro" is a restyled pass.

app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
app.mount("/pro/static", StaticFiles(directory=FRONTEND_PRO_DIR), name="static_pro")


@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/pro")
def index_pro():
    return FileResponse(FRONTEND_PRO_DIR / "index.html")
