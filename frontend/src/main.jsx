import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { api, istDate, istTime, nseTs, setSessionValue, useClock, usePersistentState, useSessionState, usePoll } from './lib.js'
import { StockChartCtx } from './components.jsx'
import Overview from './Overview.jsx'
import Heatmap from './Heatmap.jsx'
import Scanner, { DEFAULT_FILTERS, filterRows } from './Scanner.jsx'
import Scans, { BiasPill } from './Scans.jsx'
import { PcrMeter } from './Pcr.jsx'
// Pages loaded only when opened (smaller first download)
const Crypto = lazy(() => import('./Crypto.jsx'))
const Ipo = lazy(() => import('./Ipo.jsx'))
const Learning = lazy(() => import('./Learning.jsx'))
const Journal = lazy(() => import('./Journal.jsx'))

const REFRESH_MS = 10000
const PAGES = [
  { id: 'overview', label: 'Market Overview', key: '1' },
  { id: 'heatmap', label: 'Sector Heatmap', key: '2' },
  { id: 'scanner', label: 'ORB Scanner', key: '3' },
  { id: 'trend', label: 'Intraday Scanner', key: '4' },
  { id: 'crypto', label: 'Crypto', key: '6' },
  { id: 'ipo', label: 'IPO', key: '7' },
  { id: 'learning', label: 'Learning', key: '8' },
  { id: 'journal', label: 'Journal', key: '9' },
]

// Viewer count (last 24 h): ping every 15 s with a random per-browser id (no personal data).
function useViewers() {
  const [n, setN] = useState(null)
  useEffect(() => {
    let id = null
    try { id = localStorage.getItem('nseid:viewer') } catch { /* private mode */ }
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36)
      try { localStorage.setItem('nseid:viewer', id) } catch { /* private mode */ }
    }
    let alive = true
    const ping = () => api('/api/presence?id=' + encodeURIComponent(id)).then(d => alive && setN(d.online)).catch(() => {})
    ping()
    const t = setInterval(ping, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return n
}

const hhmm = d => d ? istTime(d).slice(0, 5) : '…'  // HH:MM for the compact header

function StatusBar({ live, auto, setAuto, crypto = false }) {
  const viewers = useViewers()
  const now = useClock()
  const status = live.data?.market_status?.label
  const delayed = !!live.error && !!live.data
  const ok = !!live.data && !live.error && !live.data.poll_error
  return <div className="hdr-status">
    {crypto  // crypto trades 24x7: on the Crypto page the pill shows that market, not NSE's
      ? <span className="mkt open" title="Crypto markets trade 24 hours a day, 7 days a week">Crypto · Open 24×7</span>
      : <span className={'mkt ' + (status === 'Market Open' ? 'open' : status === 'Pre-Open' ? 'pre' : 'closed')}>{status || '—'}</span>}
    {viewers != null && <span className="hdr-viewers" title={`${viewers} ${viewers === 1 ? 'person has' : 'people have'} used the dashboard in the last 24 hours`}><i className="live-dot" />{viewers}</span>}
    <span className="hdr-clock" title={`${istDate(now)} · Indian Standard Time`}><span className="hdr-date">{istDate(now)}</span> {istTime(now)} <small>IST</small></span>
    {delayed || live.data?.poll_error
      ? <span className="hdr-delayed" title={`Data delayed — last successful update ${istTime(live.data?.as_of || live.lastOk)} IST · ${live.error || live.data?.poll_error}`}><i className="dot amber" />Delayed · {hhmm(live.data?.as_of || live.lastOk)}</span>
      : <span className="hdr-upd" title={`Last updated ${live.data?.as_of ? istTime(live.data.as_of) : '…'} IST`}><i className={'dot ' + (ok && auto ? 'green' : 'grey')} />Updated {live.data?.as_of ? hhmm(live.data.as_of) : '…'}</span>}
    <button className={'hdr-auto' + (auto ? ' on' : '')} onClick={() => setAuto(a => !a)} title={auto ? 'Auto refresh is ON (every 10 seconds) — click to pause' : 'Auto refresh is OFF — click to resume'}>
      {auto ? 'Auto ✓ 10s' : 'Auto off'}</button>
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
  const crypto = usePoll(() => api('/api/crypto'), page === 'crypto' ? 10000 : 3.6e6, [page === 'crypto'])
  const ipo = usePoll(() => api('/api/ipo'), page === 'ipo' ? 30000 : 300000, [page === 'ipo'])

  const toggleSector = useCallback(sym => setSelected(s => s.includes(sym) ? s.filter(x => x !== sym) : [...s, sym]), [setSelected])
  const orbCount = orb.data?.rows ? filterRows(orb.data.rows, orbFilters, selected, orb.data).length : null
  const orb15Count = orb15.data?.rows ? filterRows(orb15.data.rows, orbFilters15, selected, orb15.data).length : null

  // Chart icon next to any stock symbol -> Intraday Scanner, Live Chart tab, that stock.
  const [chartReq, setChartReq] = useState(0)
  const openStockChart = useCallback(sym => {
    setSessionValue('slive.sym', sym); setSessionValue('scans.tab', 'chart')
    setChartReq(n => n + 1); setPage('trend'); window.scrollTo({ top: 0 })
  }, [])

  return <StockChartCtx.Provider value={openStockChart}><div className="app">
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
      <StatusBar live={live} auto={auto} setAuto={setAuto} crypto={page === 'crypto'} />
    </header>
    <main className="page">
      {live.error && !live.data && <div className="alert">{live.error}</div>}
      {page === 'overview' && <PcrMeter />}  {/* full PCR meter on Market Overview (heatmap has its own card) */}
      {/* Other pages: compact strip — Market Bias pill + Nifty PCR pill */}
      {['scanner', 'trend', 'ipo', 'learning', 'journal'].includes(page) && <div className="mini-strip">
        <BiasPill bias={live.data?.bias} />
        <PcrMeter compact />
        {page === 'journal' && <div id="journal-account-slot" className="mini-slot" />}  {/* Journal puts its sign-in / saved status here */}
      </div>}
      {page === 'overview' && <Overview live={live.data} ctx={ctx.data} />}
      {page === 'heatmap' && <Heatmap live={live.data} selected={selected} setSelected={setSelected} toggle={toggleSector} goto={setPage} />}
      {page === 'trend' && <Scans trend={trend} live={live.data} selected={selected} setSelected={setSelected} chartReq={chartReq} />}
      <Suspense fallback={<div className="empty">Loading…</div>}>
        {page === 'crypto' && <Crypto crypto={crypto} />}
        {page === 'ipo' && <Ipo ipo={ipo} />}
        {page === 'learning' && <Learning />}
        {page === 'journal' && <Journal live={live.data} />}
      </Suspense>
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
  </div></StockChartCtx.Provider>
}

createRoot(document.getElementById('root')).render(<App />)
