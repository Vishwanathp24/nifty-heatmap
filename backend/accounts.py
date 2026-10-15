"""Journal accounts: Google sign-in + each user's trade journal (SQLite).

Sign-in uses Google Identity Services: the browser gets a Google ID token, we verify it with Google's
tokeninfo endpoint (audience must be our GOOGLE_CLIENT_ID, email verified), then hand back our own random
session token (30 days). Only the Google account id, email, name and picture are kept — no passwords.
Without GOOGLE_CLIENT_ID set, sign-in is off and the Journal stays browser-only.

On Render the DB lives on the persistent disk (DATA_DIR / NIFTY_DATA_DIR); locally backend/data.
"""
import json
import os
import secrets
import sqlite3
import threading
import time
from pathlib import Path

import requests

DB_PATH = Path(os.environ.get("DATA_DIR") or os.environ.get("NIFTY_DATA_DIR") or Path(__file__).resolve().parent / "data") / "accounts.db"
SESSION_DAYS = 30
MAX_JOURNAL_BYTES = 2_000_000


def client_id():
    return os.environ.get("GOOGLE_CLIENT_ID", "").strip()


class Accounts:
    def __init__(self, path=DB_PATH):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.lock = threading.Lock()
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS users (sub TEXT PRIMARY KEY, email TEXT, name TEXT, picture TEXT, created REAL, seen REAL);
            CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, sub TEXT, expires REAL);
            CREATE TABLE IF NOT EXISTS journal (sub TEXT PRIMARY KEY, trades TEXT, updated REAL);
        """)

    def sign_in(self, credential):
        cid = client_id()
        if not cid:
            raise PermissionError("Google sign-in is not set up on this server.")
        r = requests.get("https://oauth2.googleapis.com/tokeninfo", params={"id_token": credential}, timeout=10)
        if r.status_code != 200:
            raise PermissionError("Google could not verify this sign-in.")
        info = r.json()
        if info.get("aud") != cid or info.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
            raise PermissionError("This sign-in was not issued for this site.")
        if int(info.get("exp", 0)) < time.time() or str(info.get("email_verified")).lower() != "true":
            raise PermissionError("Sign-in expired or the email is not verified.")
        user = {"sub": info["sub"], "email": info.get("email", ""), "name": info.get("name", ""), "picture": info.get("picture", "")}
        token, now = secrets.token_urlsafe(32), time.time()
        with self.lock:
            self.db.execute("INSERT INTO users VALUES (?,?,?,?,?,?) ON CONFLICT(sub) DO UPDATE SET email=excluded.email, "
                            "name=excluded.name, picture=excluded.picture, seen=excluded.seen",
                            (user["sub"], user["email"], user["name"], user["picture"], now, now))
            self.db.execute("DELETE FROM sessions WHERE expires < ?", (now,))
            self.db.execute("INSERT INTO sessions VALUES (?,?,?)", (token, user["sub"], now + SESSION_DAYS * 86400))
        return {"token": token, **{k: user[k] for k in ("email", "name", "picture")}}

    def user(self, auth_header):
        token = (auth_header or "").removeprefix("Bearer ").strip()
        if not token:
            return None
        with self.lock:
            row = self.db.execute("SELECT u.sub, u.email, u.name, u.picture FROM sessions s JOIN users u ON u.sub = s.sub "
                                  "WHERE s.token = ? AND s.expires > ?", (token, time.time())).fetchone()
        return dict(zip(("sub", "email", "name", "picture"), row)) if row else None

    def sign_out(self, auth_header):
        token = (auth_header or "").removeprefix("Bearer ").strip()
        with self.lock:
            self.db.execute("DELETE FROM sessions WHERE token = ?", (token,))

    def journal(self, sub):
        with self.lock:
            row = self.db.execute("SELECT trades, updated FROM journal WHERE sub = ?", (sub,)).fetchone()
        return {"trades": json.loads(row[0]) if row else [], "updated": row[1] if row else None}

    def save_journal(self, sub, trades):
        if not isinstance(trades, list):
            raise ValueError("trades must be a list")
        text = json.dumps(trades, separators=(",", ":"))
        if len(text) > MAX_JOURNAL_BYTES:
            raise ValueError("Journal is too large to save (over 2 MB).")
        now = time.time()
        with self.lock:
            self.db.execute("INSERT INTO journal VALUES (?,?,?) ON CONFLICT(sub) DO UPDATE SET trades=excluded.trades, updated=excluded.updated",
                            (sub, text, now))
        return {"saved": len(trades), "updated": now}
