import React, { useEffect, useState } from 'react'
import { Empty, Seg } from './components.jsx'
import { api, isNum, istTime, usePoll, useSessionState } from './lib.js'
import OptionTools, { setMoney } from './OptionTools.jsx'
import { PnlCalc, atmPremium } from './Chart.jsx'
import { RuleSummary } from './Rules.jsx'
import { PcrDecision, PcrGuide, pcrZone } from './Pcr.jsx'

// Options board shared by Crypto -> Options (BTC / ETH / SOL / XRP on Deribit, $) and the Index Options
// page (Nifty on NSE, Rs, lots). Market data to read the set-up, not a buy/sell recommendation.

export const CRYPTO = {
  key: 'copt', symbols: [['BTC', 'BTC'], ['ETH', 'ETH'], ['SOL', 'SOL'], ['XRP', 'XRP']], endpoint: '/api/crypto/options?ccy=', cur: '$', locale: 'en-US',
  vol: 'DVOL (implied vol)', volTitle: 'Deribit Volatility Index: 30-day implied volatility (like India VIX). Higher = options are more expensive / a bigger move is priced in.',
  spotNote: 'Deribit index', source: 'Deribit options (largest crypto options exchange; SOL / XRP are USDC-settled) · 25Δ skew from OKX / Deribit', oiUnit: d => d.ccy,
  biasName: 'Crypto Bias', ivBands: { BTC: [40, 65], ETH: [55, 85], SOL: [55, 90], XRP: [55, 90] },
  oiNote: 'Open interest in coins for strikes within ±30% of spot.', expiryNote: 'Deribit options expire at 1:30 PM IST.', lot: null,
}
export const INDIA = {
  key: 'iopt', symbols: [['NIFTY', 'Nifty 50'], ['SENSEX', 'Sensex']], endpoint: '/api/index-options?symbol=', cur: '', locale: 'en-IN',  // no ₹ sign (cleaner numbers)
  vol: 'India VIX', volTitle: 'India VIX: 30-day expected volatility of Nifty from option prices. Higher = options are more expensive / a bigger move is priced in.',
  spotNote: 'NSE index', source: 'NSE option chain (bid / ask / IV / OI)', oiUnit: () => 'contracts',
  biasName: 'Market Bias', ivBands: { NIFTY: [13, 20], SENSEX: [13, 20] },
  oiNote: 'Open interest in contracts for strikes within ±8% of spot.', expiryNote: 'NSE index options expire at 3:30 PM IST.', lot: 65,
  pnl: { NIFTY: 65, SENSEX: 20 },  // trade P&L calculator lot sizes
}

let M = CRYPTO
const money = (v, d = 0) => isNum(v) ? M.cur + v.toLocaleString(M.locale, { maximumFractionDigits: Math.abs(v) >= 100 || !v ? d : Math.max(d, Math.abs(v) >= 10 ? 2 : 4) }) : '—'
const big = v => !isNum(v) ? '—' : M.cur + (v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : (v / 1e6).toFixed(1) + 'M')
const sgn = (v, d = 2, suf = '%') => isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(d) + suf : '—'
const amt = v => isNum(v) ? v.toLocaleString(M.locale, { maximumFractionDigits: v >= 100 ? 0 : 1 }) : '—'
// Index options read PCR from the option sellers' side (zones in Pcr.jsx); crypto keeps the simple read.
const pcrTone = v => !isNum(v) ? '' : M.key === 'iopt' ? ({ up: 'up', down: 'down', amber: 'amber' })[pcrZone(v).tone] : v >= 1 ? 'down' : v <= 0.7 ? 'up' : ''
const pcrLabel = v => !isNum(v) ? '' : M.key === 'iopt' ? pcrZone(v).label : v >= 1 ? 'more puts than calls' : v <= 0.7 ? 'call-heavy' : 'balanced'

// Option chain around ATM (± 10 strikes), laid out like a broker chain: calls on the left, strike
// (with IV) in the middle, puts on the right; in-the-money side shaded, a line where spot sits,
// OI bars scaled to the largest OI shown. OI is in units (contracts × lot size) for index options.
function ChainTable({ exp, spot, lot, extra }) {
  const all = exp.chain || []
  if (!all.length) return <section className="opt-sec chain-card"><h3>Option chain</h3><Empty>No option chain for this expiry.</Empty></section>
  const atmI = all.reduce((b, r, i) => Math.abs(r.k - spot) < Math.abs(all[b].k - spot) ? i : b, 0)
  const rows = all.slice(Math.max(0, atmI - 10), atmI + 11)
  const m = lot || 1
  const maxOi = Math.max(...rows.flatMap(r => [r.call?.oi || 0, r.put?.oi || 0])) || 1
  const big = v => !isNum(v) ? '—' : Math.abs(v) >= 1e7 ? (v / 1e7).toFixed(2) + 'Cr' : Math.abs(v) >= 1e5 ? (v / 1e5).toFixed(2) + 'L' : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(2) + 'K' : Math.round(v).toString()
  const px = v => isNum(v) ? v.toLocaleString(M.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'
  const pc = v => isNum(v) ? <span className={v > 0 ? 'up' : v < 0 ? 'down' : 'muted'}>{v > 0 ? '+' : ''}{v.toFixed(2)}%</span> : null
  // Largest OI on each side boxed: highest call OI (often read as resistance), highest put OI (support).
  const maxSide = side => Math.max(...rows.map(r => r[side]?.oi || 0))
  const MX = { call: maxSide('call'), put: maxSide('put') }
  const oiCell = (o, side) => {
    const top = (o?.oi || 0) > 0 && o.oi === MX[side]
    return <td className={'num ch-oi ' + side + (top ? ' ch-hl ' + (side === 'call' ? 'down' : 'up') : '')}
      title={top ? (side === 'call' ? 'Highest call OI in view (often read as resistance)' : 'Highest put OI in view (often read as support)') : undefined}>
      <span className="ch-bar" style={{ width: Math.round((o?.oi || 0) / maxOi * 100) + '%' }} />
      <span className="ch-v">{big((o?.oi || 0) * m)}</span></td>
  }
  // Highlight the largest OI build-up (green) and unwinding (red) on each side among the strikes shown.
  const ext = side => { const v = rows.map(r => r[side]?.oi_chg).filter(isNum); return { hi: Math.max(...v, 0), lo: Math.min(...v, 0) } }
  const X = { call: ext('call'), put: ext('put') }
  const oiChg = (o, side) => {
    const v = o?.oi_chg, hl = !isNum(v) || v === 0 ? '' : v === X[side].hi ? ' ch-hl up' : v === X[side].lo ? ' ch-hl down' : ''
    return <td className={'num' + hl} title={hl ? (v > 0 ? `Largest ${side} OI build-up in view` : `Largest ${side} OI unwinding in view`) : undefined}>
      {isNum(v) ? <>{big(v * m)}<div className="ch-sub">{pc(o.oi_chg_pct)}</div></> : '—'}</td>
  }
  const ltp = o => <td className="num strong">{px(o?.mark)}<div className="ch-sub">{pc(o?.chg_pct)}</div></td>
  const spotAt = rows.findIndex(r => r.k > spot)  // spot line goes above this row
  // Near-the-money OI: calls from ATM up 5 strikes, puts from ATM down 5 strikes (ATM + 5 each side).
  const sum = (list, side, key) => list.reduce((t, r) => t + (r[side]?.[key] || 0), 0)
  const cRows = all.slice(atmI, atmI + 6), pRows = all.slice(Math.max(0, atmI - 5), atmI + 1)
  const cOi = sum(cRows, 'call', 'oi') * m, pOi = sum(pRows, 'put', 'oi') * m
  const cChg = sum(cRows, 'call', 'oi_chg') * m, pChg = sum(pRows, 'put', 'oi_chg') * m
  const putsBigger = pOi > cOi, ratio = cOi && pOi ? (putsBigger ? pOi / cOi : cOi / pOi) : null
  const kOf = r => r.k.toLocaleString(M.locale)
  return <section className="opt-sec chain-card">
    <div className="opt-sec-h"><div><h3>Option chain</h3><div className="muted small">Expiry {exp.expiry_ist} · ATM ± 10 strikes · OI in {lot ? 'units (contracts × lot ' + lot + ')' : 'contracts'}</div></div></div>
    {extra}
    {cOi > 0 && pOi > 0 && <div className="near-oi">
      <div className="near-oi-row">
        <div className="near-oi-box down"><span>Call OI · ATM → +5 strikes</span><b>{big(cOi)}</b>
          <small>{kOf(cRows[0])} – {kOf(cRows[cRows.length - 1])} · OI chg {cChg > 0 ? '+' : ''}{big(cChg)}</small></div>
        <div className="near-oi-box up"><span>Put OI · ATM → −5 strikes</span><b>{big(pOi)}</b>
          <small>{kOf(pRows[pRows.length - 1])} – {kOf(pRows[0])} · OI chg {pChg > 0 ? '+' : ''}{big(pChg)}</small></div>
      </div>
      <div className={'near-oi-verdict ' + (putsBigger ? 'up' : 'down')}>
        {putsBigger ? 'Put OI is greater' : 'Call OI is greater'} — {ratio.toFixed(2)}× near the money (put / call = {(pOi / cOi).toFixed(2)}).{' '}
        {putsBigger ? 'More put writing just below the market, often read as support.' : 'More call writing just above the market, often read as resistance.'}
        <span className="muted"> Positioning data, not a signal.</span>
      </div>
    </div>}
    <div className="tbl-wrap"><table className="tbl compact chain-tbl">
      <thead><tr className="grp"><th colSpan={4} className="down">Calls</th><th /><th colSpan={4} className="up">Puts</th></tr>
        <tr><th className="num">OI</th><th className="num">OI Chg</th><th className="num">Delta</th><th className="num">LTP</th>
          <th className="ch-k">Strike <span className="muted">(IV)</span></th>
          <th className="num">LTP</th><th className="num">Delta</th><th className="num">OI Chg</th><th className="num">OI</th></tr></thead>
      <tbody>{rows.map((r, i) => <React.Fragment key={r.k}>
        {i === spotAt && <tr className="ch-spot"><td colSpan={9}><span>{px(spot)}</span></td></tr>}
        <tr className={(r.k === all[atmI].k ? 'ch-atm' : '')}>
          {[oiCell(r.call, 'call'), oiChg(r.call, 'call'), <td key="d" className="num">{isNum(r.call?.delta) ? r.call.delta.toFixed(2) : '—'}</td>, ltp(r.call)].map((c, j) => React.cloneElement(c, { key: 'c' + j, className: c.props.className + (r.k < spot ? ' itm' : '') }))}
          <td className="ch-k"><b>{r.k.toLocaleString(M.locale)}</b><div className="ch-sub muted">{isNum(r.call?.iv) || isNum(r.put?.iv) ? ((r.call?.iv || 0) && (r.put?.iv || 0) ? ((r.call.iv + r.put.iv) / 2).toFixed(1) : (r.call?.iv || r.put?.iv).toFixed(1)) : '—'}</div></td>
          {[ltp(r.put), <td key="d" className="num">{isNum(r.put?.delta) ? r.put.delta.toFixed(2) : '—'}</td>, oiChg(r.put, 'put'), oiCell(r.put, 'put')].map((c, j) => React.cloneElement(c, { key: 'p' + j, className: c.props.className + (r.k > spot ? ' itm' : '') }))}
        </tr></React.Fragment>)}
        {spotAt === -1 && <tr className="ch-spot"><td colSpan={9}><span>{px(spot)}</span></td></tr>}</tbody>
    </table></div>
    <div className="muted small">Shaded = in the money. Bars = OI relative to the largest OI shown (red calls, green puts). Boxed OI = highest call OI (red, resistance) / put OI (green, support); boxed OI Chg = biggest build-up (green) / unwinding (red) on each side. OI is NSE's figure (after the close: the official end-of-day OI). LTP and OI change vs the previous close. Market data, not a signal.</div>
  </section>
}

export function OptionsBoard({ market, bias }) {
  M = market; setMoney(market)  // formatters read the active market (one board renders at a time)
  const [sym, setSym] = useSessionState(market.key + '.sym', market.symbols[0][0])
  const [code, setCode] = useState(null)
  const res = usePoll(() => api(market.endpoint + sym), 60000, [sym])
  const d = res.data && res.data.ccy === sym ? res.data : null
  useEffect(() => { setCode(null) }, [sym])
  const switcher = <Seg value={sym} onChange={setSym} options={market.symbols.map(([v, l]) => ({ value: v, label: l }))} />
  // Index Options only: trade P&L calculator for the selected index (Nifty 50 lot 65, Sensex lot 20).
  const pnl = market.pnl && (dd => { const ap = atmPremium(dd?.expiries?.[0], bias?.label)
    return <PnlCalc id={'iopt:' + sym} name={market.symbols.find(s => s[0] === sym)[1]} lot={dd?.lot || market.pnl[sym]} buy={ap?.price ?? ''} buyLabel={ap?.label} horizontal /> })
  if (!d) return <><div className="toolbar">{switcher}</div>
    {pnl ? <div className="iopt-pnl-wrap"><Empty>{res.error || `Loading ${sym} options data…`}</Empty>{pnl(null)}</div> : <Empty>{res.error || `Loading ${sym} options data…`}</Empty>}</>
  const exps = d.expiries.slice(0, 12)
  if (!exps.length) return <><div className="toolbar">{switcher}</div><Empty>No option expiries available right now.</Empty></>
  const sel = exps.find(e => e.code === code) || exps[0]
  const near = exps[0]
  const spotD = d.spot >= 10000 ? 0 : d.spot >= 10 ? 2 : 4
  // "How to read this" — collapsed by default; click to open.
  const notes = <details className="note-box small copt-notes">
      <summary>How to read this <span className="muted">(click to open)</span></summary>
      {market.key === 'iopt' ? <><PcrGuide />{sym === 'NIFTY' && near?.strikes?.length && <PcrDecision p={(() => { const st = near.strikes.filter(r => r.c || r.p); return { v: near.pcr_oi, spot: d.spot, expiry: near.expiry_ist.split(',')[0], support: st.reduce((a, r) => r.p > a.p ? r : a).k, resistance: st.reduce((a, r) => r.c > a.c ? r : a).k } })()} />}</> : <div>· <b>PCR</b> above 1 = more puts than calls (hedging or bearish bets); below 0.7 = call-heavy positioning. Extremes are often read as contrarian.</div>}
      <div>· <b>Max pain</b> = expiry price where option buyers lose the most; price sometimes gravitates toward it into expiry, with no guarantee.</div>
      <div>· <b>{market.vol} / ATM IV</b> = how expensive options are. High IV = bigger expected move and richer premiums; low IV = cheaper options.</div>
      <div>· <b>Expected move</b> = ±1 standard deviation range (~68% of outcomes) priced in by options to that expiry.</div>
      <div>· <b>25Δ skew</b> positive = puts dearer than calls (demand for downside protection); negative = upside calls in demand.</div>
      <div className="muted">Market data to understand the set-up, not a buy/sell recommendation. {market.expiryNote}</div>
    </details>
  return <div className="copt">
    <div className="toolbar">{switcher}
      <span className="muted small">{market.source} · updated {istTime(d.fetched_at)} IST{d.stale ? ' · showing last good data' : ''}</span>
    </div>
    <div className="crypto-market">
      <div className="cm-card"><div className="cm-k">{market.symbols.find(s => s[0] === sym)[1]} Spot</div><div className="cm-v">{money(d.spot, spotD)}</div><div className="cm-n muted">{market.spotNote}</div></div>
      <div className="cm-card" title={market.volTitle}>
        <div className="cm-k">{d.vol_label || market.vol}</div><div className="cm-v">{isNum(d.dvol) ? d.dvol.toFixed(1) : '—'}</div>
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

    <section className={'opt-sec' + (pnl ? ' exp-with-pnl' : '')}>  {/* Expiries table, then Trade P&L as a horizontal strip in the same card */}
    <div className="exp-main">
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
    </div>
    {pnl && <div className="exp-pnl">{pnl(d)}</div>}
    </section>


    <OptionTools key={sym} d={d} exp={sel} market={market} bias={bias} side={<ChainTable exp={sel} spot={d.spot} lot={market.lot} extra={market.key === 'iopt' && sym === 'NIFTY' ? <RuleSummary d={d} exp={near} /> : null} />} chartNote={notes} />

  </div>
}

export default function CryptoOptions({ bias }) {
  return <OptionsBoard market={CRYPTO} bias={bias} />
}
