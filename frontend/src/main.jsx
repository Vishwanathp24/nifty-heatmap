import React, { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { api, istDate, istTime, nseTs, setSessionValue, useClock, usePersistentState, useSessionState, usePoll } from './lib.js'
import Overview from './Overview.jsx'
import Heatmap from './Heatmap.jsx'
import Scanner, { DEFAULT_FILTERS, filterRows } from './Scanner.jsx'
import Ipo from './Ipo.jsx'
import Learning from './Learning.jsx'
import Scans, { BiasBanner } from './Scans.jsx'

const REFRESH_MS = 10000
const PAGES = [
  { id: 'overview', label: 'Market Overview', key: '1' },
  { id: 'heatmap', label: 'Sector Heatmap', key: '2' },
  { id: 'scanner', label: 'ORB Scanner', key: '3' },
  { id: 'trend', label: 'Intraday Scanner', key: '4' },
  { id: 'ipo', label: 'IPO', key: '5' },
  { id: 'learning', label: 'Learning', key: '6' },
]

function StatusBar({ live, auto, setAuto }) {
  const now = useClock()
  const status = live.data?.market_status?.label
  const delayed = !!live.error && !!live.data
  const ok = !!live.data && !live.error && !live.data.poll_error
  return <div className="hdr-status">
    <span className={'mkt ' + (status === 'Market Open' ? 'open' : status === 'Pre-Open' ? 'pre' : 'closed')}>{status || '—'}</span>
    <span className="hdr-clock" title="Indian Standard Time"><span className="hdr-date">{istDate(now)}</span> {istTime(now)} <small>IST</small></span>
    {delayed || live.data?.poll_error
      ? <span className="hdr-delayed" title={live.error || live.data?.poll_error}><i className="dot amber" />Data delayed · Last successful update: {istTime(live.data?.as_of || live.lastOk)}</span>
      : <span className="hdr-upd"><i className={'dot ' + (ok && auto ? 'green' : 'grey')} />Last updated: {live.data?.as_of ? istTime(live.data.as_of) : '…'}</span>}
    <button className={'hdr-auto' + (auto ? ' on' : '')} onClick={() => setAuto(a => !a)} title="Toggle auto refresh">
      Auto Refresh: {auto ? 'ON' : 'OFF'}</button>
    <span className="hdr-muted">Refresh interval: 10 sec</span>
  </div>
}

function App() {
  const [page, setPage] = useState('overview')  // every load/refresh starts on the homepage
  const [selected, setSelected] = useSessionState('sectors', [])
  const [auto, setAuto] = usePersistentState('auto', true)
  const [tf, setTf] = useSessionState('orb.tf.v4', 15)  // break candle: 5 or 15 min
  const [confirm3, setConfirm3] = useSessionState('orb.confirmMode', 1)  // 3-min confirmation: 0 off, 1 beyond break close, 2 beyond OR level
  const [orbFilters, setOrbFilters] = useSessionState('orb.filters.v3', DEFAULT_FILTERS)  // v3: defaults = full-day volume basis, F&O universe
  const [orbView, setOrbView] = useSessionState('orb.view', 15)  // ORB Scanner sub-tab: 15 = 15 Min ORB (default), 60 = 1 Hour ORB
  // 15-minute ORB scanner: same rules, its own independent settings
  const [tf15, setTf15] = useSessionState('orb15.tf', 15)
  const [confirm15, setConfirm15] = useSessionState('orb15.confirmMode', 1)
  const [orbFilters15, setOrbFilters15] = useSessionState('orb15.filters', DEFAULT_FILTERS)

  const live = usePoll(() => api('/api/live'), auto ? REFRESH_MS : 3.6e6, [auto])
  const orb = usePoll(() => api(`/api/orb?tf=${tf}&confirm=${Number(confirm3)}&orm=60`), auto ? REFRESH_MS : 3.6e6, [auto, tf, confirm3])
  const orb15 = usePoll(() => api(`/api/orb?tf=${tf15}&confirm=${Number(confirm15)}&orm=15`), auto ? REFRESH_MS : 3.6e6, [auto, tf15, confirm15])
  const ctx = usePoll(() => api('/api/context'), 60000, [])
  const trend = usePoll(() => api('/api/trend'), page === 'trend' ? 30000 : 3.6e6, [page === 'trend'])
  const ipo = usePoll(() => api('/api/ipo'), page === 'ipo' ? 30000 : 300000, [page === 'ipo'])

  const toggleSector = useCallback(sym => setSelected(s => s.includes(sym) ? s.filter(x => x !== sym) : [...s, sym]), [setSelected])
  const orbCount = orb.data?.rows ? filterRows(orb.data.rows, orbFilters, selected, orb.data).length : null
  const orb15Count = orb15.data?.rows ? filterRows(orb15.data.rows, orbFilters15, selected, orb15.data).length : null

  return <div className="app">
    <header className="hdr">
      <button className="hdr-brand" onClick={() => { setPage('overview'); window.scrollTo({ top: 0 }) }} title="Go to homepage (Market Overview)">
        <span>NSE Sector Heatmap</span></button>
      <nav className="hdr-nav">
        {PAGES.map(p => <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => setPage(p.id)}>
          {p.label}
          {p.id === 'heatmap' && selected.length ? <span className="badge">{selected.length}</span> : null}
          {p.id === 'scanner' && (orbView === 15 ? orb15Count : orbCount) != null ? <span className="badge" title={`Signals passing the current ${orbView === 15 ? '15 Min' : '1 Hour'} ORB filters`}>{orbView === 15 ? orb15Count : orbCount}</span> : null}
        </button>)}
      </nav>
      <StatusBar live={live} auto={auto} setAuto={setAuto} />
    </header>
    <main className="page">
      {live.error && !live.data && <div className="alert">{live.error}</div>}
      {page !== 'trend' && page !== 'overview' && <BiasBanner bias={live.data?.bias} onPick={id => { setSessionValue('scans.tab', id); setPage('trend'); window.scrollTo({ top: 0 }) }} />}
      {page === 'overview' && <Overview live={live.data} ctx={ctx.data} />}
      {page === 'heatmap' && <Heatmap live={live.data} selected={selected} setSelected={setSelected} toggle={toggleSector} goto={setPage} />}
      {page === 'trend' && <Scans trend={trend} live={live.data} selected={selected} setSelected={setSelected} />}
      {page === 'ipo' && <Ipo ipo={ipo} />}
      {page === 'learning' && <Learning />}
      {page === 'scanner' && <>
        <div className="orb-switch" role="tablist" aria-label="Opening range">
          {[[15, '15 Min ORB', '09:15–09:30', orb15Count], [60, '1 Hour ORB', '09:15–10:15', orbCount]].map(([v, label, range, n]) =>
            <button key={v} role="tab" aria-selected={orbView === v} className={orbView === v ? 'on' : ''} onClick={() => setOrbView(v)}>
              {label} <small>{range}</small>{n != null && <span className="count">{n}</span>}</button>)}
        </div>
        {orbView === 60
          ? <Scanner key="orb60" orm={60} orb={orb} live={live.data} selected={selected} setSelected={setSelected} tf={tf} setTf={setTf} confirm3={confirm3} setConfirm3={setConfirm3} f={orbFilters} setF={setOrbFilters} />
          : <Scanner key="orb15" orm={15} orb={orb15} live={live.data} selected={selected} setSelected={setSelected} tf={tf15} setTf={setTf15} confirm3={confirm15} setConfirm3={setConfirm15} f={orbFilters15} setF={setOrbFilters15} />}
      </>}
    </main>
    <footer className="foot">
      Decision-support scanner — no buy/sell, target or stop-loss recommendations. Data: NSE (indices, quotes, per-minute prices, bhavcopy volumes, FII/DII, GIFT Nifty, market status), BSE (Sensex), Yahoo Finance (overseas indices, Scanner candles, opening-range fallback).
      {live.data?.source_ts && <> Latest NSE quote: {istDate(nseTs(live.data.source_ts))} {istTime(nseTs(live.data.source_ts))} IST.</>}
    </footer>
  </div>
}

createRoot(document.getElementById('root')).render(<App />)
