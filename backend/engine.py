"""Live NSE engine.

Every 10 s (market hours) it pulls three NSE feeds — all indices, the F&O
universe and Nifty 200 constituents with live quotes — and from those builds
this app's own 1-minute bars per stock:

  close  = last traded price at the last snapshot in the minute
  high   = max of snapshot prices, raised to NSE's day high if that rose
  low    = likewise with the day low          (so wicks between polls count)
  cum    = NSE's cumulative day volume at the minute's last snapshot

Minutes the app was not running for are back-filled from NSE's per-minute
price series (price only; no volume). Bars are persisted to SQLite, so the
recorded `cum` values of past sessions form the time-of-day volume baseline.

ORB rules (unchanged from the spec):
  OR          = high/low 09:15-10:15 (exact from NSE day high/low when the app
                was running before 10:15, else from the minute series — flagged)
  signal      = first COMPLETED 5/15-min bar (aligned to 10:15) whose close is
                beyond the OR; break time = that bar's close time
  vol ratio   = cumulative volume to break time / average cumulative volume to
                the same clock time over recorded previous sessions (max 5)
"""
import threading
import time
import traceback
from datetime import date, datetime, timedelta
from statistics import mean

from zoneinfo import ZoneInfo

import sources
from config import (BASELINE_SESSIONS, BROAD, CLOSE_MIN, FO_INDEX, KEY_INDICES, OPEN_MIN, OR_END_MIN, OR_MINUTES,
                    POLL_SECONDS, SECTOR_LABELS, SECTORS)

IST = ZoneInfo("Asia/Kolkata")
DONE = 10 ** 4  # "data complete" marker for finished sessions


def _m(dt):
    return dt.hour * 60 + dt.minute


def hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


def _pct(a, b):
    return round((a - b) / b * 100, 2) if a is not None and b else None


def quote_view(q):
    if not q or q.get("ltp") is None:
        return None
    ltp, prev, opn = q["ltp"], q.get("prev"), q.get("open") or None
    return {"ltp": ltp, "open": opn, "high": q.get("high"), "low": q.get("low"), "prev_close": prev,
            "change": round(ltp - prev, 2) if prev else None, "pct_prev": _pct(ltp, prev),
            "change_open": round(ltp - opn, 2) if opn else None, "pct_open": _pct(ltp, opn)}


def breadth(rows, key):
    vals = [r[key] for r in rows if r.get(key) is not None]
    up, down = sum(v > 0 for v in vals), sum(v < 0 for v in vals)
    return {"up": up, "down": down, "unchanged": len(vals) - up - down, "total": len(vals),
            "ad_ratio": round(up / down, 2) if down else None}


class Engine:
    def __init__(self, store):
        self.store = store
        self.lock = threading.RLock()
        self.uni = None
        self.indices, self.quotes, self.sensex = {}, {}, None
        self.session = None          # ISO date of the session in memory
        self.bars = {}               # sym -> {minute: [o, h, l, c, v, cum, src]}
        self.orx = {60: {}, 15: {}}  # OR minutes -> {sym: (hi, lo)} exact opening range
        self.snap = {}               # sym -> {"high", "low"} from the previous snapshot
        self.until = {}              # sym -> fractional minute up to which bars are complete
        self.baseline = ([], {})     # (recorded session dates, {sym: {d: {m: cum}}})
        self.dvol = ([], {})         # (bhavcopy dates, {sym: avg daily volume})
        self.poll_ok = self.poll_err = self.source_ts = None
        self.backfill = {"state": "idle", "done": 0, "total": 0, "at": None}
        self.last_backfill = {}
        self.need_backfill = True
        self.started = False

    # ---- lifecycle -----------------------------------------------------------------------

    def start(self):
        if not self.started:
            self.started = True
            threading.Thread(target=self._poll_loop, name="nse-poll", daemon=True).start()
            threading.Thread(target=self._house_loop, name="nse-house", daemon=True).start()

    def _active(self, now):
        return now.weekday() < 5 and 8 * 60 + 55 <= _m(now) <= 16 * 60 + 5

    def _poll_loop(self):
        while True:
            t0 = time.time()
            try:
                self.poll()
            except Exception as exc:  # keep polling; the UI shows the error + last good data
                self.poll_err = f"{type(exc).__name__}: {exc}"
                traceback.print_exc()
            interval = POLL_SECONDS if self._active(datetime.now(IST)) else 60
            time.sleep(max(1.0, interval - (time.time() - t0)))

    def _house_loop(self):
        while True:
            try:
                if self.session:
                    self._ensure_bhavcopies()
                    if self.need_backfill:
                        self.need_backfill = False
                        self._backfill()
            except Exception:
                traceback.print_exc()
            time.sleep(20)

    # ---- universe ----------------------------------------------------------------------------

    def _build_universe(self):
        meta = {}
        _, fo = sources.constituents(FO_INDEX)
        lists = {}
        for key, name in BROAD.items():
            _, rows = sources.constituents(name)
            lists[key] = set(rows)
            for s, r in rows.items():
                meta.setdefault(s, r)
        members = {}
        for sym, _ in SECTORS:
            try:
                _, rows = sources.constituents(sym)
            except sources.SourceError:
                rows = {}
            members[sym] = set(rows)
            for s, r in rows.items():
                meta.setdefault(s, r)
        for s, r in fo.items():
            meta[s] = r
        scan = sorted(set(fo) | lists["n200"])
        stocks = {}
        for s in scan:
            secs = [sec for sec, _ in SECTORS if s in members[sec]]
            r = meta.get(s, {})
            stocks[s] = {
                "symbol": s, "company": r.get("company") or s, "sectors": secs,
                "sector": SECTOR_LABELS[secs[0]] if secs else "Other",
                "fo": s in fo, "n50": s in lists["n50"], "n100": s in lists["n100"], "n200": s in lists["n200"],
            }
        self.uni = {"stocks": stocks, "scan": scan, "members": members, "fo": set(fo), "lists": lists,
                    "built_on": datetime.now(IST).date()}

    # ---- polling -----------------------------------------------------------------------------

    def poll(self):
        now = datetime.now(IST)
        if self.uni is None or (self.uni["built_on"] != now.date() and _m(now) >= 8 * 60 + 30):
            self._build_universe()
        indices = sources.all_indices()
        _, fo = sources.constituents(FO_INDEX)
        _, n200 = sources.constituents("NIFTY 200")
        quotes = {**n200, **fo}
        try:
            sensex = sources.sensex()
        except sources.SourceError:
            sensex = self.sensex
        stamps = [q["updated"] for q in quotes.values() if q.get("updated")]
        source_ts = max(stamps) if stamps else None
        session = source_ts[:10] if source_ts else now.date().isoformat()
        now = datetime.now(IST)
        with self.lock:
            if self.poll_ok and (now - self.poll_ok).total_seconds() > 90:
                self.need_backfill = True  # we missed snapshots — fill the gap from NSE's minute series
            if session != self.session:
                self._switch_session(session, now)
            if session == now.date().isoformat() and OPEN_MIN <= _m(now) < CLOSE_MIN:
                self._record(quotes, now)
            self.indices, self.quotes, self.sensex = indices, quotes, sensex
            self.source_ts, self.poll_ok, self.poll_err = source_ts, now, None

    def _switch_session(self, session, now):
        self.session = session
        self.bars = self.store.session_bars(session)
        self.orx = {60: self.store.orx(session, "orx"), 15: self.store.orx(session, "orx15")}
        self.snap = {}
        over = self._session_over(now)
        self.until = {s: (DONE if over else max(b) + 1) for s, b in self.bars.items() if b}
        self.baseline = self.store.cum_history(session, BASELINE_SESSIONS)
        self.dvol = self.store.dvol_avg(session, BASELINE_SESSIONS)
        self.last_backfill = {}
        self.need_backfill = True

    def _session_over(self, now):
        return self.session is not None and (now.date().isoformat() > self.session or _m(now) >= CLOSE_MIN)

    def _record(self, quotes, now):
        m = _m(now)
        frac = m + now.second / 60
        rows, or_rows, or15_rows = [], [], []
        for sym in self.uni["scan"]:
            q = quotes.get(sym)
            if not q or not q.get("ltp"):
                continue
            ltp, dh, dl, cum = q["ltp"], q.get("high"), q.get("low"), q.get("volume")
            day = self.bars.setdefault(sym, {})
            bar = day.get(m)
            if bar is None or bar[6] != "live":
                bar = day[m] = [ltp, ltp, ltp, ltp, None, cum, "live"]
            else:
                bar[1], bar[2], bar[3], bar[5] = max(bar[1], ltp), min(bar[2], ltp), ltp, cum
            prev = self.snap.get(sym)
            if prev:
                if dh and prev["high"] and dh > prev["high"]:
                    bar[1] = max(bar[1], dh)
                if dl and prev["low"] and dl < prev["low"]:
                    bar[2] = min(bar[2], dl)
            self.snap[sym] = {"high": dh, "low": dl}
            self.until[sym] = max(self.until.get(sym, 0), frac)
            rows.append((self.session, sym, m, *bar))
            # NSE's day high/low at the last snapshot before the range ends = exact range
            if m < OR_END_MIN and dh and dl:
                self.orx[60][sym] = (dh, dl)
                or_rows.append((self.session, sym, dh, dl))
            if m < OPEN_MIN + 15 and dh and dl:
                self.orx[15][sym] = (dh, dl)
                or15_rows.append((self.session, sym, dh, dl))
        self.store.save_bars(rows)
        self.store.save_orx(or_rows, "orx")
        self.store.save_orx(or15_rows, "orx15")

    # ---- housekeeping: back-fill + bhavcopies -------------------------------------------------

    def _backfill(self):
        now = datetime.now(IST)
        with self.lock:
            session, scan = self.session, list(self.uni["scan"]) if self.uni else []
            over = self._session_over(now)
            end = CLOSE_MIN if over else min(_m(now), CLOSE_MIN)
            todo = []
            for s in scan:
                have = self.bars.get(s, {})
                # Minutes with no trades never get a bar, so only a real gap (the app
                # was not running) — at the start, the end, or 5+ minutes — triggers a fetch.
                if have:
                    lo, hi = min(have), max(have)
                    gap = lo > OPEN_MIN + 2 or hi < end - 3 or sum(1 for m in range(OPEN_MIN, end) if m not in have) >= 5
                else:
                    gap = end > OPEN_MIN
                recent = time.time() - self.last_backfill.get(s, 0) < 900
                if gap and not recent:
                    todo.append(s)
        self.backfill = {"state": "running", "done": 0, "total": len(todo), "at": now.isoformat()}
        for s in todo:
            try:
                points = sources.minute_series(s)
            except sources.SourceError:
                continue
            fetched = datetime.now(IST)
            grouped = {}
            for d, m, price in points:
                if d.isoformat() == session and OPEN_MIN <= m < CLOSE_MIN:
                    grouped.setdefault(m, []).append(price)
            rows = []
            with self.lock:
                if session != self.session:
                    break
                day = self.bars.setdefault(s, {})
                for m, ps in grouped.items():
                    if m not in day or day[m][6] != "live":
                        day[m] = [ps[0], max(ps), min(ps), ps[-1], None, None, "chart"]
                        rows.append((session, s, m, *day[m]))
                cover = DONE if self._session_over(fetched) else _m(fetched) + fetched.second / 60
                self.until[s] = max(self.until.get(s, 0), cover)
                self.last_backfill[s] = time.time()
            self.store.save_bars(rows)
            self.backfill["done"] += 1
        self.backfill["state"] = "idle"

    def _ensure_bhavcopies(self):
        have = self.store.dvol_days()
        day, found, tries = date.fromisoformat(self.session) - timedelta(days=1), 0, 0
        changed = False
        while found < BASELINE_SESSIONS and tries < 15:
            tries += 1
            if day.weekday() < 5:
                if day.isoformat() in have:
                    found += 1
                else:
                    try:
                        self.store.save_dvol(day.isoformat(), sources.bhavcopy_volumes(day))
                        found += 1
                        changed = True
                    except sources.SourceError:
                        pass  # holiday (no bhavcopy) or temporarily unavailable
            day -= timedelta(days=1)
        if changed or not self.dvol[0]:
            with self.lock:
                self.dvol = self.store.dvol_avg(self.session, BASELINE_SESSIONS)

    # ---- volume helpers ------------------------------------------------------------------------

    @staticmethod
    def _cum_at(series, t):
        """Cumulative volume at clock minute t from {minute: cum}: the last recorded value in the 3 minutes before t."""
        for m in range(t - 1, t - 4, -1):
            v = series.get(m)
            if v is not None:
                return v
        return None

    def _base_avg(self, sym, t):
        days, hist = self.baseline
        per = hist.get(sym, {})
        vals = [v for d in days if (v := self._cum_at(per.get(d, {}), t)) is not None]
        return (mean(vals), len(vals)) if vals else (None, 0)

    def _today_cum(self, sym):
        return {m: b[5] for m, b in self.bars.get(sym, {}).items() if b[5] is not None}

    def volume_now(self, sym, day_volume, now):
        """(ratio, basis) — never compares a partial day with full days."""
        if self._session_over(now):
            avg = self.dvol[1].get(sym)
            return (round(day_volume / avg, 2) if day_volume and avg else None), "full day vs 5D avg (bhavcopy)"
        t = min(_m(now), CLOSE_MIN)
        avg, n = self._base_avg(sym, t)
        if not avg or not day_volume:
            return None, "time-adjusted · baseline not recorded yet"
        return round(day_volume / avg, 2), f"time-adjusted · {n} recorded session{'s' if n != 1 else ''}"

    # ---- ORB ----------------------------------------------------------------------------------

    def _signal(self, sym, meta, tf, clock, over, confirm3=False, orm=60):
        day = self.bars.get(sym)
        if not day:
            return None
        until = DONE if over else self.until.get(sym, 0) - 0.1
        or_end = OPEN_MIN + orm  # 10:15 for the 1-hour range, 09:30 for 15 minutes
        opening = [day[m] for m in range(OPEN_MIN, or_end) if m in day]
        exact = sym in self.orx[orm]
        if exact:
            or_hi, or_lo = self.orx[orm][sym]
        elif opening:
            or_hi, or_lo = max(b[1] for b in opening), min(b[2] for b in opening)
        else:
            return None
        if until < or_end:
            return None
        # Break candle: first completed tf-minute candle (5 or 15, aligned to 10:15)
        # closing beyond the range. With confirm3, the 3-minute candle right after
        # it must show follow-through: close ABOVE the break candle's close for a
        # breakout (BELOW it for a breakdown); the signal is then that 3-min close.
        # If the 3-min candle closes back inside, the break is rejected and the scan
        # continues with later tf candles. Entries: (signal_end, signal_close, break_end, break_close).
        def close_between(a, b):
            ms = [day[m] for m in range(a, b) if m in day]
            return ms[-1][3] if ms else None

        # confirm3: 0/False = off, 1/True = 3-min close beyond the BREAK CANDLE's close,
        # 2 = 3-min close merely beyond the opening-range level.
        mode = int(confirm3)
        up = down = None
        rejected = {"up": [], "down": []}  # breaks that failed their 3-min confirmation
        for start in range(or_end, CLOSE_MIN, tf):
            end = min(start + tf, CLOSE_MIN)
            if end > until:
                break
            c = close_between(start, end)
            if c is None:
                continue
            for side in ("up", "down"):
                beyond = (lambda x: x > or_hi) if side == "up" else (lambda x: x < or_lo)
                if (up if side == "up" else down) is not None or not beyond(c):
                    continue
                if not mode:
                    hit = (end, c, None, None)
                else:
                    c_end = min(end + 3, CLOSE_MIN)
                    if c_end > until or c_end <= end:
                        continue  # confirmation candle not complete yet (or no time left)
                    cc = close_between(end, c_end)
                    ref = c if mode == 1 else (or_hi if side == "up" else or_lo)
                    follow = cc is not None and (cc > ref if side == "up" else cc < ref)
                    if not follow:
                        rejected[side].append({"time": hhmm(end), "min": end, "price": round(c, 2),
                                               "confirm_close": round(cc, 2) if cc is not None else None})
                        continue  # no follow-through -> keep looking
                    hit = (c_end, cc, end, c)
                if side == "up":
                    up = hit
                else:
                    down = hit
            if up and down:
                break
        if not up and not down:
            return None
        if up and (not down or up[0] >= down[0]):
            signal, (brk, brk_px, bc_end, bc_px), other = "BREAKOUT", up, down
        else:
            signal, (brk, brk_px, bc_end, bc_px), other = "BREAKDOWN", down, up

        q = self.quotes.get(sym) or {}
        closed = [m for m in day if m < CLOSE_MIN and m + 1 <= until]
        last_trade = day[max(closed)][3] if closed else brk_px
        ltp = last_trade if over else (q.get("ltp") or last_trade)
        prev = q.get("prev")
        cum = self._today_cum(sym)
        cum_brk = self._cum_at(cum, brk)
        avg_brk, n_brk = self._base_avg(sym, brk)
        vol_now, vol_now_basis = self.volume_now(sym, q.get("volume"), datetime.now(IST))
        level = or_hi if signal == "BREAKOUT" else or_lo
        dist = (ltp - or_hi) / or_hi * 100 if signal == "BREAKOUT" else (or_lo - ltp) / or_lo * 100
        chart_or = any(day[m][6] == "chart" for m in range(OPEN_MIN, or_end) if m in day)
        return {
            **meta, "signal": signal, "ltp": round(ltp, 2), "pct_prev": _pct(ltp, prev),
            "or_high": round(or_hi, 2), "or_low": round(or_lo, 2), "or_range_pct": _pct(or_hi, or_lo),
            "or_exact": exact or not chart_or,
            "break_price": round(brk_px, 2), "break_min": brk, "break_time": hhmm(brk), "age_min": clock - brk,
            "break_candle": {"time": hhmm(bc_end), "price": round(bc_px, 2)} if bc_end else None,
            "rejected": [r for r in rejected["up" if signal == "BREAKOUT" else "down"] if r["min"] < brk],
            "cum_volume": cum_brk, "avg_volume": round(avg_brk) if avg_brk else None, "vol_sessions": n_brk,
            "vol_ratio": round(cum_brk / avg_brk, 2) if cum_brk and avg_brk else None,
            "vol_ratio_now": vol_now, "vol_now_basis": vol_now_basis,
            "distance_pct": round(dist, 2),
            "holding": ltp > level if signal == "BREAKOUT" else ltp < level,
            "day_high": q.get("high"), "day_low": q.get("low"),
            "ffmc_cr": round(q["ffmc"] / 1e7) if q.get("ffmc") else None,
            "other_break": {"signal": "BREAKDOWN" if signal == "BREAKOUT" else "BREAKOUT",
                            "time": hhmm(other[0]), "price": round(other[1], 2)} if other else None,
        }

    def scan(self, tf, confirm3=False, orm=60):
        if tf not in (5, 15):
            raise ValueError("tf must be 5 or 15")
        if orm not in OR_MINUTES:
            raise ValueError("opening range must be 60 or 15 minutes")
        now = datetime.now(IST)
        with self.lock:
            over = self._session_over(now)
            clock = CLOSE_MIN if over else min(max(_m(now), OPEN_MIN), CLOSE_MIN)
            rows = []
            if self.uni and self.session:
                for sym in self.uni["scan"]:
                    sig = self._signal(sym, self.uni["stocks"][sym], tf, clock, over, confirm3, orm)
                    if sig:
                        rows.append(sig)
            loaded = sum(1 for s in (self.uni or {}).get("scan", []) if self.bars.get(s))
            return {
                "session_date": self.session, "live": not over and self.session == now.date().isoformat(),
                "as_of_time": hhmm(clock), "or_complete": clock >= OPEN_MIN + orm and self.session is not None,
                "or_minutes": orm, "or_end": hhmm(OPEN_MIN + orm),
                "tf": tf, "confirm3": confirm3, "rows": rows,
                "engine": {
                    "universe": len(self.uni["scan"]) if self.uni else 0, "loaded": loaded,
                    "backfill": dict(self.backfill), "poll_ok": self.poll_ok.isoformat() if self.poll_ok else None,
                    "poll_error": self.poll_err,
                    "recorded_sessions": self.baseline[0], "exact_or": len(self.orx[orm]),
                },
            }

    def candles(self, sym, tf, confirm3=False, orm=60):
        """5-minute bars for the drawer chart; volume from cumulative-volume differences."""
        now = datetime.now(IST)
        with self.lock:
            day = dict(self.bars.get(sym, {}))
            over = self._session_over(now)
            clock = CLOSE_MIN if over else min(max(_m(now), OPEN_MIN), CLOSE_MIN)
            meta = self.uni["stocks"].get(sym) if self.uni else None
            sig = self._signal(sym, meta, tf, clock, over, confirm3, orm) if meta else None
        out, prev_cum = [], 0.0
        for start in range(OPEN_MIN, CLOSE_MIN, 5):
            ms = [day[m] for m in range(start, start + 5) if m in day]
            if not ms:
                continue
            cums = [b[5] for b in ms if b[5] is not None]
            vol = None
            if cums and prev_cum is not None:
                vol = max(cums[-1] - prev_cum, 0)
            prev_cum = cums[-1] if cums else None
            out.append({"t": hhmm(start), "m": start, "o": ms[0][0], "h": max(b[1] for b in ms), "l": min(b[2] for b in ms),
                        "c": ms[-1][3], "v": vol, "src": "live" if all(b[6] == "live" for b in ms) else "chart"})
        return {"symbol": sym, "session_date": self.session, "candles": out, "signal": sig,
                "or_end_min": OPEN_MIN + orm, "quote": quote_view(self.quotes.get(sym)), "meta": meta}

    # ---- live snapshot -------------------------------------------------------------------------

    def live(self, market_status):
        now = datetime.now(IST)
        with self.lock:
            if not self.uni or not self.indices:
                return None
            idx = self.indices
            indices = {k: quote_view({"ltp": (idx.get(v) or {}).get("last"), **(idx.get(v) or {})}) for k, v in KEY_INDICES.items()}
            sx = self.sensex
            indices["sensex"] = quote_view({"ltp": sx["last"], **sx}) if sx else None
            stocks = []
            for sym, meta in self.uni["stocks"].items():
                qv = quote_view(self.quotes.get(sym))
                if not qv:
                    continue
                vol = (self.quotes[sym] or {}).get("volume")
                ratio, basis = self.volume_now(sym, vol, now)
                stocks.append({**meta, **qv, "volume": vol, "vol_ratio": ratio, "vol_basis": basis,
                               "ffmc_cr": round(self.quotes[sym]["ffmc"] / 1e7) if self.quotes[sym].get("ffmc") else None})
            sectors = []
            for sym, label in SECTORS:
                row = idx.get(sym) or {}
                qv = quote_view({"ltp": row.get("last"), **row}) if row else None
                sectors.append({"symbol": sym, "label": label, "quote": qv,
                                "nse_breadth": {"up": row.get("adv", 0), "down": row.get("dec", 0), "unchanged": row.get("unch", 0)},
                                "members": sorted(self.uni["members"].get(sym, []))})
            fo_rows = [s for s in stocks if s["fo"]]
            n50_rows = [s for s in stocks if s["n50"]]
            # Breadth follows NSE's convention (advance/decline vs previous close),
            # so the counts match nseindia.com; the vs-open view is kept alongside.
            b = {"nifty50": breadth(n50_rows, "pct_prev"), "fo": breadth(fo_rows, "pct_prev"),
                 "sectors": breadth([s["quote"] for s in sectors if s["quote"]], "pct_prev"),
                 "nifty50_open": breadth(n50_rows, "pct_open"), "fo_open": breadth(fo_rows, "pct_open")}
            return {
                "as_of": self.poll_ok.isoformat() if self.poll_ok else None, "source_ts": self.source_ts,
                "poll_error": self.poll_err, "market_status": market_status, "session_date": self.session,
                "indices": indices, "breadth": b, "bias": market_bias(indices, b), "sectors": sectors, "stocks": stocks,
                "volume_baseline": {"recorded_sessions": self.baseline[0], "bhavcopy_sessions": self.dvol[0]},
            }

    def sector_detail(self, sym):
        """Live constituents of one sector index (includes stocks outside the scan universe)."""
        _, rows = sources.constituents(sym)
        now = datetime.now(IST)
        out = []
        with self.lock:
            for s, q in rows.items():
                qv = quote_view(q)
                if not qv:
                    continue
                ratio, basis = self.volume_now(s, q.get("volume"), now)
                out.append({"symbol": s, "company": q["company"], **qv, "volume": q.get("volume"), "vol_ratio": ratio, "vol_basis": basis})
        return {"symbol": sym, "label": SECTOR_LABELS.get(sym, sym), "stocks": out, "breadth": breadth(out, "pct_open")}


def _vote(up, down):
    return 1 if up > down else -1 if down > up else 0


def market_bias(ind, b):
    comps = []
    n50, vix = ind.get("nifty50"), ind.get("indiavix")
    if n50 and n50.get("open"):
        comps.append(("nifty", "Nifty 50 vs open", _vote(n50["ltp"], n50["open"]),
                      f"{n50['ltp']:,.2f} vs open {n50['open']:,.2f} ({n50['pct_open']:+.2f}%)", "vs today's open"))
    else:
        comps.append(("nifty", "Nifty 50 vs open", 0, "N/A", "vs today's open"))
    if vix and vix.get("pct_prev") is not None:
        p = vix["pct_prev"]
        comps.append(("vix", "India VIX", _vote(0, p), f"{p:+.2f}% — " + ("falling = bullish" if p < 0 else "rising = bearish" if p > 0 else "flat"), "vs previous close"))
    else:
        comps.append(("vix", "India VIX", 0, "N/A", "vs previous close"))
    for key, label, br in (("n50", "Nifty 50 breadth", b["nifty50"]), ("fo", "F&O breadth", b["fo"]), ("sec", "Sector breadth", b["sectors"])):
        comps.append((key, label, _vote(br["up"], br["down"]), f"{br['up']} up / {br['down']} down", "vs previous close"))
    score = sum(c[2] for c in comps)
    return {"score": score, "label": "BULLISH" if score >= 3 else "BEARISH" if score <= -3 else "NEUTRAL",
            "components": [dict(zip(("key", "label", "points", "detail", "basis"), c)) for c in comps]}
