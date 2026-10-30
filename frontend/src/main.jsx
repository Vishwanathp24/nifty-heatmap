import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import favicon from './icons/favicon-64.png'
import { api, istDate, istTime, nseTs, setSessionValue, useClock, usePersistentState, useSessionState, usePoll } from './lib.js'
import { BiasPill, StockChartCtx, TopMoversCtx } from './components.jsx'
import Overview from './Overview.jsx'
import Heatmap from './Heatmap.jsx'
import Scanner, { DEFAULT_FILTERS, filterRows } from './Scanner.jsx'
import { PcrMeter } from './Pcr.jsx'
// Pages loaded only when opened (smaller first download)
const Crypto = lazy(() => import('./Crypto.jsx'))
const Ipo = lazy(() => import('./Ipo.jsx'))
const Learning = lazy(() => import('./Learning.jsx'))
const Journal = lazy(() => import('./Journal.jsx'))
const Scans = lazy(() => import('./Scans.jsx'))  // Intraday Scanner: charts, option chain, payoff tools - loaded when opened

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
].filter(p => !import.meta.env.VITE_PAGES || import.meta.env.VITE_PAGES.split(',').includes(p.id))  // VITE_PAGES: build with only these pages (Netlify copy)

// Viewer count (last 24 h): ping every 15 s with a random per-browser id (no personal data).
// Automated browsers only read the count, so bots and scanners aren't counted as people.
const AUTOMATED = typeof navigator !== 'undefined' && (navigator.webdriver || /bot|crawl|spider|headless|lighthouse|preview/i.test(navigator.userAgent))
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
    const ping = () => api('/api/presence' + (AUTOMATED ? '' : '?id=' + encodeURIComponent(id))).then(d => alive && setN(d.online)).catch(() => {})
    ping()
    const t = setInterval(ping, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return n
}

const hhmm = d => d ? istTime(d).slice(0, 5) : '…'  // HH:MM for the compact header

// Market Bias alert: a browser notification when the bias label (Bullish / Neutral / Bearish)
// changes during market hours. Works while the dashboard is open, even in a background tab.
const CAN_NOTIFY = typeof window !== 'undefined' && 'Notification' in window
function useBiasAlert(live, on) {
  const prev = useRef(null)
  const bias = live.data?.bias, open = live.data?.market_status?.label === 'Market Open'
  useEffect(() => {
    if (!bias?.label) return
    const was = prev.current
    prev.current = bias.label
    if (!on || !open || !was || was === bias.label || !CAN_NOTIFY || Notification.permission !== 'granted') return
    const score = (bias.score > 0 ? '+' : '') + bias.score
    try {
      new Notification(`Market Bias: ${bias.label} (${score})`, {
        body: `Changed from ${was} to ${bias.label} at ${istTime(new Date()).slice(0, 5)} IST`,
        tag: 'nse-bias', icon: favicon })
    } catch { /* some mobile browsers only notify from a service worker */ }
  }, [bias?.label, on, open])
}

function BiasAlertToggle({ on, setOn }) {
  const [perm, setPerm] = useState(CAN_NOTIFY ? Notification.permission : 'denied')
  if (!CAN_NOTIFY) return null
  const active = on && perm === 'granted'
  const click = async () => {
    if (active) return setOn(false)
    const p = perm === 'granted' ? 'granted' : await Notification.requestPermission()
    setPerm(p)
    setOn(p === 'granted')
  }
  const title = perm === 'denied' ? 'Notifications are blocked for this site: allow them in the browser’s site settings, then click again'
    : active ? 'Market Bias alerts ON: you get a notification when the bias changes (market hours, while this page is open). Click to turn off'
    : 'Get a notification when the Market Bias changes (Bullish / Neutral / Bearish)'
  return <button className={'hdr-auto hdr-bell' + (active ? ' on' : '')} onClick={click} title={title} aria-label="Market Bias alerts">
    {active ? '🔔 Bias' : '🔕 Bias'}</button>
}

function StatusBar({ live, auto, setAuto, crypto = false }) {
  const viewers = useViewers()
  const [alertOn, setAlertOn] = usePersistentState('biasAlert', false)
  useBiasAlert(live, alertOn)
  const now = useClock()
  const status = live.data?.market_status?.label
  const delayed = !!live.error && !!live.data
  const ok = !!live.data && !live.error && !live.data.poll_error
  return <div className="hdr-status">
    {crypto  // crypto trades 24x7: on the Crypto page the pill shows that market, not NSE's
      ? <span className="mkt open" title="Crypto markets trade 24 hours a day, 7 days a week">Crypto · Open 24×7</span>
      : <span className={'mkt ' + (status === 'Market Open' ? 'open' : status === 'Pre-Open' ? 'pre' : 'closed')}>{status || '—'}</span>}
    {viewers != null && <span className="hdr-viewers" title={`${viewers} ${viewers === 1 ? 'person has' : 'people have'} used the dashboard in the last 24 hours (stayed at least a minute; bots not counted)`}><i className="live-dot" />{viewers}</span>}
    <span className="hdr-clock" title={`${istDate(now)} · Indian Standard Time`}><span className="hdr-date">{istDate(now)}</span> {istTime(now)} <small>IST</small></span>
    {delayed || live.data?.poll_error
      ? <span className="hdr-delayed" title={`Data delayed — last successful update ${istTime(live.data?.as_of || live.lastOk)} IST · ${live.error || live.data?.poll_error}`}><i className="dot amber" />Delayed · {hhmm(live.data?.as_of || live.lastOk)}</span>
      : <span className="hdr-upd" title={`Last updated ${live.data?.as_of ? istTime(live.data.as_of) : '…'} IST`}><i className={'dot ' + (ok && auto ? 'green' : 'grey')} />Updated {live.data?.as_of ? hhmm(live.data.as_of) : '…'}</span>}
    <button className={'hdr-auto' + (auto ? ' on' : '')} onClick={() => setAuto(a => !a)} title={auto ? 'Auto refresh is ON (every 10 seconds) — click to pause' : 'Auto refresh is OFF — click to resume'}>
      {auto ? 'Auto ✓ 10s' : 'Auto off'}</button>
    {!crypto && <BiasAlertToggle on={alertOn} setOn={setAlertOn} />}
  </div>
}

function App() {
  const [page, setPage] = useState('overview')  // every load/refresh starts on the homepage
  const [selected, setSelected] = useSessionState('sectors', [])
  const [auto, setAuto] = usePersistentState('auto', true)
  const [tf, setTf] = useSessionState('orb.tf.v4', 15)  // break candle: 5 or 15 min
  const [confirm3, setConfirm3] = useSessionState('orb.confirmMode', 1)  // 3-min confirmation: 0 off, 1 beyond break close, 2 beyond OR level
  const [orbFilters, setOrbFilters] = useSessionState('orb.filters.v3', DEFAULT_FILTERS)  // v3: defaults = full-day volume basis, F&O universe
  const [orbView, setOrbView] = useSessionState('orb.view', 15)  // ORB Scanner sub-tab: 5 / 15 / 30 / 60-minute opening range (15 default)
  // 15-minute ORB scanner: same rules, its own independent settings
  const [tf15, setTf15] = useSessionState('orb15.tf', 15)
  const [confirm15, setConfirm15] = useSessionState('orb15.confirmMode', 1)
  const [orbFilters15, setOrbFilters15] = useSessionState('orb15.filters', DEFAULT_FILTERS)
  // 5-minute ORB scanner: same rules, its own independent settings
  const [tf5, setTf5] = useSessionState('orb5.tf', 5)
  const [confirm5, setConfirm5] = useSessionState('orb5.confirmMode', 1)
  const [orbFilters5, setOrbFilters5] = useSessionState('orb5.filters', DEFAULT_FILTERS)
  // 30-minute ORB scanner: same rules, its own independent settings
  const [tf30, setTf30] = useSessionState('orb30.tf', 15)
  const [confirm30, setConfirm30] = useSessionState('orb30.confirmMode', 1)
  const [orbFilters30, setOrbFilters30] = useSessionState('orb30.filters', DEFAULT_FILTERS)

  const live = usePoll(() => api('/api/live'), auto ? REFRESH_MS : 3.6e6, [auto])
  // ORB scans refresh every 10 s only where they are shown (ORB Scanner; Intraday Scanner's Common Stocks);
  // elsewhere once a minute, just for the menu badge.
  const orbMs = !auto ? 3.6e6 : page === 'scanner' || page === 'trend' ? REFRESH_MS : 60000
  const orb = usePoll(() => api(`/api/orb?tf=${tf}&confirm=${Number(confirm3)}&orm=60`), orbMs, [orbMs, tf, confirm3])
  const orb15 = usePoll(() => api(`/api/orb?tf=${tf15}&confirm=${Number(confirm15)}&orm=15`), orbMs, [orbMs, tf15, confirm15])
  const orb5 = usePoll(() => api(`/api/orb?tf=${tf5}&confirm=${Number(confirm5)}&orm=5`), orbMs, [orbMs, tf5, confirm5])
  const orb30 = usePoll(() => api(`/api/orb?tf=${tf30}&confirm=${Number(confirm30)}&orm=30`), orbMs, [orbMs, tf30, confirm30])
  const ctx = usePoll(() => api('/api/context'), 60000, [])
  const trend = usePoll(() => api('/api/trend'), page === 'trend' ? 30000 : 3.6e6, [page === 'trend'])
  const crypto = usePoll(() => api('/api/crypto'), page === 'crypto' ? 10000 : 3.6e6, [page === 'crypto'])
  const ipo = usePoll(() => api('/api/ipo'), page === 'ipo' ? 30000 : 300000, [page === 'ipo'])

  const toggleSector = useCallback(sym => setSelected(s => s.includes(sym) ? s.filter(x => x !== sym) : [...s, sym]), [setSelected])
  const orbCount = orb.data?.rows ? filterRows(orb.data.rows, orbFilters, selected, orb.data).length : null
  const orb15Count = orb15.data?.rows ? filterRows(orb15.data.rows, orbFilters15, selected, orb15.data).length : null
  const orb5Count = orb5.data?.rows ? filterRows(orb5.data.rows, orbFilters5, selected, orb5.data).length : null
  const orb30Count = orb30.data?.rows ? filterRows(orb30.data.rows, orbFilters30, selected, orb30.data).length : null
  const orbLists = { 15: orb15.data?.rows && filterRows(orb15.data.rows, orbFilters15, selected, orb15.data), 30: orb30.data?.rows && filterRows(orb30.data.rows, orbFilters30, selected, orb30.data), 60: orb.data?.rows && filterRows(orb.data.rows, orbFilters, selected, orb.data) }
  const orbNow = { 5: [orb5Count, '5 Min'], 15: [orb15Count, '15 Min'], 30: [orb30Count, '30 Min'], 60: [orbCount, '1 Hour'] }[orbView] || [orb15Count, '15 Min']

  // Chart icon next to any stock symbol -> Intraday Scanner, Live Chart tab, that stock.
  const [chartReq, setChartReq] = useState(0)
  const openStockChart = useCallback(sym => {
    setSessionValue('slive.sym', sym); setSessionValue('scans.tab', 'chart')
    setChartReq(n => n + 1); setPage('trend'); window.scrollTo({ top: 0 })
  }, [])

  // Today's Top 20 F&O gainers / losers (same ranking as the Sector Heatmap list), tagged in every scanner.
  const [topOnly, setTopOnly] = useSessionState('top20.only', '')  // scanners: '' all, 'up' Top 20 gainers, 'down' losers
  const topMovers = useMemo(() => {
    const fo = (live.data?.stocks || []).filter(s => s.fo && Number.isFinite(s.pct_prev)).sort((a, b) => b.pct_prev - a.pct_prev)
    const n = Math.min(20, Math.floor(fo.length / 2)), out = {}
    fo.slice(0, n).forEach((s, i) => { if (s.pct_prev > 0) out[s.symbol] = ['up', i + 1] })
    fo.slice(-n).reverse().forEach((s, i) => { if (s.pct_prev < 0) out[s.symbol] = ['down', i + 1] })
    return { map: out, only: topOnly, setOnly: setTopOnly }
  }, [live.data?.stocks, topOnly])
  return <StockChartCtx.Provider value={openStockChart}><TopMoversCtx.Provider value={topMovers}><div className="app">
    <header className="hdr">
      <button className="hdr-brand" onClick={() => { setPage('overview'); window.scrollTo({ top: 0 }) }} title="Go to homepage (Market Overview)">
        <span>NSE Sector Heatmap</span></button>
      <nav className="hdr-nav">
        {PAGES.map(p => <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => setPage(p.id)}>
          {p.label}
          {p.id === 'heatmap' && selected.length ? <span className="badge">{selected.length}</span> : null}
          {p.id === 'scanner' && orbNow[0] != null ? <span className="badge" title={`Signals passing the current ${orbNow[1]} ORB filters`}>{orbNow[0]}</span> : null}
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
      <Suspense fallback={<div className="empty">Loading…</div>}>
        {page === 'trend' && <Scans trend={trend} live={live.data} selected={selected} setSelected={setSelected} chartReq={chartReq} orbLists={orbLists} />}
        {page === 'crypto' && <Crypto crypto={crypto} />}
        {page === 'ipo' && <Ipo ipo={ipo} />}
        {page === 'learning' && <Learning />}
        {page === 'journal' && <Journal live={live.data} />}
      </Suspense>
      {page === 'scanner' && <>
        <div className="orb-switch" role="tablist" aria-label="Opening range">
          {[[5, '5 Min ORB', '09:15–09:20', orb5Count], [15, '15 Min ORB', '09:15–09:30', orb15Count], [30, '30 Min ORB', '09:15–09:45', orb30Count], [60, '1 Hour ORB', '09:15–10:15', orbCount]].map(([v, label, range, n]) =>
            <button key={v} role="tab" aria-selected={orbView === v} className={orbView === v ? 'on' : ''} onClick={() => setOrbView(v)}>
              {label} <small>{range}</small>{n != null && <span className="count">{n}</span>}</button>)}
        </div>
        {orbView === 60
          ? <Scanner key="orb60" orm={60} orb={orb} live={live.data} selected={selected} setSelected={setSelected} tf={tf} setTf={setTf} confirm3={confirm3} setConfirm3={setConfirm3} f={orbFilters} setF={setOrbFilters} />
          : orbView === 5
          ? <Scanner key="orb5" orm={5} orb={orb5} live={live.data} selected={selected} setSelected={setSelected} tf={tf5} setTf={setTf5} confirm3={confirm5} setConfirm3={setConfirm5} f={orbFilters5} setF={setOrbFilters5} />
          : orbView === 30
          ? <Scanner key="orb30" orm={30} orb={orb30} live={live.data} selected={selected} setSelected={setSelected} tf={tf30} setTf={setTf30} confirm3={confirm30} setConfirm3={setConfirm30} f={orbFilters30} setF={setOrbFilters30} />
          : <Scanner key="orb15" orm={15} orb={orb15} live={live.data} selected={selected} setSelected={setSelected} tf={tf15} setTf={setTf15} confirm3={confirm15} setConfirm3={setConfirm15} f={orbFilters15} setF={setOrbFilters15} />}
      </>}
    </main>
    <footer className="foot">
      Decision-support scanner — no buy/sell, target or stop-loss recommendations. Data: NSE (indices, quotes, per-minute prices, bhavcopy volumes, FII/DII, GIFT Nifty, market status), BSE (Sensex), Yahoo Finance (overseas indices, Scanner candles, opening-range fallback).
      {live.data?.source_ts && <> Latest NSE quote: {istDate(nseTs(live.data.source_ts))} {istTime(nseTs(live.data.source_ts))} IST.</>}
    </footer>
  </div></TopMoversCtx.Provider></StockChartCtx.Provider>
}

createRoot(document.getElementById('root')).render(<App />)
