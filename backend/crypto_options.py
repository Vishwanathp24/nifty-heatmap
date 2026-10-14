"""Crypto tab -> Options: BTC / ETH options positioning and volatility (public data, no login).

  Deribit get_book_summary_by_currency  -> every option's open interest, 24h volume, mark IV
  Deribit get_volatility_index_data     -> DVOL (30-day implied volatility index, like India VIX)
  Deribit get_index_price               -> spot index
  OKX     public/opt-summary            -> option deltas + IV (for the 25-delta skew)

Per expiry: put/call ratio, max pain, ATM IV, expected move, 25-delta skew and open
interest by strike. Deribit options expire at 08:00 UTC (1:30 PM IST). BTC / ETH options are
coin-settled (premium quoted in coin, 1 contract = 1 coin); SOL / XRP options are USDC-settled
(premium already in USD, 1 contract = 10 SOL / 1000 XRP, strikes like '1d38' = 1.38). No DVOL
index exists for SOL / XRP, so their volatility card shows the ~30-day ATM IV instead.
"""
import math
import threading
import time
import traceback
from datetime import datetime, timezone

import requests

DERIBIT = "https://www.deribit.com/api/v2/public/"
OKX = "https://www.okx.com/api/v5/public/"
UA = {"User-Agent": "Mozilla/5.0"}
MONTHS = {m: i for i, m in enumerate(("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"), 1)}
TTL = 60
LINEAR = {"SOL": 10, "XRP": 1000}  # USDC-settled options -> contract size in coins


def _get(url, params=None):
    r = requests.get(url, params=params, headers=UA, timeout=20)
    r.raise_for_status()
    return r.json()


def _expiry(code):
    """'26MAR27' -> datetime 2027-03-26 08:00 UTC."""
    d, mon, y = int(code[:-5]), MONTHS[code[-5:-2]], 2000 + int(code[-2:])
    return datetime(y, mon, d, 8, tzinfo=timezone.utc)


def _ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _delta(kind, s, k, iv, t):
    """Black-Scholes delta (r = 0) from the option's mark IV."""
    if not iv or t <= 0 or not s or not k:
        return None
    sig = iv / 100
    d1 = (math.log(s / k) + 0.5 * sig * sig * t) / (sig * math.sqrt(t))
    return round(_ncdf(d1) if kind == "C" else _ncdf(d1) - 1, 3)


def _max_pain(calls, puts):
    strikes = sorted(set(calls) | set(puts))
    if not strikes:
        return None
    pain = lambda p: sum(oi * max(0.0, p - k) for k, oi in calls.items()) + sum(oi * max(0.0, k - p) for k, oi in puts.items())
    return min(strikes, key=pain)


def _skew(okx_rows, exp):
    """25-delta skew for one expiry: IV of the ~25-delta put minus IV of the ~25-delta call
    (vol points). Positive = puts dearer than calls (demand for downside protection)."""
    tag = exp.strftime("%y%m%d")
    rows = [r for r in okx_rows if r["instId"].split("-")[2] == tag]
    calls = [r for r in rows if r["instId"].endswith("-C") and r.get("delta") and r.get("markVol")]
    puts = [r for r in rows if r["instId"].endswith("-P") and r.get("delta") and r.get("markVol")]
    if not calls or not puts:
        return None
    c = min(calls, key=lambda r: abs(float(r["delta"]) - 0.25))
    p = min(puts, key=lambda r: abs(float(r["delta"]) + 0.25))
    if abs(float(c["delta"]) - 0.25) > 0.1 or abs(float(p["delta"]) + 0.25) > 0.1:
        return None
    return round((float(p["markVol"]) - float(c["markVol"])) * 100, 2)


def _chain_skew(chain):
    """25-delta skew from the chain's own Black-Scholes deltas (when OKX doesn't list the coin)."""
    c = [r for r in chain if r["call"].get("delta") and r["call"].get("iv")]
    p = [r for r in chain if r["put"].get("delta") and r["put"].get("iv")]
    if not c or not p:
        return None
    c = min(c, key=lambda r: abs(r["call"]["delta"] - 0.25))
    p = min(p, key=lambda r: abs(r["put"]["delta"] + 0.25))
    if abs(c["call"]["delta"] - 0.25) > 0.1 or abs(p["put"]["delta"] + 0.25) > 0.1:
        return None
    return round(p["put"]["iv"] - c["call"]["iv"], 2)


class CryptoOptions:
    def __init__(self):
        self.lock = threading.Lock()
        self.cache = {}  # ccy -> (epoch, payload)

    def get(self, ccy):
        ccy = ccy.upper()
        if ccy not in ("BTC", "ETH", *LINEAR):
            raise ValueError("ccy must be BTC, ETH, SOL or XRP")
        with self.lock:
            hit = self.cache.get(ccy)
            if hit and time.time() - hit[0] < TTL:
                return hit[1]
            try:
                data = self._build(ccy)
                self.cache[ccy] = (time.time(), data)
                return data
            except Exception:
                traceback.print_exc(limit=1)
                if hit:
                    return {**hit[1], "stale": True}
                raise

    def _build(self, ccy):
        now = datetime.now(timezone.utc)
        linear = ccy in LINEAR
        spot = _get(DERIBIT + "get_index_price", {"index_name": ccy.lower() + ("_usdc" if linear else "_usd")})["result"]["index_price"]
        if linear:
            book = [b for b in _get(DERIBIT + "get_book_summary_by_currency", {"currency": "USDC", "kind": "option"})["result"]
                    if b["instrument_name"].startswith(ccy + "_USDC-")]
            dv = []
        else:
            book = _get(DERIBIT + "get_book_summary_by_currency", {"currency": ccy, "kind": "option"})["result"]
            end = int(now.timestamp() * 1000)
            dv = _get(DERIBIT + "get_volatility_index_data", {"currency": ccy, "resolution": "3600",
                                                              "start_timestamp": end - 26 * 3600 * 1000, "end_timestamp": end})["result"]["data"]
        try:
            okx_rows = _get(OKX + "opt-summary", {"uly": ccy + "-USD"})["data"]
        except Exception:
            okx_rows = []

        by_exp = {}
        for b in book:
            _, code, strike, kind = b["instrument_name"].split("-")
            e = by_exp.setdefault(code, {"calls": {}, "puts": {}, "cvol": 0.0, "pvol": 0.0, "iv": {}, "q": {}})
            k, oi, vol = float(strike.replace("d", ".")), b.get("open_interest") or 0.0, b.get("volume") or 0.0
            side = "calls" if kind == "C" else "puts"
            e[side][k] = e[side].get(k, 0.0) + oi
            e["cvol" if kind == "C" else "pvol"] += vol
            if b.get("mark_iv"):
                e["iv"].setdefault(k, []).append(b["mark_iv"])
            und = b.get("underlying_price") or spot  # premiums are quoted in coin; x underlying = USD
            usd = (lambda v: round(v, 5) if v else None) if linear else (lambda v: round(v * und, 2) if v else None)
            e["q"][(k, kind)] = {"mark": usd(b.get("mark_price")), "bid": usd(b.get("bid_price")), "ask": usd(b.get("ask_price")),
                                 "iv": round(b["mark_iv"], 1) if b.get("mark_iv") else None, "oi": round(oi, 1)}
            e["fwd"] = b.get("underlying_price") or spot

        expiries, tot = [], {"coi": 0.0, "poi": 0.0, "cvol": 0.0, "pvol": 0.0}
        for code, e in by_exp.items():
            exp = _expiry(code)
            days = (exp - now).total_seconds() / 86400
            if days <= 0:
                continue
            coi, poi = sum(e["calls"].values()), sum(e["puts"].values())
            for key, v in (("coi", coi), ("poi", poi), ("cvol", e["cvol"]), ("pvol", e["pvol"])):
                tot[key] += v
            fwd = e["fwd"]
            atm_k = min(e["iv"], key=lambda k: abs(k - fwd)) if e["iv"] else None
            atm_iv = round(sum(e["iv"][atm_k]) / len(e["iv"][atm_k]), 2) if atm_k else None
            move = spot * atm_iv / 100 * math.sqrt(days / 365) if atm_iv else None
            mp = _max_pain(e["calls"], e["puts"])
            lo, hi = spot * 0.7, spot * 1.3
            strikes = sorted(k for k in set(e["calls"]) | set(e["puts"]) if lo <= k <= hi)
            ist = exp.timestamp() + 5.5 * 3600
            expiries.append({
                "code": code, "expiry": exp.isoformat(), "expiry_ist": datetime.fromtimestamp(ist, timezone.utc).strftime("%d %b %Y, 1:30 PM"),
                "days": round(days, 2), "call_oi": round(coi, 1), "put_oi": round(poi, 1),
                "pcr_oi": round(poi / coi, 2) if coi else None,
                "pcr_vol": round(e["pvol"] / e["cvol"], 2) if e["cvol"] else None,
                "max_pain": mp, "max_pain_pct": round((mp - spot) / spot * 100, 2) if mp else None,
                "atm_iv": atm_iv, "move": round(move, 2 if spot >= 100 else 5) if move else None,
                "move_pct": round(move / spot * 100, 2) if move else None,
                "skew_25d": None,
                "oi_usd": round((coi + poi) * spot),
                "strikes": [{"k": k, "c": round(e["calls"].get(k, 0.0), 1), "p": round(e["puts"].get(k, 0.0), 1)} for k in strikes],
                "chain": [{"k": k,
                           "call": {**(e["q"].get((k, "C")) or {}), "delta": _delta("C", fwd, k, (e["q"].get((k, "C")) or {}).get("iv"), days / 365)},
                           "put": {**(e["q"].get((k, "P")) or {}), "delta": _delta("P", fwd, k, (e["q"].get((k, "P")) or {}).get("iv"), days / 365)}}
                          for k in strikes],
                "fwd": round(fwd, 2), "atm_strike": atm_k,
            })
        expiries.sort(key=lambda x: x["days"])
        for e in expiries:  # OKX deltas where listed (BTC / ETH / SOL), else Deribit mark-IV deltas
            e["skew_25d"] = _skew(okx_rows, _expiry(e["code"])) if okx_rows else None
            if e["skew_25d"] is None:
                e["skew_25d"] = _chain_skew(e["chain"])
        dvol_now = dv[-1][4] if dv else None
        dvol_24h = dv[-25][4] if len(dv) >= 25 else (dv[0][4] if dv else None)
        vol_label = "DVOL (implied vol)"
        if linear:  # no DVOL index: use the ATM IV of the expiry closest to 30 days
            e30 = min((e for e in expiries if e["atm_iv"]), key=lambda e: abs(e["days"] - 30), default=None)
            dvol_now, dvol_24h, vol_label = (e30 or {}).get("atm_iv"), None, "30-day ATM IV"
        return {
            "ccy": ccy, "spot": spot, "fetched_at": now.isoformat(), "vol_label": vol_label, "contract": LINEAR.get(ccy),
            "dvol": dvol_now, "dvol_change_24h": round(dvol_now - dvol_24h, 2) if dvol_now and dvol_24h else None,
            "pcr_oi": round(tot["poi"] / tot["coi"], 2) if tot["coi"] else None,
            "pcr_vol": round(tot["pvol"] / tot["cvol"], 2) if tot["cvol"] else None,
            "total_oi": round(tot["coi"] + tot["poi"], 1), "total_oi_usd": round((tot["coi"] + tot["poi"]) * spot),
            "expiries": expiries,
        }
