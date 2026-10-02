import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Drawer, Empty, Pct, Seg, SortTh, StockLink } from './components.jsx'
import { api, fmtNum, fmtPct, fmtPrice, fmtRatio, fmtVol, hhmmTo12, isNum, sessionLabel, sortRows, tone, tvStock, useSessionState } from './lib.js'

// Defaults = the qualification rule: volume-confirmed (> 1.0x) and still
// beyond the range. Relax either filter to see every stock that broke today.
export const DEFAULT_FILTERS = {
  vol: 1, volBasis: 'now', breakTime: 'any', from: '09:30', to: '15:30', maxDist: 'any',
  chgMin: '', chgMax: '', priceMin: '', priceMax: '', mcap: 'any', universe: 'fo', holdingOnly: true, search: '',
}
const DEFAULT_SORT = { key: 'break_min', dir: 'desc' }
const num = v => v === '' || v == null ? null : Number(v)

const ratioOf = (r, basis) => basis === 'now' ? r.vol_ratio_now : r.vol_ratio
// NSE publishes no intraday volume history; the app records its own. Until a
// baseline exists for the chosen basis, the volume filter is paused (and the
// UI says so) instead of silently hiding every signal.
export const volumeAvailable = (rows, basis) => rows.some(r => isNum(ratioOf(r, basis)))
const MCAP = { large: [50000, Infinity], mid: [10000, 50000], small: [0, 10000] }

export function filterRows(rows, f, selected) {
  const filters = { ...DEFAULT_FILTERS, ...f }
  const volOn = filters.vol !== 'all' && volumeAvailable(rows, filters.volBasis)
  const chgMin = num(filters.chgMin), chgMax = num(filters.chgMax), pMin = num(filters.priceMin), pMax = num(filters.priceMax)
  const q = filters.search.trim().toUpperCase()
  return rows.filter(r => {
    if (selected.length && !r.sectors.some(s => selected.includes(s))) return false
    if (volOn && !(ratioOf(r, filters.volBasis) > filters.vol)) return false
    if (filters.breakTime === 'custom') { if (r.break_time < filters.from || r.break_time > filters.to) return false }
    else if (filters.breakTime !== 'any' && !(r.age_min <= Number(filters.breakTime))) return false
    if (filters.maxDist !== 'any' && !(r.distance_pct < filters.maxDist)) return false
    if (chgMin != null && !(r.pct_prev >= chgMin)) return false
    if (chgMax != null && !(r.pct_prev <= chgMax)) return false
    if (pMin != null && !(r.ltp >= pMin)) return false
    if (pMax != null && !(r.ltp <= pMax)) return false
    if (filters.mcap !== 'any') { const [a, b] = MCAP[filters.mcap]; if (!(r.ffmc_cr >= a && r.ffmc_cr < b)) return false }
    if (filters.universe !== 'all' && !r[filters.universe]) return false
    if (filters.holdingOnly && !r.holding) return false
    if (q && !r.symbol.includes(q) && !r.company.toUpperCase().includes(q)) return false
    return true
  })
}

function SectorMulti({ sectors, selected, setSelected }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const close = e => ref.current && !ref.current.contains(e.target) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const label = Object.fromEntries(sectors.map(s => [s.symbol, s.label]))
  const toggle = sym => setSelected(s => s.includes(sym) ? s.filter(x => x !== sym) : [...s, sym])
  const pos = sectors.filter(s => s.quote?.pct_open > 0).map(s => s.symbol)
  const neg = sectors.filter(s => s.quote?.pct_open < 0).map(s => s.symbol)
  return <div className="multi" ref={ref}>
    <div className="multi-box" onClick={() => setOpen(o => !o)} role="button" tabIndex={0} aria-expanded={open}
      onKeyDown={e => e.key === 'Enter' && setOpen(o => !o)}>
      <span className="k">Sector</span>
      {selected.length ? selected.map(sym => <span className="tag" key={sym}>{label[sym] || sym}
        <button onClick={e => { e.stopPropagation(); toggle(sym) }} aria-label={`Remove ${sym}`}>×</button></span>)
        : <span className="muted">All Sectors</span>}
      <span className="caret">▾</span>
    </div>
    {open && <div className="multi-pop">
      <div className="multi-actions">
        <button className="btn sm" onClick={() => setSelected([])}>All Sectors</button>
        <button className="btn sm" onClick={() => setSelected(sectors.map(s => s.symbol))}>Select All</button>
        <button className="btn sm" onClick={() => setSelected([])}>Clear</button>
        <button className="btn sm" onClick={() => setSelected(pos)}>Positive Sectors</button>
        <button className="btn sm" onClick={() => setSelected(neg)}>Negative Sectors</button>
      </div>
      <div className="multi-list">{sectors.map(s => <label key={s.symbol} className="multi-opt">
        <input type="checkbox" checked={selected.includes(s.symbol)} onChange={() => toggle(s.symbol)} />
        <span>{s.label}</span><Pct v={s.quote?.pct_open} />
      </label>)}</div>
      <div className="muted small">Synced with the Sector Heatmap selection · % vs today's open</div>
    </div>}
  </div>
}

function Filters({ f, setF, tf, setTf, confirm3, setConfirm3, reset }) {
  const set = (k, v) => setF(x => ({ ...x, [k]: v }))
  return <div className="filters">
    <label>Volume Ratio<select value={f.vol} onChange={e => set('vol', e.target.value === 'all' ? 'all' : Number(e.target.value))}>
      <option value="all">All</option><option value={1}>&gt; 1.0x</option><option value={1.25}>&gt; 1.25x</option><option value={1.5}>&gt; 1.5x</option><option value={2}>&gt; 2.0x</option>
    </select></label>
    <label title="At break: cumulative volume to the break time vs the average to the same clock time over sessions this app recorded (max 5). Session so far: during market hours, volume so far vs recorded sessions to the same time; after the close, full-day volume vs the 5-day average from NSE bhavcopies.">Volume Basis<select value={f.volBasis} onChange={e => set('volBasis', e.target.value)}>
      <option value="break">At break time (recorded)</option><option value="now">Session so far / full day</option>
    </select></label>
    <label>Break Time<select value={f.breakTime} onChange={e => set('breakTime', e.target.value)}>
      <option value="any">Any Time</option><option value="15">Last 15 Minutes</option><option value="30">Last 30 Minutes</option><option value="60">Last 60 Minutes</option><option value="custom">Custom Time</option>
    </select></label>
    {f.breakTime === 'custom' && <label>From / To<span className="pair">
      <input type="time" value={f.from} min="09:30" max="15:30" onChange={e => set('from', e.target.value)} />
      <input type="time" value={f.to} min="09:30" max="15:30" onChange={e => set('to', e.target.value)} /></span></label>}
    <label>Max Distance From ORB<select value={f.maxDist} onChange={e => set('maxDist', e.target.value === 'any' ? 'any' : Number(e.target.value))}>
      <option value="any">Any</option><option value={0.25}>&lt; 0.25%</option><option value={0.5}>&lt; 0.50%</option><option value={1}>&lt; 1.00%</option><option value={2}>&lt; 2.00%</option>
    </select></label>
    <label>Price Change % <span className="pair">
      <input type="number" step="0.1" placeholder="min" value={f.chgMin} onChange={e => set('chgMin', e.target.value)} />
      <input type="number" step="0.1" placeholder="max" value={f.chgMax} onChange={e => set('chgMax', e.target.value)} /></span></label>
    <label>Price Range ₹<span className="pair">
      <input type="number" placeholder="min" value={f.priceMin} onChange={e => set('priceMin', e.target.value)} />
      <input type="number" placeholder="max" value={f.priceMax} onChange={e => set('priceMax', e.target.value)} /></span></label>
    <label title="Free-float market capitalisation from NSE">Market Cap (free float)<select value={f.mcap} onChange={e => set('mcap', e.target.value)}>
      <option value="any">Any</option><option value="large">≥ ₹50,000 Cr</option><option value="mid">₹10,000–50,000 Cr</option><option value="small">&lt; ₹10,000 Cr</option>
    </select></label>
    <label>Universe<select value={f.universe} onChange={e => set('universe', e.target.value)}>
      <option value="all">All scanned</option><option value="fo">F&O Only</option><option value="n50">Nifty 50 Only</option><option value="n100">Nifty 100 Only</option><option value="n200">Nifty 200 Only</option>
    </select></label>
    <label title="Break candle: the first 5- or 15-min candle (aligned to the end of the opening range) that closes beyond it.">Confirm Candle<select value={tf} onChange={e => setTf(Number(e.target.value))}>
      <option value={5}>5 min close</option><option value={15}>15 min close</option>
    </select></label>
    <label title="After the break candle, the next 3-min candle must confirm. Beyond break close: it closes higher than the break candle's close (breakout) / lower (breakdown). Beyond OR level: it just closes beyond the opening range. A failed confirmation rejects that break and the scanner waits for the next one.">3-min Confirmation<select value={Number(confirm3)} onChange={e => setConfirm3(Number(e.target.value))}>
      <option value={1}>Beyond break close</option><option value={2}>Beyond OR level</option><option value={0}>Off</option>
    </select></label>
    <label className="check-label"><input type="checkbox" checked={f.holdingOnly} onChange={e => set('holdingOnly', e.target.checked)}  title="Hide stocks whose price has fallen back inside the opening range after breaking it" />Still beyond range</label>
    <button className="btn sm" onClick={reset}>Reset Filters</button>
  </div>
}

function Fresh({ row, live }) {
  if (!isNum(row.age_min)) return <span className="muted">N/A</span>
  const age = Math.max(0, Math.floor(row.age_min))
  if (live && age <= 15) return <span className="fresh-new"><b>NEW</b> {age} min ago</span>
  return <span className="muted">{age} min{live ? ' ago' : ''}</span>
}

function IntradayChart({ data, extra }) {  // extra: optional 15-min range {or_high, or_low}
  const c = data?.candles || []
  if (!c.length) return <Empty>No candles.</Empty>
  const sig = data.signal
  const W = 640, H = 300, PH = 210, VH = 60, L = 8, R = 84, T = 8
  const cw = (W - L - R) / Math.max(c.length, 1)
  const hi = Math.max(...c.map(x => x.h), sig?.or_high ?? -Infinity, extra?.or_high ?? -Infinity)
  const lo = Math.min(...c.map(x => x.l), sig?.or_low ?? Infinity, extra?.or_low ?? Infinity)
  const pad = (hi - lo) * 0.06 || 1
  const y = v => T + (hi + pad - v) / (hi - lo + 2 * pad) * (PH - T)
  const vmax = Math.max(0, ...c.map(x => x.v || 0)) || 1
  const x = i => L + i * cw + cw / 2
  const orEnd = c.findIndex(k => k.m >= (data.or_end_min ?? 615))
  // The confirming bar closes at break_min; mark the last 5-minute candle inside it.
  const brkI = sig ? c.reduce((best, k, i) => k.m < sig.break_min ? i : best, -1) : -1
  const ticks = c.map((k, i) => [k, i]).filter(([k]) => k.m % 60 === 15)
  const or15End = extra ? c.findIndex(k => k.m >= 570) : -1
  // Right-hand price labels, nudged apart so nearby levels never overlap.
  const labels = []
  if (sig) labels.push({ v: sig.or_high, t: `ORH ${fmtNum(sig.or_high)}`, cls: 'up' }, { v: sig.or_low, t: `ORL ${fmtNum(sig.or_low)}`, cls: 'down' })
  if (extra) labels.push({ v: extra.or_high, t: `15m H ${fmtNum(extra.or_high)}`, cls: 'or15' }, { v: extra.or_low, t: `15m L ${fmtNum(extra.or_low)}`, cls: 'or15' })
  const near = v => labels.some(l => Math.abs(y(l.v) - y(v)) < 12)
  if (!near(hi)) labels.push({ v: hi, t: fmtNum(hi), cls: '' })
  if (!near(lo)) labels.push({ v: lo, t: fmtNum(lo), cls: '' })
  labels.sort((a, b) => y(a.v) - y(b.v))
  let lastY = -Infinity
  for (const l of labels) { l.y = Math.max(y(l.v) + 4, lastY + 11); lastY = l.y }
  return <svg viewBox={`0 0 ${W} ${H}`} className="ichart" role="img" aria-label="Intraday 5-minute chart with opening range">
    {orEnd > 0 && <rect x={L} y={T} width={orEnd * cw} height={PH - T} className={(data.or_end_min ?? 615) <= 570 ? 'or-zone15' : 'or-zone'} />}
    {or15End > 0 && <rect x={L} y={T} width={or15End * cw} height={PH - T} className="or-zone15" />}
    {sig && <>
      <line x1={L} x2={W - R} y1={y(sig.or_high)} y2={y(sig.or_high)} className="or-line hi" />
      <line x1={L} x2={W - R} y1={y(sig.or_low)} y2={y(sig.or_low)} className="or-line lo" />
    </>}
    {extra && <>
      <line x1={L} x2={W - R} y1={y(extra.or_high)} y2={y(extra.or_high)} className="or-line or15" />
      <line x1={L} x2={W - R} y1={y(extra.or_low)} y2={y(extra.or_low)} className="or-line or15" />
    </>}
    {labels.map(l => <text key={l.t} x={W - R + 4} y={l.y} className={'axis-t ' + l.cls}>{l.t}</text>)}
    {c.map((k, i) => {
      const up = k.c >= k.o
      return <g key={k.m} className={up ? 'cu' : 'cd'}>
        <line x1={x(i)} x2={x(i)} y1={y(k.h)} y2={y(k.l)} />
        <rect x={x(i) - cw * 0.35} width={Math.max(cw * 0.7, 1)} y={y(Math.max(k.o, k.c))} height={Math.max(Math.abs(y(k.o) - y(k.c)), 0.8)} />
        {isNum(k.v) && <rect className="vbar" x={x(i) - cw * 0.35} width={Math.max(cw * 0.7, 1)} y={H - 18 - k.v / vmax * VH} height={k.v / vmax * VH} />}
      </g>
    })}
    {(sig?.rejected || []).map(r => {
      const i = c.reduce((best, k, j) => k.m < r.min ? j : best, -1)
      return i >= 0 && <circle key={r.min} cx={x(i)} cy={y(r.price)} r="4" className="rej-dot"><title>Rejected break {r.time}: close {fmtNum(r.price)}, 3-min close {fmtNum(r.confirm_close)}</title></circle>
    })}
    {sig && brkI >= 0 && <>
      <line x1={x(brkI) + cw / 2} x2={x(brkI) + cw / 2} y1={T} y2={H - 18} className="brk-line" />
      <circle cx={x(brkI)} cy={y(sig.break_price)} r="4.5" className={'brk-dot ' + (sig.signal === 'BREAKOUT' ? 'up' : 'down')} />
      <text x={Math.min(x(brkI) + cw / 2 + 4, W - R - 70)} y={T + 12} className="axis-t strong">{sig.signal === 'BREAKOUT' ? '▲' : '▼'} {sig.break_time}</text>
    </>}
    {ticks.map(([k, i]) => <text key={k.m} x={x(i)} y={H - 4} className="axis-t" textAnchor="middle">{k.t}</text>)}
    <text x={L + 2} y={PH + 12} className="axis-t">{c.some(k => isNum(k.v)) ? 'Volume (5m, recorded)' : 'Volume not recorded for this session'}</text>
  </svg>
}

function SignalDrawer({ row, tf, confirm3, orm, onClose }) {
  const orEndTxt = orm === 15 ? '09:30' : '10:15'
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!row) return
    let alive = true
    const load = () => api(`/api/orb/candles?symbol=${encodeURIComponent(row.symbol)}&tf=${tf}&confirm=${Number(confirm3)}&orm=${orm}`).then(d => alive && (setData(d), setErr(''))).catch(e => alive && setErr(e.message))
    setData(null); load()
    const t = setInterval(load, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [row?.symbol, tf, confirm3, orm])
  if (!row) return null
  const s = data?.signal || row
  const facts = [
    ['Sector', s.sector], ['Signal', <span className={'sig ' + (s.signal === 'BREAKOUT' ? 'up' : 'down')}>{s.signal}</span>],
    ['Current Price', fmtPrice(row.ltp)], ['Change % (vs prev close)', <Pct v={row.pct_prev} />],
    ['Opening Range High', fmtPrice(s.or_high)], ['Opening Range Low', fmtPrice(s.or_low)],
    ...(s.break_candle ? [[`Break Candle (${tf}-min close)`, `${fmtPrice(s.break_candle.price)} at ${hhmmTo12(s.break_candle.time)}`]] : []),
    [s.break_candle ? '3-min Confirmation Close' : 'Break Price (candle close)', fmtPrice(s.break_price)], [s.break_candle ? 'Confirmed At' : 'Break Time', hhmmTo12(s.break_time)],
    ['Volume Ratio @ break', s.vol_ratio != null ? `${fmtRatio(s.vol_ratio)} (${s.vol_sessions} session${s.vol_sessions === 1 ? '' : 's'})` : 'N/A — not recorded'],
    ['Volume Ratio now', <span title={row.vol_now_basis}>{fmtRatio(row.vol_ratio_now)}</span>],
    ['Cum Volume @ break', fmtVol(s.cum_volume)], ['Avg @ same time', fmtVol(s.avg_volume)],
    ['Distance From ORB', <Pct v={row.distance_pct} />], ['OR width', fmtPct(s.or_range_pct)],
    ['OR source', s.or_exact ? `Exact (NSE day high/low at ${orEndTxt})` : 'Approx. (NSE 1-min prices)'], ['Free-float mcap', isNum(row.ffmc_cr) ? '₹' + fmtNum(row.ffmc_cr, 0) + ' Cr' : 'N/A'],
    ['Day High', fmtPrice(row.day_high)], ['Day Low', fmtPrice(row.day_low)],
  ]
  return <Drawer open onClose={onClose} wide title={<StockLink symbol={row.symbol} company={row.company} className="strong" />}>
    <div className="facts-grid">{facts.map(([k, v]) => <div key={k}><div className="k">{k}</div><div className="v">{v}</div></div>)}</div>
    {row.other_break && <div className="note-box">Also broke {row.other_break.signal === 'BREAKOUT' ? 'above OR high' : 'below OR low'} earlier at {hhmmTo12(row.other_break.time)} (close {fmtPrice(row.other_break.price)}). Current signal is the more recent side.</div>}
    {!row.holding && <div className="note-box">Price is back inside the opening range.</div>}
    {s.rejected?.length > 0 && <div className="note-box"><b>{s.rejected.length} earlier break{s.rejected.length > 1 ? 's' : ''} rejected</b> (3-min confirmation failed — hollow markers on the chart):
      {s.rejected.map(r => <div key={r.min}>· {r.time.replace(/^0/, '')} break close {fmtNum(r.price)} → 3-min close {fmtNum(r.confirm_close)}</div>)}</div>}
    {!s.or_exact && <div className="note-box">Opening range taken from NSE's 1-minute price series because the app was not running before {orEndTxt} — intraminute wicks may be missed.</div>}
    <h4>Intraday 5-minute chart <span className="muted small">shaded {orm === 15 ? 'pink' : 'light blue'} = opening range 09:15–{orEndTxt} · dashed = OR high / low · marker = {Number(confirm3) ? '3-min confirmation close · hollow = rejected break' : `first ${tf}-min close beyond the range`}</span></h4>
    {err ? <div className="alert">{err}</div> : data ? <IntradayChart data={data} /> : <Empty>Loading candles…</Empty>}
    <a className="btn primary" href={tvStock(row.symbol)} target="_blank" rel="noopener noreferrer">Open TradingView ↗</a>
  </Drawer>
}

export default function Scanner({ orb, live, selected, setSelected, tf, setTf, confirm3, setConfirm3, f, setF, orm = 60 }) {
  const [tab, setTab] = useSessionState(`orb${orm}.tab`, 'all')
  const [sort, setSort] = useSessionState(`orb${orm}.sort`, DEFAULT_SORT)  // default: Break Time, latest first
  const orEndTxt = orm === 15 ? '09:30' : '10:15'
  const orName = orm === 15 ? '15-minute' : '1-hour'
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [drawer, setDrawer] = useState(null)
  const filters = { ...DEFAULT_FILTERS, ...f }

  const data = orb.data
  const bias = live?.bias?.label
  const sectors = live?.sectors || []

  const base = useMemo(() => filterRows(data?.rows || [], filters, selected), [data, selected, f]) // eslint-disable-line react-hooks/exhaustive-deps

  const counts = { all: base.length, breakout: base.filter(r => r.signal === 'BREAKOUT').length, breakdown: base.filter(r => r.signal === 'BREAKDOWN').length }
  const rows = sortRows(tab === 'all' ? base : base.filter(r => r.signal === tab.toUpperCase()), sort.key, sort.dir)
  const sp = { sort, setSort }
  const eng = data?.engine

  return <>
    <div className="page-title"><h1>ORB Scanner · {orm === 15 ? '15 Min' : '1 Hour'}</h1>
      <span className="muted small">{orName} Opening Range (09:15–{orEndTxt} IST) · signal = first {tf}-min candle closing beyond the range{Number(confirm3) === 1 ? ', confirmed by the next 3-min candle closing beyond the break candle\'s close' : Number(confirm3) === 2 ? ', confirmed by the next 3-min candle also closing beyond the range' : ''}</span></div>

    <div className="scan-head">
      <span className={'bias-pill ' + (bias === 'BULLISH' ? 'bull' : bias === 'BEARISH' ? 'bear' : 'neutral')}>Market Bias: {bias || 'N/A'}{isNum(live?.bias?.score) ? ` (${live.bias.score > 0 ? '+' : ''}${live.bias.score})` : ''}</span>
      <div className="tabs" role="tablist">
        {[['all', 'All'], ['breakout', 'Breakout'], ['breakdown', 'Breakdown']].map(([id, label]) =>
          <button key={id} role="tab" aria-selected={tab === id}
            className={(tab === id ? 'on ' : '') + ((id === 'breakout' && bias === 'BULLISH') || (id === 'breakdown' && bias === 'BEARISH') ? 'emph ' + id : '')}
            onClick={() => setTab(id)} title={(id === 'breakout' && bias === 'BULLISH') || (id === 'breakdown' && bias === 'BEARISH') ? 'Aligned with current market bias' : ''}>
            {label} <span className="count">{counts[id]}</span></button>)}
      </div>
      <input className="search" placeholder="Search symbol" value={filters.search} onChange={e => setF(x => ({ ...x, search: e.target.value }))} />
      <span className="grow" />
      <EngineStatus data={data} eng={eng} error={orb.error} />
    </div>

    <div className="toolbar"><SectorMulti sectors={sectors} selected={selected} setSelected={setSelected} />
      {selected.length > 0 && <button className="btn sm clear-sectors" onClick={() => setSelected([])} title="Clear the sector filter (also clears the heatmap selection)">✕ Clear sectors ({selected.length})</button>}
      <button className="btn sm filters-toggle" onClick={() => setFiltersOpen(o => !o)}>{filtersOpen ? 'Hide filters' : 'Filters'}</button></div>
    <div className={'filters-wrap' + (filtersOpen ? ' open' : '')}>
      <Filters f={filters} setF={setF} tf={tf} setTf={setTf} confirm3={confirm3} setConfirm3={setConfirm3} reset={() => { setF(DEFAULT_FILTERS); setSort(DEFAULT_SORT); setTf(15); setConfirm3(1) }} />
    </div>

    {data?.or_complete && filters.vol !== 'all' && !volumeAvailable(data.rows, filters.volBasis) && <div className="note-box">
      <b>Volume filter paused.</b> {filters.volBasis === 'break'
        ? <>NSE does not publish intraday volume history, so the at-break ratio needs sessions this app has recorded ({eng.recorded_sessions.length}/5 so far — keep the backend running during market hours). </>
        : <>No volume baseline yet for this basis. </>}
      Signals below are <b>not</b> volume-confirmed.{filters.volBasis === 'break' && !data.live && <> Switch Volume Basis to <button className="btn ghost sm" onClick={() => setF(x => ({ ...x, volBasis: 'now' }))}>Session so far / full day</button> to confirm with full-day volume vs the 5-day average.</>}
    </div>}
    {data?.or_complete && <div className="muted small qualify-line">
      <b className="strong">{counts.all}</b> signals pass the current filters · {data.rows.length} of {eng.universe} scanned stocks had a {confirm3 ? `${tf}-min break with 3-min confirmation` : `${tf}-min close beyond the range`} at some point this session
      {(filters.vol !== 1 || !filters.holdingOnly || filters.volBasis !== 'now') && <> · <button className="btn ghost sm" onClick={() => setF(x => ({ ...x, vol: 1, volBasis: 'now', holdingOnly: true }))}>Restore default qualification (&gt; 1.0x, still beyond range)</button></>}
    </div>}
    {data && !data.or_complete && <div className="note-box">Opening range 09:15–{orEndTxt} IST is still forming. The scanner starts evaluating completed candles after {orEndTxt}.</div>}

    <div className="tbl-wrap scanner-wrap">
      <table className="tbl scanner">
        <thead><tr>
          <SortTh label="Symbol" k="symbol" {...sp} defaultDir="asc" />
          <SortTh label="Sector" k="sector" {...sp} defaultDir="asc" />
          <SortTh label="Signal" k="signal" {...sp} defaultDir="asc" />
          <SortTh label="LTP" k="ltp" {...sp} num />
          <SortTh label="Chg %" k="pct_prev" {...sp} num title="Change vs previous close" />
          <th className="num">OR High</th><th className="num">OR Low</th>
          <th className="num">Break Price</th>
          <SortTh label="Break Time" k="break_min" {...sp} num title="Close time of the first candle closing beyond the range. Click: Latest → Earliest / Earliest → Latest" />
          <SortTh label={data?.live ? 'Fresh' : `Fresh (at ${data?.as_of_time || '15:30'})`} k="age_min" {...sp} num defaultDir="asc" />
          <SortTh label="Cum Vol @ break" k="cum_volume" {...sp} num title="Cumulative volume 09:15 → break time" />
          <SortTh label="Avg @ break" k="avg_volume" {...sp} num title="Average cumulative volume up to the same clock time over sessions this app recorded (max 5)" />
          {filters.volBasis === 'now'
            ? <SortTh label={data?.live ? 'Vol Ratio (session)' : 'Vol Ratio (full day)'} k="vol_ratio_now" {...sp} num title={data?.live ? 'Volume so far vs recorded sessions to the same time' : 'Full-day volume vs 5-day average (NSE bhavcopy)'} />
            : <SortTh label="Vol Ratio" k="vol_ratio" {...sp} num title="Cum Vol / 5D Avg at break time (time-adjusted)" />}
          <SortTh label="Dist ORB %" k="distance_pct" {...sp} num title="Breakout: (LTP − OR High) / OR High · Breakdown: (OR Low − LTP) / OR Low" />
          <th className="num">Day High</th><th className="num">Day Low</th>
        </tr></thead>
        <tbody>
          {rows.map(r => <tr key={r.symbol} onClick={() => setDrawer(r)} className={(data?.live && r.age_min <= 15 ? 'fresh ' : '') + (drawer?.symbol === r.symbol ? 'active' : '')}>
            <td><StockLink symbol={r.symbol} company={r.company} className="strong" /></td>
            <td className="muted" title={r.sectors.join(', ')}>{r.sector}</td>
            <td><span className={'sig ' + (r.signal === 'BREAKOUT' ? 'up' : 'down')}>{r.signal}</span>{!r.holding && <span className="inside" title="Price back inside the opening range">in range</span>}</td>
            <td className="num">{fmtNum(r.ltp)}</td>
            <td className="num"><Pct v={r.pct_prev} /></td>
            <td className="num" title={r.or_exact ? '' : 'Approximate: from NSE 1-minute prices'}>{!r.or_exact && <span className="approx">≈</span>}{fmtNum(r.or_high)}</td>
            <td className="num" title={r.or_exact ? '' : 'Approximate: from NSE 1-minute prices'}>{!r.or_exact && <span className="approx">≈</span>}{fmtNum(r.or_low)}</td>
            <td className="num">{fmtNum(r.break_price)}</td>
            <td className="num strong">{hhmmTo12(r.break_time)}</td>
            <td className="num"><Fresh row={r} live={data?.live} /></td>
            <td className="num">{fmtVol(r.cum_volume)}</td>
            <td className="num">{fmtVol(r.avg_volume)}</td>
            {(v => <td className={'num strong ' + (v >= 1.5 ? 'up' : v < 1 ? 'muted' : '')}>{fmtRatio(v)}</td>)(filters.volBasis === 'now' ? r.vol_ratio_now : r.vol_ratio)}
            <td className={'num ' + tone(r.distance_pct)}>{fmtPct(r.distance_pct)}</td>
            <td className="num">{fmtNum(r.day_high)}</td>
            <td className="num">{fmtNum(r.day_low)}</td>
          </tr>)}
        </tbody>
      </table>
      {!rows.length && <Empty>{!data ? (orb.error || 'Loading scanner…') : !data.or_complete ? 'Waiting for the opening range to complete.' : 'No stocks match the current tab and filters.'}</Empty>}
    </div>
    <p className="muted small">Scanner surfaces stocks meeting defined conditions only — no buy/sell, target or stop-loss recommendations. At-break volume baseline: {eng?.recorded_sessions?.length ? eng.recorded_sessions.map(sessionLabel).join(', ') : 'no sessions recorded yet'}. ≈ = opening range from NSE 1-minute prices (app not running before {orEndTxt}).</p>
    {drawer && <SignalDrawer row={rows.find(r => r.symbol === drawer.symbol) || drawer} tf={tf} confirm3={confirm3} orm={orm} onClose={() => setDrawer(null)} />}
  </>
}

function EngineStatus({ data, eng, error }) {
  if (!data) return <span className="muted small">{error || 'Connecting…'}</span>
  const session = sessionLabel(data.session_date)
  return <span className="engine small">
    <b>Session {session}</b>{data.live ? ' · live' : ' · closed (session review)'} ·
    {` ${eng.loaded}/${eng.universe} stocks with bars`}
    {eng.backfill?.state === 'running' && ` · back-filling ${eng.backfill.done}/${eng.backfill.total}`}
    {eng.poll_error && <span className="down"> · {eng.poll_error}</span>}
    {error && <span className="amber"> · refresh failed, showing last data</span>}
  </span>
}

// Details for any stock (used by the Top 20 Gainers / Losers): live quote,
// intraday chart, and the stock's 1-hour ORB signal if it has one.
export function StockDrawer({ stock, onClose }) {
  const [data, setData] = useState(null)
  const [sig15, setSig15] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!stock) return
    let alive = true
    const q = `/api/orb/candles?symbol=${encodeURIComponent(stock.symbol)}&tf=15&confirm=1`
    const load = () => Promise.all([api(q + '&orm=60'), api(q + '&orm=15')])
      .then(([d60, d15]) => alive && (setData(d60), setSig15(d15.signal), setErr(''))).catch(e => alive && setErr(e.message))
    setData(null); setSig15(null); load()
    const t = setInterval(load, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [stock?.symbol])
  if (!stock) return null
  const orbSig = x => x ? <span className={'sig ' + (x.signal === 'BREAKOUT' ? 'up' : 'down')}>{x.signal} {hhmmTo12(x.break_time)}</span> : <span className="muted">{data ? 'No signal' : '…'}</span>
  const sig = data?.signal
  const facts = [
    ['Sector', stock.sector], ['LTP', fmtPrice(stock.ltp)],
    ['Change % (vs prev close)', <Pct v={stock.pct_prev} />], ['Change', <span className={tone(stock.change)}>{isNum(stock.change) ? (stock.change > 0 ? '+' : '') + fmtNum(stock.change) : 'N/A'}</span>],
    ['Open', fmtPrice(stock.open)], ['Prev Close', fmtPrice(stock.prev_close)],
    ['Day High', fmtPrice(stock.high)], ['Day Low', fmtPrice(stock.low)],
    ['Volume', fmtVol(stock.volume)], ['Vol vs 5D', <span title={stock.vol_basis}>{fmtRatio(stock.vol_ratio)}</span>],
    ['ORB 1 Hour', orbSig(sig)],
    ['OR 1 Hour High / Low', sig ? `${fmtNum(sig.or_high)} / ${fmtNum(sig.or_low)}` : 'N/A'],
    ['ORB 15 Min', orbSig(sig15)],
    ['OR 15 Min High / Low', sig15 ? `${fmtNum(sig15.or_high)} / ${fmtNum(sig15.or_low)}` : 'N/A'],
  ]
  return <Drawer open onClose={onClose} wide title={<StockLink symbol={stock.symbol} company={stock.company} className="strong" />}>
    <div className="facts-grid">{facts.map(([k, v]) => <div key={k}><div className="k">{k}</div><div className="v">{v}</div></div>)}</div>
    <h4>Intraday 5-minute chart <span className="muted small">shaded: light blue = 1-hour range (09:15–10:15), pink = 15-min range (09:15–09:30){sig ? ' · green/red dashed = 1-hour OR high / low' : ''}{sig15 ? ' · blue dotted = 15-min OR high / low' : ''} · marker = 1-hour ORB signal</span></h4>
    {err ? <div className="alert">{err}</div> : data ? <IntradayChart data={data} extra={sig15 ? { or_high: sig15.or_high, or_low: sig15.or_low } : null} /> : <Empty>Loading candles…</Empty>}
    <a className="btn primary" href={tvStock(stock.symbol)} target="_blank" rel="noopener noreferrer">Open TradingView ↗</a>
  </Drawer>
}
