"""Kite Live: the owner's own Zerodha Kite Connect app gives live index quotes and option-chain OI.

Private by design: every /api/kite/* call needs the dashboard access key (the local build has it; on the
public site the owner unlocks a browser at /?owner). The API key / secret and the daily access token are kept
in backend/.kite.json and backend/.kite_token.json (chmod 600, never committed, never copied by the deploy).
Kite access tokens end every morning (about 6 AM), so you log in once a day.

Kite has no option-chain call: the chain is built from the NFO / BFO instrument list plus live quotes
(up to 500 instruments per call). Kite quotes have no previous-day OI, so "OI change" uses the previous
close OI from the NSE option chain the rest of the site already reads (open interest at the last close).
Talks to the Kite Connect v3 REST API with requests (no extra package needed).
"""
import csv
import hashlib
import io
import json
import secrets
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode

import requests

API = "https://api.kite.trade"
LOGIN = "https://kite.zerodha.com/connect/login"
HERE = Path(__file__).resolve().parent
CFG_FILE = HERE / ".kite.json"
TOKEN_FILE = HERE / ".kite_token.json"
IST = timezone(timedelta(hours=5, minutes=30))
HDR = {"X-Kite-Version": "3"}

INDEX_QUOTES = [("NSE:NIFTY 50", "Nifty 50"), ("NSE:NIFTY BANK", "Bank Nifty"), ("NSE:NIFTY FIN SERVICE", "Fin Nifty"),
                ("NSE:NIFTY MID SELECT", "Midcap Nifty"), ("BSE:SENSEX", "Sensex"), ("NSE:INDIA VIX", "India VIX")]
# option name in the instrument list -> (exchange, index quote)
UNDERLYINGS = {"NIFTY": ("NFO", "NSE:NIFTY 50"), "BANKNIFTY": ("NFO", "NSE:NIFTY BANK"), "FINNIFTY": ("NFO", "NSE:NIFTY FIN SERVICE"),
               "MIDCPNIFTY": ("NFO", "NSE:NIFTY MID SELECT"), "SENSEX": ("BFO", "BSE:SENSEX")}
TTL = 2  # seconds a reading is reused (Kite allows about 1 quote call a second)


class KiteError(Exception):
    pass


def _read(p):
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def _write(p, d):
    p.write_text(json.dumps(d))
    p.chmod(0o600)


def _session_day():
    """Kite tokens end around 6 AM IST: a login before 6 AM belongs to the previous day."""
    return (datetime.now(IST) - timedelta(hours=6)).strftime("%Y-%m-%d")


class KiteLive:
    def __init__(self, prev_oi=None):
        self.lock = threading.Lock()
        self.states = {}
        self.cache = {}
        self.instruments = {}  # exchange -> (day, rows)
        self.prev_oi = prev_oi  # fn(name, expiry_date) -> {(strike, 'CE'|'PE'): previous close OI in shares} or None

    # ---- setup and login -------------------------------------------------------------
    def config(self):
        c = _read(CFG_FILE)
        return c if c.get("api_key") and c.get("api_secret") else None

    def save_config(self, api_key, api_secret):
        api_key, api_secret = (api_key or "").strip(), (api_secret or "").strip()
        if not api_key or not api_secret:
            raise ValueError("Both the API key and the API secret are needed.")
        _write(CFG_FILE, {"api_key": api_key, "api_secret": api_secret})
        TOKEN_FILE.unlink(missing_ok=True)

    def token(self):
        t = _read(TOKEN_FILE)
        return t if t.get("access_token") and t.get("day") == _session_day() else None

    def login_url(self):
        c = self.config()
        if not c:
            raise KiteError("Add your Kite API key and secret first.")
        st = secrets.token_urlsafe(16)
        now = time.time()
        self.states = {k: v for k, v in self.states.items() if now - v < 900}
        self.states[st] = now
        return f"{LOGIN}?" + urlencode({"v": 3, "api_key": c["api_key"], "redirect_params": urlencode({"state": st})})

    def finish_login(self, request_token, state):
        # The state check is a convenience, not the lock: a Kite token can only be turned into a session with our
        # API secret, and a Personal app logs in only its own Zerodha client ID. So a login started from Kite itself
        # (or one that spanned a server restart, which forgets the state) is accepted too.
        if state:
            self.states.pop(state, None)
        c = self.config()
        if not c:
            raise KiteError("The Kite API key and secret are not saved on this site yet. Open the Kite view, save them, then log in.")
        if not request_token:
            raise KiteError("Kite did not send a login token.")
        r = requests.post(API + "/session/token", headers=HDR, timeout=20, data={
            "api_key": c["api_key"], "request_token": request_token,
            "checksum": hashlib.sha256((c["api_key"] + request_token + c["api_secret"]).encode()).hexdigest()})
        d = r.json() if r.content else {}
        tok = (d.get("data") or {}).get("access_token")
        if d.get("status") != "success" or not tok:
            raise KiteError(d.get("message") or f"Kite login failed (HTTP {r.status_code}).")
        u = d["data"]
        _write(TOKEN_FILE, {"access_token": tok, "day": _session_day(), "name": u.get("user_shortname") or u.get("user_name"),
                            "user_id": u.get("user_id")})
        self.cache.clear()

    def logout(self):
        TOKEN_FILE.unlink(missing_ok=True)
        self.cache.clear()

    def status(self):
        c, t = self.config(), self.token()
        return {"configured": bool(c), "logged_in": bool(c and t), "api_key": c and c["api_key"],
                "name": t and t.get("name"), "user_id": t and t.get("user_id")}

    # ---- data --------------------------------------------------------------------------
    def _get(self, path, params=None, raw=False):
        c, t = self.config(), self.token()
        if not c or not t:
            raise KiteError("Not logged in to Kite today.")
        try:
            r = requests.get(API + path, params=params, timeout=20,
                             headers={**HDR, "Authorization": f"token {c['api_key']}:{t['access_token']}"})
        except requests.RequestException as e:
            raise KiteError(f"Kite did not answer ({e.__class__.__name__}).")
        if r.status_code == 403:
            TOKEN_FILE.unlink(missing_ok=True)
            raise KiteError("Your Kite login has expired. Log in again.")
        if raw and r.ok:
            return r.text
        try:
            d = r.json()
        except ValueError:
            raise KiteError(f"Kite returned HTTP {r.status_code}.")
        if d.get("status") != "success":
            msg = d.get("message") or f"Kite error (HTTP {r.status_code})."
            if d.get("error_type") == "PermissionException" or "permission" in msg.lower():
                msg += " (Live quotes need a paid Kite Connect app, not the free Personal app.)"
            raise KiteError(msg)
        return d.get("data") or {}

    def _cached(self, key, fn, ttl=TTL):
        hit = self.cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        with self.lock:
            hit = self.cache.get(key)
            if hit and time.time() - hit[0] < ttl:
                return hit[1]
            v = fn()
            self.cache[key] = (time.time(), v)
            return v

    def _instruments(self, exch):
        day = datetime.now(IST).strftime("%Y-%m-%d")
        hit = self.instruments.get(exch)
        if hit and hit[0] == day:
            return hit[1]
        rows = []
        for r in csv.DictReader(io.StringIO(self._get(f"/instruments/{exch}", raw=True))):
            if r.get("instrument_type") in ("CE", "PE") and r.get("name") in UNDERLYINGS:
                rows.append({"sym": r["tradingsymbol"], "name": r["name"], "type": r["instrument_type"],
                             "strike": float(r["strike"]), "expiry": r["expiry"], "lot": int(float(r["lot_size"] or 0))})
        self.instruments[exch] = (day, rows)
        return rows

    def _quote(self, keys):
        out = {}
        for i in range(0, len(keys), 500):
            out.update(self._get("/quote", [("i", k) for k in keys[i:i + 500]]))
        return out

    def quotes(self):
        def f():
            q = self._quote([k for k, _ in INDEX_QUOTES])
            out = []
            for k, name in INDEX_QUOTES:
                v = q.get(k)
                if not v:
                    continue
                o, lp = v.get("ohlc") or {}, v.get("last_price")
                prev = o.get("close")
                chg = lp - prev if lp is not None and prev else None
                out.append({"symbol": k, "name": name, "ltp": lp, "chg": chg, "chg_pct": chg / prev * 100 if chg is not None else None,
                            "open": o.get("open"), "high": o.get("high"), "low": o.get("low"), "prev": prev})
            return out
        return self._cached("quotes", f)

    def chain(self, name="NIFTY", strikes=10, expiry=""):
        name = name.upper()
        if name not in UNDERLYINGS:
            raise ValueError("Unknown index.")
        exch, idx = UNDERLYINGS[name]
        strikes = max(1, min(int(strikes), 40))

        def f():
            today = date.today().isoformat()
            opts = [r for r in self._instruments(exch) if r["name"] == name and r["expiry"] >= today]
            exps = sorted({r["expiry"] for r in opts})
            if not exps:
                raise KiteError("No option contracts found.")
            ex = expiry if expiry in exps else exps[0]
            opts = [r for r in opts if r["expiry"] == ex]
            spot = (self._quote([idx]).get(idx) or {}).get("last_price")
            ks = sorted({r["strike"] for r in opts})
            if not ks or not spot:
                raise KiteError("No live price for the index.")
            atm = min(ks, key=lambda k: abs(k - spot))
            i = ks.index(atm)
            win = set(ks[max(0, i - strikes): i + strikes + 1])
            pick = [r for r in opts if r["strike"] in win]
            q = self._quote([f"{exch}:{r['sym']}" for r in pick])
            prev = None
            if self.prev_oi:
                try:
                    prev = self.prev_oi(name, ex)
                except Exception:
                    prev = None
            rows = {}
            for r in pick:
                v = q.get(f"{exch}:{r['sym']}") or {}
                o = v.get("ohlc") or {}
                lp, pc = v.get("last_price"), o.get("close")
                oi = v.get("oi")
                p = prev.get((r["strike"], r["type"])) if prev else None
                rows.setdefault(r["strike"], {"k": r["strike"]})["call" if r["type"] == "CE" else "put"] = {
                    "ltp": lp, "chg": lp - pc if lp is not None and pc else None, "oi": oi,
                    "prev_oi": p, "oi_chg": oi - p if oi is not None and p is not None else None,
                    "vol": v.get("volume"), "oi_high": v.get("oi_day_high"), "oi_low": v.get("oi_day_low")}
            lot = pick[0]["lot"] if pick else None
            return {"index": name, "spot": spot, "atm": atm, "lot": lot, "expiries": [{"label": datetime.strptime(e, "%Y-%m-%d").strftime("%d %b %Y"), "ts": e} for e in exps[:8]],
                    "expiry": ex, "chain": [rows[k] for k in sorted(rows)], "has_prev": bool(prev),
                    "at": datetime.now(timezone.utc).isoformat()}
        return self._cached(f"chain:{name}:{strikes}:{expiry}", f)

    # ---- your account (works on the free Personal app too) -------------------------------
    def portfolio(self):
        def f():
            pos = self._get("/portfolio/positions")
            hold = self._get("/portfolio/holdings")
            def p(x):
                return {"symbol": x.get("tradingsymbol"), "exchange": x.get("exchange"), "product": x.get("product"),
                        "qty": x.get("quantity"), "avg": x.get("average_price"), "ltp": x.get("last_price"),
                        "close": x.get("close_price"), "pnl": x.get("pnl"), "m2m": x.get("m2m"),
                        "realised": x.get("realised"), "unrealised": x.get("unrealised"),
                        "buy_qty": x.get("day_buy_quantity"), "sell_qty": x.get("day_sell_quantity")}
            def h(x):
                qty = (x.get("quantity") or 0) + (x.get("t1_quantity") or 0)
                avg, ltp, close = x.get("average_price") or 0, x.get("last_price") or 0, x.get("close_price") or 0
                return {"symbol": x.get("tradingsymbol"), "exchange": x.get("exchange"), "qty": qty, "t1": x.get("t1_quantity") or 0,
                        "avg": avg, "ltp": ltp, "close": close, "invested": qty * avg, "value": qty * ltp,
                        "pnl": x.get("pnl") if x.get("pnl") is not None else qty * (ltp - avg),
                        "day_chg": qty * (ltp - close) if close else None, "day_pct": x.get("day_change_percentage")}
            return {"positions": [p(x) for x in (pos.get("net") or [])], "holdings": [h(x) for x in hold or []],
                    "at": datetime.now(timezone.utc).isoformat()}
        return self._cached("portfolio", f, ttl=5)

