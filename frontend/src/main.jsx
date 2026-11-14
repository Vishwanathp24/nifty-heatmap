import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import favicon from './icons/favicon-64.png'
import { api, istDate, istTime, nseTs, setSessionValue, useClock, usePersistentState, useSessionState, usePoll } from './lib.js'
import { StockChartCtx, TopMoversCtx } from './components.jsx'
import Overview from './Overview.jsx'
import Heatmap from './Heatmap.jsx'
import Scanner, { DEFAULT_FILTERS, filterRows } from './Scanner.jsx'
import { MiniCards } from './Pcr.jsx'
import { PageHowTo } from './guides.jsx'
import InfoPage, { INFO_PAGES, InfoLinks } from './Legal.jsx'
import InstallPrompt, { openInstall, useCanInstall } from './InstallPrompt.jsx'
// Pages loaded only when opened (smaller first download)
// Pages loaded on demand. A tab left open across a site update still asks for the previous version's file
// names, which no longer exist after a deploy: instead of a blank page, reload once to get the latest version
// (at most once a minute, so a real outage does not loop).
const lazyPage = load => lazy(() => load().catch(err => {
  let last = 0
  try { last = Number(sessionStorage.getItem('nseid:chunkReload')) || 0 } catch { /* private mode */ }
  if (Date.now() - last > 60000) {
    try { sessionStorage.setItem('nseid:chunkReload', String(Date.now())); sessionStorage.setItem('nseid:chunkPage', window.location.pathname) } catch { /* private mode */ }
    window.location.reload()
    return new Promise(() => {})  // keep showing "Updating…" until the reload happens
  }
  throw err
}))
const Crypto = lazyPage(() => import('./Crypto.jsx'))
const Ipo = lazyPage(() => import('./Ipo.jsx'))
const Learning = lazyPage(() => import('./Learning.jsx'))
const Journal = lazyPage(() => import('./Journal.jsx'))
const Scans = lazyPage(() => import('./Scans.jsx'))  // Intraday Scanner: charts, option chain, payoff tools - loaded when opened

const REFRESH_MS = 10000
const PAGES = [
  { id: 'overview', label: 'Market Overview', key: '1' },
  { id: 'heatmap', label: 'Sector Heatmap', key: '2' },
  { id: 'scanner', label: 'ORB Scanner', key: '3' },
  { id: 'trend', label: 'Intraday Scanner', key: '4' },
  { id: 'crypto', label: 'Crypto', key: '6' },
  { id: 'ipo', label: 'IPO', key: '7' },
  { id: 'learning', label: 'Learning', key: '8' },
].filter(p => !import.meta.env.VITE_PAGES || import.meta.env.VITE_PAGES.split(',').includes(p.id))  // VITE_PAGES: build with only these pages (Netlify copy)

// Phones: app layout with a bottom tab bar (more than 5 pages, as in Advanced: the rest go under "More").
// One line-icon set (24px grid, drawn in the text colour) so every tab looks the same.
const TAB_PATHS = {
  overview: 'M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10',
  heatmap: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  scanner: 'M12 8v5l3 2M9 2h6M12 4a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  crypto: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 8h4a2 2 0 0 1 0 4h-4zm0 4h4.5a2 2 0 0 1 0 4H9.5zM9.5 8v8M11 6v2M11 16v2',
  ipo: 'M5 21V4M5 4h11l-2 4 2 4H5',
  learning: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 21V5M8 7h7',
  journal: 'M5 3h11l3 3v15H5zM8 9h8M8 13h8M8 17h5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
}
const TabIcon = ({ id }) => <svg className="tab-ic" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
  strokeWidth={id === 'more' ? 3.2 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={TAB_PATHS[id]} /></svg>
const TAB_SHORT = { overview: 'Overview', heatmap: 'Heatmap', scanner: 'ORB', trend: 'Intraday', crypto: 'Crypto', ipo: 'IPO', learning: 'Learning', journal: 'Journal' }

// Footer link that opens the Add to Home Screen banner (phones / tablets not using the app yet).
function InstallLink() {
  const where = useCanInstall()
  return where ? <div className="install-link"><button className="btn sm" onClick={openInstall}>{where === 'phone' ? '📲 Add to Home Screen' : '⭐ Bookmark this site'}</button></div> : null
}

function TabBar({ pages, page, setPage, badges }) {
  const [more, setMore] = useState(false)
  const canInstall = useCanInstall()
  const main = pages.length > 5 ? pages.slice(0, 4) : pages, rest = pages.length > 5 ? pages.slice(4) : []
  const go = id => { setMore(false); setPage(id); window.scrollTo({ top: 0 }) }
  const tab = p => <button key={p.id} className={'tab' + (page === p.id ? ' on' : '')} onClick={() => go(p.id)}>
    <span className="tab-icw"><TabIcon id={p.id} />{badges[p.id] ? <span className="tab-badge">{badges[p.id]}</span> : null}</span>{TAB_SHORT[p.id]}</button>
  return <>
    {more && <div className="tab-sheet-bg" onClick={() => setMore(false)}><div className="tab-sheet" onClick={e => e.stopPropagation()}>
      <div className="tab-sheet-k">More pages</div>{rest.map(tab)}
      {canInstall === 'phone' && <button className="tab install-tab" onClick={() => { setMore(false); openInstall() }}><span className="tab-icw">📲</span>Install app</button>}</div></div>}
    <nav className="tabbar" aria-label="Pages">{main.map(tab)}
      {rest.length > 0 && <button className={'tab' + (rest.some(p => p.id === page) ? ' on' : more ? ' open' : '')} onClick={() => setMore(m => !m)}>
        <span className="tab-icw"><TabIcon id="more" /></span>More</button>}</nav>
  </>
}

// Advanced top menu: pages listed here would sit under one dropdown instead of their own links (none now:
// Journal was removed and Learning is a normal menu item).
const MENU_IDS = []
function NavMenu({ pages, page, go }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const off = e => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const esc = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', off); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', off); document.removeEventListener('keydown', esc) }
  }, [open])
  if (!pages.length) return null
  const cur = pages.find(p => p.id === page)
  return <div className={'nav-menu' + (cur ? ' active' : '') + (open ? ' open' : '')} ref={ref}>
    <button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>Learn &amp; Track <span className="nav-caret">▾</span></button>
    {open && <div className="nav-menu-list" role="menu">{pages.map(p => <a key={p.id} role="menuitem" href={PATHS[p.id]} className={page === p.id ? 'active' : ''}
      onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); setOpen(false); go(p.id) }}>{p.label}</a>)}</div>}
  </div>
}

// Basic site (header switch): only these pages, exactly as in Advanced.
const BASIC_PAGES = ['overview', 'heatmap', 'scanner', 'trend']  // Intraday Scanner in Basic shows 3 scans only (Scans.jsx BASIC_TABS)

// One real URL per page, so each can be linked, indexed and shared. The server serves the same app for these paths.
const PATHS = { overview: '/', heatmap: '/heatmap', scanner: '/orb-scanner', trend: '/intraday-scanner', crypto: '/crypto', ipo: '/ipo', learning: '/learning',  // /journal (removed) opens Market Overview
  ...Object.fromEntries(INFO_PAGES.map(p => [p.id, p.path])) }  // + About, Contact, Privacy Policy, Terms of Use, Disclaimer (footer links)
const INFO_IDS = INFO_PAGES.map(p => p.id)
const pageFromPath = path => Object.keys(PATHS).find(id => PATHS[id] === path.replace(/(.)\/$/, '$1')) || 'overview'

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

// Market Bias and Nifty OI Change alerts: a notification when either label (Bullish / Neutral / Bearish)
// changes during market hours (the server sends both by web push; the in-page fallback covers Market Bias). Works while the dashboard is open, even in a background tab.
// Phones show notifications only through a service worker (sw.js); iPhones only for the
// site added to the Home Screen (iOS 16.4+), so there the button explains how.
const CAN_NOTIFY = typeof window !== 'undefined' && 'Notification' in window
const IS_IOS = typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {})
// Web push: the server sends the alert, so it arrives with the phone locked or the app closed.
const b64ToBytes = b => Uint8Array.from(atob((b + '='.repeat((4 - b.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
async function pushSubscribe() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false
  try {
    const reg = await navigator.serviceWorker.ready
    const { key } = await api('/api/push/key')
    const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) })
    await api('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) })
    return true
  } catch { return false }
}
async function pushUnsubscribe() {
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
    if (!sub) return
    await api('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {})
    await sub.unsubscribe()
  } catch { /* nothing to undo */ }
}
function showAlert(title, opts) {
  const reg = 'serviceWorker' in navigator ? navigator.serviceWorker.getRegistration() : Promise.resolve(null)
  reg.then(r => r ? r.showNotification(title, opts) : new Notification(title, opts))
    .catch(() => { try { new Notification(title, opts) } catch { /* no way to notify here */ } })
}
function useBiasAlert(live, on) {  // in-page alert, used only where web push isn't available
  const prev = useRef(null)
  const bias = live.data?.bias, open = live.data?.market_status?.label === 'Market Open'
  useEffect(() => {
    if (!bias?.label) return
    const was = prev.current
    prev.current = bias.label
    if (!on || !open || !was || was === bias.label || !CAN_NOTIFY || Notification.permission !== 'granted') return
    const score = (bias.score > 0 ? '+' : '') + bias.score
    showAlert(`Market Bias: ${bias.label} (${score})`, {
      body: `Changed from ${was} to ${bias.label} at ${istTime(new Date()).slice(0, 5)} IST`,
      tag: 'nse-bias', icon: favicon })
  }, [bias?.label, on, open])
}

function BiasAlertToggle({ on, setOn, setPushed }) {
  const [perm, setPerm] = useState(CAN_NOTIFY ? Notification.permission : 'denied')
  if (!CAN_NOTIFY) return IS_IOS ? <button className="hdr-auto hdr-bell" aria-label="Market Bias and Nifty OI Change alerts" onClick={() => alert(
    'Market Bias and Nifty OI Change alerts on iPhone:\n\n1. Open this site in Safari (or Chrome), tap Share, then "Add to Home Screen".\n'
    + '2. Open the dashboard from the new Home Screen icon.\n3. Tap 🔕 Bias there and choose Allow.\n\n(Needs iOS 16.4 or newer.)')}>🔕 Bias</button> : null
  const active = on && perm === 'granted'
  const click = async () => {
    if (active) { setOn(false); setPushed(false); return pushUnsubscribe() }
    const p = perm === 'granted' ? 'granted' : await Notification.requestPermission()
    setPerm(p)
    setOn(p === 'granted')
    if (p === 'granted') setPushed(await pushSubscribe())
  }
  const title = perm === 'denied' ? 'Notifications are blocked for this site: allow them in the browser’s site settings, then click again'
    : active ? 'Alerts ON: you get a notification when Market Bias or Nifty OI Change turns Bullish / Neutral / Bearish during market hours, even with the phone locked. Click to turn off'
    : 'Get a notification when Market Bias or Nifty OI Change turns Bullish / Neutral / Bearish'
  return <button className={'hdr-auto hdr-bell' + (active ? ' on' : '')} onClick={click} title={title} aria-label="Market Bias and Nifty OI Change alerts">
    {active ? '🔔 Bias' : '🔕 Bias'}</button>
}

function StatusBar({ live, auto, setAuto, crypto = false }) {
  const viewers = useViewers()
  const [alertOn, setAlertOn] = usePersistentState('biasAlert', false)
  const [pushed, setPushed] = usePersistentState('biasPush', false)  // server push active: skip the in-page alert
  useBiasAlert(live, alertOn && !pushed)
  useEffect(() => { if (alertOn && CAN_NOTIFY && Notification.permission === 'granted') pushSubscribe().then(setPushed) }, [])  // keep the server's copy fresh
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
      : <span className="hdr-upd" title={`Last updated ${live.data?.as_of ? istTime(live.data.as_of) : '…'} IST`}><i className={'dot ' + (ok && auto ? 'green' : 'grey')} /><span className="hdr-upd-k">Updated </span>{live.data?.as_of ? hhmm(live.data.as_of) : '…'}</span>}
    <button className={'hdr-auto' + (auto ? ' on' : '')} onClick={() => setAuto(a => !a)} title={auto ? 'Auto refresh is ON (every 10 seconds) — click to pause' : 'Auto refresh is OFF — click to resume'}>
      {auto ? 'Auto ✓ 10s' : 'Auto off'}</button>
    {!crypto && <BiasAlertToggle on={alertOn} setOn={setAlertOn} setPushed={setPushed} />}
  </div>
}

// If a page still fails to load (offline, or the reload above already happened), show a message and a
// Reload button instead of a blank page.
class PageBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidUpdate(prev) { if (prev.page !== this.props.page && this.state.err) this.setState({ err: null }) }
  render() {
    return this.state.err
      ? <div className="empty">This page could not load (a newer version of the site may be available, or the connection dropped).
        <div style={{ marginTop: 10 }}><button className="btn primary" onClick={() => window.location.reload()}>Reload</button></div></div>
      : this.props.children
  }
}

function App() {
  // Every visit opens on Market Overview, whatever page address it was opened with (bookmark, home-screen app,
  // shared link). Exceptions: the info pages (About, Privacy, Terms…) and search-engine bots, which need the
  // page their address names.
  const [page, setPageState] = useState(() => {
    const p = pageFromPath(window.location.pathname)
    let back = null  // after an update reload (lazyPage), go back to the page that was being opened
    try { back = sessionStorage.getItem('nseid:chunkPage'); sessionStorage.removeItem('nseid:chunkPage') } catch { /* private mode */ }
    if (back) return pageFromPath(back)
    return AUTOMATED || INFO_IDS.includes(p) ? p : 'overview'
  })
  useEffect(() => { if (page === 'overview' && window.location.pathname !== '/') window.history.replaceState(null, '', '/') }, [])
  const setPage = useCallback(id => {
    setPageState(id)
    if (window.location.pathname !== PATHS[id]) window.history.pushState(null, '', PATHS[id])
    if (INFO_IDS.includes(id)) window.scrollTo({ top: 0 })
  }, [])
  useEffect(() => {  // browser back/forward
    const onPop = () => setPageState(pageFromPath(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const [fullData, setFullData] = usePersistentState('fullData', false)  // phones / tablets: original full panels instead of small cards
  // Every visit opens Basic on phones (a page Basic doesn't have opens the home page instead) and Advanced on
  // larger screens; a switch lasts until the page is reloaded.
  const [mode, setMode] = useState(() => window.matchMedia('(max-width: 600px)').matches ? 'basic' : 'advanced')
  const basic = mode === 'basic'
  useEffect(() => { if (basic && !BASIC_PAGES.includes(page) && !INFO_IDS.includes(page)) setPage('overview') }, [basic, page])
  const navPages = basic ? PAGES.filter(p => BASIC_PAGES.includes(p.id)) : PAGES
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
  // Data for other pages is prefetched a few seconds after load, so it doesn't slow the page being opened.
  const later = (on, path) => on ? api(path) : new Promise(r => setTimeout(r, 8000)).then(() => api(path))
  const trend = usePoll(() => later(page === 'trend', '/api/trend'), page === 'trend' ? 30000 : 3.6e6, [page === 'trend'])
  const crypto = usePoll(() => later(page === 'crypto', '/api/crypto'), page === 'crypto' ? 10000 : 3.6e6, [page === 'crypto'])
  const ipo = usePoll(() => later(page === 'ipo', '/api/ipo'), page === 'ipo' ? 30000 : 300000, [page === 'ipo'])

  // Today's Top 20 F&O gainers / losers (same ranking as the Sector Heatmap list), tagged in every scanner.
  // Scanners (Basic and Advanced): one on/off button for Top 20 gainers + losers, on by default; tap off to see all stocks
  const [topOn, setTopOn] = useSessionState('top20.on', true)
  const topMovers = useMemo(() => {
    const fo = (live.data?.stocks || []).filter(s => s.fo && Number.isFinite(s.pct_prev)).sort((a, b) => b.pct_prev - a.pct_prev)
    const n = Math.min(20, Math.floor(fo.length / 2)), out = {}
    fo.slice(0, n).forEach((s, i) => { if (s.pct_prev > 0) out[s.symbol] = ['up', i + 1] })
    fo.slice(-n).reverse().forEach((s, i) => { if (s.pct_prev < 0) out[s.symbol] = ['down', i + 1] })
    return { map: out, only: topOn ? 'both' : '', topOn, setTopOn }
  }, [live.data?.stocks, topOn])
  const topCut = rows => topOn ? rows.filter(r => topMovers.map[r.symbol]) : rows  // tab counts match the list shown
  const toggleSector = useCallback(sym => setSelected(s => s.includes(sym) ? s.filter(x => x !== sym) : [...s, sym]), [setSelected])
  const orbCount = orb.data?.rows ? topCut(filterRows(orb.data.rows, orbFilters, selected, orb.data)).length : null
  const orb15Count = orb15.data?.rows ? topCut(filterRows(orb15.data.rows, orbFilters15, selected, orb15.data)).length : null
  const orb5Count = orb5.data?.rows ? topCut(filterRows(orb5.data.rows, orbFilters5, selected, orb5.data)).length : null
  const orb30Count = orb30.data?.rows ? topCut(filterRows(orb30.data.rows, orbFilters30, selected, orb30.data)).length : null
  const orbLists = { 15: orb15.data?.rows && filterRows(orb15.data.rows, orbFilters15, selected, orb15.data), 30: orb30.data?.rows && filterRows(orb30.data.rows, orbFilters30, selected, orb30.data), 60: orb.data?.rows && filterRows(orb.data.rows, orbFilters, selected, orb.data) }
  const orbNow = { 5: [orb5Count, '5 Min'], 15: [orb15Count, '15 Min'], 30: [orb30Count, '30 Min'], 60: [orbCount, '1 Hour'] }[orbView] || [orb15Count, '15 Min']

  // Chart icon next to any stock symbol -> Intraday Scanner, Live Chart tab, that stock.
  const [chartReq, setChartReq] = useState(0)
  const openStockChart = useCallback(sym => {
    setSessionValue('slive.sym', sym); setSessionValue('scans.tab', 'chart')
    setChartReq(n => n + 1); setMode('advanced'); setPage('trend'); window.scrollTo({ top: 0 })  // the Live Chart is an Advanced page
  }, [])

  return <StockChartCtx.Provider value={openStockChart}><TopMoversCtx.Provider value={topMovers}><div className={'app tab-app' + (fullData ? ' full-data' : '')}>
    <header className="hdr">
      <button className="hdr-brand" onClick={() => { setPage('overview'); window.scrollTo({ top: 0 }) }} title="Go to homepage (Market Overview)">
        <span>NSE Sector Heatmap</span></button>
      <div className="seg mode-switch" role="group" aria-label="Site version">
        {[['basic', 'Basic'], ['advanced', 'Advanced']].map(([v, l]) => <button key={v} className={mode === v ? 'on' : ''} onClick={() => setMode(v)}
          title={v === 'basic' ? 'Simple view: Market Overview, Sector Heatmap, ORB Scanner and 3 intraday scans' : 'Full view: every scanner, chart and tool'}>{l}</button>)}
      </div>
      <button className={'full-toggle' + (fullData ? ' on' : '')} role="switch" aria-checked={fullData} onClick={() => setFullData(f => !f)}
        title="Phones and tablets: show the full data panels (as in the first version) instead of the small cards"><i />Full data</button>
      <nav className="hdr-nav">
        {navPages.filter(p => !MENU_IDS.includes(p.id)).map(p => <a key={p.id} href={PATHS[p.id]} className={page === p.id ? 'active' : ''} onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); setPage(p.id) }}>
          {p.label}
          {p.id === 'heatmap' && selected.length ? <span className="badge">{selected.length}</span> : null}
          {p.id === 'scanner' && orbNow[0] != null ? <span className="badge" title={`Signals passing the current ${orbNow[1]} ORB filters`}>{orbNow[0]}</span> : null}
        </a>)}
      <NavMenu pages={navPages.filter(p => MENU_IDS.includes(p.id))} page={page} go={setPage} />
      </nav>
      <StatusBar live={live} auto={auto} setAuto={setAuto} crypto={page === 'crypto'} />
    </header>
    <main className="page">
      {live.error && !live.data && <div className="alert">{live.error}</div>}
      {/* Market Bias, OI Change, PCR, Expected Move, breadth and FII / DII as small cards on every page except Crypto;
          on Overview / Heatmap only in the phone / tablet views (desktop has the full panels) */}
      {page !== 'crypto' && !INFO_IDS.includes(page) && <MiniCards always={page !== 'heatmap' ? true : fullData && 'full'} bias={live.data?.bias} breadth={live.data?.breadth} fiiDii={ctx.data?.fii_dii?.data} nifty={live.data?.indices?.nifty50} />}
      {page === 'journal' && <div className="mini-strip"><div id="journal-account-slot" className="mini-slot" /></div>}  {/* Journal puts its sign-in / saved status here */}
      {page === 'overview' && <Overview live={live.data} ctx={ctx.data} openOptionSelling={() => { setSessionValue('scans.tab', 'osell'); setMode('advanced'); setPage('trend'); window.scrollTo({ top: 0 }) }} />}
      {page === 'heatmap' && <Heatmap live={live.data} selected={selected} setSelected={setSelected} toggle={toggleSector} goto={setPage} />}
      <PageBoundary page={page}><Suspense fallback={<div className="empty">Loading… (updating to the latest version if the site was just updated)</div>}>
        {page === 'trend' && <Scans basic={basic} trend={trend} live={live.data} selected={selected} setSelected={setSelected} chartReq={chartReq} orbLists={orbLists} />}
        {page === 'crypto' && <Crypto crypto={crypto} />}
        {INFO_IDS.includes(page) && <InfoPage id={page} />}
        {page === 'ipo' && <Ipo ipo={ipo} />}
        {page === 'learning' && <Learning />}
        {page === 'journal' && <Journal live={live.data} />}
      </Suspense></PageBoundary>
      {page === 'scanner' && <>
        <div className="orb-switch" role="tablist" aria-label="Opening range">
          {[[5, '5 Min ORB', '09:15–09:20', orb5Count], [15, '15 Min ORB', '09:15–09:30', orb15Count], [30, '30 Min ORB', '09:15–09:45', orb30Count], [60, '1 Hour ORB', '09:15–10:15', orbCount]].map(([v, label, range, n]) =>
            <button key={v} role="tab" aria-selected={orbView === v} className={orbView === v ? 'on' : ''} onClick={() => setOrbView(v)}>
              {label.replace(' ORB', '')}<span className="hide-m"> ORB</span> <small>{range}</small>{n != null && <span className="count">{n}</span>}</button>)}
        </div>
        {orbView === 60
          ? <Scanner key="orb60" orm={60} orb={orb} live={live.data} selected={selected} setSelected={setSelected} tf={tf} setTf={setTf} confirm3={confirm3} setConfirm3={setConfirm3} f={orbFilters} setF={setOrbFilters} />
          : orbView === 5
          ? <Scanner key="orb5" orm={5} orb={orb5} live={live.data} selected={selected} setSelected={setSelected} tf={tf5} setTf={setTf5} confirm3={confirm5} setConfirm3={setConfirm5} f={orbFilters5} setF={setOrbFilters5} />
          : orbView === 30
          ? <Scanner key="orb30" orm={30} orb={orb30} live={live.data} selected={selected} setSelected={setSelected} tf={tf30} setTf={setTf30} confirm3={confirm30} setConfirm3={setConfirm30} f={orbFilters30} setF={setOrbFilters30} />
          : <Scanner key="orb15" orm={15} orb={orb15} live={live.data} selected={selected} setSelected={setSelected} tf={tf15} setTf={setTf15} confirm3={confirm15} setConfirm3={setConfirm15} f={orbFilters15} setF={setOrbFilters15} />}
      </>}
      <PageHowTo page={page} />  {/* Market Overview has its own (with the live 3-step check) */}
    </main>
    <InstallPrompt />  {/* phones / tablets not using the home-screen app yet */}
    <TabBar pages={navPages} page={page} setPage={setPage} badges={{ heatmap: selected.length || null, scanner: orbNow[0] }} />
    <footer className="foot">
      <InfoLinks go={setPage} />
      <InstallLink />
      Decision-support scanner — no buy/sell, target or stop-loss recommendations. Data: NSE (indices, quotes, per-minute prices, bhavcopy volumes, FII/DII, GIFT Nifty, market status), BSE (Sensex), Yahoo Finance (overseas indices, Scanner candles, opening-range fallback).
      {live.data?.source_ts && <> Latest NSE quote: {istDate(nseTs(live.data.source_ts))} {istTime(nseTs(live.data.source_ts))} IST.</>}
    </footer>
  </div></TopMoversCtx.Provider></StockChartCtx.Provider>
}

createRoot(document.getElementById('root')).render(<App />)
