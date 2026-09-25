# Production incident notes

## 2026-09-12 — nifty-heatmap.onrender.com unresponsive

**Reported by user**: "not able to https://nifty-heatmap.onrender.com/ its taking a very very long time"

### Diagnosis

Checked directly via `curl` with timing:

```
curl -s -o /dev/null -w "http_code: %{http_code}\ntime_total: %{time_total}s\ntime_connect: %{time_connect}s\n" --max-time 60 https://nifty-heatmap.onrender.com/
```

Result: TCP connect succeeded in ~60ms, but **no HTTP response at all** within 60s (`http_code: 000`). Repeated against the cheapest possible endpoints too:

- `/` (root, static index.html) — hung, no response, 30s+ timeout
- `/api/sensex` — hung, no response, 30s timeout
- `/api/global-cues` — hung, no response, 30s timeout

These are all normally sub-second responses (category "(a)" routes per the earlier Netlify-migration exploration — cheap live-data calls, no dependency on the 22MB long-daily-history cache or self-tracked intraday state). Every single request hanging, including the cheapest ones, rules out "one slow scanner computation" and points to either:

- The whole Python process being hung/deadlocked (e.g. a lock held indefinitely), or
- The Render instance having crashed/restarted and its proxy not yet clearing the stale connection.

TCP connect succeeding instantly means this is **not** a DNS/network issue on the client side — the server-side process itself isn't responding.

### What I could not check

No Render dashboard/API/CLI access from this environment — could not pull the actual service logs, restart the instance, or confirm deploy/crash history directly.

### Suggested next steps (for the user, via Render dashboard)

1. **Logs tab** — look for a crash/exception right before it went unresponsive.
2. **Events tab** — check for auto-restart activity or a recent deploy that coincides with the hang.
3. **Manual restart** — fastest fix for a genuinely hung process, from the dashboard.

If the Render logs get pasted back, revisit this file with the actual root cause and a code fix (rather than the guesses above), so this doesn't recur.

### Follow-up

_(Add findings here once Render logs are available.)_

## 2026-09-25 — Recurrence, same shape

Hit again while verifying a frontend change (TradingView index links) on
the Netlify-hosted copy - the page never got past its loading skeleton.
Checked the Render backend directly:

```
/api/market-overview   -> 502
/api/heatmap           -> 503
/api/advance-decline   -> timeout (15s, no response)
/api/fo-scanner        -> timeout
/api/fii-dii           -> timeout
/api/pcr               -> timeout
/api/sensex            -> 200 (fine)
/api/global-cues       -> 200 (fine)
```

Same mixed 502/503/timeout shape as the first incident - some routes
fail outright, others hang completely, a few unrelated ones (Sensex,
Global Cues - both non-NSE data sources, see global_markets_client.py)
keep working. This split points at something wrong specifically in the
NSE-data path (nse_client.py / its session-bootstrap / its background
threads) rather than the whole process being down, since a fully-dead
process would fail every route identically, including the two that kept
working.

Confirmed NOT caused by the code just shipped: the TradingView link
change was verified working against a healthy local `uvicorn` instance
(all 3 links present, correct hrefs, no console errors) before this was
noticed - this is a production-only, backend-only issue.

Still no Render dashboard/API access from this environment to see the
actual crash/exception. Same ask as before: Logs + Events tabs, manual
restart if it's just stuck. Recurring, unresolved - worth checking
whether this correlates with something time-based (market open/close
transition, the 6-hour long-daily-history refresh cycle, etc.) once
real logs are available.
