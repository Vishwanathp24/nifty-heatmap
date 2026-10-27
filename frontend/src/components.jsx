import React, { createContext, useContext, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { fmtPct, isNum, tone, tvIndex, tvStock, tvSymbol } from './lib.js'

// Every chart link opens a new tab and stops propagation, so clicking it never
// selects a card, opens a drawer or touches any dashboard state.
const stop = e => e.stopPropagation()

// Opens a stock in Intraday Scanner -> Live Chart (provided by the app shell).
export const StockChartCtx = createContext(null)
// Today's Top 20 F&O gainers / losers (set in main.jsx): map = symbol -> ['up' | 'down', rank];
// only = '' | 'up' | 'down', the scanner filter shared by every scanner table.
export const TopMoversCtx = createContext({ map: {}, only: '', setOnly: () => {} })

// Scanner rows with the Top 20 filter applied; when it is on, ordered by rank (#1 first).
export function useTopPass() {
  const { map, only } = useContext(TopMoversCtx)
  return rows => only ? rows.filter(r => map[r.symbol]?.[0] === only).sort((a, b) => map[a.symbol][1] - map[b.symbol][1]) : rows
}

export function TopFilter() {
  const { only, setOnly } = useContext(TopMoversCtx)
  return <Seg value={only} onChange={setOnly} options={[{ value: '', label: 'All stocks', title: 'Show every stock in this scan' },
    { value: 'up', label: 'Top 20 gainers', tone: 'up', title: 'Only stocks in today’s Top 20 F&O gainers' },
    { value: 'down', label: 'Top 20 losers', tone: 'down', title: 'Only stocks in today’s Top 20 F&O losers' }]} />
}

// Tag shown beside a symbol in the scanners when it is in today's Top 20 gainers or losers.
export function TopTag({ symbol }) {
  const t = useContext(TopMoversCtx).map[symbol]
  if (!t) return null
  const [dir, rank] = t
  return <span className={'top-tag ' + dir} title={`Top 20 F&O ${dir === 'up' ? 'gainer' : 'loser'} today: #${rank} by % change vs previous close`}>{dir === 'up' ? '▲' : '▼'} #{rank}</span>
}

export const CandleIcon = () => <svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">
  <path d="M3 2v10M7 4v8M11 1v9" stroke="currentColor" strokeWidth="1" /><rect x="1.8" y="5" width="2.4" height="4" fill="currentColor" />
  <rect x="5.8" y="6" width="2.4" height="3.5" fill="currentColor" /><rect x="9.8" y="3" width="2.4" height="4" fill="currentColor" /></svg>

export function StockLink({ symbol, company, children, className = '' }) {
  const openChart = useContext(StockChartCtx)
  const link = <a className={'tv-link ' + className} href={tvStock(symbol)} target="_blank" rel="noopener noreferrer"
    onClick={stop} title={(company ? company + ' · ' : '') + `Open ${tvSymbol(symbol)} on TradingView`}>{children ?? symbol}<span className="ext">↗</span></a>
  if (!openChart) return link
  return <span className="stock-link">{link}<button className="chart-btn" title={`Open ${symbol} in the Live Chart`} aria-label={`Live chart ${symbol}`}
    onClick={e => { e.preventDefault(); e.stopPropagation(); openChart(symbol) }}><CandleIcon /></button></span>
}

export function IndexLink({ name, label, className = '' }) {
  const url = tvIndex(name)
  if (!url) return <span className={className}>{label ?? name}</span>
  return <a className={'tv-link ' + className} href={url} target="_blank" rel="noopener noreferrer" onClick={stop}
    title={`Open ${name} on TradingView`}>{label ?? name}<span className="ext">↗</span></a>
}

export function ChartIcon({ name }) {
  const url = tvIndex(name)
  if (!url) return null
  return <a className="chart-icon" href={url} target="_blank" rel="noopener noreferrer"
    onClick={stop} onKeyDown={stop} aria-label={`Open ${name} chart on TradingView`} title="Open chart on TradingView">↗</a>
}

export const Pct = ({ v, d }) => <span className={'num ' + tone(v)}>{fmtPct(v, d)}</span>

export function SortTh({ label, k, sort, setSort, num, title, defaultDir = 'desc' }) {
  const active = sort.key === k
  const next = () => setSort(active ? { key: k, dir: sort.dir === 'desc' ? 'asc' : 'desc' } : { key: k, dir: defaultDir })
  return <th className={(num ? 'num ' : '') + 'sortable' + (active ? ' sorted' : '')} onClick={next} title={title || 'Sort'}
    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
    {label}<span className="arrow">{active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
  </th>
}

export function Section({ title, subtitle, right, children, className = '' }) {
  return <section className={'section ' + className}>
    <div className="section-head">
      <div><h2>{title}</h2>{subtitle && <p className="sub">{subtitle}</p>}</div>
      {right && <div className="section-right">{right}</div>}
    </div>
    {children}
  </section>
}

export function Drawer({ open, onClose, title, children, wide }) {
  useEffect(() => {
    if (!open) return
    const onKey = e => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  useEffect(() => {  // stop the page behind from scrolling while the panel is open (phones)
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])
  if (!open) return null
  // Rendered at the top of the page (portal): a panel opened from inside a scrolling table would
  // otherwise be trapped in that box on iPhone Safari instead of opening full screen.
  return createPortal(<>
    <div className="drawer-scrim" onClick={onClose} />
    <aside className={'drawer' + (wide ? ' wide' : '')} role="dialog" aria-label={typeof title === 'string' ? title : 'Details'}>
      <div className="drawer-head"><div className="drawer-title">{title}</div><button className="icon-btn" onClick={onClose} aria-label="Close">✕</button></div>
      <div className="drawer-body">{children}</div>
    </aside>
  </>, document.body)
}

export function BreadthBar({ up, down, unchanged }) {
  const total = up + down + unchanged
  if (!total) return <div className="bbar empty" />
  const w = n => (n / total * 100) + '%'
  return <div className="bbar" role="img" aria-label={`${up} advancing, ${down} declining, ${unchanged} unchanged`}>
    <span className="bb-up" style={{ width: w(up) }} />
    <span className="bb-flat" style={{ width: w(unchanged) }} />
    <span className="bb-down" style={{ width: w(down) }} />
  </div>
}

export function Seg({ options, value, onChange, className = '' }) {
  return <div className={'seg ' + className} role="group">
    {options.map(o => <button key={o.value} className={(value === o.value ? 'on ' : '') + (o.tone || '')} onClick={() => onChange(o.value)}
      title={o.title}>{o.label}</button>)}
  </div>
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>
}

export function BiasPill({ bias }) {
  const label = bias?.label
  const tone = label === 'BULLISH' ? 'bull' : label === 'BEARISH' ? 'bear' : 'neutral'
  return <span className={'bias-pill ' + tone} title={bias?.components ? bias.components.map(c => `${c.label} ${c.points > 0 ? '+1' : c.points < 0 ? '−1' : '0'}`).join(' · ') : undefined}>
    Market Bias: {label || 'N/A'}{isNum(bias?.score) ? ` (${bias.score > 0 ? '+' : ''}${bias.score})` : ''}</span>
}
