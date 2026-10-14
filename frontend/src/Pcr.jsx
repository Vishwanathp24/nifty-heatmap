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
    {open && <PcrGuide />}
  </div>
}
