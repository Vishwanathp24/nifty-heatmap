import React from 'react'
import { api, fmtNum, fmtVol, isNum, usePoll, useSessionState } from './lib.js'

// Option-selling rules shared by Intraday Scanner → Option Selling (stocks) and Market Overview →
// Option Selling Outlook (index cards): regime, the 6 checks, structures and rule-based strike plans.
// Planning numbers from fixed rules, not advice.
const gt = (a, b) => isNum(a) && isNum(b) && a > b
const lt = (a, b) => isNum(a) && isNum(b) && a < b

// Option Selling: which F&O stocks suit a defined-risk option-selling trade now, which structure fits
// the stock's regime, and (on click) rule-based strikes from its option chain. Planning numbers, not advice.
export const OS_KIND = {
  range: { label: 'Range-bound', strat: 'Iron Condor', tone: 'neutral', what: 'Sell an OTM call spread above and an OTM put spread below: profits if the stock stays between the short strikes.' },
  bull: { label: 'Bullish', strat: 'Bull Put Spread', tone: 'up', what: 'Sell an OTM put below support and buy a lower put: profits if the stock stays above the short put.' },
  bear: { label: 'Bearish', strat: 'Bear Call Spread', tone: 'down', what: 'Sell an OTM call above resistance and buy a higher call: profits if the stock stays below the short call.' },
}
export function osRegime(r) {
  const d = r.daily || {}, h = r.tf60 || {}
  if (!isNum(d.rsi) || !isNum(h.adx)) return null
  const move = Math.abs(r.pct_prev ?? 0)
  if (h.adx < 20 && d.rsi >= 40 && d.rsi <= 60 && move < 1.5) return 'range'
  if (gt(d.close, d.sma20) && gt(h.ema9, h.ema21) && d.rsi >= 50 && d.rsi <= 70 && (r.pct_prev ?? 0) > -0.5) return 'bull'
  if (lt(d.close, d.sma20) && lt(h.ema9, h.ema21) && d.rsi >= 30 && d.rsi <= 50 && (r.pct_prev ?? 0) < 0.5) return 'bear'
  return null
}
export const OS_CHECKS = [
  ['Regime', 'A clear regime: range-bound, or a steady up / down trend', (r, k) => !!k],
  ['Liquid', 'Volume at least 0.8× its 5-day average (options easier to enter and exit)', r => isNum(r.vol_ratio) && r.vol_ratio >= 0.8],
  ['Calm', 'Moved less than 2% today: no shock or news move in progress', r => isNum(r.pct_prev) && Math.abs(r.pct_prev) < 2],
  ['Not stretched', 'Daily RSI between 30 and 70: not at an extreme that could snap back', r => isNum(r.daily?.rsi) && r.daily.rsi >= 30 && r.daily.rsi <= 70],
  ['Trend fits', 'Hourly ADX fits the structure: under 20 for a range, 20+ for a trend', (r, k) => isNum(r.tf60?.adx) && (k === 'range' ? r.tf60.adx < 20 : r.tf60.adx >= 20)],
  ['Supertrend', 'Hourly Supertrend agrees (up for bullish, down for bearish; any for a range)', (r, k) => k === 'range' || (k === 'bull' ? r.tf60?.st_dir === 1 : r.tf60?.st_dir === -1)],
]
const mid = o => isNum(o?.bid) && isNum(o?.ask) && o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : isNum(o?.mark) ? o.mark : null
function osPlan(d, kind, lot, minWidth = 0) {  // minWidth: protective strike at least this far out (indices)
  const exps = (d?.expiries || []).filter(e => e.chain?.length)
  const e = exps.find(x => x.days >= 5) || exps[0]
  if (!e) return null
  const spot = d.spot, move = e.move, ch = e.chain
  const ks = ch.map(r => r.k)
  const above = ch.filter(r => r.k > spot), below = ch.filter(r => r.k < spot)
  const cWall = above.reduce((a, r) => (r.call?.oi || 0) > (a?.call?.oi || 0) ? r : a, null)?.k
  const pWall = below.reduce((a, r) => (r.put?.oi || 0) > (a?.put?.oi || 0) ? r : a, null)?.k
  const at = k => ch.find(r => r.k === k)
  const legs = []
  const call = () => {
    const lim = Math.max(spot + (move || 0), cWall || 0)
    const sk = ks.find(k => k >= lim); if (!isNum(sk)) return null
    const bk = ks.find(k => k > sk && k - sk >= minWidth); if (!isNum(bk)) return null
    const cr = (mid(at(sk)?.call) ?? NaN) - (mid(at(bk)?.call) ?? NaN)
    return { side: 'call', sell: sk, buy: bk, width: bk - sk, credit: cr, sellOi: at(sk)?.call?.oi, sellBid: at(sk)?.call?.bid }
  }
  const put = () => {
    const lim = Math.min(spot - (move || 0), pWall || Infinity)
    const sk = [...ks].reverse().find(k => k <= lim); if (!isNum(sk)) return null
    const bk = [...ks].reverse().find(k => k < sk && sk - k >= minWidth); if (!isNum(bk)) return null
    const cr = (mid(at(sk)?.put) ?? NaN) - (mid(at(bk)?.put) ?? NaN)
    return { side: 'put', sell: sk, buy: bk, width: sk - bk, credit: cr, sellOi: at(sk)?.put?.oi, sellBid: at(sk)?.put?.bid }
  }
  if (kind !== 'bull') legs.push(call())
  if (kind !== 'bear') legs.push(put())
  if (legs.some(l => !l)) return { e, spot, move, cWall, pWall, legs: [], err: 'Not enough strikes in the chain for this structure.' }
  const credit = legs.reduce((a, l) => a + l.credit, 0)
  const width = Math.max(...legs.map(l => l.width))
  const ok = isNum(credit) && credit > 0
  return { e, spot, move, cWall, pWall, legs, credit, width, lot,
    maxProfit: ok && lot ? credit * lot : null, maxLoss: ok && lot ? (width - credit) * lot : null,
    beUp: legs.find(l => l.side === 'call') ? legs.find(l => l.side === 'call').sell + credit : null,
    beDn: legs.find(l => l.side === 'put') ? legs.find(l => l.side === 'put').sell - credit : null,
    thin: legs.some(l => !(l.sellBid > 0) || !(l.sellOi >= 100)), low: ok && credit < width * 0.15 }
}
export function OsPlan({ r, kind, lot, width = 0 }) {
  const res = usePoll(() => api('/api/index-options?symbol=' + encodeURIComponent(r.symbol)), 120000, [r.symbol])
  const p = res.data ? osPlan(res.data, kind, lot, width) : null
  const K = OS_KIND[kind], f = v => fmtNum(v, 2), rs = v => isNum(v) ? '₹' + Math.round(v).toLocaleString('en-IN') : '—'
  if (!res.data) return <div className="os-plan muted">{res.error || `Loading ${r.symbol} option chain…`}</div>
  if (!p || p.err) return <div className="os-plan muted">{p?.err || 'No option chain for this stock.'}</div>
  return <div className="os-plan">
    <div className="os-plan-h"><b className={K.tone === 'up' ? 'up' : K.tone === 'down' ? 'down' : 'amber'}>{K.strat}</b> on {r.symbol} · expiry <b>{p.e.expiry_ist.split(',')[0]}</b> ({Math.round(p.e.days)} days) · spot {f(p.spot)} · expected move ±{f(p.move)} ({p.e.move_pct?.toFixed(1)}%) · ATM IV {p.e.atm_iv ?? '—'}% · PCR {p.e.pcr_oi ?? '—'} · call wall {p.cWall ?? '—'} · put wall {p.pWall ?? '—'}</div>
    <table className="tbl compact os-legs"><thead><tr><th>Leg</th><th className="num">Strike</th><th className="num">Premium (mid)</th><th className="num">Short-strike OI</th></tr></thead><tbody>
      {p.legs.flatMap(l => [
        <tr key={l.side + 's'}><td className="down">Sell {l.side === 'call' ? 'Call (CE)' : 'Put (PE)'}</td><td className="num"><b>{l.sell}</b></td><td className="num">{f(mid(p.e.chain.find(x => x.k === l.sell)?.[l.side]))}</td><td className="num muted">{fmtVol(l.sellOi)}</td></tr>,
        <tr key={l.side + 'b'}><td className="up">Buy {l.side === 'call' ? 'Call (CE)' : 'Put (PE)'} (protection)</td><td className="num">{l.buy}</td><td className="num">{f(mid(p.e.chain.find(x => x.k === l.buy)?.[l.side]))}</td><td className="num muted">—</td></tr>])}
    </tbody></table>
    <div className="os-nums">
      <span>Net credit <b>{f(p.credit)}</b>/share</span>
      <span>Lot <b>{p.lot ?? '—'}</b></span>
      <span>Max profit <b className="up">{rs(p.maxProfit)}</b></span>
      <span>Max loss <b className="down">{rs(p.maxLoss)}</b></span>
      <span>Breakeven {p.beDn ? <b>{f(p.beDn)}</b> : null}{p.beDn && p.beUp ? ' – ' : ''}{p.beUp ? <b>{f(p.beUp)}</b> : null}</span>
      <span>Reward : risk <b>{isNum(p.maxProfit) && p.maxLoss > 0 ? '1 : ' + (p.maxLoss / p.maxProfit).toFixed(1) : '—'}</b></span>
    </div>
    {(p.thin || p.low || !(p.credit > 0)) && <div className="note-box">{!(p.credit > 0) ? 'No usable credit at these strikes (quotes missing or crossed): skip or check the live chain. '
      : p.low ? 'The credit is under 15% of the spread width: the reward is small for the risk. Consider skipping. ' : ''}{p.thin ? 'Thin market at a short strike (no bid, or under 100 contracts of open interest): fills may be poor and exits hard. ' : ''}</div>}
    <div className="os-exit"><b>Exit plan (rules):</b> take profit when the spread can be bought back for 30–50% of the credit (₹{isNum(p.credit) ? (p.credit * 0.5).toFixed(2) : '—'}–{isNum(p.credit) ? (p.credit * 0.3).toFixed(2) : '—'}/share);
      exit if the stock closes beyond a short strike ({p.legs.map(l => l.sell).join(' / ')}) or the spread's value doubles (loss ≈ the credit); close by 2 days before expiry to avoid expiry-day swings.</div>
  </div>
}
// Indices in Option Selling: Nifty and Bank Nifty use their NSE option chains; Sensex options are on BSE,
// whose data is blocked from this server, so its plan is an estimate from India VIX (no premiums).
const OS_INDICES = [['NIFTY', 'Nifty 50', 'nifty50', 200], ['BANKNIFTY', 'Bank Nifty', 'niftybank', 500], ['SENSEX', 'Sensex', 'sensex', 500]]  // last = spread width (points)
function SensexEstimate({ spot, vix, kind, lot, width = 500 }) {
  const f = v => fmtNum(v, 0)
  if (!isNum(spot) || !isNum(vix)) return <div className="os-plan muted">Waiting for Sensex and India VIX prices…</div>
  const days = 7, em = spot * vix / 100 * Math.sqrt(days / 365)
  const callS = Math.ceil((spot + em) / 100) * 100, putS = Math.floor((spot - em) / 100) * 100
  const K = OS_KIND[kind]
  return <div className="os-plan">
    <div className="os-plan-h"><b className={K.tone === 'up' ? 'up' : K.tone === 'down' ? 'down' : 'amber'}>{K.strat}</b> on Sensex · <b>estimate</b>: BSE's option chain can't be read from this server, so the 1-week expected move uses India VIX ({vix.toFixed(2)}) as a stand-in · spot {f(spot)} · expected move ±{f(em)} over {days} days</div>
    <table className="tbl compact os-legs"><thead><tr><th>Leg</th><th className="num">Strike</th></tr></thead><tbody>
      {kind !== 'bull' && <><tr><td className="down">Sell Call (CE)</td><td className="num"><b>{callS}</b></td></tr><tr><td className="up">Buy Call (CE) (protection)</td><td className="num">{callS + width}</td></tr></>}
      {kind !== 'bear' && <><tr><td className="down">Sell Put (PE)</td><td className="num"><b>{putS}</b></td></tr><tr><td className="up">Buy Put (PE) (protection)</td><td className="num">{putS - width}</td></tr></>}
    </tbody></table>
    <div className="os-nums"><span>Lot <b>{lot}</b></span><span>Spread width <b>{width}</b></span><span>Max loss = ({width} − credit) × {lot}</span></div>
    <div className="note-box">Check the premiums, open interest and the exact weekly expiry on your broker (BSE) before using these strikes: credit, profit and loss can't be worked out here.</div>
  </div>
}
export function IndexSellCards({ live, lots, fallback }) {
  const reg = usePoll(() => api('/api/index-regime'), 300000, [])
  const [open, setOpen] = useSessionState('os.idxOpen', '')
  const [pick, setPick] = useSessionState('os.idxKind', {})
  const vix = live?.indices?.indiavix?.ltp
  return <div className="os-idx">
    {OS_INDICES.map(([sym, name, key, width]) => {
      const q = live?.indices?.[key] || {}, g = reg.data?.[sym]
      const r = { symbol: sym, ltp: q.ltp, pct_prev: q.pct_prev, vol_ratio: 1, daily: g?.daily, tf60: g?.tf60 }
      const k = g ? osRegime(r) : null
      const res = OS_CHECKS.map(([key2, , f], i) => key2 === 'Liquid' ? true : !!f(r, k))
      const kind = pick[sym] || k || fallback
      const lot = lots[sym] || (sym === 'SENSEX' ? 20 : null)
      const why = !g ? 'loading…' : k ? OS_KIND[k].label : g.daily?.rsi > 70 ? `Stretched: daily RSI ${g.daily.rsi.toFixed(1)} (over 70)`
        : g.daily?.rsi < 30 ? `Stretched: daily RSI ${g.daily.rsi.toFixed(1)} (under 30)` : 'No clear regime'
      return <div key={sym} className={'os-idx-card' + (open === sym ? ' open' : '')}>
        <div className="os-idx-top"><b>{name}</b> <span className="num">{fmtNum(q.ltp)}</span>
          <span className={q.pct_prev >= 0 ? 'up' : 'down'}>{isNum(q.pct_prev) ? (q.pct_prev > 0 ? '+' : '') + q.pct_prev.toFixed(2) + '%' : ''}</span>
          <span className="setup-dots">{OS_CHECKS.map(([kk, d], i) => <i key={kk} className={res[i] ? 'ok' : ''} title={(res[i] ? '✓ ' : '✗ ') + d} />)}</span>
          <span className="muted small">{res.filter(Boolean).length}/6</span></div>
        <div className="os-idx-mid"><span className={'cp-pill ' + (k === 'bull' ? 'bull' : k === 'bear' ? 'bear' : '')}>{k ? OS_KIND[k].strat : 'No structure'}</span>
          <span className="muted small">{why}{g ? ` · daily RSI ${fmtNum(g.daily?.rsi, 1)} · 1H ADX ${fmtNum(g.tf60?.adx, 1)}` : ''}</span></div>
        <div className="os-idx-act">
          <select value={kind} onChange={e => setPick({ ...pick, [sym]: e.target.value })} title="Structure for the strike plan">
            {['range', 'bull', 'bear'].map(x => <option key={x} value={x}>{OS_KIND[x].strat}{x === k ? ' (fits)' : ''}</option>)}</select>
          <button className="btn sm" onClick={() => setOpen(open === sym ? '' : sym)}>{open === sym ? 'Hide plan' : 'Strike plan'}</button>
        </div>
        {open === sym && (sym === 'SENSEX' ? <SensexEstimate spot={q.ltp} vix={vix} kind={kind} lot={lot} width={width} /> : <OsPlan r={r} kind={kind} lot={lot} width={width} />)}
        {open === sym && !k && <div className="note-box">The rules find no clean structure for {name} right now ({why.toLowerCase()}). This plan is for the structure you picked: selling against a stretched trend carries more risk.</div>}
      </div>
    })}
  </div>
}

