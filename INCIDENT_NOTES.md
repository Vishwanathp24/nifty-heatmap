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
