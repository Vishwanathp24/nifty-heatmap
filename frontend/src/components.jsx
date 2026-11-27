import React, { createContext, useContext, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { fmtPct, isNum, tone, tvIndex, tvStock, tvSymbol } from './lib.js'

// Every chart link opens a new tab and stops propagation, so clicking it never
// selects a card, opens a drawer or touches any dashboard state.
const stop = e => e.stopPropagation()

// Opens a stock in Intraday Scanner -> Live Chart (provided by the app shell).
export const StockChartCtx = createContext(null)
// Today's Top 20 F&O gainers / losers (set in main.jsx): map = symbol -> ['up' | 'down', rank];
// only = '' | 'up' | 'down', the scanner filter shared by every scanner table.
export const TopMoversCtx = createContext({ map: {}, only: '', topOn: false, setTopOn: () => {} })

// Scanner rows with the Top 20 filter applied; when it is on, ordered by rank (#1 first).
export function useTopPass() {
  const { map, only } = useContext(TopMoversCtx)
  if (only === 'both') return rows => rows.filter(r => map[r.symbol])  // either list, scan order kept
  return rows => only ? rows.filter(r => map[r.symbol]?.[0] === only).sort((a, b) => map[a.symbol][1] - map[b.symbol][1]) : rows
}

export function TopFilter() {
  const { topOn, setTopOn } = useContext(TopMoversCtx)
  return <button className={'top-toggle' + (topOn ? ' on' : '')} aria-pressed={topOn} onClick={() => setTopOn(v => !v)}
    title={topOn ? 'Showing only today’s Top 20 F&O gainers and losers. Tap to show all stocks' : 'Showing all stocks. Tap to show only today’s Top 20 F&O gainers and losers'}>
    <i>{topOn ? '✓' : ''}</i>Top 20 gainers + losers</button>
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

// Ribbon pill: advancing / declining and A/D ratio for a breadth bucket (tone by A/D vs 1).
// Advances / declines / unchanged as small coloured chips: ↑ green, ↓ red, — grey (same look everywhere).
export function AdChips({ up, down, unch, className = '' }) {
  return <span className={'ad-chips ' + className}
    title={`Advances ${up ?? '—'} · Declines ${down ?? '—'}${unch != null ? ` · Unchanged ${unch}` : ''}`}>
    <span className="up">↑{up ?? '—'}</span><span className="down">↓{down ?? '—'}</span>
    {unch != null && <span>— {unch}</span>}</span>
}

// A "29 up / 21 down" reading (Market Bias table) shown as chips; any other text unchanged.
export function AdText({ text }) {
  const m = /^(\d+) up \/ (\d+) down$/.exec(text || '')
  return m ? <AdChips up={m[1]} down={m[2]} /> : text
}

export function BreadthPill({ label, b }) {
  if (!b) return null
  const tone = !isNum(b.ad_ratio) ? 'neutral' : b.ad_ratio > 1 ? 'bull' : b.ad_ratio < 1 ? 'bear' : 'neutral'
  return <span className={'bias-pill ' + tone} title={`${label} breadth vs previous close: ${b.up} advancing, ${b.down} declining, ${b.unchanged} unchanged`}>
    {label}<span className="hide-m"> Breadth</span>: {b.up}↑ {b.down}↓ · A/D {isNum(b.ad_ratio) ? b.ad_ratio.toFixed(2) : 'N/A'}</span>
}

export function BiasPill({ bias }) {
  const label = bias?.label
  const tone = label === 'BULLISH' ? 'bull' : label === 'BEARISH' ? 'bear' : 'neutral'
  return <span className={'bias-pill ' + tone} title={bias?.components ? bias.components.map(c => `${c.label} ${c.points > 0 ? '+1' : c.points < 0 ? '−1' : '0'}`).join(' · ') : undefined}>
    Market Bias: {label || 'N/A'}{isNum(bias?.score) ? ` (${bias.score > 0 ? '+' : ''}${bias.score})` : ''}</span>
}

// Copies symbols as "NSE:A,NSE:B,…": paste into TradingView's watchlist "Add symbol" box to add them all at once.
// Phones: TradingView's app adds one symbol at a time, so on a phone the button opens a sheet where
// each stock is a tap-to-copy chip (ticked once copied); desktop copies the whole list in one go.
const isPhone = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 760px), (pointer: coarse) and (max-width: 1024px)').matches
async function copyText(text) {
  try { await navigator.clipboard.writeText(text) } catch {
    const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select()
    try { document.execCommand('copy') } catch { /* nothing else to try */ } t.remove()
  }
}
export function CopyTv({ symbols, label = 'Copy for TradingView' }) {
  const [done, setDone] = useState(null)
  const [sheet, setSheet] = useState(false)
  const [copied, setCopied] = useState({})
  const list = [...new Set(symbols)].map(tvSymbol)
  const copyAll = async () => { await copyText(list.join(',')); setDone(list.length); setTimeout(() => setDone(null), 2500) }
  const copyOne = async s => { await copyText(s); setCopied(c => ({ ...c, [s]: true })) }
  const n = Object.keys(copied).filter(s => list.includes(s)).length
  return <>
    <button className="btn sm copy-tv" onClick={() => isPhone() ? (setCopied({}), setSheet(true)) : copyAll()} disabled={!list.length}
      title="Copies the symbols shown (NSE:SYMBOL, comma-separated). In TradingView open the watchlist, click + (Add symbol), paste and press Enter. On a phone: tap each stock to copy it, then paste it in TradingView.">
      {done != null ? `✓ Copied ${done}` : `📋 ${label}${list.length ? ` (${list.length})` : ''}`}</button>
    {sheet && createPortal(<div className="tv-sheet-bg" onClick={() => setSheet(false)}>
      <div className="tv-sheet" role="dialog" aria-label="Copy stocks for TradingView" onClick={e => e.stopPropagation()}>
        <div className="tv-sheet-h"><b>Tap a stock to copy it</b><button className="btn sm" onClick={() => setSheet(false)}>Done</button></div>
        <p className="muted small">Then open TradingView, tap + in your watchlist, paste, and come back for the next one. {n} of {list.length} copied.</p>
        <div className="tv-chips">{list.map(s => <button key={s} className={'tv-chip' + (copied[s] ? ' on' : '')} onClick={() => copyOne(s)}>
          {copied[s] ? '✓ ' : ''}{s.replace(/^NSE:/, '')}</button>)}</div>
        <button className="btn sm tv-all" onClick={async () => { await copyText(list.join(',')); setCopied(Object.fromEntries(list.map(s => [s, true]))) }}>Copy all as one line (desktop TradingView)</button>
      </div></div>, document.body)}
  </>
}
