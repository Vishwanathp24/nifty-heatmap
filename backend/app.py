"""FastAPI server for NSE Sector heatmap. No login: all data is public.

Run:  uvicorn app:app --host 127.0.0.1 --port 8100
The built frontend (frontend/dist) is served from / when present.
"""
import os
import secrets
import threading
import time
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from zoneinfo import ZoneInfo

import sources
from config import CLOSE_MIN, OPEN_MIN
from engine import Engine
from store import Store

IST = ZoneInfo("Asia/Kolkata")
app = FastAPI(title="NSE Sector heatmap")
app.add_middleware(GZipMiddleware, minimum_size=2000)
engine = Engine(Store())

# Access key for requests arriving through a tunnel (the Netlify site). Local
# requests (http://127.0.0.1:8100) need no key. The key lives in backend/.access_key
# (created on first run) or DASHBOARD_ACCESS_KEY.
KEY_FILE = Path(__file__).resolve().parent / ".access_key"
if not os.environ.get("DASHBOARD_ACCESS_KEY") and not KEY_FILE.exists():
    KEY_FILE.write_text(secrets.token_urlsafe(24))
    KEY_FILE.chmod(0o600)
ACCESS_KEY = os.environ.get("DASHBOARD_ACCESS_KEY") or KEY_FILE.read_text().strip()


@app.middleware("http")
async def require_key_when_tunnelled(request: Request, call_next):
    # On Render the site itself is the public front door, so no tunnel key is needed.
    tunnelled = not os.environ.get("RENDER") and ("cf-connecting-ip" in request.headers or "x-forwarded-for" in request.headers)
    if tunnelled and request.url.path.startswith("/api/") and request.headers.get("x-dashboard-key") != ACCESS_KEY:
        return JSONResponse(status_code=401, content={"detail": "Missing or invalid dashboard access key."})
    return await call_next(request)


@app.on_event("startup")
def _start():
    engine.start()


class Cached:
    """Keeps the last good value; a failed refresh never blanks it."""

    def __init__(self, ttl, fetch):
        self.ttl, self.fetch, self.lock = ttl, fetch, threading.Lock()
        self.value = self.fetched_at = self.error = None
        self.checked = 0.0

    def get(self):
        with self.lock:
            if time.time() - self.checked >= self.ttl:
                self.checked = time.time()
                try:
                    self.value, self.fetched_at, self.error = self.fetch(), datetime.now(IST).isoformat(), None
                except Exception as exc:
                    self.error = f"{type(exc).__name__}"
            return {"data": self.value, "fetched_at": self.fetched_at, "error": self.error}


def _clock_status(now):
    t = now.hour * 60 + now.minute
    if now.weekday() >= 5:
        return "Market Closed"
    if OPEN_MIN <= t < CLOSE_MIN:
        return "Market Open"
    if 9 * 60 <= t < OPEN_MIN:
        return "Pre-Open"
    return "Market Closed"


_status = Cached(30, sources.market_status)


def market_status():
    now = datetime.now(IST)
    clock = _clock_status(now)
    nse = _status.get()["data"]
    if nse and nse.get("status"):
        is_open = nse["status"].lower() == "open"
        label = ("Pre-Open" if clock == "Pre-Open" else "Market Open") if is_open else "Market Closed"
        return {"label": label, "source": "NSE", "message": nse.get("message")}
    return {"label": clock, "source": "clock", "message": None}


def _global():
    rows = []
    try:
        rows.append(sources.gift_nifty())
    except sources.SourceError:
        rows.append({"label": "GIFT Nifty", "last": None})
    for label, sym in sources.GLOBAL_SYMBOLS:
        try:
            rows.append(sources.global_index(label, sym))
        except (sources.SourceError, KeyError, IndexError, TypeError):
            rows.append({"label": label, "last": None})
    if not any(r.get("last") for r in rows):
        raise sources.SourceError("no global data")
    return rows


_global_cues = Cached(60, _global)
_fii = Cached(600, sources.fii_dii)
_sector_cache = {}


@app.get("/api/live")
def live():
    data = engine.live(market_status())
    if data is None:
        raise HTTPException(status_code=503, detail=engine.poll_err or "Loading NSE data — first snapshot in progress.")
    return data


@app.get("/api/context")
def context():
    return {"global": _global_cues.get(), "fii_dii": _fii.get()}


@app.get("/api/orb")
def orb(tf: int = 15, confirm: int = 1):
    try:
        return engine.scan(tf, bool(confirm))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/orb/candles")
def orb_candles(symbol: str, tf: int = 15, confirm: int = 1):
    if tf not in (5, 15):
        raise HTTPException(status_code=400, detail="tf must be 5 or 15")
    return engine.candles(symbol.strip().upper(), tf, bool(confirm))


@app.get("/api/sector")
def sector(symbol: str):
    hit = _sector_cache.get(symbol)
    if hit and time.time() - hit[0] < 8:
        return hit[1]
    try:
        data = engine.sector_detail(symbol)
    except sources.SourceError as exc:
        if hit:
            return {**hit[1], "stale": True}
        raise HTTPException(status_code=502, detail=f"NSE did not return constituents ({exc}).")
    _sector_cache[symbol] = (time.time(), data)
    return data


DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html")
