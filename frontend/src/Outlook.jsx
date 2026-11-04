import React, { useMemo, useState } from 'react'
import { Section } from './components.jsx'
import { useOiChange } from './Pcr.jsx'
import { isNum, istTime } from './lib.js'

// Market Outlook on Market Overview: a rule-based read of the next session (after the close) or of the
// rest of today (during market hours), worked out live from the data already on this page: Market Bias,
// breadth, India VIX, FII / DII, GIFT Nifty, US markets and the Nifty option chain (OI change, PCR,
// call / put OI walls, max pain, expected move). It shows what the signals point to and the levels to
// watch. It is not a prediction and never a buy / sell call.

const k = v => isNum(v) ? Math.round(v).toLocaleString('en-IN') : '—'
const pct = (v, d = 2) => isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)}%` : '—'

export default function MarketOutlook({ live, ctx }) {
  const { d, e, s } = useOiChange()
  const o = useMemo(() => build(live, ctx, d, e, s), [live, ctx, d, e, s])
  const [more, setMore] = useState(false)
  if (!o) return null
  return <Section title={<><span className="c-hide">Market </span>{o.title.replace('Market ', '')}</>} subtitle={o.subtitle} className="outlook"
    right={<button className="btn ghost sm" onClick={() => setMore(m => !m)} aria-expanded={more}>{more ? 'Hide details' : 'See details'}</button>}>
    <div className={'ol-card c-only ' + o.lean.key}>  {/* phones / tablets: the same answer as a small card */}
      <div className="ol-card-top"><span className={'ol-pill ' + o.lean.key}><span className="ol-dot">{o.lean.key === 'bull' ? '🟢' : o.lean.key === 'bear' ? '🔴' : '🟡'}</span>{o.lean.label}</span>
        <span className="ol-card-n">{o.lean.key === 'bear' ? o.down : o.up} of {o.up + o.down + o.flat} signs {o.lean.key === 'bear' ? 'bad' : 'good'}</span></div>
      {o.gap && <div className="ol-card-l">Likely open: <b className={o.gap.pts >= 0 ? 'up' : 'down'}>{o.gap.pts >= 0 ? '+' : '−'}{k(Math.abs(o.gap.pts))} pts</b></div>}
      <div className="ol-card-l">{o.short}</div>
    </div>
    <div className={'ol-simple c-hide ' + o.lean.key}>
      <span className="ol-emoji" aria-hidden="true">{o.lean.key === 'bull' ? '🟢' : o.lean.key === 'bear' ? '🔴' : '🟡'}</span>
      <div>{o.simple.map((x, i) => <p key={i}>{x}</p>)}</div>
    </div>
    {more && <div className="ol-grid">
      <div className={'ol-lean ' + o.lean.key}>
        <div className="k">Signals lean</div>
        <div className="ol-lean-v">{o.lean.label}</div>
        <div className="ol-score">{o.up} positive · {o.down} negative · {o.flat} neutral</div>
        {o.gap && <div className="ol-gap">GIFT Nifty points to <b className={o.gap.pts >= 0 ? 'up' : 'down'}>{o.gap.pts >= 0 ? '+' : '−'}{k(Math.abs(o.gap.pts))} ({pct(o.gap.pct)})</b> vs Nifty’s close</div>}
      </div>
      <div className="ol-sig">
        <b>What points up</b>
        {o.pros.length ? <ul>{o.pros.map(x => <li key={x}>{x}</li>)}</ul> : <p className="muted small">Nothing clearly positive.</p>}
        <b>What holds it back</b>
        {o.cons.length ? <ul>{o.cons.map(x => <li key={x}>{x}</li>)}</ul> : <p className="muted small">Nothing clearly negative.</p>}
      </div>
      <div className="ol-levels">
        <b>Levels to watch</b>
        <table className="tbl compact ol-tbl"><tbody>
          {o.levels.map(([l, v, t, n]) => <tr key={l}><td>{l}</td><td className={'num ' + (t || '')}><b>{v}</b></td><td className="muted small">{n}</td></tr>)}
        </tbody></table>
      </div>
      <div className="ol-scen">
        <b>How it could play out</b>
        <ol>{o.scenarios.map(x => <li key={x[0]}><b>{x[0]}</b> {x[1]}</li>)}</ol>
        <p className="muted small">Check at 9:08 AM: the Pre-Open Nifty 50 and GIFT Nifty cards show the real gap. In the first 15–30 minutes, Nifty OI Change shows whether puts (support) or calls (resistance) are being added.</p>
      </div>
    </div>}
    <p className="ol-note c-hide muted small">Worked out automatically from the data on this page{o.at ? ` (option chain ${istTime(o.at)} IST)` : ''}. A read of the signals, not a prediction: markets often do the opposite. Not investment advice and not a buy / sell recommendation.</p>
  </Section>
}

function build(live, ctx, d, e, s) {
  if (!live?.indices?.nifty50) return null
  const n = live.indices.nifty50, vix = live.indices.indiavix, open = live.market_status?.label === 'Market Open'
  const b = live.bias, br = live.breadth || {}
  const glob = ctx?.global?.data || []
  const g = l => glob.find(x => x.label === l)
  const fii = ctx?.fii_dii?.data?.fii, dii = ctx?.fii_dii?.data?.dii
  const pros = [], cons = []
  let up = 0, down = 0, flat = 0
  const vote = (v, pro, con) => { if (v > 0) { up++; pros.push(pro) } else if (v < 0) { down++; cons.push(con) } else flat++ }

  // 1. Market Bias (breadth-based, 5 checks)
  if (b && isNum(b.score)) vote(b.score >= 3 ? 1 : b.score <= -3 ? -1 : 0,
    `Market Bias ${b.label} (${b.score > 0 ? '+' : ''}${b.score} / 5): Nifty ${pct(n.pct_open)} from its open, breadth ${br.nifty50 ? `${br.nifty50.up} up / ${br.nifty50.down} down` : ''}`,
    `Market Bias ${b.label} (${b.score} / 5): Nifty ${pct(n.pct_open)} from its open, breadth ${br.nifty50 ? `${br.nifty50.up} up / ${br.nifty50.down} down` : ''}`)
  // 2. F&O breadth
  const fo = br.fo
  if (fo && fo.up + fo.down) { const r = fo.up / (fo.up + fo.down); vote(r >= 0.65 ? 1 : r <= 0.35 ? -1 : 0, `Broad buying: ${fo.up} of ${fo.up + fo.down} F&O stocks up`, `Broad selling: ${fo.down} of ${fo.up + fo.down} F&O stocks down`) }
  // 3. India VIX
  if (vix && isNum(vix.pct_prev)) vote(vix.pct_prev <= -1 ? 1 : vix.pct_prev >= 3 ? -1 : 0,
    `India VIX ${vix.ltp?.toFixed(2)}, ${pct(vix.pct_prev)}: fear easing`, `India VIX ${vix.ltp?.toFixed(2)}, ${pct(vix.pct_prev)}: fear rising`)
  // 4. FII cash flow (latest data date)
  if (fii && isNum(fii.net)) vote(fii.net >= 1000 ? 1 : fii.net <= -1000 ? -1 : 0,
    `FII net bought ₹${k(fii.net)} Cr (${fii.date})${dii && isNum(dii.net) ? `, DII ${dii.net >= 0 ? 'bought' : 'sold'} ₹${k(Math.abs(dii.net))} Cr` : ''}`,
    `FII net sold ₹${k(Math.abs(fii.net))} Cr (${fii.date})${dii && isNum(dii.net) ? `, DII ${dii.net >= 0 ? 'bought' : 'sold'} ₹${k(Math.abs(dii.net))} Cr` : ''}`)
  // 5. GIFT Nifty gap (only meaningful outside market hours)
  const gift = g('GIFT Nifty')
  const gap = !open && gift && isNum(gift.last) && isNum(n.ltp) ? { pts: gift.last - n.ltp, pct: (gift.last / n.ltp - 1) * 100 } : null
  if (gap) vote(gap.pct >= 0.3 ? 1 : gap.pct <= -0.3 ? -1 : 0,
    `GIFT Nifty ${k(gift.last)}: about ${k(gap.pts)} points above Nifty’s close`, `GIFT Nifty ${k(gift.last)}: about ${k(Math.abs(gap.pts))} points below Nifty’s close`)
  // 6. US markets
  const us = ['Dow Jones', 'S&P 500', 'Nasdaq'].map(g).filter(x => x && isNum(x.pct))
  if (us.length) { const avg = us.reduce((a, x) => a + x.pct, 0) / us.length; const t = us.map(x => `${x.label.replace('Dow Jones', 'Dow')} ${pct(x.pct, 1)}`).join(', ')
    vote(avg >= 0.5 ? 1 : avg <= -0.5 ? -1 : 0, `US markets up: ${t}`, `US markets down: ${t}`) }
  // 7. Option writers' fresh OI (same window as the OI Change panel)
  if (s) vote(s.sent.key === 'bull' ? 1 : s.sent.key === 'bear' ? -1 : 0,
    `Option writers lean bullish: ${s.sent.why.replace(/ —.*$/, '')}`, `Option writers lean bearish: ${s.sent.why.replace(/ —.*$/, '')}`)

  // Levels from the nearest expiry's option chain
  const spot = isNum(n.ltp) ? n.ltp : d?.spot
  const st = (e?.strikes || []).filter(r => r.c || r.p)
  const above = st.filter(r => r.k >= spot).sort((a, b2) => b2.c - a.c), below = st.filter(r => r.k <= spot).sort((a, b2) => b2.p - a.p)
  const near = arr => arr.slice(0, 3).sort((a, b2) => Math.abs(a.k - spot) - Math.abs(b2.k - spot))
  const res = near(above), sup = near(below)
  const R1 = res[0]?.k, R2 = res.find(r => r.k > (R1 ?? Infinity))?.k, S1 = sup[0]?.k, S2 = sup.find(r => r.k < (S1 ?? -Infinity))?.k
  const mp = e?.max_pain
  const day = isNum(e?.move) && isNum(e?.days) ? e.move / Math.sqrt(Math.max(1, e.days)) : null
  if (s && isNum(s.pcr) && s.pcr < 0.8) cons.push(`PCR ${s.pcr.toFixed(2)} (strikes ${k(s.lo)}–${k(s.hi)}): more calls than puts, call writers are active`)
  if (s && isNum(s.pcr) && s.pcr > 1.4) cons.push(`PCR ${s.pcr.toFixed(2)}: very put-heavy, the market may be stretched`)
  if (isNum(R1) && isNum(spot) && R1 - spot <= 150) cons.push(`Heavy call OI at ${k(R1)}, just ${k(R1 - spot)} points above: option sellers expect Nifty to stay below it`)
  if (isNum(mp) && isNum(spot) && Math.abs(mp - spot) >= 100) (mp < spot ? cons : pros).push(`Max pain ${k(mp)} is ${mp < spot ? 'below' : 'above'} Nifty (${e.expiry_ist.split(',')[0]} expiry)`)

  const net = up - down
  const lean = net >= 2 ? { key: 'bull', label: 'Positive' } : net <= -2 ? { key: 'bear', label: 'Negative' } : { key: 'neutral', label: 'Mixed' }
  const levels = [
    isNum(R2) && ['Resistance 2', k(R2), 'down', 'next call OI wall'],
    isNum(R1) && ['Resistance 1', k(R1), 'down', 'highest call OI near spot'],
    ['Nifty', k(spot), '', open ? 'now' : 'last close'],
    gap && ['GIFT Nifty', k(gift.last), gap.pts >= 0 ? 'up' : 'down', 'indicated open'],
    isNum(mp) && ['Max pain', k(mp), '', `${e.expiry_ist.split(',')[0]} expiry`],
    isNum(S1) && ['Support 1', k(S1), 'up', 'highest put OI near spot'],
    isNum(S2) && ['Support 2', k(S2), 'up', 'next put OI wall'],
    isNum(day) && ['1-day range', `±${k(day)}`, '', `from expected move ±${k(e.move)} to expiry`],
  ].filter(Boolean)

  const R = isNum(R1) ? k(R1) : 'resistance', Sx = isNum(S1) ? k(S1) : 'support'
  const scenarios = lean.key === 'bull' ? [
    [`${open ? 'Holds the gains' : 'Opens higher'} and stays above ${R}.`, `The strongest case. Call writers at ${R} may have to cover; next zone ${isNum(R2) ? k(R2) : 'higher'}.`],
    [`${open ? 'Rises' : 'Gap-up'} then fades below ${R}.`, `Profit-booking could pull Nifty toward ${isNum(mp) ? `${k(mp)} (max pain)` : Sx}, with support at ${Sx}${isNum(S2) ? ` and ${k(S2)}` : ''}.`],
    ['Flat or lower.', open ? 'Only if breadth and OI turn against the move.' : 'Likely only if global cues reverse overnight (watch GIFT Nifty before 9:08).'],
  ] : lean.key === 'bear' ? [
    [`${open ? 'Stays weak' : 'Opens lower'} and breaks ${Sx}.`, `The weakest case. Put writers at ${Sx} may cover; next zone ${isNum(S2) ? k(S2) : 'lower'}.`],
    [`${open ? 'Dips' : 'Gap-down'} then recovers above ${Sx}.`, `Short covering could lift Nifty toward ${isNum(mp) ? `${k(mp)} (max pain)` : R}, with resistance at ${R}.`],
    ['Flat or higher.', open ? 'Only if breadth and OI turn in favour.' : 'Likely only if global cues improve overnight (watch GIFT Nifty before 9:08).'],
  ] : [
    [`Range between ${Sx} and ${R}.`, 'The most likely case when signals disagree: option writers defend both sides.'],
    [`Breaks above ${R}.`, `Call writers may cover; next zone ${isNum(R2) ? k(R2) : 'higher'}.`],
    [`Breaks below ${Sx}.`, `Put writers may cover; next zone ${isNum(S2) ? k(S2) : 'lower'}.`],
  ]
  const total = up + down + flat
  const day1 = open ? 'The rest of today' : 'The next session'
  const simple = [
    lean.key === 'bull' ? `${day1} looks positive: ${up} of ${total} signs are good${gap && gap.pts > 0 ? `, and Nifty may open about ${k(gap.pts)} points higher` : ''}.`
      : lean.key === 'bear' ? `${day1} looks weak: ${down} of ${total} signs are bad${gap && gap.pts < 0 ? `, and Nifty may open about ${k(Math.abs(gap.pts))} points lower` : ''}.`
      : `${day1} looks mixed: the signs don’t agree (${up} good, ${down} bad), so Nifty may move sideways.`,
    lean.key === 'bear'
      ? `Key level ${Sx}: if Nifty stays below it, it may fall further${isNum(S2) ? ` (toward ${k(S2)})` : ''}; if it climbs back above, it may recover toward ${R}.`
      : lean.key === 'bull'
      ? `Key level ${R}: if Nifty stays above it, it may go higher${isNum(R2) ? ` (toward ${k(R2)})` : ''}; if it slips below, it may drop back toward ${isNum(mp) ? k(mp) : Sx}.`
      : `Watch ${Sx} below and ${R} above: a clear move past either one shows the direction.`,
    'This is a guide, not a guarantee, and not a buy or sell tip.',
  ]
  const short = lean.key === 'bear'
    ? <>Watch <b>{Sx}</b>: below → {isNum(S2) ? k(S2) : 'lower'} · above → {R}</>
    : lean.key === 'bull'
    ? <>Watch <b>{R}</b>: above → {isNum(R2) ? k(R2) : 'higher'} · below → {isNum(mp) ? k(mp) : Sx}</>
    : <>Range <b>{Sx}</b> – <b>{R}</b>: a break shows the direction</>
  const sd = live.session_date ? new Date(live.session_date + 'T12:00:00+05:30').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : ''
  return {
    title: open ? 'Market Outlook · rest of today' : 'Market Outlook · next session',
    subtitle: open ? 'What today’s live signals point to — not a prediction' : `Based on ${sd} close and tonight’s global cues — not a prediction`,
    lean, up, down, flat, simple, short, pros, cons, levels, scenarios, gap, at: d?.fetched_at,
  }
}

