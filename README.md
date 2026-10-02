# NSE Sector heatmap

A standalone NSE intraday dashboard: market breadth, sector heatmap and a 1-hour
Opening Range Breakout scanner. **No broker login** — it uses only the exchanges'
public data.

```bash
./start.sh          # builds the UI, starts the server
```
Open **http://127.0.0.1:8100**. Needs Python 3.10+ and Node 20+.
(For UI development: `cd frontend && npm run dev` → http://127.0.0.1:5180, proxying /api to :8100.)

**Keep it running during market hours.** The backend polls NSE every 10 seconds and
records its own 1-minute bars and cumulative volume (in `backend/data/market.db`).

## Data sources

| Data | Source |
|---|---|
| Indices, sector indices, India VIX, advance/decline | NSE `allIndices` |
| Live stock quotes (F&O universe, Nifty 50/100/200, sector constituents), free-float market cap | NSE market-watch `getIndicesData` |
| Per-minute price history for the current session (back-fill) | NSE `getSymbolChartData` |
| Daily volume history (5-day averages) | NSE CM bhavcopy archive |
| Market status, FII/DII, GIFT Nifty | NSE |
| Sensex | BSE (NSE does not publish it) |
| Dow, S&P 500, Nasdaq, Nikkei, Hang Seng | Yahoo Finance (Global Cues panel only) |

These are public website feeds, not contracted APIs: they can change or rate-limit
without notice. The backend paces requests (≤ ~4.5/s to NSE), keeps the last good
data on any failure, and the UI shows "Data delayed" when refreshes fail.

## What NSE does and doesn't provide — and how the app handles it

* **Intraday volume history is not published by NSE.** The app records NSE's cumulative
  day volume every 10 s. The ORB **at-break volume ratio** (cumulative volume to the
  break time ÷ average cumulative volume to the same clock time over previous
  sessions) therefore becomes available once the app has recorded at least one
  earlier session, and uses up to 5. Until then the volume filter is paused and the
  scanner says so. After the close, "Session so far / full day" compares full-day
  volume with the 5-day bhavcopy average — exact from day one.
* **Opening range** is exact (NSE day high/low captured just before 10:15) when the app
  was running before 10:15. Otherwise it is rebuilt from NSE's 1-minute prices and
  shown with **≈**, since intraminute wicks can be missed.
* Signals use completed candles only: a 5- or 15-minute bar (aligned to 10:15) must
  **close** beyond the range. Break time = that bar's close time.

## Pages

* **Market Overview** — Global cues and FII/DII (dated) at the top, then Market Bias (five ±1
  votes: Nifty vs open, VIX vs prev close, Nifty 50 / F&O / sector breadth vs previous close —
  NSE's own advance/decline convention), index cards, breadth panels and top movers.
* **Sector Heatmap** — 27 NSE sector indices coloured by % change (vs open or vs prev
  close). Click a card for its live constituents; the checkbox selects it as a scanner
  filter; ↗ opens TradingView.
* **ORB Scanner** — Breakout / Breakdown tabs, sector filter synced with the heatmap,
  volume / time / distance / price / market-cap / universe filters, sortable columns,
  and a detail drawer with an intraday chart.

Decision support only — no buy/sell, target or stop-loss recommendations.

## Hosting on Render

This repo deploys as a Render web service (see `render.yaml`): `pip install -r requirements.txt`,
then `uvicorn backend.main:app`. The built UI (`frontend/dist`) is committed and served by the
backend. Data (recorded bars, volume baseline, bhavcopy volumes) lives on the persistent disk at
`DATA_DIR=/var/data`. Use the Starter plan: the free plan sleeps when idle, which stops the
10-second NSE polling and the volume recording.
