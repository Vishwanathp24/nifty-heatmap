import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Empty, Seg } from './components.jsx'
import { api, isNum, istTime, usePoll, useSessionState } from './lib.js'
import OptionTools, { BIAS_VIEW, BUYER, FIT, NONE, VIEWS, legPrice, refStrikes, setMoney } from './OptionTools.jsx'

// Live chart shared by Crypto -> Live Chart (OKX, $) and Intraday Scanner -> Live Chart (NSE via
// Yahoo, INR): candles with volume, session-break lines, drag back in time (older candles load as
// you go), scroll to zoom, and the multi-timeframe indicator table beside it. Times are IST.

export const CHART_TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '3h', '4h', '1D', '1W', '1M']
const LONG_TF = new Set(['1D', '1W', '1M'])
const IST = { timeZone: 'Asia/Kolkata', hour12: false }
const pctEl = v => isNum(v) ? <span className={v > 0 ? 'up' : v < 0 ? 'down' : ''}>{v > 0 ? '+' : ''}{v.toFixed(2)}%</span> : '—'
const fix = s => s.replace('Sept', 'Sep')
const istDay = t => fix(new Date(t).toLocaleDateString('en-GB', { ...IST, day: '2-digit', month: 'short' }))
const istHm = t => new Date(t).toLocaleTimeString('en-GB', { ...IST, hour: '2-digit', minute: '2-digit' })
const istMon = t => fix(new Date(t).toLocaleDateString('en-GB', { ...IST, month: 'short', year: 'numeric' }))
const istYear = t => new Date(t).toLocaleDateString('en-GB', { ...IST, year: 'numeric' })
const istFull = t => fix(new Date(t).toLocaleDateString('en-GB', { ...IST, day: '2-digit', month: 'short', year: 'numeric' }))

export function CandleChart({ candles, tf, fmt, onNeedOlder, loadingOlder, height }) {
  const box = useRef(null)
  const [w, setW] = useState(900)
  const [hover, setHover] = useState(null)
  const [off, setOff] = useState(0)        // candles hidden on the right (0 = live end)
  const [span, setSpan] = useState(null)   // candles in view (null = fit the width)
  const drag = useRef(null)
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, Math.round(e.contentRect.width))))
    if (box.current) ro.observe(box.current)
    return () => ro.disconnect()
  }, [])
  const H = Math.max(380, Math.round(height || 0)), VOL = Math.round(H * 0.16), L = 8, R = 72, T = 10, B = 24  // height follows the P&L card beside it
  const len = candles.length
  const n = Math.max(10, Math.min(len, span || Math.floor((w - L - R) / 7)))
  const o = Math.max(0, Math.min(off, len - n))
  const cs = candles.slice(len - o - n, len - o)
  useEffect(() => { if (len - o - n < 20 && onNeedOlder) onNeedOlder() }, [o, n, len])
  const zoom = useRef({ n, len })
  zoom.current = { n, len }
  useEffect(() => {  // non-passive wheel listener so the page doesn't scroll while zooming
    const el = box.current?.querySelector('svg')
    if (!el) return
    const wheel = e => { e.preventDefault(); const z = zoom.current; setSpan(Math.max(20, Math.min(z.len, Math.round(z.n * (e.deltaY > 0 ? 1.15 : 1 / 1.15))))) }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [cs.length > 0])
  if (!cs.length) return null
  const hi = Math.max(...cs.map(c => c.h)), lo = Math.min(...cs.map(c => c.l))
  const pad = (hi - lo) * 0.05 || hi * 0.001
  const yMax = hi + pad, yMin = lo - pad
  const vMax = Math.max(...cs.map(c => c.v)) || 1
  const cw = (w - L - R) / cs.length
  const x = i => L + cw * i + cw / 2
  const y = p => T + (yMax - p) / (yMax - yMin) * (H - VOL - T - B)
  const last = candles[len - 1]
  const ticks = Array.from({ length: 5 }, (_, i) => yMin + (yMax - yMin) * (i + 0.5) / 5)
  const long = LONG_TF.has(tf)
  const fmtT = t => long ? istFull(t) : `${istDay(t)} ${istHm(t)} IST`
  // Period that starts a new axis "section": day (intraday), month (1D), year (1W / 1M).
  const period = t => tf === '1D' ? istMon(t) : long ? istYear(t) : istDay(t)
  const plain = t => tf === '1D' ? istDay(t) : long ? istMon(t) : istHm(t)
  const every = Math.max(1, Math.ceil(cs.length / Math.max(2, Math.floor(w / 80))))
  // Session breaks: the first candle of each new day (intraday timeframes).
  const breaks = long ? [] : cs.map((c, i) => i && istDay(cs[i - 1].t) !== istDay(c.t) ? i : null).filter(i => i != null)
  const axis = []
  cs.forEach((c, i) => {
    if (i && period(cs[i - 1].t) !== period(c.t)) axis.push({ i, text: period(c.t), day: true })
    else if (i % every === 0) axis.push({ i, text: plain(c.t) })
  })
  if (axis.length && !axis.some(a => a.day)) axis[0] = { ...axis[0], text: period(cs[axis[0].i].t), day: true }
  // Keep labels at least ~50px apart: date labels win over time labels, earlier dates over later ones.
  const days = []
  for (const a of axis.filter(a => a.day)) if (!days.length || (a.i - days[days.length - 1].i) * cw >= 50) days.push(a)
  const ticksX = [...days, ...axis.filter(a => !a.day && !days.some(b => Math.abs(b.i - a.i) * cw < 50))]
  const h = hover != null ? cs[hover] : cs[cs.length - 1]
  const chg = h ? (h.c - h.o) / h.o * 100 : null
  const down = e => { drag.current = { x: e.clientX, o }; e.currentTarget.setPointerCapture(e.pointerId) }
  const move = e => {
    const r = e.currentTarget.getBoundingClientRect()
    if (drag.current) { setOff(Math.max(0, drag.current.o + Math.round((e.clientX - drag.current.x) / cw))); setHover(null); return }
    const i = Math.floor((e.clientX - r.left - L) / cw)
    setHover(i >= 0 && i < cs.length ? i : null)
  }
  return <div className="lc-wrap" ref={box}>
    <div className="lc-ohlc small">{h && <><b>{fmtT(h.t)}</b> O {fmt(h.o)} · H {fmt(h.h)} · L {fmt(h.l)} · C <b className={h.c >= h.o ? 'up' : 'down'}>{fmt(h.c)}</b> {pctEl(chg)} · Vol {h.v.toLocaleString('en-US', { maximumFractionDigits: 2 })}</>}
      <span className="lc-nav">{loadingOlder && <span className="muted">loading older candles…</span>}
        {(o > 0 || span) && <button className="btn sm" onClick={() => { setOff(0); setSpan(null) }} title="Back to the latest candles">Latest ⟶</button>}</span></div>
    <svg width={w} height={H} className={'lc' + (drag.current ? ' dragging' : '')} onPointerDown={down} onPointerMove={move}
      onPointerUp={() => { drag.current = null }} onPointerLeave={() => { if (!drag.current) setHover(null) }}
      onDoubleClick={() => { setOff(0); setSpan(null) }}>
      {ticks.map((p, i) => <g key={i}><line x1={L} x2={w - R} y1={y(p)} y2={y(p)} className="lc-grid" /><text x={w - R + 6} y={y(p) + 4} className="lc-ax">{fmt(p)}</text></g>)}
      {breaks.map(i => <line key={'s' + cs[i].t} x1={x(i) - cw / 2} x2={x(i) - cw / 2} y1={T} y2={H - B} className="lc-session"><title>New session · {istDay(cs[i].t)}</title></line>)}
      {ticksX.map(a => <text key={'t' + cs[a.i].t} x={x(a.i) < L + 24 ? L : x(a.i)} y={H - 6} className={'lc-ax' + (a.day ? ' lc-day' : '')} textAnchor={x(a.i) < L + 24 ? 'start' : 'middle'}>{a.text}</text>)}
      {cs.map((c, i) => {
        const up = c.c >= c.o, bw = Math.max(1, cw * 0.65)
        return <g key={c.t} className={up ? 'lc-up' : 'lc-dn'}>
          <rect x={x(i) - bw / 2} y={H - B - c.v / vMax * VOL} width={bw} height={c.v / vMax * VOL} className="lc-vol" />
          <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} />
          <rect x={x(i) - bw / 2} y={y(Math.max(c.o, c.c))} width={bw} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} />
        </g>
      })}
      {hover != null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="lc-cross" />}
      {last && last.c <= yMax && last.c >= yMin && <g><line x1={L} x2={w - R} y1={y(last.c)} y2={y(last.c)} className={'lc-last ' + (last.c >= last.o ? 'up' : 'down')} />
        <rect x={w - R + 2} y={y(last.c) - 9} width={R - 4} height={18} rx="3" className={'lc-tag ' + (last.c >= last.o ? 'up' : 'down')} />
        <text x={w - R + 6} y={y(last.c) + 4} className="lc-tag-t">{fmt(last.c)}</text></g>}
    </svg>
  </div>
}

// Indicator table: timeframes as rows, indicators as columns; each value coloured by its trend
// (green = up, red = down, black = neutral).
const IND_ROWS = [['vwap', 'VWAP'], ['ema5', 'EMA 5'], ['ema9', 'EMA 9'], ['st', 'ST'], ['rsi', 'RSI'], ['adx', 'ADX'], ['dip', 'DI +'], ['dim', 'DI −']]
const indTone = (t, k) => {
  const v = t[k]
  if (!isNum(v)) return ''
  if (k === 'vwap' || k === 'ema5' || k === 'ema9') return t.close > v ? 'up' : 'down'
  if (k === 'st') return t.st_dir === 1 ? 'up' : 'down'
  if (k === 'rsi') return v > 60 ? 'up' : v < 40 ? 'down' : ''
  if (k === 'adx') return v > 25 ? (t.dip > t.dim ? 'up' : 'down') : ''  // strong trend, in the DI direction
  if (k === 'dip') return t.dip > t.dim ? 'up' : ''
  if (k === 'dim') return t.dim > t.dip ? 'down' : ''
  return ''
}

export function IndTable({ url, sym, fmtShort, source }) {
  const res = usePoll(() => api(url), 20000, [url])
  const d = res.data && res.data.symbol === sym ? res.data : null
  if (!d) return <div className="ind-tbl muted small">{res.error || `Loading indicators for ${sym}…`}</div>
  const fmt = (k, v) => !isNum(v) ? '—' : ['rsi', 'adx', 'dip', 'dim'].includes(k) ? v.toFixed(1) : fmtShort(v)
  return <div className="ind-tbl"><div className="tbl-wrap"><table className="tbl compact">
    <thead><tr><th>TF</th>{IND_ROWS.map(([k, l]) => <th key={k} className="num">{l}</th>)}</tr></thead>
    <tbody>{d.tfs.map(tf => { const t = d.rows[tf]
      return <tr key={tf}><td className="strong">{tf}</td>
        {IND_ROWS.map(([k]) => <td key={k} className={'num ind-v ' + (t ? indTone(t, k) : '')}>{t ? fmt(k, t[k]) : '—'}</td>)}</tr> })}</tbody>
  </table></div><div className="muted small">Green = up, red = down, black = neutral. VWAP / EMA: price above = up · ST = Supertrend direction · RSI &gt; 60 up, &lt; 40 down · ADX &gt; 25 = strong trend, coloured by the DI direction · DI+ / DI−: the higher line. VWAP resets each day (intraday), week (1D), month (1W), year (1M). {source}. Updated {istTime(d.fetched_at)} IST.</div></div>
}

// Type-to-filter picker: typing R lists symbols starting with R, RE narrows to RE…, then company
// names starting with the text (e.g. "Tata"). Arrow keys + Enter or click to pick, Esc to close.
function SymbolPicker({ opts, value, onPick, label }) {
  const [q, setQ] = useState(null)  // null = closed
  const [hi, setHi] = useState(0)
  const box = useRef(null)
  useEffect(() => {
    if (q == null) return
    const out = e => { if (box.current && !box.current.contains(e.target)) setQ(null) }
    document.addEventListener('pointerdown', out)
    return () => document.removeEventListener('pointerdown', out)
  }, [q != null])
  const cur = opts.find(o => o.symbol === value)
  const qq = (q || '').trim().toUpperCase()
  const list = q == null ? [] : !qq ? opts.slice(0, 80)
    : [...opts.filter(o => o.symbol.startsWith(qq)), ...opts.filter(o => !o.symbol.startsWith(qq) && (o.name || '').toUpperCase().startsWith(qq))].slice(0, 80)
  const pick = o => { onPick(o.symbol); setQ(null) }
  const key = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, list.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { if (list[hi]) { pick(list[hi]); e.target.blur() } }
    else if (e.key === 'Escape') { setQ(null); e.target.blur() }
  }
  return <div className="sym-pick" ref={box}>
    <input className="coin-pick" aria-label={label} placeholder={`Type a ${label.toLowerCase()}…`}
      value={q ?? (value + (cur?.name ? ' · ' + cur.name : ''))}
      onFocus={e => { setQ(''); setHi(0); e.target.select() }} onChange={e => { setQ(e.target.value); setHi(0) }} onKeyDown={key} />
    {q != null && <ul className="sym-list" role="listbox">
      {list.length ? list.map((o, i) => <li key={o.symbol} role="option" aria-selected={i === hi} className={(i === hi ? 'hi ' : '') + (o.symbol === value ? 'cur' : '')}
        onPointerDown={e => { e.preventDefault(); pick(o) }} onPointerEnter={() => setHi(i)}>
        <b>{o.symbol}</b>{o.name && <span className="muted"> · {o.name}</span>}</li>)
        : <li className="muted">No match for “{q}”</li>}
      {!qq && opts.length > 80 && <li className="muted small">Type to narrow down the {opts.length} {label.toLowerCase()}s…</li>}
    </ul>}
  </div>
}

// Chart page body: symbol dropdown + timeframe buttons + chart + indicator table.
// candlesUrl(sym, tf, before?) / indUrl(sym) build the API calls; fallback(d) marks data without
// older history or indicators (crypto coins charted from CoinGecko).
export function ChartView({ prefix, opts, sym, onPick, candlesUrl, indUrl, fmt, fmtShort, pollMs, sourceLine, indSource, head, note, fallback = () => false, label = 'Symbol', bias, biasName = 'Market Bias', optNote, chainUrl, premFmt, optMarket }) {
  // Option chain for the strategy card and the payoff calculator (symbols with listed options only).
  const cUrl = chainUrl ? chainUrl(sym) : null
  const chain = usePoll(() => cUrl ? api(cUrl) : Promise.resolve(null), 60000, [cUrl])
  const cd = cUrl && chain.data && chain.data.ccy === sym ? chain.data : null
  const exp = cd?.expiries?.find(e => e.chain?.length)
  const [loadReq, setLoadReq] = useState(null)
  const loadSpec = spec => { setLoadReq(r => ({ spec, n: (r?.n || 0) + 1 })); setTimeout(() => document.getElementById('payoff-calc')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50) }
  if (optMarket) setMoney(optMarket)
  const [tfRaw, setTf] = useSessionState(prefix + '.tf', '5m')
  const tf = CHART_TFS.includes(tfRaw) ? tfRaw : tfRaw === '1d' ? '1D' : '5m'
  const res = usePoll(() => api(candlesUrl(sym, tf)), pollMs, [sym, tf])
  const d = res.data && res.data.symbol === sym && res.data.tf === tf ? res.data : null
  // The candle chart takes the height of the Trade P&L card beside it (side-by-side layout only).
  const [sideH, setSideH] = useState(null)
  const roRef = useRef(null)
  const sideRef = el => {  // callback ref: starts measuring whenever the card mounts
    roRef.current?.disconnect()
    if (!el) return
    roRef.current = new ResizeObserver(() => {
      const top = el.parentElement
      const sideBySide = top && Math.abs(el.getBoundingClientRect().top - top.getBoundingClientRect().top) < 5
      setSideH(sideBySide ? Math.round(el.getBoundingClientRect().height) : null)
    })
    roRef.current.observe(el)
  }
  const key = sym + '|' + tf
  const [older, setOlder] = useState({ key, rows: [], end: false, loading: false })
  const hist = older.key === key ? older : { key, rows: [], end: false, loading: false }
  const cs = useMemo(() => {
    const latest = d?.candles || []
    const first = latest[0]?.t ?? Infinity
    return [...hist.rows.filter(c => c.t < first), ...latest]
  }, [d, hist.rows])
  const fb = d && fallback(d)
  const loadOlder = () => {
    if (fb || hist.loading || hist.end || !cs.length) return
    const before = cs[0].t
    setOlder({ ...hist, loading: true })
    api(candlesUrl(sym, tf, before))
      .then(r => setOlder(o => o.key !== key && o.key !== hist.key ? o : { key, rows: [...(r.candles || []).filter(c => c.t < before), ...hist.rows], end: !!r.end, loading: false }))
      .catch(() => setOlder(o => ({ ...o, loading: false })))
  }
  const last = cs[cs.length - 1]
  return <div className="clive">
    <div className="toolbar">
      <SymbolPicker opts={opts} value={sym} onPick={onPick} label={label} />
      <Seg value={tf} onChange={setTf} options={CHART_TFS.map(v => ({ value: v, label: v }))} />
      {d && <span className="muted small">{sourceLine(d)} · updated {istTime(d.fetched_at)} IST{d.stale ? ' · showing last good data' : ''}</span>}
    </div>
    {!d ? <Empty>{res.error || `Loading ${sym} candles…`}</Empty> : <>
      <div className="lc-head"><span className="lc-px">{fmt(last?.c)}</span>{head}</div>
      <div className="lc-top">  {/* candle chart | trade P&L calculator */}
        <CandleChart key={key} candles={cs} tf={tf} fmt={fmt} onNeedOlder={loadOlder} loadingOlder={hist.loading} height={sideH ? sideH - 32 : null} />
        <div ref={sideRef} className="lc-top-side">
        {(() => { const ap = atmPremium(exp, bias); const lot = cd?.lot || cd?.contract || optMarket?.lot || 1
          return <PnlCalc id={prefix + ':' + sym} name={sym} lot={lot} buy={ap?.price ?? (isNum(last?.c) ? +last.c.toFixed(2) : '')} buyLabel={ap ? ap.label : 'last price'} /> })()}
        </div>
      </div>
      <div className="muted small">Drag the chart left / right to move through time (older candles load as you go) · scroll to zoom · double-click or “Latest” to return · dashed lines = new session (day). Hover a candle for its open / high / low / close. Times in IST.{note ? ' ' + note : ''}</div>
      <div className="lc-cards">
        <section className="lc-card"><div className="lc-card-h"><h3>Indicators</h3><span className="muted small">{sym} · 1m … 1M</span></div>
          {!fb && indUrl ? <IndTable url={indUrl(sym)} sym={sym} fmtShort={fmtShort} source={indSource} /> : <div className="muted small">No indicator data for {sym} (not on OKX).</div>}</section>
        <StrategyCard prefix={prefix} bias={bias} biasName={biasName} sym={sym} optNote={optNote} hasChain={!!cUrl} chainErr={chain.error} d={cd} exp={exp} onLoad={loadSpec} fmt={premFmt || fmt} />
      </div>
      {exp && optMarket && <div className="lc-calc">
        <OptionTools key={sym + exp.code} d={cd} exp={exp} market={optMarket} bias={bias ? { label: bias } : null} only="calc" loadReq={loadReq} />
      </div>}
    </>}
  </div>
}

// Strategy explainer card: what option sellers (left) and buyers (right) typically use for a market
// view, with the strikes from the live option chain where the symbol has options (nearest expiry;
// same rules as Index Options: sellers sell the 3rd out-of-the-money strike and hedge with a further
// strike costing about 10% of the sold premium). Follows the bias until the user picks a view.
// Educational, not a recommendation.
function StrategyCard({ prefix, bias, biasName, sym, optNote, hasChain, chainErr, d, exp, onLoad, fmt }) {
  const [pick, setPick] = useSessionState(prefix + '.view', null)
  const biasView = BIAS_VIEW[bias]
  const view = pick || biasView || 'bull'
  const v = VIEWS[view]
  const ref = useMemo(() => exp ? refStrikes(exp) : null, [exp])
  const legsFor = spec => spec.map(([type, side, at]) => { const l = { type, side, k: ref[at], at }; return { ...l, prem: legPrice(exp.chain, l) } })
  const groups = [['sell', 'For option sellers', 'credit — you collect the premium; loss capped by the hedge leg'],
                  ['buy', 'For option buyers', 'debit — you pay the premium; risk limited to what you pay']]
  return <section className="lc-card strat-card">
    <div className="lc-card-h"><h3>Strategy explainer</h3>
      <span className="muted small">{pick ? 'your view' : bias ? `following the ${biasName} (${bias})` : 'pick a view'}{exp ? ` · strikes from the ${exp.expiry_ist.split(',')[0]} expiry, spot ${fmt(d.spot)}` : ''}</span></div>
    <div className="toolbar">
      <div className="seg">{Object.entries(VIEWS).map(([k, x]) => <button key={k} className={(view === k ? 'on ' : '') + (x.tone || '')} onClick={() => setPick(k === biasView ? null : k)}>{x.label}</button>)}</div>
      {hasChain && !d && <span className="muted small">{chainErr ? 'Option chain unavailable right now' : 'Loading option chain…'}</span>}
    </div>
    {exp && <div className="lc-chain-stats">
      <span>Expiry <b>{exp.expiry_ist.split(',')[0]}</b> <span className="muted">({exp.days < 1 ? Math.round(exp.days * 24) + 'h' : exp.days.toFixed(1) + ' days'})</span></span>
      <span title="At-the-money implied volatility">ATM IV <b>{isNum(exp.atm_iv) ? exp.atm_iv.toFixed(1) + '%' : '—'}</b></span>
      <span title="±1 standard deviation move to expiry implied by ATM IV">Expected move <b>±{fmt(exp.move)}</b> <span className="muted">({isNum(exp.move_pct) ? exp.move_pct + '%' : '—'})</span></span>
      <span title="Put OI ÷ Call OI">PCR <b className={exp.pcr_oi >= 1 ? 'down' : exp.pcr_oi <= 0.7 ? 'up' : ''}>{exp.pcr_oi ?? '—'}</b></span>
      <span title="Expiry price at which option buyers lose the most">Max pain <b>{fmt(exp.max_pain)}</b> <span className="muted">({isNum(exp.max_pain_pct) ? (exp.max_pain_pct > 0 ? '+' : '') + exp.max_pain_pct + '%' : '—'})</span></span>
      <span>ATM strike <b>{fmt(ref?.atm)}</b></span>
    </div>}
    <div className="lc-strat-groups">{groups.map(([k, title, sub]) => {
      const list = v.list.filter(x => (k === 'buy') === BUYER.has(x[0]))
      const fit = FIT[k][view]?.normal
      return <div key={k} className={'lc-strat-group ' + k}>
        <div className="lc-strat-gh"><b>{title}</b> <span className="muted small">{sub}</span></div>
        {list.length ? <div className="lc-strat-list">{list.map(([name, why, spec]) => {
          const ls = ref ? legsFor(spec) : []
          const sold = ls.find(l => l.side === 'sell')
          return <div key={name} className={'lc-strat' + (name === fit ? ' fit' : '')}>
            {name === fit && <span className="fit-badge">✓ Typical for this view</span>}
            <div className="strat-h"><b className="lc-strat-name">{name}</b>{ref && <button className="btn sm" onClick={() => onLoad(spec)}>Open in calculator ↓</button>}</div>
            <div className="muted small">{why}</div>
            {ls.length > 0 && <div className="strat-legs">{ls.map((l, i) => {
              const tag = l.at === 'c3' || l.at === 'p3' ? ' · 3rd OTM' : sold && sold.prem && l.side === 'buy' && (l.at === 'ch' || l.at === 'ph') ? ` · ${Math.round(l.prem / sold.prem * 100)}% of sold` : l.at === 'atm' ? ' · ATM' : ''
              return <span key={i} className={'leg ' + l.side}>{l.side === 'buy' ? 'Buy' : 'Sell'} {fmt(l.k)} {l.type === 'C' ? 'call' : 'put'} @ {isNum(l.prem) ? fmt(l.prem) : '—'}{tag}</span>
            })}</div>}
          </div>
        })}</div> : <div className="muted small">{NONE[k]}</div>}
      </div>
    })}</div>
    <div className="muted small">{v.label} view on {sym}. {optNote || ''} Premiums are per unit (sells at the bid, buys at the ask). Strategies explained for learning — not a buy/sell recommendation.</div>
  </section>
}

// Trade P&L calculator for one instrument (the stock / coin on the Live Chart, or Nifty 50 / Sensex
// on Index Options). Quantity defaults to the exchange lot size and the buy price to the at-the-money
// option premium (put when the bias is bearish, call otherwise); risk : reward defaults to 1:5 (1% stop-loss, 5% target) — all
// editable. Total buy = buy price × quantity × lots; sell price = buy price × (1 + target %);
// P&L = (sell − buy) × quantity × lots.
const n2 = v => isNum(v) ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'
const PNL_STORE = new Map()  // per instrument, kept for the visit

export function atmPremium(exp, bias) {
  if (!exp?.chain?.length) return null
  const ref = refStrikes(exp)
  const side = bias === 'BEARISH' ? 'put' : 'call'
  const q = exp.chain.find(r => r.k === ref.atm)?.[side] || {}
  const p = q.ask || q.mark
  return isNum(p) ? { price: +p.toFixed(2), label: `ATM ${ref.atm.toLocaleString('en-IN')} ${side} (ask)` } : null
}

const RR = [1, 2, 3, 5]  // 1:N = 1% stop-loss, N% target

export function PnlCalc({ id, name, lot, buy, buyLabel }) {
  const fresh = () => ({ buy: buy ?? '', qty: lot || 1, lots: 1, sl: 1, tgt: 5, edited: false })  // default 1:5
  const [c, setC] = useState(() => PNL_STORE.get(id) || fresh())
  useEffect(() => { setC(PNL_STORE.get(id) || fresh()) }, [id])
  // follow the live default (lot size / ATM premium) until the user edits a field
  useEffect(() => { if (!c.edited) setC(x => ({ ...x, buy: buy ?? x.buy, qty: lot || x.qty })) }, [buy, lot])
  useEffect(() => { PNL_STORE.set(id, c) }, [id, c])
  const set = patch => setC(x => ({ ...x, ...patch, edited: true }))
  const num = v => v === '' ? '' : Number(v)
  const b = Number(c.buy) || 0, tg = Number(c.tgt) || 0, sl = Number(c.sl) || 0
  const ratio = sl === 1 && RR.includes(tg) ? tg : null  // which 1:N button is on (else Custom)
  const units = (Number(c.qty) || 0) * (Number(c.lots) || 0)
  const sell = b * (1 + tg / 100), slPx = b * (1 - sl / 100)
  const totBuy = b * units, totSell = sell * units, pnl = totSell - totBuy, slLoss = (slPx - b) * units
  const inp = (k, step = 'any') => <input type="number" step={step} value={c[k]} onChange={e => set({ [k]: num(e.target.value) })} />
  const pctIn = k => <input type="number" step="0.5" min="0" value={c[k]} onChange={e => set({ [k]: num(e.target.value) })} />  // same box size as the other inputs
  return <section className="lc-card pnl-calc">
    <div className="lc-card-h"><h3>Trade P&amp;L · {name}</h3>
      {c.edited && <button className="btn sm" onClick={() => setC(fresh())}>Reset</button>}</div>
    <div className="seg rr-seg" title="Risk : reward — 1:3 means 1% stop-loss and 3% profit">
      {RR.map(n => <button key={n} className={ratio === n ? 'on' : ''} onClick={() => set({ sl: 1, tgt: n })}>1:{n}</button>)}
      <button className={ratio == null ? 'on' : ''} onClick={() => set({})} title="Set your own stop-loss % and target % below">Custom</button>
    </div>
    <table className="pnl-tbl"><tbody>
      <tr><td>Buy price {buyLabel && !c.edited && <div className="muted small">{buyLabel}</div>}</td><td>{inp('buy')}</td></tr>
      <tr><td>Quantity <span className="muted">(lot size{lot ? ' ' + lot : ''})</span></td><td>{inp('qty', 1)}</td></tr>
      <tr><td>Lots</td><td>{inp('lots', 1)}</td></tr>
      <tr className="calc-row"><td>Total buy</td><td>{n2(totBuy)}</td></tr>
      <tr><td>Stop-loss <span className="muted">(%)</span></td><td>{pctIn('sl')}</td></tr>
      <tr><td>SL price</td><td><input type="number" step="any" value={+slPx.toFixed(2)} onChange={e => b && set({ sl: +((1 - (Number(e.target.value) || 0) / b) * 100).toFixed(2) })} /></td></tr>
      <tr className="calc-row"><td>Loss at SL</td><td className={slLoss < 0 ? 'down' : ''}>{n2(slLoss)}</td></tr>
      <tr><td>Target profit <span className="muted">(%)</span></td><td>{pctIn('tgt')}</td></tr>
      <tr><td>Sell price</td><td><input type="number" step="any" value={+sell.toFixed(2)} onChange={e => b && set({ tgt: +(((Number(e.target.value) || 0) / b - 1) * 100).toFixed(2) })} /></td></tr>
      <tr className="calc-row"><td>Total sell</td><td>{n2(totSell)}</td></tr>
      <tr className="calc-row big"><td>P&amp;L at target</td><td className={pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}>{pnl > 0 ? '+' : ''}{n2(pnl)}</td></tr>
    </tbody></table>
    <div className="muted small">1:N = 1% stop-loss and N% target on the buy price (Custom: set your own). SL / sell price = buy price − SL % / + target % (edit either). Total = price × quantity × lots. Your numbers, not a recommendation.</div>
  </section>
}
