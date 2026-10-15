import React, { useState } from 'react'
import { api, isNum, istTime, usePoll } from './lib.js'

// PCR (OI) = total put open interest ÷ total call open interest, read from the option sellers'
// side: heavy put writing = support below (bullish), heavy call writing = resistance above
// (bearish). A market-mood meter, not a buy/sell signal.
export const PCR_ZONES = [
  { max: 0.7, key: 'oversold', label: 'Oversold / Bounce zone', tone: 'up',
    text: 'Market has fallen a lot, fear is high and call sellers are heavy — bounce or short covering becomes more likely.' },
  { max: 1.0, key: 'bearish', label: 'Bearish → Neutral', tone: 'amber',
    text: 'Call writers are still active — pressure on the market; rises may see selling.' },
  { max: 1.3, key: 'bullish', label: 'Healthy Bullish', tone: 'up',
    text: 'Put writers are strong — big traders expect the market to hold; usually a healthy uptrend.' },
  { max: 1.5, key: 'strong', label: 'Strong Bullish (stretching)', tone: 'up',
    text: 'Put writing is heavy; the market is getting stretched — watch for the 1.5+ risk zone.' },
  { max: Infinity, key: 'overbought', label: 'Overbought / Risk zone', tone: 'down',
    text: 'Market has run up fast and the crowd is one-sided bullish — profit booking, reversal or sharp correction risk rises.' },
]
export const pcrZone = v => isNum(v) ? PCR_ZONES.find(z => v < z.max) : null

// Short guide used in "How to read this" (Index Options) and the meter's details.
export function PcrGuide() {
  return <div className="pcr-guide">
    <div><b>PCR (OI)</b> = total put OI ÷ total call OI — a market-mood meter read from the option sellers' side
      (more put writing = support below, more call writing = resistance above).</div>
    <div className="pcr-zones">{PCR_ZONES.map((z, i) => <span key={z.key} className={'pcr-z ' + z.tone}>
      <b>{i === 0 ? '< 0.7' : i === PCR_ZONES.length - 1 ? '> 1.5' : `${PCR_ZONES[i - 1].max} – ${z.max}`}</b> {z.label}</span>)}</div>
    <div>Low PCR = fear high = bounce chance · High PCR = greed high = correction risk. Rising PCR = bullish strength building; falling PCR = bullish momentum weakening.
      Best read with support / resistance (low PCR + strong support = better reversal chance; high PCR + strong resistance = profit-booking risk) and confirmed by price and OI shifts — never a buy/sell signal on its own.</div>
  </div>
}

// Nifty PCR for the nearest expiry (shared by the meter and the Sector Heatmap card).
export function usePcr() {
  const res = usePoll(() => api('/api/index-options?symbol=NIFTY'), 60000, [])
  const d = res.data, e = d?.expiries?.[0], v = e?.pcr_oi
  return d && isNum(v) ? { v, zone: pcrZone(v), expiry: e.expiry_ist.split(',')[0], all: d.pcr_oi, at: d.fetched_at, ...levels(d, e) } : null
}

// Support / resistance from the option chain: strike with the highest put OI (support) and call OI
// (resistance) for the nearest expiry.
function levels(d, e) {
  const st = (e?.strikes || []).filter(r => r.c || r.p)
  if (!st.length) return { spot: d?.spot }
  const sup = st.reduce((a, r) => r.p > a.p ? r : a), res = st.reduce((a, r) => r.c > a.c ? r : a)
  return { spot: d.spot, support: sup.k, resistance: res.k }
}

// "Common interpretation" table and the decision check: PCR alone is never a buy / sell trigger.
const PCR_TABLE = [
  ['Below 0.7', 'Call OI dominates', 'Potentially bearish'],
  ['0.7 – 1.0', 'Relatively balanced to bearish', 'Wait for price confirmation'],
  ['1.0 – 1.3', 'Relatively balanced to bullish', 'Check trend and OI changes'],
  ['Above 1.3', 'High put-to-call OI ratio', 'Check for extremes and reversals'],
]
const rowOf = v => v < 0.7 ? 0 : v < 1.0 ? 1 : v <= 1.3 ? 2 : 3
const fmtK = v => isNum(v) ? v.toLocaleString('en-IN') : '—'

export function pcrCheck(p) {
  if (!p) return null
  const { v, spot, support, resistance } = p
  const reading = v > 1.3 ? `${v.toFixed(2)} is a high reading — heavy put positioning (often support), but an extreme can also mean crowded positioning. Treat it as a reason for caution, not an automatic sell signal.`
    : v < 0.7 ? `${v.toFixed(2)} is a low reading — call OI dominates; wait for price to confirm before acting on it.`
    : v < 1.0 ? `${v.toFixed(2)} is balanced to bearish — wait for price confirmation.`
    : `${v.toFixed(2)} is balanced to bullish — check the trend and OI changes.`
  let state = 'wait', status = 'Wait — price is between support and resistance; no confirmation either way.'
  if (isNum(spot) && isNum(resistance) && spot > resistance) { state = 'ce'; status = `Bullish breakout condition met — Nifty ${fmtK(Math.round(spot))} is above the ${fmtK(resistance)} resistance (highest call OI). The CE side applies only while it sustains above it.` }
  else if (isNum(spot) && isNum(support) && spot < support) { state = 'pe'; status = `Support broken — Nifty ${fmtK(Math.round(spot))} is below the ${fmtK(support)} support (highest put OI). The PE side applies only while it sustains below it.` }
  return { reading, state, status, row: rowOf(v) }
}

export function PcrDecision({ p }) {
  const c = pcrCheck(p)
  if (!c) return null
  return <div className="pcr-dec">
    <b>PCR decision guide</b>
    <table className="tbl compact pcr-dec-tbl"><thead><tr><th>PCR (OI)</th><th>Common interpretation</th><th>Response</th></tr></thead>
      <tbody>{PCR_TABLE.map((r, i) => <tr key={r[0]} className={i === c.row ? 'on' : ''}><td className="strong">{r[0]}</td><td>{r[1]}</td><td>{r[2]}</td></tr>)}</tbody></table>
    <div><b>Now:</b> {c.reading}</div>
    <div className="pcr-dec-levels">Support (highest put OI) <b className="up">{fmtK(p.support)}</b> · Spot <b>{fmtK(isNum(p.spot) ? Math.round(p.spot) : null)}</b> · Resistance (highest call OI) <b className="down">{fmtK(p.resistance)}</b> · expiry {p.expiry}</div>
    <div className={'pcr-dec-status ' + c.state}>{c.status}</div>
    <ul className="pcr-dec-rules">
      <li><b>CE side</b> — only if Nifty's price action confirms a bullish reversal or breakout (sustains above resistance).</li>
      <li><b>PE side</b> — only if Nifty breaks support and sustains below it.</li>
      <li><b>Wait</b> — if price is moving sideways or PCR conflicts with price action.</li>
    </ul>
    <div className="muted small">Ranges are rough guides, not fixed rules — PCR levels vary by expiry, market conditions and data provider. Never trade on PCR alone: confirm option-chain changes, support / resistance and price action. Not a buy/sell recommendation.</div>
  </div>
}

// Meter shown on every page except Crypto: Nifty PCR for the nearest expiry, zone bar and meaning.
export function PcrMeter() {
  const res = usePoll(() => api('/api/index-options?symbol=NIFTY'), 60000, [])
  const [open, setOpen] = useState(false)
  const d = res.data
  const e = d?.expiries?.[0]
  const v = e?.pcr_oi
  const z = pcrZone(v)
  if (!d || !z) return null
  const pos = Math.max(0, Math.min(100, (v - 0.4) / (1.9 - 0.4) * 100))  // scale 0.4 … 1.9
  return <div className={'pcr-meter ' + z.tone}>
    <div className="pcr-main">
      <span className="pcr-k">Nifty PCR (OI)</span>
      <b className="pcr-v">{v.toFixed(2)}</b>
      <span className={'pcr-pill ' + z.tone}>{z.label}</span>
      <span className="pcr-bar" title="< 0.7 oversold · 0.7–1.0 bearish→neutral · 1.0–1.3 healthy bullish · 1.3–1.5 strong · > 1.5 overbought">
        {[0.7, 1.0, 1.3, 1.5].map(t => <i key={t} className="pcr-tick" style={{ left: (t - 0.4) / 1.5 * 100 + '%' }} />)}
        <i className="pcr-mark" style={{ left: pos + '%' }} /></span>
      <span className="pcr-text muted small">{z.text}</span>
      <span className="muted small">Expiry {e.expiry_ist.split(',')[0]} · all expiries {d.pcr_oi ?? '—'} · {istTime(d.fetched_at)} IST</span>
      <button className="btn sm" onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'What is PCR?'}</button>
    </div>
    {open && <><PcrGuide /><PcrDecision p={{ v, ...levels(d, e), expiry: e.expiry_ist.split(',')[0] }} /></>}
  </div>
}

// Nifty PCR card (Sector Heatmap top row, Market Overview beside India VIX).
export function PcrCard() {
  const pcr = usePcr()
  return <>
    <div className={'card hm-card ' + (pcr?.zone.tone || '')}>
      <div className="card-k">Nifty PCR (OI)</div>
      <div className="card-v">{pcr ? pcr.v.toFixed(2) : '—'} {pcr && <span className={'pcr-pill ' + pcr.zone.tone}>{pcr.zone.label}</span>}</div>
      <div className="card-n">{pcr ? <>{pcr.zone.text} <span className="muted">Expiry {pcr.expiry} · all expiries {pcr.all ?? '—'}</span></> : 'Loading…'}</div>
      {pcr && (() => { const c = pcrCheck(pcr); return <div className={'pcr-dec-status small ' + c.state} title="Support = highest put OI strike, resistance = highest call OI strike (nearest expiry)">
        {c.state === 'wait' ? `Wait — inside ${pcr.support?.toLocaleString('en-IN')} support / ${pcr.resistance?.toLocaleString('en-IN')} resistance` : c.state === 'ce' ? `Above ${pcr.resistance?.toLocaleString('en-IN')} resistance — CE side only if it sustains` : `Below ${pcr.support?.toLocaleString('en-IN')} support — PE side only if it sustains`}</div> })()}
    </div>
  </>
}
