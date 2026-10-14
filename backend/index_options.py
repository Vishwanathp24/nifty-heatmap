"""Index Options page (Nifty, NSE) and the Live Chart strategy card (F&O stocks, NSE Equity chain):
option chains in the same shape as the
crypto options payload, so the page can reuse the expiries table, OI chart, strike
table, strategy explainer and payoff calculator.

  NSE option-chain-contract-info?symbol=NIFTY           -> expiry dates
  NSE option-chain-v3?type=Indices&symbol=NIFTY&expiry=  -> per strike: CE / PE bid, ask, LTP, IV, OI
Sensex options trade only on BSE, whose API refuses this network (Access Denied); the
endpoint reports that instead of guessing. NSE options expire at 3:30 PM IST.
"""
import math
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import sources

IST = timezone(timedelta(hours=5, minutes=30))
TTL = 60
N_EXPIRIES = 6
BAND = 0.08  # strikes within +-8% of spot (indices)
BAND_STOCK = 0.20  # stock strikes are wider apart relative to price
INDICES = ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY")


_LOTS = {"at": 0, "map": {}}


def lot_size(symbol):
    """F&O lot size for the current month from NSE's fo_mktlots.csv (cached 6 hours)."""
    if time.time() - _LOTS["at"] > 6 * 3600 or not _LOTS["map"]:
        try:
            import requests
            r = requests.get("https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv", headers={"User-Agent": "Mozilla/5.0"}, timeout=20)
            r.raise_for_status()
            m = {}
            for line in r.text.splitlines()[1:]:
                parts = [x.strip() for x in line.split(",")]
                if len(parts) > 2 and parts[2].isdigit():
                    m[parts[1].upper()] = int(parts[2])
            if m:
                _LOTS.update(at=time.time(), map=m)
        except Exception:
            _LOTS["at"] = time.time() - 6 * 3600 + 300  # retry in 5 min
    return _LOTS["map"].get(symbol.upper())


def _ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _delta(kind, s, k, iv, t):
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


class IndexOptions:
    def __init__(self, engine):
        self.engine = engine
        self.lock = threading.Lock()
        self.cache = {}

    def get(self, symbol):
        symbol = symbol.upper()
        if symbol == "SENSEX":
            raise LookupError("Sensex options trade only on BSE, and BSE's data API refuses requests from this "
                              "network (Access Denied), so a Sensex option chain isn't available.")
        if not re.fullmatch(r"[A-Z0-9&-]{1,20}", symbol):
            raise ValueError("invalid symbol")
        with self.lock:
            hit = self.cache.get(symbol)
            if hit and time.time() - hit[0] < TTL:
                return hit[1]
            try:
                data = self._build(symbol)
                self.cache[symbol] = (time.time(), data)
                return data
            except Exception:
                if hit:
                    return {**hit[1], "stale": True}
                raise

    def _vix(self):
        try:
            v = (self.engine.indices or {}).get("INDIA VIX") or {}
            return v.get("last"), round(v["last"] - v["prev"], 2) if v.get("last") and v.get("prev") else None
        except Exception:
            return None, None

    def _build(self, symbol):
        now = datetime.now(IST)
        info = sources.nse.get(sources.NSE_API + "option-chain-contract-info?symbol=" + quote(symbol), timeout=25)
        dates = info.get("expiryDates") or []
        spot, expiries = None, []
        tot = {"coi": 0.0, "poi": 0.0, "cvol": 0.0, "pvol": 0.0}
        for ds in dates[:N_EXPIRIES]:
            exp = datetime.strptime(ds, "%d-%b-%Y").replace(hour=15, minute=30, tzinfo=IST)
            days = (exp - now).total_seconds() / 86400
            if days <= 0:
                continue
            kind = "Indices" if symbol in INDICES else "Equity"  # F&O stocks use the Equity chain
            d = sources.nse.get(sources.NSE_API + f"option-chain-v3?type={kind}&symbol={quote(symbol)}&expiry={quote(ds)}", timeout=25)
            rec = d.get("records") or {}
            spot = rec.get("underlyingValue") or spot
            rows = [r for r in rec.get("data") or [] if r.get("CE") or r.get("PE")]
            if not rows or not spot:
                continue
            calls, puts, ivs, q = {}, {}, {}, {}
            cvol = pvol = 0.0
            for r in rows:
                k = float(r.get("strikePrice") or (r.get("CE") or r.get("PE"))["strikePrice"])
                for kind, key in (("C", "CE"), ("P", "PE")):
                    o = r.get(key)
                    if not o:
                        continue
                    oi = float(o.get("openInterest") or 0)
                    (calls if kind == "C" else puts)[k] = oi
                    if kind == "C":
                        cvol += float(o.get("totalTradedVolume") or 0)
                    else:
                        pvol += float(o.get("totalTradedVolume") or 0)
                    iv = o.get("impliedVolatility") or None
                    if iv:
                        ivs.setdefault(k, []).append(float(iv))
                    q[(k, kind)] = {"bid": o.get("buyPrice1") or None, "ask": o.get("sellPrice1") or None,
                                    "mark": o.get("lastPrice") or None, "iv": round(float(iv), 1) if iv else None, "oi": oi,
                                    # option-chain table: LTP change, OI change, volume
                                    "chg": o.get("change"), "chg_pct": o.get("pChange") if o.get("pChange") is not None else o.get("PChange"),
                                    "oi_chg": o.get("changeinOpenInterest"), "oi_chg_pct": o.get("pchangeinOpenInterest"),
                                    "vol": o.get("totalTradedVolume")}
            coi, poi = sum(calls.values()), sum(puts.values())
            for key, v in (("coi", coi), ("poi", poi), ("cvol", cvol), ("pvol", pvol)):
                tot[key] += v
            atm = min(ivs, key=lambda k: abs(k - spot)) if ivs else None
            atm_iv = round(sum(ivs[atm]) / len(ivs[atm]), 2) if atm else None
            move = spot * atm_iv / 100 * math.sqrt(days / 365) if atm_iv else None
            mp = _max_pain(calls, puts)
            band = BAND if symbol in INDICES else BAND_STOCK
            strikes = sorted(k for k in set(calls) | set(puts) if abs(k / spot - 1) <= band)
            t = days / 365
            chain = [{"k": k,
                      "call": {**(q.get((k, "C")) or {}), "delta": _delta("C", spot, k, (q.get((k, "C")) or {}).get("iv"), t)},
                      "put": {**(q.get((k, "P")) or {}), "delta": _delta("P", spot, k, (q.get((k, "P")) or {}).get("iv"), t)}}
                     for k in strikes]
            c25 = [r for r in chain if r["call"].get("delta") and r["call"].get("iv")]
            p25 = [r for r in chain if r["put"].get("delta") and r["put"].get("iv")]
            skew = None
            if c25 and p25:
                c = min(c25, key=lambda r: abs(r["call"]["delta"] - 0.25))
                p = min(p25, key=lambda r: abs(r["put"]["delta"] + 0.25))
                if abs(c["call"]["delta"] - 0.25) <= 0.1 and abs(p["put"]["delta"] + 0.25) <= 0.1:
                    skew = round(p["put"]["iv"] - c["call"]["iv"], 2)
            expiries.append({
                "code": ds, "expiry": exp.isoformat(), "expiry_ist": exp.strftime("%d %b %Y, 3:30 PM"), "days": round(days, 2),
                "call_oi": coi, "put_oi": poi, "pcr_oi": round(poi / coi, 2) if coi else None,
                "pcr_vol": round(pvol / cvol, 2) if cvol else None,
                "max_pain": mp, "max_pain_pct": round((mp - spot) / spot * 100, 2) if mp else None,
                "atm_iv": atm_iv, "move": round(move, 2) if move else None, "move_pct": round(move / spot * 100, 2) if move else None,
                "skew_25d": skew, "fwd": spot, "atm_strike": min(strikes, key=lambda k: abs(k - spot)) if strikes else None,
                "strikes": [{"k": k, "c": calls.get(k, 0.0), "p": puts.get(k, 0.0)} for k in strikes], "chain": chain,
            })
            time.sleep(0.3)
        vix, vix_chg = self._vix()
        return {"ccy": symbol, "spot": spot, "fetched_at": datetime.now(timezone.utc).isoformat(), "lot": lot_size(symbol),
                "dvol": vix, "dvol_change_24h": vix_chg, "vol_label": "India VIX",
                "pcr_oi": round(tot["poi"] / tot["coi"], 2) if tot["coi"] else None,
                "pcr_vol": round(tot["pvol"] / tot["cvol"], 2) if tot["cvol"] else None,
                "total_oi": tot["coi"] + tot["poi"], "total_oi_usd": None, "expiries": expiries}
