"""Crypto tab -> live views (read-only market data; nothing here places orders):

  CoinGecko /search/trending             -> the most-searched coins on CoinGecko in the last 24h
  GeckoTerminal /networks/trending_pools -> trending on-chain (DEX) pools + a basic safety check
  OKX /market/candles                    -> candles for the live chart (1m / 5m / 15m / 1H / 1D)
  OKX /public/instruments                -> every coin with a USDT market (chart search)

Pool screening follows CoinGecko's trading-bot article,
used here only to display information. Responses are cached so the free API limits hold.
"""
import threading
import time
from datetime import datetime, timezone

import requests

CG = "https://api.coingecko.com/api/v3/"
GT = "https://api.geckoterminal.com/api/v2/"
OKX = "https://www.okx.com/api/v5/market/"
UA = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
# Chart timeframes -> OKX bar (None = 3h, built from 1-hour candles). Daily and longer use UTC-aligned bars.
BARS = {"1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "2h": "2H", "3h": None,
        "4h": "4H", "1D": "1Dutc", "1W": "1Wutc", "1M": "1Mutc"}
LEGACY_TF = {"1d": "1D"}

# Safety screen for DEX pools (the AI-bot article's scam filter, as warnings only)
MIN_LIQ = 50_000      # USD locked in the pool
MIN_VOL = 25_000      # USD traded in 24h
MIN_BUYS = 100        # buy transactions in 24h
NEW_HOURS = 24        # pool younger than this


class Busy(LookupError):
    """Free API rate limit hit (HTTP 429)."""


def _get(url, params=None, timeout=15):
    for attempt in range(2):
        r = requests.get(url, params=params, headers=UA, timeout=timeout)
        if r.status_code != 429:
            break
        if attempt == 0:
            time.sleep(2)
    if r.status_code == 429:
        raise Busy("The free data source is busy (rate limit). Retrying automatically in about a minute.")
    r.raise_for_status()
    return r.json()


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _agg3h(h1):
    """3-hour candles from 1-hour ones (UTC-aligned 00/03/06/... buckets, like OKX's other bars)."""
    out = []
    for b in h1:
        k = b["t"] // 10800000 * 10800000
        if out and out[-1]["t"] == k:
            o = out[-1]
            o.update(h=max(o["h"], b["h"]), l=min(o["l"], b["l"]), c=b["c"], v=o["v"] + b["v"])
        else:
            out.append({**b, "t": k})
    return out


class CryptoLive:
    def __init__(self):
        self.lock = threading.Lock()
        self.cache = {}  # key -> (epoch, payload)
        self.failed = {}  # key -> (epoch, exception): don't retry a failing source on every poll

    def _cached(self, key, ttl, build):
        with self.lock:
            hit = self.cache.get(key)
            fail = self.failed.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        if fail and time.time() - fail[0] < 30:
            if hit:
                return {**hit[1], "stale": True}
            raise fail[1]
        try:
            data = build()
        except Exception as exc:
            with self.lock:
                self.failed[key] = (time.time(), exc)
            if hit:
                return {**hit[1], "stale": True}
            raise
        with self.lock:
            self.cache[key] = (time.time(), data)
        return data

    # -- every coin with an OKX USDT market (Live Chart search) ----------------------------
    def symbols(self):
        return self._cached("symbols", 3600, self._symbols)

    def _symbols(self):
        d = _get("https://www.okx.com/api/v5/public/instruments", {"instType": "SPOT"})
        syms = sorted({x["baseCcy"] for x in d.get("data") or [] if x.get("quoteCcy") == "USDT" and x.get("state") == "live"})
        return {"symbols": syms, "fetched_at": datetime.now(timezone.utc).isoformat()}

    # -- trending on CoinGecko ------------------------------------------------------------
    def trending(self):
        return self._cached("trending", 120, self._trending)

    def _trending(self):
        d = _get(CG + "search/trending")
        rows = []
        for i, c in enumerate(d.get("coins") or [], 1):
            it = c.get("item") or {}
            data = it.get("data") or {}
            rows.append({"pos": i, "id": it.get("id"), "symbol": (it.get("symbol") or "").upper(), "name": it.get("name"),
                         "thumb": it.get("small") or it.get("thumb"), "rank": it.get("market_cap_rank"),
                         "price": _f(data.get("price")),
                         "pct_24h": round(_f((data.get("price_change_percentage_24h") or {}).get("usd")) or 0, 2) if data.get("price_change_percentage_24h") else None,
                         "market_cap": data.get("market_cap"), "volume": data.get("total_volume")})
        return {"rows": rows, "fetched_at": datetime.now(timezone.utc).isoformat()}

    # -- DEX pools + safety check ---------------------------------------------------------
    def pools(self):
        return self._cached("pools", 60, self._pools)

    def _pools(self):
        d = _get(GT + "networks/trending_pools", {"include": "base_token,dex,network", "page": 1})
        inc = {(x["type"], x["id"]): x.get("attributes") or {} for x in d.get("included") or []}
        now = datetime.now(timezone.utc)
        rows = []
        for p in d.get("data") or []:
            a, rel = p.get("attributes") or {}, p.get("relationships") or {}
            ref = lambda k: (((rel.get(k) or {}).get("data")) or {})
            tok = inc.get(("token", ref("base_token").get("id")), {})
            dex = inc.get(("dex", ref("dex").get("id")), {})
            net = inc.get(("network", ref("network").get("id")), {})
            tx = (a.get("transactions") or {}).get("h24") or {}
            liq, vol = _f(a.get("reserve_in_usd")), _f((a.get("volume_usd") or {}).get("h24"))
            buys, sells = tx.get("buys") or 0, tx.get("sells") or 0
            created = a.get("pool_created_at")
            age_h = (now - datetime.fromisoformat(created.replace("Z", "+00:00"))).total_seconds() / 3600 if created else None
            flags = []
            if liq is None or liq < MIN_LIQ:
                flags.append(f"Low liquidity (< ${MIN_LIQ // 1000}K)")
            if vol is None or vol < MIN_VOL:
                flags.append(f"Low 24h volume (< ${MIN_VOL // 1000}K)")
            if buys < MIN_BUYS:
                flags.append(f"Few buys (< {MIN_BUYS} in 24h)")
            if buys >= 20 and sells <= buys * 0.05:
                flags.append("Almost no sells (possible honeypot)")
            if age_h is not None and age_h < NEW_HOURS:
                flags.append(f"New pool ({age_h:.0f}h old)")
            if liq and vol and vol > liq * 50:
                flags.append("Volume ≫ liquidity (wash trading?)")
            pc = a.get("price_change_percentage") or {}
            rows.append({"name": a.get("name"), "symbol": tok.get("symbol") or (a.get("name") or "").split(" / ")[0],
                         "network": net.get("name") or (p.get("id") or "").split("_")[0], "dex": dex.get("name"),
                         "price": _f(a.get("base_token_price_usd")), "liquidity": liq, "volume": vol,
                         "fdv": _f(a.get("fdv_usd")), "buys": buys, "sells": sells,
                         "pct_1h": _f(pc.get("h1")), "pct_24h": _f(pc.get("h24")), "age_h": round(age_h, 1) if age_h is not None else None,
                         "flags": flags, "risk": "high" if len(flags) >= 2 else "watch" if flags else "ok",
                         "url": "https://www.geckoterminal.com/" + (p.get("id") or "").replace("_", "/pools/", 1)})
        return {"rows": rows, "rules": {"min_liquidity": MIN_LIQ, "min_volume": MIN_VOL, "min_buys": MIN_BUYS, "new_hours": NEW_HOURS},
                "fetched_at": now.isoformat()}

    # -- live candles ---------------------------------------------------------------------
    def candles(self, symbol, tf, cg_id=None, before=None):
        """OKX USDT candles; coins OKX doesn't list fall back to CoinGecko OHLC (needs the
        CoinGecko id): 30-min candles for the last day, or 4-hour candles for '1d' (no volume)."""
        symbol, tf = symbol.upper(), LEGACY_TF.get(tf, tf)
        if tf not in BARS:
            raise ValueError("tf must be one of " + ", ".join(BARS))
        on_okx = symbol in set(self.symbols()["symbols"])
        if on_okx and before:  # older history for dragging the chart back
            return self._cached(f"h:{symbol}:{tf}:{before}", 600, lambda: self._history(symbol, tf, int(before)))
        if on_okx:
            return self._cached(f"c:{symbol}:{tf}", 3, lambda: self._candles(symbol, tf))
        if before:
            return {"symbol": symbol, "tf": tf, "candles": [], "source": "CoinGecko", "end": True}
        if not cg_id:
            raise LookupError(f"{symbol} has no USDT market on OKX, so there is no live chart for it.")
        days = 30 if tf in ("1D", "1W", "1M") else 1
        return self._cached(f"cg:{cg_id}:{days}", 120, lambda: self._cg_candles(symbol, cg_id, tf, days))

    def _candles(self, symbol, tf):
        d = _get(OKX + "candles", {"instId": f"{symbol}-USDT", "bar": BARS[tf] or "1H", "limit": 300 if BARS[tf] is None else 200})
        if d.get("code") not in ("0", 0) or not d.get("data"):
            raise LookupError(f"{symbol} has no USDT market on OKX, so there is no live chart for it.")
        rows = [{"t": int(x[0]), "o": float(x[1]), "h": float(x[2]), "l": float(x[3]), "c": float(x[4]), "v": float(x[5])}
                for x in reversed(d["data"])]
        if BARS[tf] is None:
            rows = _agg3h(rows)
        return {"symbol": symbol, "tf": tf, "candles": rows, "source": "OKX", "bar": tf,
                "fetched_at": datetime.now(timezone.utc).isoformat()}

    def _history(self, symbol, tf, before):
        d = _get(OKX + "history-candles", {"instId": f"{symbol}-USDT", "bar": BARS[tf] or "1H", "after": before, "limit": 100})
        rows = [{"t": int(x[0]), "o": float(x[1]), "h": float(x[2]), "l": float(x[3]), "c": float(x[4]), "v": float(x[5])}
                for x in reversed(d.get("data") or [])]
        if BARS[tf] is None:
            rows = [b for b in _agg3h(rows) if b["t"] < before]
        return {"symbol": symbol, "tf": tf, "candles": rows, "source": "OKX", "before": before, "end": not rows}

    def _cg_candles(self, symbol, cg_id, tf, days):
        d = _get(CG + f"coins/{cg_id}/ohlc", {"vs_currency": "usd", "days": days})
        if not d:
            raise LookupError(f"No candle data for {symbol}.")
        rows = [{"t": int(x[0]) - (1800000 if days == 1 else 14400000), "o": x[1], "h": x[2], "l": x[3], "c": x[4], "v": 0}
                for x in d]  # CoinGecko stamps a candle at its close; shift to the open like OKX
        return {"symbol": symbol, "tf": tf, "candles": rows, "source": "CoinGecko", "bar": "30m" if days == 1 else "4h",
                "fetched_at": datetime.now(timezone.utc).isoformat()}


# -- multi-timeframe indicator table (Live Chart) --------------------------------------------
# VWAP / EMA 5 / EMA 9 / Supertrend / RSI / ADX / DI on 1m ... 1M OKX candles. OKX has no 3-hour
# bar, so 3h is built from 1-hour candles. VWAP resets each IST day on intraday timeframes, each
# week on 1D, each month on 1W and each year on 1M.
IND_TFS = [("1m", "1m"), ("3m", "3m"), ("5m", "5m"), ("15m", "15m"), ("30m", "30m"), ("1h", "1H"), ("2h", "2H"),
           ("3h", None), ("4h", "4H"), ("1D", "1Dutc"), ("1W", "1Wutc"), ("1M", "1Mutc")]


def _anchor(tf, b):
    d = datetime.fromisoformat(b["d"])
    if tf == "1D":
        return d.isocalendar()[:2]
    if tf == "1W":
        return (d.year, d.month)
    if tf == "1M":
        return d.year
    return b["d"]


def _vwap_anchored(tf, c):
    key = _anchor(tf, c[-1])
    pv = vol = 0.0
    for b in c:
        if b["v"] and _anchor(tf, b) == key:
            pv += (b["h"] + b["l"] + b["c"]) / 3 * b["v"]
            vol += b["v"]
    return pv / vol if vol else None


def _three_hour(h1):
    out = []
    for b in h1:
        start = (b["ts"] // 3600000) // 3 * 3
        if out and out[-1]["_k"] == start:
            o = out[-1]
            o.update(h=max(o["h"], b["h"]), l=min(o["l"], b["l"]), c=b["c"], v=o["v"] + b["v"], t=o["t"])
        else:
            out.append({**b, "_k": start})
    return out


def _tf_indicators(tf, c):
    from trend import indicators
    if not c or len(c) < 30:
        return None
    r = indicators(c)
    if r:
        v = _vwap_anchored(tf, c)
        r["vwap"] = round(v, 6) if v else None
    return r


def indicator_table(live, symbol):
    from concurrent.futures import ThreadPoolExecutor
    from crypto import okx_candles
    symbol = symbol.upper()
    if symbol not in set(live.symbols()["symbols"]):
        raise LookupError(f"{symbol} has no USDT market on OKX, so there are no indicators for it.")

    def one(item):
        tf, bar = item
        try:
            c = _three_hour(okx_candles(symbol, "1H", 300)) if bar is None else okx_candles(symbol, bar, 300)
            return tf, _tf_indicators(tf, c)
        except Exception:
            return tf, None

    def build():
        with ThreadPoolExecutor(max_workers=6) as ex:
            res = dict(ex.map(one, IND_TFS))
        return {"symbol": symbol, "tfs": [t for t, _ in IND_TFS], "rows": res, "fetched_at": datetime.now(timezone.utc).isoformat()}

    return live._cached("ind:" + symbol, 20, build)
