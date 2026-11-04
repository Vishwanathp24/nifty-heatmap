"""Fyers Live tab: the owner's own Fyers API app gives live index quotes and the option chain.

Private by design: every /api/fyers/* call needs the dashboard access key (the local build has it,
the public build does not, so the tab is hidden there). The App ID / Secret and the daily access
token are kept in backend/.fyers.json and backend/.fyers_token.json (chmod 600, never committed,
never copied by the deploy). Fyers tokens expire every day, so you log in once each morning.

Talks to the Fyers v3 REST API with requests (no extra package needed).
"""
import hashlib
import json
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode

import requests

API = "https://api-t1.fyers.in/api/v3"
DATA = "https://api-t1.fyers.in/data"
HERE = Path(__file__).resolve().parent
CFG_FILE = HERE / ".fyers.json"
TOKEN_FILE = HERE / ".fyers_token.json"
IST = timezone(timedelta(hours=5, minutes=30))

INDEX_SYMBOLS = [  # (Fyers symbol, display name)
    ("NSE:NIFTY50-INDEX", "Nifty 50"), ("NSE:NIFTYBANK-INDEX", "Bank Nifty"), ("NSE:FINNIFTY-INDEX", "Fin Nifty"),
    ("NSE:MIDCPNIFTY-INDEX", "Midcap Nifty"), ("BSE:SENSEX-INDEX", "Sensex"), ("NSE:INDIAVIX-INDEX", "India VIX"),
]
CHAIN_SYMBOLS = {"NIFTY": "NSE:NIFTY50-INDEX", "BANKNIFTY": "NSE:NIFTYBANK-INDEX", "FINNIFTY": "NSE:FINNIFTY-INDEX",
                 "MIDCPNIFTY": "NSE:MIDCPNIFTY-INDEX", "SENSEX": "BSE:SENSEX-INDEX"}
LOTS = {"NIFTY": 65, "BANKNIFTY": 30, "FINNIFTY": 60, "MIDCPNIFTY": 120, "SENSEX": 20}  # contracts -> shares, as on the OI panel
TTL = 3  # seconds a reading is reused (several open tabs share one Fyers call)


class FyersError(Exception):
    pass


def _read(p):
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def _write(p, d):
    p.write_text(json.dumps(d))
    p.chmod(0o600)


def _today():
    return datetime.now(IST).strftime("%Y-%m-%d")


class FyersLive:
    def __init__(self):
        self.lock = threading.Lock()
        self.states = {}  # login state -> created time (stops forged callbacks)
        self.cache = {}

    # ---- setup and login -------------------------------------------------------------
    def config(self):
        c = _read(CFG_FILE)
        return c if c.get("client_id") and c.get("secret_key") and c.get("redirect_uri") else None

    def save_config(self, client_id, secret_key, redirect_uri):
        client_id, secret_key, redirect_uri = (client_id or "").strip(), (secret_key or "").strip(), (redirect_uri or "").strip()
        if not client_id or not secret_key or not redirect_uri.startswith(("http://", "https://")):
            raise ValueError("App ID, Secret ID and a redirect URL (http… or https…) are all needed.")
        _write(CFG_FILE, {"client_id": client_id, "secret_key": secret_key, "redirect_uri": redirect_uri})
        TOKEN_FILE.unlink(missing_ok=True)

    def token(self):
        t = _read(TOKEN_FILE)
        return t.get("access_token") if t.get("date") == _today() else None  # Fyers tokens end each day

    def login_url(self):
        c = self.config()
        if not c:
            raise FyersError("Add your Fyers App ID and Secret first.")
        st = secrets.token_urlsafe(16)
        now = time.time()
        self.states = {k: v for k, v in self.states.items() if now - v < 900}
        self.states[st] = now
        return f"{API}/generate-authcode?" + urlencode({"client_id": c["client_id"], "redirect_uri": c["redirect_uri"],
                                                         "response_type": "code", "state": st})

    def finish_login(self, auth_code, state):
        if not state or self.states.pop(state, None) is None:
            raise FyersError("This login link has expired. Start the Fyers login again from the Fyers Live tab.")
        c = self.config()
        if not c or not auth_code:
            raise FyersError("Fyers did not send a login code.")
        r = requests.post(API + "/validate-authcode", timeout=20, json={
            "grant_type": "authorization_code", "code": auth_code,
            "appIdHash": hashlib.sha256(f"{c['client_id']}:{c['secret_key']}".encode()).hexdigest()})
        d = r.json() if r.content else {}
        if d.get("s") != "ok" or not d.get("access_token"):
            raise FyersError(d.get("message") or f"Fyers login failed (HTTP {r.status_code}).")
        _write(TOKEN_FILE, {"access_token": d["access_token"], "date": _today()})
        self.cache.clear()

    def logout(self):
        TOKEN_FILE.unlink(missing_ok=True)
        self.cache.clear()

    def status(self):
        c = self.config()
        out = {"configured": bool(c), "logged_in": False, "redirect_uri": c and c["redirect_uri"],
               "client_id": c and c["client_id"]}
        if c and self.token():
            try:
                p = self._get(API + "/profile")
                out.update(logged_in=True, name=(p.get("data") or {}).get("name"), fy_id=(p.get("data") or {}).get("fy_id"))
            except FyersError as e:
                out["error"] = str(e)
        return out

    # ---- data --------------------------------------------------------------------------
    def _get(self, url, params=None):
        c, tok = self.config(), self.token()
        if not c or not tok:
            raise FyersError("Not logged in to Fyers today.")
        try:
            r = requests.get(url, params=params, timeout=15, headers={"Authorization": f"{c['client_id']}:{tok}"})
        except requests.RequestException as e:
            raise FyersError(f"Fyers did not answer ({e.__class__.__name__}).")
        try:
            d = r.json()
        except ValueError:
            raise FyersError(f"Fyers returned HTTP {r.status_code}.")
        if d.get("s") != "ok":
            if d.get("code") in (-8, -15, -16, -17) or r.status_code == 401:  # expired / invalid token
                TOKEN_FILE.unlink(missing_ok=True)
                raise FyersError("Your Fyers login has expired. Log in again.")
            raise FyersError(d.get("message") or f"Fyers error (HTTP {r.status_code}).")
        return d

    def _cached(self, key, fn):
        hit = self.cache.get(key)
        if hit and time.time() - hit[0] < TTL:
            return hit[1]
        with self.lock:
            hit = self.cache.get(key)
            if hit and time.time() - hit[0] < TTL:
                return hit[1]
            v = fn()
            self.cache[key] = (time.time(), v)
            return v

    def quotes(self):
        def f():
            d = self._get(DATA + "/quotes", {"symbols": ",".join(s for s, _ in INDEX_SYMBOLS)})
            names = dict(INDEX_SYMBOLS)
            out = []
            for q in d.get("d") or []:
                v = q.get("v") or {}
                out.append({"symbol": q.get("n"), "name": names.get(q.get("n"), q.get("n")), "ltp": v.get("lp"),
                            "chg": v.get("ch"), "chg_pct": v.get("chp"), "open": v.get("open_price"), "high": v.get("high_price"),
                            "low": v.get("low_price"), "prev": v.get("prev_close_price")})
            order = [s for s, _ in INDEX_SYMBOLS]
            out.sort(key=lambda x: order.index(x["symbol"]) if x["symbol"] in order else 99)
            return out
        return self._cached("quotes", f)

    def chain(self, name="NIFTY", strikes=10, expiry=""):
        sym = CHAIN_SYMBOLS.get(name.upper())
        if not sym:
            raise ValueError("Unknown index.")
        strikes = max(1, min(int(strikes), 50))

        def f():
            d = (self._get(DATA + "/options-chain-v3", {"symbol": sym, "strikecount": strikes, "timestamp": expiry or ""}).get("data")) or {}
            rows, spot = {}, None
            for o in d.get("optionsChain") or []:
                t = o.get("option_type")
                if not t:  # the index itself
                    spot = o.get("ltp")
                    continue
                k = o.get("strike_price")
                side = "call" if t == "CE" else "put"
                rows.setdefault(k, {"k": k})[side] = {"ltp": o.get("ltp"), "chg": o.get("ltpch"), "chg_pct": o.get("ltpchp"),
                                                      "oi": o.get("oi"), "oi_chg": o.get("oich"), "oi_chg_pct": o.get("oichp"),
                                                      "prev_oi": o.get("prev_oi"), "vol": o.get("volume"), "bid": o.get("bid"), "ask": o.get("ask")}
            ch = sorted(rows.values(), key=lambda r: r["k"])
            atm = min((r["k"] for r in ch), key=lambda k: abs(k - spot)) if ch and spot else None
            exps = [{"label": e.get("date"), "ts": e.get("expiry")} for e in d.get("expiryData") or []]
            return {"index": name.upper(), "symbol": sym, "spot": spot, "atm": atm, "lot": LOTS.get(name.upper(), 1),
                    "expiries": exps, "expiry": expiry or (exps[0]["ts"] if exps else ""), "chain": ch,
                    "vix": (d.get("indiavixData") or {}).get("ltp"), "at": datetime.now(timezone.utc).isoformat()}
        return self._cached(f"chain:{name}:{strikes}:{expiry}", f)
