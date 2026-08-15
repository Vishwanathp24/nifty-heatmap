# Nifty Sector Dashboard — Project Context / Handoff

Paste this into a new chat to resume work with full context. Written 2026-08-15.

## What this is

A FastAPI backend + two vanilla-JS frontends tracking NSE's F&O (futures &
options) universe: sector heatmap, market breadth, movers, and several
self-tracked intraday scanners + a technical screener. Two frontends share
one API for side-by-side comparison:
- `/` — the original/classic build (light theme) — **this is the one with
  every feature**; all scanner/screener work has only been built here.
- `/pro` — a restyled dark-theme pass, intentionally scoped down (no ORB/
  Buy-Sell/Breakout/Screener/F&O-Stock-List panels).

Repo: **https://github.com/Vishwanathp24/nifty-heatmap** (pushed, `main`
branch, latest commit as of writing: `dd35967`).

Local path: `/Users/vishwanathpujari/Documents/claude/nifty`

## Run it locally

```bash
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8420
```
Open http://localhost:8420 (classic) or http://localhost:8420/pro (dark).
There's also `.claude/launch.json` configured for the Claude Code preview
tool (`preview_start` with `{name: "nifty-dashboard"}`).

## Architecture

- **`backend/nse_client.py`** (~1700 lines) — all data logic. NSE has no
  public API; this calls the same undocumented JSON endpoints
  nseindia.com's own pages use (session bootstrap via a cookie-setting
  page, then reused session, retry-with-rebootstrap on 401/403/5xx), plus
  NSE's daily "Bhavcopy" (EOD settlement) CSV archive, which — unlike the
  JSON APIs — is NOT behind bot protection, confirmed working directly.
  That Bhavcopy archive is the real daily-OHLC data source for everything
  that needs history (RSI/SMA/EMA/MACD/ADX, the Buy/Sell scanner's daily
  leg, the F&O Screener).
- **`backend/main.py`** — FastAPI routes, thin wrappers around
  `nse_client.client` methods. Serves both frontends as static files +
  index routes.
- **`frontend/`** — classic dashboard (index.html, app.js, styles.css).
- **`frontend_pro/`** — dark "pro" dashboard, same API, fewer panels.
- **`render.yaml`** — Render.com Blueprint for deployment (paid Starter
  plan + persistent disk — NOT free tier, see below for why).
- **`.gitignore`** — excludes the self-tracked JSON candle-history files,
  `__pycache__`, venvs, `.DS_Store`.

### Why some things are "self-tracked"

NSE has no accessible endpoint for historical intraday candles or
previous-day OHLC (tried several; all blocked or empty). So a background
thread (`_orb_loop`/`_orb_tick` in `NSEClient.__init__`) polls the F&O
universe every ~20s during market hours (09:15–15:30 IST, Mon–Fri) and
builds its own candles from those snapshots (`_bucket_candles`). Completed
candles are persisted to disk (`backend/intraday_history_{15,30,45,60}m.json`,
path overridable via `NIFTY_DATA_DIR` env var) so history survives restarts
and accumulates across trading days. This is why the app **cannot run on a
free-tier PaaS that spins down when idle** — it would silently lose its
tracking and never accumulate intraday history. Daily-level indicators
don't have this problem — they're built fresh from real Bhavcopy history
every few hours, no warm-up needed.

## Full feature list (classic frontend `/`)

1. **Sectoral Heatmap** — all 23 NSE sectoral indices, unfiltered, mirrors
   NSE's own site tile-for-tile (deliberately NOT deduped — user preferred
   this "first version" over a cleaner 13-sector consolidation that was
   tried and reverted). Click a tile → constituent stocks with TradingView
   chart links.
2. **Market Bias** — same-session breadth summary (Nifty 50, India VIX,
   advance/decline, F&O breadth, sector breadth) → Bullish/Bearish/Neutral
   score. Explicitly labeled "not a prediction". Sensex/global indices
   deliberately excluded (no reliable free source found).
3. **Nifty 50 Advance vs Decline** — vs today's **open** (not previous
   close, which is what NSE's own counters use).
4. **F&O Gainers / Losers**, **Most Active Equities** (by Volume/Value,
   side by side), **Volume Gainers**, **52-Week High/Low** (Highs/Lows side
   by side) — all F&O-universe-filtered, sortable, sector-filterable via
   one shared dropdown.
5. **Scanners panel** — one tabbed panel (mobile-friendly: only one
   sub-section renders at a time) containing:
   - **Opening Range Breakout (ORB)** — 5/15/30/45/60-min windows,
     self-tracked. Only shows stocks that actually broke the range.
   - **Buy/Sell Scanner (Bullish/Bearish Intraday)** — daily (real,
     Bhavcopy-backed) + selectable intraday timeframe (self-tracked):
     Close vs SMA(20), Close vs each of last 5 bars' High/Low, RSI(14) vs
     60/40. Replicated from 2 published Chartink screenshots. A stock only
     "qualifies" once both timeframes pass.
   - **15-Min Breakout Scanner** — independent, pure 15-min: Close vs
     rolling 20-bar Close-high, Volume vs its own 20-bar SMA. Note: the
     Sell variant deliberately wants volume BELOW average (not a spike) —
     that's the source scanner's own asymmetric rule, kept as-is.
6. **F&O Stock List (Volume & RSI)** — liquidity/valuation screener
   (Market Cap > ₹30,000 Cr, Mkt Cap/Turnover < 3000, Turnover >
   ₹50 Cr, Up-from-52w-low < 200%). Collapsed by default, shows only
   qualifying stocks. One condition (ROCE vs 3yr avg) intentionally NOT
   applied — no accessible NSE data source for financial-statement ratios.

## F&O Screener — built, then removed (2026-08-15)

A 4th Scanners-panel tab, "Screener": 5 daily-technical screens replicated
from published Chartink scanners (Bullish Trend (MA+ADX+MACD), Open=High/
Low, Strong Uptrend, Volume Shockers, F&O Stocks price-range), each showing
per-stock condition chips, running on real Bhavcopy daily history (no
self-tracking). The user asked to remove it. Fully reverted: the tab/
group-div/JS (`loadScreenerList`/`refreshScreener`/`renderChecks`/
`escapeAttr`/`SCREENER_COLUMNS`)/CSS (`.check-chip`/`.checks-cell`) in the
classic dashboard, the `/api/screener*` routes in `main.py`, and every
`SCREENER_*` constant + the 5 `_screen_*` functions + the screener-only
`_wma`/`_macd`/`_adx` math + `get_screener_list`/`get_screener_status`/
`get_screener` in `nse_client.py` — all gone, confirmed via grep sweep and
a live check that `/api/screener*` now 404s while the Buy/Sell scanner
(the only other consumer of `_get_daily_history`) still works.
`DAILY_HISTORY_TARGET_DAYS` was reverted **65 → 30** (30 was the original,
pre-Screener value — the Buy/Sell scanner's daily leg only needs ~21 days;
65 existed solely so the Screener's SMA(50)/MACD/ADX had warm-up room).
The "6 more published Chartink screens" deferred-work item below is now
moot (there is no Screener left to extend) but left in place as history.
No reason was given for the removal - if this comes up again, don't
assume it's unwanted for the same reason as before; ask fresh, same as
the Intraday Option Signal removal below.

## Intraday Option Signal — built, then removed (2026-08-15)

A simplified intraday option-buying decision tool (Market Bias + 15-Min
ORB + 5/9 EMA + Volume + RSI → BUY CALL/BUY PUT/NO TRADE) was built here
across several phases in one session (single-symbol lookup in the classic
dashboard, a dedicated `/signal` site with a whole-F&O-universe Bullish/
Bearish scan, then a candle-close-confirmed ORB + false-breakout filter +
computed Entry/Stop-Loss/Target + static option-selection guidance) — then
the user asked to remove it entirely in the same session. Fully reverted:
the `/signal` route, `frontend_signal/` directory, all `/api/option-signal*`
+ `/api/fo-symbols` routes, every `OPTION_SIGNAL_*`/`_option_signal_*`
piece in `nse_client.py`, and the tab/JS/CSS in the classic dashboard are
all gone — verified via a full grep sweep (no leftover references) and a
live check that `/signal` and the removed API routes now 404 while
everything else (`/`, `/pro`, the 4 remaining scanner tabs) still works.
No reason was given for the removal - if this comes up again, don't assume
it's unwanted for the same reason as before; ask fresh.

## NOT yet built (explicitly deferred, not forgotten)

- ~~6 more published Chartink screens~~ — **moot**: these would have
  extended the F&O Screener tab, which has since been removed entirely
  (see above). Left here only as a record of what was once being
  considered: "BUY 100% ACCURACY - MORNING SCANNER", "UP TREND F&O
  STOCKS", "DOWN TREND F&O STOCKS", "F&O - MONTHLY GAINERS & LOSERS",
  "MONTHLY LOWEST LOW F&O STOCKS", "TRENDLINE BREAKOUT F&O".
- **ROCE condition** in F&O Stock List — no accessible data source.
- **Actual deployment** — only *prepped* (render.yaml, `NIFTY_DATA_DIR` env
  var support), never actually deployed to Render.com or a VPS. User's
  goal was "have the data on the go" (mobile/remote access); recommended
  path is Render.com paid Starter plan + persistent disk (free tier would
  silently kill the self-tracking thread when idle), or a small always-on
  VPS (~$5-6/mo). Neither has been executed yet.
- `/pro` dark frontend intentionally does NOT have ORB/Buy-Sell/Breakout/
  Screener/F&O-Stock-List — scoped to the classic frontend only, by
  explicit earlier decision.

## Known technical gotchas worth remembering

- **Browser caching**: FastAPI's default static/file responses don't set
  `Cache-Control`, so Chrome can skip revalidation. Fixed via a global
  `no-cache` middleware in `main.py` — if frontend edits ever seem not to
  take effect, check for *duplicate stale uvicorn processes* first
  (`pkill -f "uvicorn backend.main:app"` then restart clean), that's bitten
  us before.
- **CSS Grid `1fr` overflow bug**: hit this twice — bare `1fr` grid tracks
  don't clamp below their content's min-content width. Both the heatmap
  grid and the paired F&O-panel rows (Gainers/Losers, Most Active,
  52-Week) drifted wider than the rest of the page until fixed with
  `minmax(0, 1fr)` (+ `min-width: 0` on the grid item, needed when the
  overflow is nested a level deeper). Watch for this pattern if new
  side-by-side panels get added.
- **NSE endpoints are unofficial** — can change shape without notice. An
  error banner in the UI is the signal to check `nse_client.py` against
  NSE's own network tab.
- **RSI** implementation is a simplified trailing-window average (not full
  Wilder smoothing from inception) — standard simplification, documented
  in the code.
- Git identity for this repo is set **locally** (not global):
  `Vishwanath <vishwanath@radix.email>` — change via `git config
  user.name`/`user.email` if you want different commit attribution.

## Git/GitHub state

- Repo initialized, remote `origin` → `https://github.com/Vishwanathp24/nifty-heatmap.git`
  (HTTPS, not SSH — pushes need a GitHub Personal Access Token as the
  password when prompted, which is already cached/working on this
  machine as of the last successful push).
- 2 commits on `main` so far:
  1. `5aebd88` — Initial commit
  2. `dd35967` — Mobile-friendly Scanners panel, new F&O Screener tab,
     layout fixes
- Working tree was clean as of the last push (2026-08-15).

## Style/workflow notes for continuing this project

- The user has iteratively refined nearly every feature through direct,
  specific feedback (e.g. reverted a sector-consolidation redesign back to
  the "first version" because it "gives more clarity"). Prefer asking a
  scoping question (via a multiple-choice-style check-in) before large
  build-outs rather than assuming scope, especially when a feature request
  references external screenshots/specs with many conditions.
- When replicating a published scanner/screener, preserve its rules
  exactly (including quirky/asymmetric ones) rather than "fixing" them —
  this has come up multiple times and the user explicitly wants fidelity
  to the source, with any deviation clearly noted in the UI/code comments.
- Always verify UI changes live (this session uses the Claude Code
  preview/browser tools against `localhost:8420`) before declaring done —
  caching and stale-server bugs have caused false "it's broken" reports
  before.
- Never handle credentials/tokens/passwords directly — the user
  authenticates and pastes tokens into their own terminal prompts.
