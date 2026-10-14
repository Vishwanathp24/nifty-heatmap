import React, { useEffect, useMemo, useState } from 'react'
import { Seg } from './components.jsx'
import { isNum, useSessionState } from './lib.js'

// Decision tools for crypto options (BTC / ETH on Deribit): strike table, strategy explainer
// and a multi-leg payoff calculator. The user chooses the trade; these only show the numbers.
// Not a buy/sell recommendation.

let MK = { cur: '$', locale: 'en-US' }
export const setMoney = m => { MK = m }  // set by the options board for the active market
const usd = (v, d = 0) => isNum(v) ? (v < 0 ? '−' : '') + MK.cur + Math.abs(v).toLocaleString(MK.locale, { maximumFractionDigits: d }) : '—'
const sgnUsd = v => isNum(v) ? (v > 0 ? '+' : '') + usd(v) : '—'

// ---- payoff maths (at expiry) ----------------------------------------------------------------
const ncdf = x => 0.5 * (1 + erf(x / Math.SQRT2))
function erf(x) { // Abramowitz-Stegun 7.1.26
  const s = Math.sign(x); x = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * x)
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x))
}
const legPrice = (chain, l) => {
  const q = chain.find(r => r.k === l.k)?.[l.type === 'C' ? 'call' : 'put'] || {}
  return l.side === 'buy' ? (q.ask || q.mark) : (q.bid || q.mark)  // buys fill at the ask, sells at the bid
}
// Position value *now* at underlying price s (Black-Scholes, r = 0, each leg's own IV).
const bsPrice = (type, s, k, iv, t) => {
  if (!(iv > 0) || t <= 0) return Math.max(0, type === 'C' ? s - k : k - s)
  const sig = iv / 100, sq = sig * Math.sqrt(t), d1 = (Math.log(s / k) + sq * sq / 2) / sq, d2 = d1 - sq
  return type === 'C' ? s * ncdf(d1) - k * ncdf(d2) : k * ncdf(-d2) - s * ncdf(-d1)
}
const valueNow = (legs, s, t) => legs.reduce((a, l) => a + (l.side === 'buy' ? 1 : -1) * l.qty * bsPrice(l.type, s, l.k, l.iv, t), 0)

const pnlAt = (legs, s) => legs.reduce((a, l) => {
  const intr = l.type === 'C' ? Math.max(0, s - l.k) : Math.max(0, l.k - s)
  return a + l.qty * (l.side === 'buy' ? intr - l.prem : l.prem - intr)
}, 0)

function analyse(legs, exp, spot) {
  if (!legs.length || legs.some(l => !isNum(l.prem))) return null
  const net = legs.reduce((a, l) => a + l.qty * (l.side === 'buy' ? -l.prem : l.prem), 0)  // + credit / − debit
  const callSlope = legs.reduce((a, l) => a + (l.type === 'C' ? (l.side === 'buy' ? l.qty : -l.qty) : 0), 0)
  const hiS = Math.max(spot * 3, ...legs.map(l => l.k * 2))
  const pts = []
  for (let i = 0; i <= 3000; i++) pts.push(hiS * i / 3000)
  const vals = pts.map(s => pnlAt(legs, s))
  const maxP = callSlope > 1e-9 ? Infinity : Math.max(...vals)
  const maxL = callSlope < -1e-9 ? -Infinity : Math.min(...vals)
  const be = []
  for (let i = 1; i < pts.length; i++) {
    if ((vals[i - 1] < 0 && vals[i] >= 0) || (vals[i - 1] >= 0 && vals[i] < 0)) {
      const t = vals[i - 1] / (vals[i - 1] - vals[i]); be.push(pts[i - 1] + t * (pts[i] - pts[i - 1]))
    }
  }
  // chance of finishing in profit: lognormal price at expiry using the ATM implied vol
  let pop = null
  if (isNum(exp.atm_iv) && exp.days > 0) {
    const sig = exp.atm_iv / 100 * Math.sqrt(exp.days / 365), f = exp.fwd || spot
    const cdf = s => s <= 0 ? 0 : ncdf((Math.log(s / f) + sig * sig / 2) / sig)
    pop = 0
    for (let i = 1; i < pts.length; i++) if (pnlAt(legs, (pts[i - 1] + pts[i]) / 2) > 0) pop += cdf(pts[i]) - cdf(pts[i - 1])
    if (callSlope > 1e-9 && vals[vals.length - 1] > 0) pop += 1 - cdf(hiS)
    pop = Math.round(pop * 100)
  }
  return { net, maxP, maxL, be, pop }
}

function PayoffChart({ legs, exp, spot, sl }) {
  const ref = React.useRef(null)
  const [W, setW] = useState(760)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const H = 260, L = 70, R = 16, T = 14, B = 28
  const span = Math.max((exp.move || spot * 0.05) * 2.5, spot * 0.06)
  const lo = Math.max(0, spot - span), hi = spot + span
  const xs = Array.from({ length: 241 }, (_, i) => lo + (hi - lo) * i / 240)
  const ys = xs.map(s => pnlAt(legs, s))
  const yMin = Math.min(0, ...ys), yMax = Math.max(0, ...ys), pad = (yMax - yMin) * 0.1 || 1
  const x = s => L + (s - lo) / (hi - lo) * (W - L - R)
  const y = v => T + (yMax + pad - v) / (yMax - yMin + 2 * pad) * (H - T - B)
  const path = xs.map((s, i) => `${i ? 'L' : 'M'}${x(s).toFixed(1)},${y(ys[i]).toFixed(1)}`).join('')
  const zero = y(0)
  const band = exp.move ? [x(Math.max(lo, spot - exp.move)), x(Math.min(hi, spot + exp.move))] : null
  return <div ref={ref} className="payoff-wrap"><svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="payoff-svg" role="img" aria-label="Profit and loss at expiry">
    <defs>
      <clipPath id="pos"><rect x={L} y={T} width={W - L - R} height={Math.max(0, zero - T)} /></clipPath>
      <clipPath id="neg"><rect x={L} y={zero} width={W - L - R} height={Math.max(0, H - B - zero)} /></clipPath>
    </defs>
    {band && <rect x={band[0]} y={T} width={band[1] - band[0]} height={H - T - B} className="pf-band" />}
    <path d={path + `L${x(hi)},${zero}L${x(lo)},${zero}Z`} className="pf-area up" clipPath="url(#pos)" />
    <path d={path + `L${x(hi)},${zero}L${x(lo)},${zero}Z`} className="pf-area down" clipPath="url(#neg)" />
    <line x1={L} x2={W - R} y1={zero} y2={zero} className="pf-zero" />
    <path d={path} className="pf-line" />
    <line x1={x(spot)} x2={x(spot)} y1={T} y2={H - B} className="pf-spot" />
    {isNum(exp.max_pain) && exp.max_pain > lo && exp.max_pain < hi && <line x1={x(exp.max_pain)} x2={x(exp.max_pain)} y1={T} y2={H - B} className="pf-mp" />}
    {isNum(sl) && sl > lo && sl < hi && <><line x1={x(sl)} x2={x(sl)} y1={T} y2={H - B} className="pf-sl" /><text x={x(sl) + 4} y={T + 12} className="pf-ax pf-sl-t">SL {usd(sl)}</text></>}
    {[yMax, 0, yMin].map((v, i) => <text key={i} x={L - 6} y={y(v) + 4} className="pf-ax" textAnchor="end">{usd(v)}</text>)}
    {[lo, spot, hi].map((s, i) => <text key={i} x={x(s)} y={H - 8} className="pf-ax" textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>{usd(s)}</text>)}
  </svg></div>
}

function Metrics({ a, legs = [], compact = false }) {
  if (!a) return <span className="muted">—</span>
  // Premium in money terms for the whole quantity (legs carry qty in units).
  const paid = legs.filter(l => l.side === 'buy').reduce((t, l) => t + l.prem * l.qty, 0)
  const recd = legs.filter(l => l.side === 'sell').reduce((t, l) => t + l.prem * l.qty, 0)
  const sells = legs.some(l => l.side === 'sell')
  const capital = !sells ? paid : a.maxL === -Infinity ? null : Math.abs(a.maxL)
  const marginTitle = sells ? 'Approximate: for a hedged (defined-risk) position the margin is close to the maximum loss; your broker’s SPAN + exposure margin can differ.' : 'Buying options needs only the premium paid.'
  const marginChip = <span title={marginTitle}>{sells ? 'Margin needed ≈ ' : 'Capital needed '}<b>{capital == null ? 'High — unhedged short' : usd(capital)}</b></span>
  const popChip = <span title="Probability the position ends in profit at expiry, from the at-the-money implied volatility (market-implied, not a forecast)">Chance of profit ≈ <b>{isNum(a.pop) ? a.pop + '%' : '—'}</b></span>
  // Strategy-explainer cards show only these two; the calculator shows the full breakdown.
  // Explainer cards: margin + chance of profit always; on wide cards (lots of room) also
  // net credit/cost, max loss and breakeven, shown via a container query.
  if (compact) return <div className="pf-metrics">{marginChip}{popChip}
    <span className="xtra">{a.net >= 0 ? 'Net credit' : 'Net cost'} <b>{usd(Math.abs(a.net))}</b></span>
    <span className="xtra">Max loss <b className="down">{a.maxL === -Infinity ? 'Unlimited' : usd(a.maxL)}</b></span>
    <span className="xtra">Breakeven <b>{a.be.length ? a.be.map(v => usd(v)).join(' / ') : '—'}</b></span>
  </div>
  return <div className="pf-metrics pf-line1">
    <span>Premium paid <b className="down">{usd(paid)}</b></span>
    <span>Premium received <b className="up">{usd(recd)}</b></span>
    {marginChip}
    <span>{a.net >= 0 ? 'Net credit' : 'Net cost'} <b>{usd(Math.abs(a.net))}</b></span>
    <span>Max profit <b className="up">{a.maxP === Infinity ? 'Unlimited' : usd(a.maxP)}</b></span>
    <span>Max loss <b className="down">{a.maxL === -Infinity ? 'Unlimited' : usd(a.maxL)}</b></span>
    <span>Breakeven <b>{a.be.length ? a.be.map(v => usd(v)).join(' / ') : '—'}</b></span>
    {popChip}
  </div>
}

// ---- stop-loss calculator -------------------------------------------------------------------
// The user picks the rule; this shows where it sits and what it costs (estimate, not advice).
function StopLoss({ legs, exp, spot, capital, onLevel, unit }) {
  const credit = legs.reduce((t, l) => t + (l.side === 'sell' ? 1 : -1) * l.prem * l.qty, 0)  // + credit / − debit
  const [rule, setRule] = useState(credit > 0 ? 'mult' : 'pct')
  const [pct, setPct] = useState(40)
  const [mult, setMult] = useState(2)
  const t = Math.max(exp.days, 0.01) / 365
  const v0 = valueNow(legs, spot, t)
  const pnl = s => valueNow(legs, s, t) - v0  // change from now if the underlying moves to s
  // direction that hurts the position: compare a small move each way
  const step = Math.max(spot * 0.0005, 1)
  const adverseUp = pnl(spot + step * 20) < pnl(spot - step * 20)
  const [level, setLevel] = useState(() => Math.round(adverseUp ? spot + (exp.move || spot * 0.01) : spot - (exp.move || spot * 0.01)))
  let loss = null, slLevel = null, note = ''
  if (rule === 'level') {
    slLevel = level; loss = Math.max(0, -pnl(level))
  } else {
    loss = rule === 'pct' ? Math.abs(credit) * pct / 100 : credit > 0 ? credit * (mult - 1) : null
    if (rule === 'mult' && credit <= 0) note = 'The × premium rule is for credit (selling) trades — use % of premium for this position.'
    if (loss != null) {  // walk the underlying in the adverse direction until the loss is reached
      for (let i = 1; i <= 4000; i++) {
        const s2 = adverseUp ? spot + step * i : spot - step * i
        if (-pnl(s2) >= loss) { slLevel = s2; break }
      }
      if (slLevel == null) note = 'This loss is not reached within a large move right now (loss capped by the hedge before that point).'
    }
  }
  useEffect(() => { onLevel(slLevel) }, [slLevel])
  const pctCap = isNum(loss) && capital ? loss / capital * 100 : null
  return <div className="sl-box">
    <div className="sl-h"><b>Stop-loss calculator</b><span className="muted small">choose your rule — the numbers below follow it</span></div>
    <div className="sl-row">
      <Seg value={rule} onChange={setRule} options={[{ value: 'pct', label: '% of premium' }, { value: 'mult', label: '× premium collected' }, { value: 'level', label: 'Underlying level' }]} />
      {rule === 'pct' && <label className="field-inline">Exit at <input type="number" min="5" max="100" step="5" value={pct} onChange={e => setPct(Math.min(100, Math.max(1, Number(e.target.value) || 1)))} className="qty" /> % loss of premium</label>}
      {rule === 'mult' && <label className="field-inline">Exit when it costs <input type="number" min="1.1" max="5" step="0.1" value={mult} onChange={e => setMult(Math.max(1.1, Number(e.target.value) || 2))} className="qty" /> × the credit to close</label>}
      {rule === 'level' && <label className="field-inline">Exit if {unit} reaches <input type="number" step="1" value={level} onChange={e => setLevel(Number(e.target.value) || level)} className="qty wide" /></label>}
    </div>
    <div className="pf-metrics pf-line1">
      <span>Stop-loss level ≈ <b className="down">{isNum(slLevel) ? usd(slLevel) : '—'}</b>{isNum(slLevel) && <span className="muted"> ({((slLevel / spot - 1) * 100).toFixed(2)}% from spot)</span>}</span>
      <span>Loss if hit ≈ <b className="down">{isNum(loss) ? usd(-loss) : '—'}</b></span>
      <span>Of capital / margin <b>{isNum(pctCap) ? pctCap.toFixed(1) + '%' : '—'}</b></span>
      <span>Position value at exit ≈ <b>{isNum(loss) ? usd(Math.abs(credit < 0 ? -credit - loss : credit + loss)) : '—'}</b></span>
    </div>
    {note && <div className="muted small">{note}</div>}
    <div className="muted small">Estimate if the move happens now (option prices from each leg’s implied volatility); closer to expiry, the same move costs a buyer more and a seller less. Gaps, slippage and fees are not included. Your rule, not a recommendation.</div>
  </div>
}

// ---- strategy explainer ---------------------------------------------------------------------
const VIEWS = {
  bull: { label: 'Bullish', tone: 'up', list: [
    ['Long call', 'Buy an at-the-money call. Gains if price rises past the breakeven; loss limited to the premium.', [['C', 'buy', 'atm']]],
    ['Bull call spread', 'Buy an ATM call and sell a call near the +1σ expected-move edge. Cheaper than a call; profit capped.', [['C', 'buy', 'atm'], ['C', 'sell', 'up']]],
    ['Bull put spread', 'Sell the 3rd out-of-the-money put and buy a lower put costing about 10% of the sold premium as the hedge. Collects a credit if price stays above the short put.', [['P', 'sell', 'p3'], ['P', 'buy', 'ph']]],
  ] },
  bear: { label: 'Bearish', tone: 'down', list: [
    ['Long put', 'Buy an at-the-money put. Gains if price falls past the breakeven; loss limited to the premium.', [['P', 'buy', 'atm']]],
    ['Bear put spread', 'Buy an ATM put and sell a put near the −1σ edge. Cheaper than a put; profit capped.', [['P', 'buy', 'atm'], ['P', 'sell', 'dn']]],
    ['Bear call spread', 'Sell the 3rd out-of-the-money call and buy a higher call costing about 10% of the sold premium as the hedge. Collects a credit if price stays below the short call.', [['C', 'sell', 'c3'], ['C', 'buy', 'ch']]],
  ] },
  range: { label: 'Range-bound', list: [
    ['Iron condor', 'Sell the 3rd out-of-the-money put and call; buy hedges costing about 10% of each sold premium. Earns the credit if price stays between the short strikes.', [['P', 'buy', 'ph'], ['P', 'sell', 'p3'], ['C', 'sell', 'c3'], ['C', 'buy', 'ch']]],
    ['Iron butterfly', 'Sell an ATM straddle and buy wings near ±1σ. Larger credit, narrower profit zone around spot.', [['P', 'buy', 'dn'], ['P', 'sell', 'atm'], ['C', 'sell', 'atm'], ['C', 'buy', 'up']]],
  ] },
  move: { label: 'Big move either way', list: [
    ['Long straddle', 'Buy an ATM call and put. Gains if price moves more than the combined premium in either direction.', [['C', 'buy', 'atm'], ['P', 'buy', 'atm']]],
    ['Long strangle', 'Buy a call near +1σ and a put near −1σ. Cheaper than a straddle, needs a bigger move.', [['C', 'buy', 'up'], ['P', 'buy', 'dn']]],
  ] },
}

function refStrikes(exp) {
  const ks = exp.chain.map(r => r.k), f = exp.fwd, m = exp.move || f * 0.03
  const near = t => ks.reduce((a, k) => Math.abs(k - t) < Math.abs(a - t) ? k : a, ks[0])
  const atm = exp.atm_strike || near(f)
  const up = Math.max(near(f + m), ks.find(k => k > atm) ?? atm), dn = Math.min(near(f - m), [...ks].reverse().find(k => k < atm) ?? atm)
  // Option-seller rule: sell the 3rd out-of-the-money strike; hedge with the further-out
  // strike whose premium (ask) is closest to 10% of the sold premium (bid).
  const callsOtm = ks.filter(k => k > atm), putsOtm = [...ks].filter(k => k < atm).reverse()
  const c3 = callsOtm[2] ?? callsOtm[callsOtm.length - 1] ?? atm, p3 = putsOtm[2] ?? putsOtm[putsOtm.length - 1] ?? atm
  const q = (k, side) => exp.chain.find(r => r.k === k)?.[side] || {}
  const hedge = (sold, side, further) => {
    const target = (q(sold, side).bid || q(sold, side).mark || 0) * 0.10
    const cands = further.filter(k => isNum(q(k, side).ask || q(k, side).mark))
    return cands.length ? cands.reduce((a, k) => Math.abs((q(k, side).ask || q(k, side).mark) - target) < Math.abs((q(a, side).ask || q(a, side).mark) - target) ? k : a) : sold
  }
  const ch = hedge(c3, 'call', ks.filter(k => k > c3)), ph = hedge(p3, 'put', ks.filter(k => k < p3))
  return { atm, up, dn, up2: Math.max(near(f + 2 * m), ks.find(k => k > up) ?? up), dn2: Math.min(near(f - 2 * m), [...ks].reverse().find(k => k < dn) ?? dn), c3, p3, ch, ph }
}

// ---- bias-driven guidance ------------------------------------------------------------------
// Market Bias -> view; implied-volatility regime -> the structure that usually fits it.
const BIAS_VIEW = { BULLISH: 'bull', BEARISH: 'bear', NEUTRAL: 'range' }
// Debit structures (premium paid) suit option buyers; credit structures (premium collected) suit sellers.
const BUYER = new Set(['Long call', 'Bull call spread', 'Long put', 'Bear put spread', 'Long straddle', 'Long strangle'])
const FIT = {
  buy: {
    bull: { low: 'Long call', normal: 'Bull call spread', high: 'Bull call spread' },
    bear: { low: 'Long put', normal: 'Bear put spread', high: 'Bear put spread' },
    range: null,
    move: { low: 'Long straddle', normal: 'Long strangle', high: 'Long strangle' },
  },
  sell: {
    bull: { low: 'Bull put spread', normal: 'Bull put spread', high: 'Bull put spread' },
    bear: { low: 'Bear call spread', normal: 'Bear call spread', high: 'Bear call spread' },
    range: { low: 'Iron condor', normal: 'Iron condor', high: 'Iron butterfly' },
    move: null,
  },
}
const IVW = { low: 'implied volatility is low (premiums cheap)', normal: 'implied volatility is normal', high: 'implied volatility is high (premiums rich)' }
// Why the marked structure suits this volatility, per structure.
const reason = (name, regime) => {
  const iv = IVW[regime]
  if (name === 'Long call' || name === 'Long put') return `${iv} — buying the option outright keeps the full move; the most you can lose is the premium paid`
  if (name === 'Bull call spread' || name === 'Bear put spread') return `${iv} — the sold leg pays for part of the bought option, lowering cost and breakeven; profit is capped`
  if (name === 'Bull put spread' || name === 'Bear call spread') return `${iv} — collects premium if price stays on the right side of the short strike; the bought leg caps the loss${regime === 'low' ? ' (credit is small for the risk when premiums are thin)' : regime === 'high' ? ' (rich premiums favour sellers)' : ''}`
  if (name === 'Iron condor') return `${iv} — collects premium while price stays inside the expected-move range; the wings cap the loss${regime === 'low' ? ' (thin premiums mean a small credit)' : ''}`
  if (name === 'Iron butterfly') return `${iv} — rich premiums make the ATM straddle credit large; the wings cap the loss, but the profit zone is narrow`
  if (name === 'Long straddle') return `${iv} — cheap premiums make buying both the ATM call and put affordable; needs a move bigger than the total premium`
  if (name === 'Long strangle') return `${iv} — out-of-the-money call + put cost less than a straddle when premiums aren't cheap; needs a bigger move`
  return iv
}
const NONE = {
  buy: 'A range-bound view is expressed by selling premium; option buyers need a move (see the “Big move either way” view).',
  sell: 'Selling premium is the opposite of expecting a big move; this view has buyer structures only.',
}

// ---- main component -------------------------------------------------------------------------
export default function OptionTools({ d, exp, market = {}, bias }) {
  const ccy = d.ccy
  const lot = market.lot || 1  // fixed exchange lot size; quantity is set in lots
  const mult = market.lot ? lot : 1  // index options: quantity in lots x lot size
  const unit = market.lot ? 'unit' : ccy
  const ref = useMemo(() => refStrikes(exp), [exp])
  const mkLegs = spec => spec.map(([type, side, at]) => ({ type, side, k: ref[at], qty: 1, at }))
  const [legs, setLegs] = useState(() => mkLegs([['C', 'buy', 'atm']]))
  const biasView = BIAS_VIEW[bias?.label]
  const [viewManual, setViewManual] = useSessionState((market.key || 'opt') + '.viewManual', false)
  const [viewPick, setViewPick] = useState('bull')
  const view = !viewManual && biasView ? biasView : viewPick
  const setView = v => { setViewPick(v); setViewManual(true) }
  const bands = (market.ivBands || {})[ccy] || [15, 25]
  const iv = d.dvol
  const regime = !isNum(iv) ? 'normal' : iv < bands[0] ? 'low' : iv > bands[1] ? 'high' : 'normal'
  const fitB = FIT.buy[view]?.[regime], fitS = FIT.sell[view]?.[regime]
  const groups = [['sell', 'For option sellers', 'credit — you collect the premium; loss capped by the hedge leg', fitS],
                  ['buy', 'For option buyers', 'debit — you pay the premium; risk limited to what you pay', fitB]]
    .map(([k, title, sub, fit]) => [k, title, sub, fit, [...VIEWS[view].list].filter(x => (k === 'buy') === BUYER.has(x[0])).sort((x, y) => (y[0] === fit) - (x[0] === fit))])
  useEffect(() => { setLegs(ls => ls.map(l => ({ ...l, k: exp.chain.some(r => r.k === l.k) ? l.k : ref.atm }))) }, [exp.code])
  const priced = legs.map(l => ({ ...l, prem: legPrice(exp.chain, l), qty: l.qty * mult, iv: exp.chain.find(r => r.k === l.k)?.[l.type === 'C' ? 'call' : 'put']?.iv }))
  const [slLevel, setSlLevel] = useState(null)
  const a = analyse(priced, exp, d.spot)
  const strikes = exp.chain.map(r => r.k)
  // Calculator starts with the structure that fits the Market Bias (buyer pick, or the seller
  // pick when the view has no buyer structure) and follows it until the user edits a leg.
  const [legsManual, setLegsManual] = useState(false)
  // Default calculator trade: Long call when bullish, Long put when bearish (follows the bias-driven view);
  // range-bound / big-move views start with their marked structure.
  const defName = view === 'bull' ? 'Long call' : view === 'bear' ? 'Long put' : (fitS || fitB)
  const defSpec = VIEWS[view].list.find(x => x[0] === defName)?.[2]
  useEffect(() => { if (!legsManual && defSpec) setLegs(mkLegs(defSpec)) }, [defName, view, exp.code, legsManual])
  const edit = fn => { setLegsManual(true); setLegs(fn) }
  const setLeg = (i, patch) => edit(ls => ls.map((l, j) => j === i ? { ...l, ...patch } : l))
  const load = spec => { edit(() => mkLegs(spec)); document.getElementById('payoff-calc')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  const tag = k => [k === ref.atm && 'ATM', k === exp.max_pain && 'max pain', k === ref.up && '+1σ', k === ref.dn && '−1σ'].filter(Boolean)

  return <div className="opt-tools">
    <section className="opt-sec">
      <div className="opt-sec-h">
        <div><h3>Strategy explainer</h3><div className="muted small">Expiry {exp.expiry_ist} · pick the view you have, see how each structure behaves with live prices</div></div>
        <div className="opt-view"><span className="muted small">My view</span>
          <Seg value={view} onChange={setView} options={Object.entries(VIEWS).map(([v, o]) => ({ value: v, label: o.label, tone: o.tone }))} />
          {viewManual && biasView && <button className="btn sm" onClick={() => setViewManual(false)} title="Follow the Market Bias again">Follow bias</button>}</div>
      </div>
      <div className={'bias-guide ' + (view === 'bull' ? 'bull' : view === 'bear' ? 'bear' : 'neutral')}>
        <div className="bg-line">
          {bias?.label ? <span className={'bias-pill ' + (bias.label === 'BULLISH' ? 'bull' : bias.label === 'BEARISH' ? 'bear' : 'neutral')}>{market.biasName || 'Market Bias'}: {bias.label} ({bias.score > 0 ? '+' : ''}{bias.score})</span> : <span className="muted small">Market Bias not available yet</span>}
          <span className={'iv-pill ' + regime}>{market.vol || 'IV'} {isNum(iv) ? iv.toFixed(1) : '—'} · {regime} volatility</span>
        </div>
        <div className="bg-text">
          {viewManual || !biasView
            ? <>You are viewing <b>{VIEWS[view].label}</b> strategies{biasView && biasView !== view ? <> — the Market Bias currently points to <b>{VIEWS[biasView].label}</b></> : null}. </>
            : <>The Market Bias is <b>{bias.label}</b>, so <b>{VIEWS[view].label}</b> strategies are shown. </>}
        </div>
        <div className="bg-roles">
          <div><span className="role-tag sell">Option seller</span> {fitS ? <><b>{fitS}</b> — {reason(fitS, regime)}.</> : <span className="muted">{NONE.sell}</span>}</div>
          <div><span className="role-tag buy">Option buyer</span> {fitB ? <><b>{fitB}</b> — {reason(fitB, regime)}.</> : <span className="muted">{NONE.buy}</span>}</div>
        </div>
        <div className="muted small">Guidance on which structure matches the bias, volatility and your trading style — strikes, size, timing and risk are your decision. Not a buy/sell recommendation.</div>
      </div>
      <div className={'strat-groups' + (groups.some(g => !g[4].length) ? ' single' : '')}>{groups.map(([k, title, sub, fit, list]) => <div key={k} className={'strat-group ' + k + (list.length ? '' : ' empty')}>
        <div className="sg-h"><span className={'role-tag ' + k}>{title}</span><span className="muted small">{sub}</span></div>
        {!list.length ? <div className="muted small sg-none">{NONE[k]}</div> :
      <div className="strat-list">{list.map(([name, why, spec]) => {
        const ls = mkLegs(spec).map(l => ({ ...l, prem: legPrice(exp.chain, l), qty: l.qty * mult }))
        return <div key={name} className={'strat' + (name === fit ? ' fit' : '')}>
          {name === fit && <span className="fit-tag">✓ Fits current conditions</span>}
          <div className="strat-h"><b>{name}</b><button className="btn sm" onClick={() => load(spec)}>Open in calculator ↓</button></div>
          <div className="muted small strat-why">{why}</div>
          <div className="strat-legs">{ls.map((l, i) => {
            const sold = l.at === 'ch' || l.at === 'ph' ? ls.find(x => x.side === 'sell' && x.type === l.type) : null
            const tagTxt = l.at === 'c3' || l.at === 'p3' ? ' · 3rd OTM' : sold && sold.prem ? ` · ${Math.round(l.prem / sold.prem * 100)}% of sold` : ''
            return <span key={i} className={'leg ' + l.side}>{l.side === 'buy' ? 'Buy' : 'Sell'} {usd(l.k)} {l.type === 'C' ? 'call' : 'put'} @ {usd(l.prem, market.lot ? 2 : 0)}{tagTxt}</span>
          })}</div>
          <Metrics a={analyse(ls, exp, d.spot)} legs={ls} compact />
        </div>
      })}</div>}
      </div>)}</div>
      <p className="muted small opt-foot">Buyer examples use the at-the-money and ±1 expected-move strikes; seller examples sell the 3rd out-of-the-money strike and hedge with a strike costing ~10% of the sold premium. {market.lot ? `1 lot (${lot} units)` : `1 ${ccy}`} per leg, buys at the ask and sells at the bid. Education about how each structure behaves, not a recommendation.</p>
    </section>

    <section className="opt-sec" id="payoff-calc">
      <div className="opt-sec-h"><div><h3>Payoff calculator</h3><div className="muted small">Expiry {exp.expiry_ist} · {legsManual ? 'your own legs' : <>starts with <b>{defName}</b> to match the {market.biasName || 'Market Bias'} — edit any leg or load an example above</>}</div></div>
        {legsManual && defSpec && <button className="btn sm" onClick={() => setLegsManual(false)} title="Go back to the structure that matches the Market Bias">Reset to bias</button>}</div>
      <div className="calc-legs">
        {legs.map((l, i) => <div key={i} className="calc-leg">
          <span className="leg-no">Leg {i + 1}</span>
          <Seg value={l.side} onChange={v => setLeg(i, { side: v })} options={[{ value: 'buy', label: 'Buy', tone: 'up' }, { value: 'sell', label: 'Sell', tone: 'down' }]} />
          <Seg value={l.type} onChange={v => setLeg(i, { type: v })} options={[{ value: 'C', label: 'Call' }, { value: 'P', label: 'Put' }]} />
          <select value={l.k} onChange={e => setLeg(i, { k: Number(e.target.value) })} aria-label="Strike">
            {strikes.map(k => <option key={k} value={k}>{usd(k)}{tag(k).length ? ' · ' + tag(k).join(', ') : ''}</option>)}</select>
          <label className="field-inline">Qty <input type="number" min={market.lot ? 1 : 0.1} step={market.lot ? 1 : 0.1} value={l.qty} onChange={e => setLeg(i, { qty: Math.max(market.lot ? 1 : 0.1, Number(e.target.value) || 1) })} className="qty" /> {market.lot ? <>lot{l.qty === 1 ? '' : 's'} <span className="units">= {(l.qty * lot).toLocaleString('en-IN')} units</span></> : ccy}</label>
          <span className="muted small">premium {usd(priced[i].prem, market.lot ? 2 : 0)} / {unit}</span>
          {isNum(priced[i].prem) && <span className={'leg-amt ' + l.side}>{l.side === 'buy' ? 'you pay' : 'you receive'} <b>{usd(priced[i].prem * priced[i].qty)}</b></span>}
          {legs.length > 1 && <button className="btn sm leg-x" onClick={() => edit(ls => ls.filter((_, j) => j !== i))} aria-label="Remove leg">✕</button>}
        </div>)}
        <div className="calc-actions"><button className="btn sm" onClick={() => edit(ls => [...ls, { type: 'P', side: 'buy', k: ref.atm, qty: 1 }])} disabled={legs.length >= 4}>+ Add leg</button>
          {market.lot && <span className="muted small" title="NSE lot size for this index">Lot size {lot} units (fixed) · change Qty to trade more lots</span>}</div>
      </div>
      <Metrics a={a} legs={priced} />
      {a && <StopLoss key={legs.map(l => l.side + l.type + l.k).join() + exp.code} legs={priced} exp={exp} spot={d.spot} unit={ccy === 'BTC' || ccy === 'ETH' ? ccy : 'Nifty'}
        capital={priced.some(l => l.side === 'sell') ? (a.maxL === -Infinity ? null : Math.abs(a.maxL)) : priced.reduce((t, l) => t + l.prem * l.qty, 0)} onLevel={setSlLevel} />}
      {a && <PayoffChart legs={priced} exp={exp} spot={d.spot} sl={slLevel} />}
      <div className="muted small opt-foot">P&amp;L at expiry ({exp.expiry_ist}). <span className="pf-key spot" /> spot · <span className="pf-key band" /> expected move ±{usd(exp.move)} · <span className="pf-key mp" /> max pain {usd(exp.max_pain)} · <span className="pf-key sl" /> stop-loss level. Fees and early exit are not included.</div>
    </section>
  </div>
}
