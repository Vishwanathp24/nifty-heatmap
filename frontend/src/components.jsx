import React, { useEffect } from 'react'
import { fmtPct, tone, tvIndex, tvStock } from './lib.js'

// Every chart link opens a new tab and stops propagation, so clicking it never
// selects a card, opens a drawer or touches any dashboard state.
const stop = e => e.stopPropagation()

export function StockLink({ symbol, company, children, className = '' }) {
  return <a className={'tv-link ' + className} href={tvStock(symbol)} target="_blank" rel="noopener noreferrer"
    onClick={stop} title={(company ? company + ' · ' : '') + `Open NSE:${symbol} on TradingView`}>{children ?? symbol}<span className="ext">↗</span></a>
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
  if (!open) return null
  return <>
    <div className="drawer-scrim" onClick={onClose} />
    <aside className={'drawer' + (wide ? ' wide' : '')} role="dialog" aria-label={typeof title === 'string' ? title : 'Details'}>
      <div className="drawer-head"><div className="drawer-title">{title}</div><button className="icon-btn" onClick={onClose} aria-label="Close">✕</button></div>
      <div className="drawer-body">{children}</div>
    </aside>
  </>
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
