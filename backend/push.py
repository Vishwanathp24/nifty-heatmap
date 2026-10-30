"""Web push for Market Bias alerts: phones get them even when locked or the app is closed.

A browser that turns on 🔔 Bias subscribes through its own push service (Apple / Google /
Mozilla) and posts the subscription here. A background thread checks the bias every 15 s
and, during market hours, sends one push to every subscription when the label changes
(Bullish / Neutral / Bearish). The VAPID key pair is created on first run and kept next to
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


def _send(sub, title, body):
    """True if delivered or worth keeping; False when the subscription is gone."""
    try:
        webpush(sub, json.dumps({"title": title, "body": body, "tag": "nse-bias"}),
                vapid_private_key=str(KEY_FILE), vapid_claims={"sub": SUBJECT},
                ttl=600, headers={"Urgency": "high"}, timeout=10)
    except WebPushException as exc:
        return getattr(exc.response, "status_code", None) not in (404, 410)
    except Exception:  # network trouble: keep it, try again next time
        pass
    return True


def send_all(title, body):
    with _lock:
        subs = list(_subs.values())
    gone = [s["endpoint"] for s in subs if not _send(s, title, body)]
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
                                         "You'll get a notification when the bias changes during market hours."),
                     daemon=True).start()
    return True


def unsubscribe(endpoint):
    with _lock:
        if _subs.pop(endpoint or "", None):
            _save()


def start(get_bias):
    """get_bias() -> (label, score, market_open). Runs the change watcher in the background."""
    def loop():
        prev = None
        while True:
            try:
                label, score, is_open = get_bias()
            except Exception:
                label = None
            if label:
                if is_open and prev and label != prev and _subs:
                    now = time.gmtime(time.time() + 5.5 * 3600)
                    send_all(f"Market Bias: {label} ({score:+d})",
                             f"Changed from {prev} to {label} at {now.tm_hour:02d}:{now.tm_min:02d} IST")
                prev = label
            time.sleep(CHECK_EVERY)
    threading.Thread(target=loop, name="bias-push", daemon=True).start()
