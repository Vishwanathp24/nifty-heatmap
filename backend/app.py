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
    trend_scan.ensure_started()


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
def orb(tf: int = 15, confirm: int = 1, orm: int = 60):
    try:
        return engine.scan(tf, confirm if confirm in (0, 1, 2) else 1, orm)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/orb/candles")
def orb_candles(symbol: str, tf: int = 15, confirm: int = 1, orm: int = 60):
    if tf not in (5, 15) or orm not in (15, 30, 60):
        raise HTTPException(status_code=400, detail="tf must be 5 or 15; orm must be 15, 30 or 60")
    return engine.candles(symbol.strip().upper(), tf, confirm if confirm in (0, 1, 2) else 1, orm)


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


# ---- viewer count: each open dashboard pings every 15 s with a random browser id; the
# header shows how many different browsers were seen in the last 24 hours. Only the id
# and a timestamp are kept (no personal data), saved next to the DB so restarts keep it.
import json as _json

from store import DB_PATH

PRESENCE_WINDOW = 24 * 3600
PRESENCE_FILE = DB_PATH.parent / "presence.json"
_presence_lock = threading.Lock()
try:
    _presence = {k: float(v) for k, v in _json.loads(PRESENCE_FILE.read_text()).items()}
except (OSError, ValueError, AttributeError):
    _presence = {}
_presence_saved = [0.0]


@app.get("/api/presence")
def presence(id: str = ""):
    now = time.time()
    with _presence_lock:
        if 8 <= len(id) <= 64:
            _presence[id] = now
        for k in [k for k, t in _presence.items() if now - t > PRESENCE_WINDOW]:
            del _presence[k]
        if now - _presence_saved[0] > 60:  # persist at most once a minute
            _presence_saved[0] = now
            try:
                PRESENCE_FILE.parent.mkdir(parents=True, exist_ok=True)
                PRESENCE_FILE.write_text(_json.dumps(_presence))
            except OSError:
                pass
        return {"online": len(_presence), "window_hours": 24}


_crypto = None


@app.get("/api/crypto")
def crypto():
    """Crypto tab: top coins (OKX USDT + CoinDCX INR), categories, bias, trending, ORB."""
    global _crypto
    from crypto import CryptoData

    if _crypto is None:
        _crypto = CryptoData()
    return _crypto.snapshot()


_crypto_opt = None


@app.get("/api/crypto/options")
def crypto_options(ccy: str = "BTC"):
    """Crypto -> Options: BTC / ETH put/call ratio, max pain, DVOL / IV, expected move, skew, OI by strike."""
    global _crypto_opt
    from crypto_options import CryptoOptions

    if _crypto_opt is None:
        _crypto_opt = CryptoOptions()
    try:
        return _crypto_opt.get(ccy)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Options data unavailable ({type(exc).__name__}).")


_crypto_live = None


def _live():
    global _crypto_live
    from crypto_live import CryptoLive

    if _crypto_live is None:
        _crypto_live = CryptoLive()
    return _crypto_live


def _live_call(fn, *args):
    try:
        return fn(*args)
    except (ValueError, LookupError) as exc:
        raise HTTPException(status_code=404 if isinstance(exc, LookupError) else 400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Live data unavailable ({type(exc).__name__}).")


@app.get("/api/crypto/symbols")
def crypto_symbols():
    """Crypto -> Live Chart search: every coin with an OKX USDT market."""
    return _live_call(_live().symbols)


@app.get("/api/crypto/trending")
def crypto_trending():
    """Crypto -> CoinGecko Trending: most-searched coins in the last 24h."""
    return _live_call(_live().trending)


@app.get("/api/crypto/pools")
def crypto_pools():
    """Crypto -> DEX Pools: trending on-chain pools with a basic safety screen (GeckoTerminal)."""
    return _live_call(_live().pools)


@app.get("/api/crypto/indicators")
def crypto_indicators(symbol: str = "BTC"):
    """Crypto -> Live Chart: indicator table on 1m ... 1M timeframes for one coin (OKX candles)."""
    from crypto_live import indicator_table
    return _live_call(indicator_table, _live(), symbol)


@app.get("/api/crypto/candles")
def crypto_candles(symbol: str = "BTC", tf: str = "1m", id: str = "", before: str = ""):
    """Crypto -> Live Chart: OKX candles for one coin."""
    return _live_call(_live().candles, symbol, tf, id or None, before or None)


_stock_chart = None


def _schart():
    global _stock_chart
    from stock_chart import StockChart

    if _stock_chart is None:
        _stock_chart = StockChart()
    return _stock_chart


@app.get("/api/chart/candles")
def stock_candles(symbol: str, tf: str = "5m", before: str = ""):
    """Intraday Scanner -> Live Chart: NSE stock candles (Yahoo) on 1m ... 1M; before = older history."""
    return _live_call(_schart().candles, symbol, tf, before or None)


@app.get("/api/chart/indicators")
def stock_indicators(symbol: str):
    """Intraday Scanner -> Live Chart: indicator table on 1m ... 1M for one NSE stock."""
    return _live_call(_schart().indicators, symbol)


_index_opt = None


@app.get("/api/index-options")
def index_options(symbol: str = "NIFTY"):
    """Index Options page: Nifty option chain (NSE) -> PCR, max pain, IV, expected move, skew, chain."""
    global _index_opt
    from index_options import IndexOptions

    if _index_opt is None:
        _index_opt = IndexOptions(engine)
    try:
        return _index_opt.get(symbol)
    except LookupError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except sources.SourceError as exc:
        raise HTTPException(status_code=502, detail=f"NSE option chain unavailable ({exc}).")


_accounts = None


def _acc():
    global _accounts
    if _accounts is None:
        from accounts import Accounts
        _accounts = Accounts()
    return _accounts


def _signed_in(request: Request):
    user = _acc().user(request.headers.get("authorization"))
    if not user:
        raise HTTPException(status_code=401, detail="Sign in to use your saved journal.")
    return user


@app.get("/api/auth/config")
def auth_config():
    """Journal sign-in: the Google OAuth client id (empty = sign-in turned off)."""
    from accounts import client_id
    return {"google_client_id": client_id()}


@app.post("/api/auth/google")
async def auth_google(request: Request):
    import requests
    body = await request.json()
    try:
        return _acc().sign_in(str(body.get("credential", "")))
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc))
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach Google ({type(exc).__name__}).")


@app.get("/api/auth/me")
def auth_me(request: Request):
    u = _signed_in(request)
    return {k: u[k] for k in ("email", "name", "picture")}


@app.post("/api/auth/logout")
def auth_logout(request: Request):
    _acc().sign_out(request.headers.get("authorization"))
    return {"ok": True}


@app.get("/api/journal")
def journal_get(request: Request):
    return _acc().journal(_signed_in(request)["sub"])


@app.put("/api/journal")
async def journal_put(request: Request):
    sub = _signed_in(request)["sub"]
    body = await request.json()
    try:
        return _acc().save_journal(sub, body.get("trades"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


_ipo = None


@app.get("/api/ipo/detail")
def ipo_detail_route(symbol: str, series: str = "EQ"):
    """IPO tab -> click a company: issue facts, live subscription by category, checklist."""
    from ipo import ipo_detail
    return _live_call(ipo_detail, symbol, series)


@app.get("/api/ipo/video")
def ipo_video(q: str):
    """IPO blog post -> the top YouTube result for "<company> IPO review" (embedded without autoplay)."""
    from ipo import youtube_top
    return youtube_top(q)


@app.get("/api/ipo")
def ipo():
    """Upcoming / open IPOs and recent listings (NSE mainboard + NSE SME)."""
    global _ipo
    from ipo import IpoData

    if _ipo is None:
        _ipo = IpoData()
    try:
        return _ipo.snapshot()
    except sources.SourceError as exc:
        raise HTTPException(status_code=502, detail=f"NSE IPO data unavailable ({exc}).")


from trend import TrendScan

trend_scan = TrendScan(engine)


@app.get("/api/trend")
def trend():
    """Trend Scan tab: VWAP, EMA 5/9, Supertrend, RSI, ADX/DI on 15-min and 1-hour candles."""
    return trend_scan.snapshot()


DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if DIST.exists():
    class _CachedStatic(StaticFiles):
        """Hashed build files never change under the same name: let browsers keep them a year."""
        async def get_response(self, path, scope):
            resp = await super().get_response(path, scope)
            if resp.status_code == 200:
                resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return resp

    app.mount("/assets", _CachedStatic(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})  # always pick up a new deploy
