import React, { useEffect, useState } from 'react'
import { Empty, Seg } from './components.jsx'
import { api, isNum, istTime, usePoll, useSessionState } from './lib.js'
import OptionTools, { setMoney } from './OptionTools.jsx'

// Options board shared by Crypto -> Options (BTC / ETH on Deribit, $) and the Index Options
// page (Nifty on NSE, Rs, lots). Market data to read the set-up, not a buy/sell recommendation.

export const CRYPTO = {
  key: 'copt', symbols: [['BTC', 'BTC'], ['ETH', 'ETH']], endpoint: '/api/crypto/options?ccy=', cur: '$', locale: 'en-US',
  vol: 'DVOL (implied vol)', volTitle: 'Deribit Volatility Index: 30-day implied volatility (like India VIX). Higher = options are more expensive / a bigger move is priced in.',
  spotNote: 'Deribit index', source: 'Deribit options (largest crypto options exchange) · 25Δ skew from OKX', oiUnit: d => d.ccy,
  biasName: 'Crypto Bias', ivBands: { BTC: [40, 65], ETH: [55, 85] },
  oiNote: 'Open interest in coins (1 contract = 1 coin) for strikes within ±30% of spot.', expiryNote: 'Deribit options expire at 1:30 PM IST.', lot: null,
}
export const INDIA = {
  key: 'iopt', symbols: [['NIFTY', 'Nifty 50'], ['SENSEX', 'Sensex']], endpoint: '/api/index-options?symbol=', cur: '₹', locale: 'en-IN',
  vol: 'India VIX', volTitle: 'India VIX: 30-day expected volatility of Nifty from option prices. Higher = options are more expensive / a bigger move is priced in.',
  spotNote: 'NSE index', source: 'NSE option chain (bid / ask / IV / OI)', oiUnit: () => 'contracts',
  biasName: 'Market Bias', ivBands: { NIFTY: [13, 20], SENSEX: [13, 20] },
  oiNote: 'Open interest in contracts for strikes within ±8% of spot.', expiryNote: 'NSE index options expire at 3:30 PM IST.', lot: 65,
}

let M = CRYPTO
const money = (v, d = 0) => isNum(v) ? M.cur + v.toLocaleString(M.locale, { maximumFractionDigits: d }) : '—'
const big = v => !isNum(v) ? '—' : M.cur + (v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : (v / 1e6).toFixed(1) + 'M')
const sgn = (v, d = 2, suf = '%') => isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(d) + suf : '—'
const amt = v => isNum(v) ? v.toLocaleString(M.locale, { maximumFractionDigits: v >= 100 ? 0 : 1 }) : '—'
const pcrTone = v => !isNum(v) ? '' : v >= 1 ? 'down' : v <= 0.7 ? 'up' : ''
const pcrLabel = v => !isNum(v) ? '' : v >= 1 ? 'more puts than calls' : v <= 0.7 ? 'call-heavy' : 'balanced'

export function OptionsBoard({ market, bias }) {
  M = market; setMoney(market)  // formatters read the active market (one board renders at a time)
  const [sym, setSym] = useSessionState(market.key + '.sym', market.symbols[0][0])
  const [code, setCode] = useState(null)
  const res = usePoll(() => api(market.endpoint + sym), 60000, [sym])
  const d = res.data && res.data.ccy === sym ? res.data : null
  useEffect(() => { setCode(null) }, [sym])
  const switcher = <Seg value={sym} onChange={setSym} options={market.symbols.map(([v, l]) => ({ value: v, label: l }))} />
  if (!d) return <><div className="toolbar">{switcher}</div><Empty>{res.error || `Loading ${sym} options data…`}</Empty></>
  const exps = d.expiries.slice(0, 12)
  if (!exps.length) return <><div className="toolbar">{switcher}</div><Empty>No option expiries available right now.</Empty></>
  const sel = exps.find(e => e.code === code) || exps[0]
  const near = exps[0]
  const spotD = d.spot >= 10000 ? 0 : 2
  return <div className="copt">
    <div className="toolbar">{switcher}
      <span className="muted small">{market.source} · updated {istTime(d.fetched_at)} IST{d.stale ? ' · showing last good data' : ''}</span>
    </div>
    <div className="crypto-market">
      <div className="cm-card"><div className="cm-k">{market.symbols.find(s => s[0] === sym)[1]} Spot</div><div className="cm-v">{money(d.spot, spotD)}</div><div className="cm-n muted">{market.spotNote}</div></div>
      <div className="cm-card" title={market.volTitle}>
        <div className="cm-k">{market.vol}</div><div className="cm-v">{isNum(d.dvol) ? d.dvol.toFixed(1) : '—'}</div>
        <div className="cm-n"><span className={d.dvol_change_24h > 0 ? 'down' : d.dvol_change_24h < 0 ? 'up' : ''}>{sgn(d.dvol_change_24h, 2, '')}</span> <span className="muted">{market.lot ? 'vs prev close' : '24h'} · ≈{isNum(d.dvol) ? (d.dvol / Math.sqrt(market.lot ? 252 : 365)).toFixed(2) : '—'}% daily move</span></div></div>
      <div className="cm-card" title="Put/Call ratio of open interest. Above 1 = more puts (hedging / bearish bets); below 0.7 = call-heavy positioning.">
        <div className="cm-k">Put/Call Ratio (OI)</div><div className={'cm-v ' + pcrTone(d.pcr_oi)}>{d.pcr_oi ?? '—'}</div>
        <div className="cm-n muted">{pcrLabel(d.pcr_oi)} · volume PCR {d.pcr_vol ?? '—'}</div></div>
      <div className="cm-card" title="Max pain: the expiry price at which option buyers would lose the most. Price often drifts toward it into expiry, but not reliably.">
        <div className="cm-k">Max Pain · {near.code}</div><div className="cm-v">{money(near.max_pain)}</div>
        <div className="cm-n muted">{sgn(near.max_pain_pct)} vs spot · {near.expiry_ist}</div></div>
      <div className="cm-card" title="One standard deviation (~68% of outcomes) move implied by at-the-money option IV, to the nearest expiry.">
        <div className="cm-k">Expected Move · {near.code}</div><div className="cm-v">±{money(near.move)}</div>
        <div className="cm-n muted">±{near.move_pct}% · {money(d.spot - (near.move || 0))} – {money(d.spot + (near.move || 0))}</div></div>
    </div>

    <section className="opt-sec">
    <div className="opt-sec-h"><div><h3>Expiries</h3><div className="muted small">Click a row to use that expiry in the tools below · total open interest {amt(d.total_oi)} {market.oiUnit(d)}{isNum(d.total_oi_usd) ? ` (${big(d.total_oi_usd)})` : ''}</div></div></div>
    <div className="tbl-wrap trend-wrap"><table className="tbl copt-tbl">
      <thead><tr>
        <th>Expiry (IST)</th><th className="num">Days</th><th className="num" title="Price at which option buyers lose the most">Max Pain</th><th className="num">vs Spot</th>
        <th className="num" title="Put OI ÷ Call OI">PCR (OI)</th><th className="num" title="Put volume ÷ Call volume">PCR (Vol)</th>
        <th className="num">Call OI</th><th className="num">Put OI</th><th className="num" title="At-the-money implied volatility">ATM IV</th>
        <th className="num" title="±1 standard deviation move to expiry implied by ATM IV">Expected Move</th>
        <th className="num" title="IV of the 25-delta put minus the 25-delta call. Positive = downside protection costs more (caution); negative = calls in demand.">25Δ Skew</th>
      </tr></thead>
      <tbody>{exps.map(e => <tr key={e.code} className={'clickable' + (e.code === sel.code ? ' row-sel' : '')} onClick={() => setCode(e.code)}>
        <td className="strong">{e.expiry_ist}</td><td className="num">{e.days < 1 ? (e.days * 24).toFixed(0) + 'h' : e.days.toFixed(1)}</td>
        <td className="num strong">{money(e.max_pain)}</td><td className="num">{sgn(e.max_pain_pct)}</td>
        <td className={'num ' + pcrTone(e.pcr_oi)}>{e.pcr_oi ?? '—'}</td><td className={'num ' + pcrTone(e.pcr_vol)}>{e.pcr_vol ?? '—'}</td>
        <td className="num">{amt(e.call_oi)}</td><td className="num">{amt(e.put_oi)}</td>
        <td className="num">{isNum(e.atm_iv) ? e.atm_iv.toFixed(1) + '%' : '—'}</td>
        <td className="num">±{money(e.move)} <span className="muted small">({e.move_pct}%)</span></td>
        <td className={'num ' + (e.skew_25d > 0 ? 'down' : e.skew_25d < 0 ? 'up' : '')}>{isNum(e.skew_25d) ? sgn(e.skew_25d, 1, '') : '—'}</td>
      </tr>)}</tbody>
    </table></div>
    </section>

    <OptionTools key={sym} d={d} exp={sel} market={market} bias={bias} />

    <div className="note-box small copt-notes">
      <b>How to read this</b>
      <div>· <b>PCR</b> above 1 = more puts than calls (hedging or bearish bets); below 0.7 = call-heavy positioning. Extremes are often read as contrarian.</div>
      <div>· <b>Max pain</b> = expiry price where option buyers lose the most; price sometimes gravitates toward it into expiry, with no guarantee.</div>
      <div>· <b>{market.vol} / ATM IV</b> = how expensive options are. High IV = bigger expected move and richer premiums; low IV = cheaper options.</div>
      <div>· <b>Expected move</b> = ±1 standard deviation range (~68% of outcomes) priced in by options to that expiry.</div>
      <div>· <b>25Δ skew</b> positive = puts dearer than calls (demand for downside protection); negative = upside calls in demand.</div>
      <div className="muted">Market data to understand the set-up, not a buy/sell recommendation. {market.expiryNote}</div>
    </div>
  </div>
}

export default function CryptoOptions({ bias }) {
  return <OptionsBoard market={CRYPTO} bias={bias} />
}
