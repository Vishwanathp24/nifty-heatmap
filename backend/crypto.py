"""Crypto tab: market overview, Fear & Greed, Altcoin Season Index, top-100 coins
(rank, price, today %, 24h %, distance from ATH and 1-year low), category heatmap, trending
scanner and ORB. Prices in USD. The crypto "day" starts at 12:00 AM IST.

Data (public, no login):
  CoinGecko /coins/markets  -> top coins by market cap, ATH / ATL, market cap, volume
  CoinGecko /global         -> total market cap, 24h volume, BTC / ETH dominance
  alternative.me /fng       -> Crypto Fear & Greed Index
  OKX /market/tickers       -> live USDT prices (USDT ~ USD)
  OKX /market/candles       -> 1m / 15m / 1H / 1D candles (ORB, indicators, Altcoin Season, 1-year low)
"""
import re
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone

import requests

from trend import STEP_KEYS, indicators

OKX = "https://www.okx.com/api/v5/market/"
CG = "https://api.coingecko.com/api/v3/"
UA = {"User-Agent": "Mozilla/5.0"}
IST = timedelta(hours=5, minutes=30)
TOP_N = 100
OR_MINUTES = (15, 60)
TF, CONFIRM = 1, 1  # ORB on 1-min candles: 1-min break candle, next 1-min close beyond the break close

CATEGORIES = {
    "Layer 1": ["BTC", "ETH", "SOL", "XRP", "ADA", "AVAX", "DOT", "TRX", "NEAR", "SUI", "APT", "TON", "GRAM", "LTC", "BCH",
                "XLM", "ATOM", "HBAR", "ICP", "ETC", "TIA", "SEI", "S", "ALGO", "KAS", "XDC", "VET", "FLR", "XTZ", "BSV",
                "CFX", "MON", "PI", "STX", "HASH", "CC", "M", "XPL", "QNT"],
    "Layer 2": ["ARB", "OP", "POL", "STRK", "IMX", "ZK", "MNT"],
    "DeFi": ["UNI", "AAVE", "LDO", "CRV", "ENA", "ONDO", "JUP", "PENDLE", "INJ", "DYDX", "HYPE", "MORPHO", "SKY", "AERO",
             "RAY", "CAKE", "ETHFI", "JST", "SUN", "ASTER", "LIT", "DRV", "FF", "GNO", "OHM", "WLFI"],
    "Meme": ["DOGE", "SHIB", "PEPE", "WIF", "BONK", "TRUMP", "FLOKI", "PUMP", "PENGU", "SPX"],
    "AI": ["TAO", "FET", "RENDER", "WLD", "VIRTUAL", "VVV", "GRASS", "KITE"],
    "Infra": ["LINK", "PYTH", "FIL", "GRT", "AR", "ZRO", "BTT"],
    "Exchange": ["BNB", "OKB", "LEO", "CRO", "KCS", "GT", "BGB", "HTX", "WBT", "NEXO"],
    "Privacy": ["ZEC", "XMR", "DASH", "BDX", "NIGHT"],
}
CATEGORY_OF = {c: cat for cat, coins in CATEGORIES.items() for c in coins}
# Not tradable crypto for this list: stablecoins, gold, tokenised funds / RWAs, wrapped & staked.
EXCLUDE_NAME = re.compile(r"\b(usd|dollar|euro|eur|gold|fund|securities|treasury|t-bills?|bond|clo|heloc|"
                          r"wrapped|staked|bridged|liquid staking|restaked|yield|capital)\b", re.I)
EXCLUDE_SYM = {"USDT", "USDC", "DAI", "USDE", "USDS", "USD1", "USDG", "PYUSD", "RLUSD", "USYC", "USDY", "BUIDL", "USDF",
               "USDD", "BFUSD", "USDGO", "U", "OUSD", "USTB", "GHO", "USD0", "TUSD", "EURC", "FDUSD", "STABLE", "A7A5",
               "YLDS", "USDAI", "SOFID", "REUSD", "OUSG", "APXUSD", "JTRSY", "JAAA", "EUTBL", "EURSAFO", "XAUT", "PAXG",
               "KAU", "FIGR_HELOC", "BCAP", "WBTC", "WETH", "STETH", "WSTETH", "WEETH", "CBBTC", "RETH", "BTW", "RAIN"}


def _get(url, params=None, timeout=15):
    r = requests.get(url, params=params, headers=UA, timeout=timeout)
    r.raise_for_status()
    return r.json()


def _ist_midnight_ms(now=None):
    now_ist = (now or datetime.now(timezone.utc)) + IST
    mid = now_ist.replace(hour=0, minute=0, second=0, microsecond=0) - IST
    return int(mid.timestamp() * 1000)


def okx_candles(coin, bar, limit=300, since_ms=None):
    """Oldest-first candles; d / m / t are the IST date, minute of the IST day, IST hh:mm."""
    rows, after = [], None
    while True:
        params = {"instId": f"{coin}-USDT", "bar": bar, "limit": min(limit, 300 if after is None else 100)}
        if after:
            params["after"] = after
        data = _get(OKX + ("candles" if after is None else "history-candles"), params)["data"]
        if not data:
            break
        rows += data
        oldest = int(data[-1][0])
        if since_ms is None or oldest <= since_ms or len(rows) >= 2000:
            break
        after = str(oldest)
        time.sleep(0.12)
    out = []
    for x in reversed(rows):
        ts = int(x[0])
        if since_ms is not None and ts < since_ms:
            continue
        t = datetime.fromtimestamp(ts / 1000, timezone.utc) + IST
        out.append({"ts": ts, "d": t.date().isoformat(), "m": t.hour * 60 + t.minute, "t": f"{t.hour:02d}:{t.minute:02d}",
                    "o": float(x[1]), "h": float(x[2]), "l": float(x[3]), "c": float(x[4]), "v": float(x[5]),
                    "done": x[8] == "1"})
    return out


def _hhmm(m):
    m %= 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def orb(c1, orm, last):
    """Opening range 12:00 AM IST + orm minutes (1-min candles); break = first 1-min close
    beyond it, confirmed by the next 1-min close beyond the break close."""
    if not c1:
        return None
    day = c1[-1]["d"]
    today = [b for b in c1 if b["d"] == day]
    rng = [b for b in today if b["m"] < orm]
    if not rng or today[-1]["m"] < orm:
        return {"complete": False}
    hi, lo = max(b["h"] for b in rng), min(b["l"] for b in rng)
    by_m = {b["m"]: b for b in today}
    done = [b["m"] + 1 for b in today if b["done"]]
    closed_until = max(done) if done else 0
    up = down = None
    rejected = []
    for start in range(orm, 1440, TF):
        end = start + TF
        if end > closed_until:
            break
        bars = [by_m[m] for m in range(start, end) if m in by_m]
        if not bars:
            continue
        c = bars[-1]["c"]
        for side in ("up", "down"):
            if (up if side == "up" else down) or not (c > hi if side == "up" else c < lo):
                continue
            cb = by_m.get(end)
            if not cb or end + CONFIRM > closed_until:
                continue
            ok = cb["c"] > c if side == "up" else cb["c"] < c
            item = {"time": _hhmm(end + CONFIRM), "break_close": c, "confirm_close": cb["c"], "break_candle": _hhmm(start)}
            if not ok:
                rejected.append({"side": side, **item})
                continue
            if side == "up":
                up = item
            else:
                down = item
        if up and down:
            break
    if not (up or down):
        return {"complete": True, "high": hi, "low": lo, "signal": None, "rejected": rejected}
    # like the stock ORB: when both sides confirmed, show the more recent signal
    hit = max([x for x in (up, down) if x], key=lambda x: x["time"])
    sig = "BREAKOUT" if hit is up else "BREAKDOWN"
    lvl = hi if sig == "BREAKOUT" else lo
    return {"complete": True, "high": hi, "low": lo, "signal": sig, **hit,
            "holding": last is not None and (last > hi if sig == "BREAKOUT" else last < lo),
            "dist_pct": round((last - lvl) / lvl * 100, 2) if last else None, "rejected": rejected}


def trend_steps(c15, h1):
    """Indicator values after each of today's (IST) 15-min candles, for the 'Time' column."""
    if not c15:
        return []
    day = c15[-1]["d"]
    first = next(i for i, b in enumerate(c15) if b["d"] == day)
    pack = lambda t: [t[k] for k in STEP_KEYS] if t else None
    steps = []
    for i in range(first, len(c15)):
        end_ts = c15[i]["ts"] + 15 * 60000
        hh = [b for b in h1 if b["ts"] < end_ts]
        if hh:
            hh = hh[:-1] + [{**hh[-1], "c": c15[i]["c"]}]  # forming hour closes at this 15-min close
        steps.append([_hhmm(c15[i]["m"] + 15), pack(indicators(c15[:i + 1])), pack(indicators(hh))])
    return steps


def _fg_label(v):
    return "Extreme Fear" if v < 25 else "Fear" if v < 45 else "Neutral" if v <= 55 else "Greed" if v <= 75 else "Extreme Greed"


class CryptoData:
    def __init__(self):
        self.lock = threading.Lock()
        self.markets, self.tick = [], {}
        self.globl = self.fng = self.altseason = None
        self.rows = {}       # symbol -> {"tf15", "tf60", "steps", "day_open", "orb": {15, 60}}
        self.daily = {}      # symbol -> (fetched epoch, 1-year daily candles): Altcoin Season + 1Y low
        self.m1 = {}         # symbol -> today's 1-min candles (kept and topped up incrementally)
        self.cycle = {"state": "starting", "done": 0, "total": 0, "finished": None}
        self.at = {"tick": 0.0, "mk": 0.0, "glob": 0.0, "fng": 0.0}
        self.thread = None

    def ensure_started(self):
        if self.thread is None or not self.thread.is_alive():
            self.thread = threading.Thread(target=self._loop, name="crypto", daemon=True)
            self.thread.start()

    # ---- feeds -------------------------------------------------------------------------------

    def _refresh(self, force=False):
        now = time.time()
        if force or now - self.at["mk"] > 90 or not self.markets:
            try:
                raw = _get(CG + "coins/markets", {"vs_currency": "usd", "order": "market_cap_desc", "per_page": 250,
                                                  "page": 1, "price_change_percentage": "24h"})
                keep, seen = [], set()
                for x in raw:
                    sym = (x.get("symbol") or "").upper()
                    if (not sym or sym in seen or sym in EXCLUDE_SYM or EXCLUDE_NAME.search(x.get("name") or "")
                            or not x.get("market_cap") or not re.fullmatch(r"[A-Z0-9]{1,12}", sym)):
                        continue
                    seen.add(sym)
                    keep.append(x)
                with self.lock:
                    self.markets = keep[:TOP_N]
                self.at["mk"] = now
            except Exception:
                traceback.print_exc(limit=1)
        if force or now - self.at["tick"] > 8:
            try:
                t = {}
                for x in _get(OKX + "tickers", {"instType": "SPOT"})["data"]:
                    coin, _, quote = x["instId"].partition("-")
                    if quote == "USDT" and x.get("last"):
                        t[coin] = {"last": float(x["last"]), "vol_usdt": float(x["volCcy24h"] or 0)}
                with self.lock:
                    self.tick = t
                self.at["tick"] = now
            except Exception:
                traceback.print_exc(limit=1)
        if now - self.at["glob"] > 300:
            try:
                g = _get(CG + "global")["data"]
                self.globl = {"mcap": g["total_market_cap"]["usd"], "volume": g["total_volume"]["usd"],
                              "mcap_change_24h": round(g["market_cap_change_percentage_24h_usd"], 2),
                              "btc_dom": round(g["market_cap_percentage"]["btc"], 2),
                              "eth_dom": round(g["market_cap_percentage"]["eth"], 2)}
                self.at["glob"] = now
            except Exception:
                traceback.print_exc(limit=1)
        if now - self.at["fng"] > 600:
            try:
                d = _get("https://api.alternative.me/fng/", {"limit": 2})["data"]
                v = int(d[0]["value"])
                self.fng = {"value": v, "label": d[0]["value_classification"] or _fg_label(v),
                            "yesterday": int(d[1]["value"]) if len(d) > 1 else None}
                self.at["fng"] = now
            except Exception:
                traceback.print_exc(limit=1)

    def _daily(self, s):
        """1 year of daily candles, refreshed hourly (Altcoin Season Index, 1-year low)."""
        hit = self.daily.get(s)
        if hit and time.time() - hit[0] < 3600:
            return hit[1]
        try:
            d = okx_candles(s, "1D", 300, since_ms=int((time.time() - 366 * 86400) * 1000))
        except Exception:
            d = hit[1] if hit else []
        self.daily[s] = (time.time(), d)
        return d

    def _m1(self, s, since):
        """Today's 1-min candles: full day on first load, then only the newest ones."""
        have = [b for b in self.m1.get(s, []) if b["ts"] >= since]
        if not have:
            have = okx_candles(s, "1m", 300, since_ms=since)
        else:
            new = okx_candles(s, "1m", 100)
            by = {b["ts"]: b for b in have}
            by.update({b["ts"]: b for b in new if b["ts"] >= since})
            have = [by[k] for k in sorted(by)]
        self.m1[s] = have
        return have

    def _altseason(self, syms):
        """Share of the top-50 altcoins (on OKX) whose 90-day return beats BTC's. >= 75 = Altcoin
        Season, <= 25 = Bitcoin Season (blockchaincenter.net definition)."""
        def ret90(s):
            d = self._daily(s)
            return (d[-1]["c"] / d[-91]["c"] - 1) * 100 if len(d) >= 91 else None
        btc = ret90("BTC")
        alts = [r for s in [x for x in syms if x != "BTC"][:50] for r in [ret90(s)] if r is not None]
        if btc is None or not alts:
            return None
        v = round(100 * sum(r > btc for r in alts) / len(alts))
        return {"value": v, "coins": len(alts), "btc_90d": round(btc, 2),
                "label": "Altcoin Season" if v >= 75 else "Bitcoin Season" if v <= 25 else "Neutral"}

    def _loop(self):
        while True:
            try:
                self._refresh(force=True)
                with self.lock:
                    syms = [m["symbol"].upper() for m in self.markets]
                    on_okx = [s for s in syms if s in self.tick]
                self.cycle = {"state": "running", "done": 0, "total": len(on_okx), "finished": self.cycle.get("finished")}
                since = _ist_midnight_ms()
                for s in on_okx:
                    try:
                        c15 = okx_candles(s, "15m", 300)
                        h1 = okx_candles(s, "1H", 300)
                        c1 = self._m1(s, since)
                        d1 = self._daily(s)
                        last = (self.tick.get(s) or {}).get("last")
                        row = {"tf15": indicators(c15), "tf60": indicators(h1), "steps": trend_steps(c15, h1),
                               "day_open": c1[0]["o"] if c1 and c1[0]["ts"] == since else None,
                               "low_1y": min(b["l"] for b in d1) if d1 else None,
                               "low_1y_date": min(d1, key=lambda b: b["l"])["d"] if d1 else None,
                               "orb": {orm: orb(c1, orm, last) for orm in OR_MINUTES}}
                        with self.lock:
                            self.rows[s] = row
                    except Exception:
                        traceback.print_exc(limit=1)
                    self.cycle["done"] += 1
                    self._refresh()
                    time.sleep(0.12)
                self.altseason = self._altseason([s for s in syms if s in self.tick]) or self.altseason
                self.cycle["state"] = "idle"
                self.cycle["finished"] = datetime.now(timezone.utc).isoformat()
            except Exception:
                traceback.print_exc(limit=1)
            time.sleep(20)

    # ---- endpoint payload --------------------------------------------------------------------

    def snapshot(self):
        self.ensure_started()
        try:
            self._refresh()
        except Exception:
            pass
        with self.lock:
            markets, tick, rows = list(self.markets), dict(self.tick), dict(self.rows)
        coins = []
        for rank, m in enumerate(markets, 1):
            s = m["symbol"].upper()
            row, t = rows.get(s, {}), tick.get(s)
            price = t["last"] if t else m.get("current_price")
            day_open = row.get("day_open")
            ath, low1y = m.get("ath"), row.get("low_1y")
            if low1y and price:
                low1y = min(low1y, price)
            cat = CATEGORY_OF.get(s, "Other")
            coins.append({
                "symbol": s, "id": m.get("id"), "name": m.get("name"), "company": m.get("name"), "rank": rank, "cg_rank": m.get("market_cap_rank"),
                "category": cat, "sector": cat, "sectors": [cat], "fo": True, "okx": bool(t),
                "price": price, "ltp": price, "day_open": day_open,
                "pct_day": round((price - day_open) / day_open * 100, 2) if price and day_open else None,
                "pct_24h": round(m["price_change_percentage_24h"], 2) if m.get("price_change_percentage_24h") is not None else None,
                "market_cap": m.get("market_cap"), "volume": m.get("total_volume"),
                "ath": ath, "ath_date": (m.get("ath_date") or "")[:10], "low_1y": low1y, "low_1y_date": row.get("low_1y_date"),
                "from_ath": round((price - ath) / ath * 100, 2) if price and ath else None,
                "from_low_1y": round((price - low1y) / low1y * 100, 2) if price and low1y else None,
                "tf15": row.get("tf15"), "tf60": row.get("tf60"), "steps": row.get("steps", []), "since": {},
                "orb15": (row.get("orb") or {}).get(15), "orb60": (row.get("orb") or {}).get(60),
            })
        for c in coins:
            c["pct_prev"] = c["pct_day"] if c["pct_day"] is not None else c["pct_24h"]
        return {"coins": coins, "global": self.globl, "fear_greed": self.fng, "altseason": self.altseason,
                "bias": self._bias(coins), "cycle": self.cycle, "day_start": "12:00 AM IST",
                "fetched_at": datetime.now(timezone.utc).isoformat()}

    @staticmethod
    def _bias(coins):
        by = {c["symbol"]: c for c in coins}
        vote = lambda v: 0 if v is None or v == 0 else (1 if v > 0 else -1)
        pct = lambda c: c["pct_day"] if c["pct_day"] is not None else c["pct_24h"]
        comps = []
        for sym in ("BTC", "ETH"):
            p = pct(by[sym]) if sym in by else None
            comps.append({"key": sym.lower(), "label": f"{sym} vs day open", "points": vote(p),
                          "detail": f"{p:+.2f}% since 12:00 AM IST" if p is not None else "N/A"})
        vals = [pct(c) for c in coins if pct(c) is not None]
        up, down = sum(v > 0 for v in vals), sum(v < 0 for v in vals)
        comps.append({"key": "breadth", "label": "Coin breadth", "points": vote(up - down), "detail": f"{up} up / {down} down"})
        cats = {}
        for c in coins:
            if pct(c) is not None and c["category"] != "Other":
                cats.setdefault(c["category"], []).append(pct(c))
        cu = sum(sum(v) / len(v) > 0 for v in cats.values())
        cd = sum(sum(v) / len(v) < 0 for v in cats.values())
        comps.append({"key": "cats", "label": "Category breadth", "points": vote(cu - cd), "detail": f"{cu} up / {cd} down"})
        alts = sorted(pct(c) for c in coins if c["symbol"] != "BTC" and pct(c) is not None)
        med = alts[len(alts) // 2] if alts else None
        comps.append({"key": "alts", "label": "Altcoins (median)", "points": vote(med),
                      "detail": f"median altcoin {med:+.2f}% today" if med is not None else "N/A"})
        score = sum(c["points"] for c in comps)
        return {"score": score, "label": "BULLISH" if score >= 3 else "BEARISH" if score <= -3 else "NEUTRAL",
                "components": comps}
