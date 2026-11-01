"""Web push for Market Bias and Nifty OI Change alerts: phones get them even when locked or the app is closed.

A browser that turns on 🔔 Bias subscribes through its own push service (Apple / Google /
Mozilla) and posts the subscription here. A background thread checks every 15 s and, during
market hours, sends one push to every subscription when the Market Bias label or the Nifty OI
Change reading changes (Bullish / Neutral / Bearish). An OI Change reading must hold for about
a minute first, so a reading that flickers around the threshold doesn't send a burst of alerts. The VAPID key pair is created on first run and kept next to
the DB (never in git); subscriptions that the push service reports as gone are dropped.
"""
import base64
import json
import threading
import time

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

from store import DB_PATH

KEY_FILE = DB_PATH.parent / "vapid_private.pem"
SUBS_FILE = DB_PATH.parent / "push_subs.json"
SUBJECT = "https://moneymaau.com"  # contact for the push services (VAPID "sub")
CHECK_EVERY = 15

_lock = threading.Lock()
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
if KEY_FILE.exists():
    _vapid = Vapid.from_file(str(KEY_FILE))
else:
    _vapid = Vapid()
    _vapid.generate_keys()
    _vapid.save_key(str(KEY_FILE))
    KEY_FILE.chmod(0o600)
PUBLIC_KEY = base64.urlsafe_b64encode(_vapid.public_key.public_bytes(
    serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)).rstrip(b"=").decode()

try:
    _subs = json.loads(SUBS_FILE.read_text())  # endpoint -> subscription
except (OSError, ValueError):
    _subs = {}


def _save():
    try:
        SUBS_FILE.write_text(json.dumps(_subs))
    except OSError:
        pass


def _send(sub, title, body, tag="nse-bias"):
    """True if delivered or worth keeping; False when the subscription is gone."""
    try:
        webpush(sub, json.dumps({"title": title, "body": body, "tag": tag}),
                vapid_private_key=str(KEY_FILE), vapid_claims={"sub": SUBJECT},
                ttl=600, headers={"Urgency": "high"}, timeout=10)
    except WebPushException as exc:
        return getattr(exc.response, "status_code", None) not in (404, 410)
    except Exception:  # network trouble: keep it, try again next time
        pass
    return True


def send_all(title, body, tag="nse-bias"):
    with _lock:
        subs = list(_subs.values())
    gone = [s["endpoint"] for s in subs if not _send(s, title, body, tag)]
    if gone:
        with _lock:
            for e in gone:
                _subs.pop(e, None)
            _save()


def subscribe(sub):
    endpoint = (sub or {}).get("endpoint", "")
    keys = (sub or {}).get("keys") or {}
    if not endpoint.startswith("https://") or not keys.get("p256dh") or not keys.get("auth"):
        return False
    with _lock:
        _subs[endpoint] = {"endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]}}
        _save()
    # confirmation, so the phone shows straight away that alerts reach it
    threading.Thread(target=_send, args=(_subs[endpoint], "Market Bias alerts are on",
                                         "You'll get a notification when Market Bias or Nifty OI Change turns Bullish, Neutral or Bearish during market hours."),
                     daemon=True).start()
    return True


def unsubscribe(endpoint):
    with _lock:
        if _subs.pop(endpoint or "", None):
            _save()


OI_HOLD = 4  # checks (about a minute) a new OI Change reading must hold before it is sent


def start(get_bias, get_oi=None):
    """get_bias() -> (label, score, market_open); get_oi() -> (label, detail) for Nifty OI Change, or (None, "").
    Runs the change watcher in the background."""
    def loop():
        prev = oi_prev = oi_new = None
        oi_seen = 0
        while True:
            try:
                label, score, is_open = get_bias()
            except Exception:
                label, is_open = None, False
            now = time.gmtime(time.time() + 5.5 * 3600)
            at = f"{now.tm_hour:02d}:{now.tm_min:02d} IST"
            if label:
                if is_open and prev and label != prev and _subs:
                    send_all(f"Market Bias: {label} ({score:+d})", f"Changed from {prev} to {label} at {at}")
                prev = label
            if get_oi:
                try:
                    oi, detail = get_oi()
                except Exception:
                    oi, detail = None, ""
                if oi:
                    oi_seen = oi_seen + 1 if oi == oi_new else 1
                    oi_new = oi
                    if oi != oi_prev and oi_seen >= OI_HOLD:
                        if is_open and oi_prev and _subs:
                            send_all(f"Nifty OI Change: {oi}", f"Changed from {oi_prev} to {oi} at {at}{' · ' + detail if detail else ''}", tag="nse-oi")
                        oi_prev = oi
            time.sleep(CHECK_EVERY)
    threading.Thread(target=loop, name="bias-push", daemon=True).start()
