"""Fyers API v3 integration - Phase 1: login flow + a raw-quote diagnostic
helper, deliberately NOT wired into the F&O Scanner table yet.

Why split like this: Fyers' official docs don't publish the exact Quotes
response field names anywhere fetchable, and there are user-reported cases
of the Quotes API returning a null LTP specifically for NSE F&O-list
symbols even during market hours (a real, documented risk - not
hypothetical). Rather than guess field names and silently ship wrong
numbers, this module gets the auth flow + a raw passthrough working first;
the actual field-mapping into scanner rows happens once a real response
has been inspected together with the user. See PROJECT_CONTEXT.md.

Auth flow (Fyers API v3, via the official `fyers-apiv3` SDK):
1. GET /fyers/login -> redirects the user's browser to Fyers' own login
   page (SessionModel.generate_authcode()).
2. User logs in with their Fyers credentials + TOTP, approves the app.
3. Fyers redirects back to FYERS_REDIRECT_URI with an auth `code` query
   param - that's /fyers/callback below.
4. The callback exchanges the code for an access token
   (SessionModel.set_token + generate_token()) and persists it.

Access tokens expire daily (Fyers invalidates them overnight) - this is
tracked here as "valid only for the calendar day (IST) it was issued",
a conservative simplification of Fyers' actual expiry, so the user
re-logs in once each morning rather than the app silently using a stale/
invalid token.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import pathlib

from fyers_apiv3 import fyersModel

from .nse_client import DATA_DIR, IST

TOKEN_PATH = DATA_DIR / "fyers_token.json"
FYERS_QUOTES_BATCH_SIZE = 50  # Fyers' own documented cap per Quotes call


class FyersConfigError(RuntimeError):
    """FYERS_APP_ID / FYERS_APP_SECRET / FYERS_REDIRECT_URI not set."""


class FyersNotConnected(RuntimeError):
    """No valid (today-issued) access token - the user needs to /fyers/login."""


def _app_id() -> str:
    v = os.environ.get("FYERS_APP_ID")
    if not v:
        raise FyersConfigError("FYERS_APP_ID environment variable is not set")
    return v


def _app_secret() -> str:
    v = os.environ.get("FYERS_APP_SECRET")
    if not v:
        raise FyersConfigError("FYERS_APP_SECRET environment variable is not set")
    return v


def _redirect_uri() -> str:
    # Defaults to the deployed site's callback; override locally via env
    # (e.g. http://localhost:8420/fyers/callback) - must exactly match
    # whatever Redirect URL is registered on the Fyers app itself.
    return os.environ.get("FYERS_REDIRECT_URI", "https://heatmap.bankerage.in/fyers/callback")


def _session_model(state: str = "nifty-dashboard") -> "fyersModel.SessionModel":
    return fyersModel.SessionModel(
        client_id=_app_id(),
        secret_key=_app_secret(),
        redirect_uri=_redirect_uri(),
        response_type="code",
        state=state,
        grant_type="authorization_code",
    )


def get_login_url() -> str:
    """The URL to send the user's browser to for /fyers/login."""
    return _session_model().generate_authcode()


def exchange_auth_code(auth_code: str) -> str:
    """Trades the callback's `code` param for an access token, persists it
    (with today's IST date so we know when it goes stale), and returns it."""
    session = _session_model()
    session.set_token(auth_code)
    response = session.generate_token()
    access_token = response.get("access_token") if isinstance(response, dict) else None
    if not access_token:
        raise RuntimeError(f"Fyers token exchange failed: {response}")

    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(
        json.dumps(
            {
                "access_token": access_token,
                "issued_date": dt.datetime.now(IST).date().isoformat(),
            }
        )
    )
    return access_token


def _load_token() -> str | None:
    if not TOKEN_PATH.exists():
        return None
    try:
        data = json.loads(TOKEN_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    if data.get("issued_date") != dt.datetime.now(IST).date().isoformat():
        return None  # issued on an earlier day - Fyers will have invalidated it
    return data.get("access_token")


def is_connected() -> bool:
    return _load_token() is not None


def get_connection_status() -> dict:
    token = _load_token()
    return {"connected": token is not None}


def _client(token: str) -> "fyersModel.FyersModel":
    return fyersModel.FyersModel(token=token, is_async=False, client_id=_app_id(), log_path="")


def get_raw_quotes(symbols: list[str]) -> dict:
    """Diagnostic passthrough - NOT parsed/shaped yet (see module docstring).
    `symbols` in Fyers format, e.g. ["NSE:RELIANCE-EQ", "NSE:TCS-EQ"].
    Batches at FYERS_QUOTES_BATCH_SIZE since Fyers caps Quotes calls at 50
    symbols; merges each batch's raw response list under one "d" key so the
    caller sees a single combined response shaped like Fyers' own."""
    token = _load_token()
    if token is None:
        raise FyersNotConnected("No valid Fyers access token - visit /fyers/login first")

    client = _client(token)
    combined: list = []
    last_response = None
    for i in range(0, len(symbols), FYERS_QUOTES_BATCH_SIZE):
        batch = symbols[i : i + FYERS_QUOTES_BATCH_SIZE]
        response = client.quotes({"symbols": ",".join(batch)})
        last_response = response
        if isinstance(response, dict) and isinstance(response.get("d"), list):
            combined.extend(response["d"])
        else:
            # Surface whatever Fyers actually returned (e.g. an error dict)
            # rather than silently dropping this batch.
            raise RuntimeError(f"Unexpected Fyers quotes response: {response}")

    return {"s": last_response.get("s") if isinstance(last_response, dict) else None, "d": combined}


def to_fyers_symbol(nse_symbol: str) -> str:
    """NSE trading symbol (as used everywhere else in this app, e.g.
    "RELIANCE") -> Fyers' equity symbol format, e.g. "NSE:RELIANCE-EQ"."""
    return f"NSE:{nse_symbol}-EQ"
