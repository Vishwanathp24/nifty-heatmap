"""SQLite persistence.

bars  : 1-minute bars per stock per session. src='live' bars are built by this
        app from 10-second NSE snapshots and carry `cum` (NSE's cumulative day
        volume at the last snapshot in that minute). src='chart' bars are
        back-filled from NSE's per-minute price series: price only, no volume.
orx   : exact opening-range high/low, captured from NSE's day high/low at the
        last snapshot before 10:15 (only when the app was running then).
dvol  : daily volume per stock from NSE bhavcopies (5-day daily averages).

NSE does not publish intraday volume history, so the time-of-day volume
baseline is built from `cum` values this app has recorded in past sessions.
"""
import sqlite3
import threading
from pathlib import Path

import os

# On Render the DB lives on the persistent disk (NIFTY_DATA_DIR / DATA_DIR); locally backend/data.
DB_PATH = Path(os.environ.get("DATA_DIR") or os.environ.get("NIFTY_DATA_DIR") or Path(__file__).resolve().parent / "data") / "market.db"


class Store:
    def __init__(self, path=DB_PATH):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.lock = threading.Lock()
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS bars (d TEXT, sym TEXT, m INT, o REAL, h REAL, l REAL, c REAL,
                                             v REAL, cum REAL, src TEXT, PRIMARY KEY (d, sym, m));
            CREATE TABLE IF NOT EXISTS orx (d TEXT, sym TEXT, hi REAL, lo REAL, PRIMARY KEY (d, sym));
            CREATE TABLE IF NOT EXISTS orx15 (d TEXT, sym TEXT, hi REAL, lo REAL, PRIMARY KEY (d, sym));
            CREATE TABLE IF NOT EXISTS dvol (d TEXT, sym TEXT, vol REAL, PRIMARY KEY (d, sym));
            CREATE INDEX IF NOT EXISTS bars_sym ON bars (sym, d);
        """)

    def q(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def many(self, sql, rows):
        if not rows:
            return
        with self.lock:
            self.db.execute("BEGIN")
            self.db.executemany(sql, rows)
            self.db.execute("COMMIT")

    # -- bars -----------------------------------------------------------------------------

    def save_bars(self, rows):
        """rows: (d, sym, m, o, h, l, c, v, cum, src). Live bars always win over chart bars."""
        self.many("""INSERT INTO bars VALUES (?,?,?,?,?,?,?,?,?,?)
                     ON CONFLICT(d, sym, m) DO UPDATE SET o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c,
                       v=excluded.v, cum=excluded.cum, src=excluded.src
                     WHERE bars.src != 'live' OR excluded.src = 'live'""", rows)

    def session_bars(self, d):
        out = {}
        for sym, m, o, h, l, c, v, cum, src in self.q("SELECT sym, m, o, h, l, c, v, cum, src FROM bars WHERE d=? ORDER BY m", (d,)):
            out.setdefault(sym, {})[m] = [o, h, l, c, v, cum, src]
        return out

    def cum_history(self, before_d, sessions):
        """{sym: {d: {m: cum}}} for the last `sessions` recorded sessions before `before_d`."""
        days = [r[0] for r in self.q("SELECT DISTINCT d FROM bars WHERE d < ? AND cum IS NOT NULL ORDER BY d DESC LIMIT ?",
                                     (before_d, sessions))]
        out = {}
        if days:
            marks = ",".join("?" * len(days))
            for sym, d, m, cum in self.q(f"SELECT sym, d, m, cum FROM bars WHERE d IN ({marks}) AND cum IS NOT NULL", days):
                out.setdefault(sym, {}).setdefault(d, {})[m] = cum
        return sorted(days), out

    # -- opening range / daily volume --------------------------------------------------------

    # orx = 1-hour range (to 10:15), orx15 = 15-minute range (to 09:30)
    def save_orx(self, rows, table="orx"):
        self.many(f"INSERT OR REPLACE INTO {table} VALUES (?,?,?,?)", rows)

    def orx(self, d, table="orx"):
        return {sym: (hi, lo) for sym, hi, lo in self.q(f"SELECT sym, hi, lo FROM {table} WHERE d=?", (d,))}

    def save_dvol(self, d, vols):
        self.many("INSERT OR REPLACE INTO dvol VALUES (?,?,?)", [(d, s, v) for s, v in vols.items()])

    def dvol_days(self):
        return {r[0] for r in self.q("SELECT DISTINCT d FROM dvol")}

    def dvol_avg(self, before_d, sessions):
        days = [r[0] for r in self.q("SELECT DISTINCT d FROM dvol WHERE d < ? ORDER BY d DESC LIMIT ?", (before_d, sessions))]
        if not days:
            return [], {}
        marks = ",".join("?" * len(days))
        rows = self.q(f"SELECT sym, AVG(vol), COUNT(*) FROM dvol WHERE d IN ({marks}) GROUP BY sym", days)
        return sorted(days), {sym: avg for sym, avg, n in rows if n >= min(3, len(days))}
