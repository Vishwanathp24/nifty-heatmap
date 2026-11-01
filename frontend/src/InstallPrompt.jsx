import React, { useEffect, useState } from 'react'

// "Add to Home Screen" nudge for phones and tablets that are not using the installed app yet;
// on desktop, a "Bookmark this site" nudge (browsers let a page suggest it, not add the bookmark itself).
// Android / Chrome: our button opens the browser's own install dialog (beforeinstallprompt).
// iPhone / iPad: Apple has no install API, so the banner shows the Share → Add to Home Screen steps.
// Other browsers (or Chrome before it offers the dialog): the banner shows the ⋮ menu → Install app steps.
// Shown 15 s after a page opens on the first visit, 30 s on later visits; × (not now) hides it for 7 days,
// "Don't show again" for 24 hours (a short message says so). Not shown when the app is known to be installed: Android tells us through
// getInstalledRelatedApps() and by not offering the install dialog; an uninstalled app is offered again.
// iPhones give a website no way to know, so there it follows the visit / snooze rules only.

const COMPACT = '(max-width: 600px), (pointer: coarse) and (max-width: 1366px)'
const SNOOZE_DAYS = 7
const HIDE_HOURS = 24  // the "Don't show again" button
const FIRST_DELAY_MS = 15000, LATER_DELAY_MS = 30000

let deferred = null  // Chrome's install event, kept for our button (it fires once, early, so listen at load)
const listeners = new Set()
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; store('installedSeen', null); listeners.forEach(f => f()) })  // offered = not installed (or removed)
  window.addEventListener('appinstalled', () => { deferred = null; store('installedSeen', String(Date.now())); listeners.forEach(f => f()) })
}

function store(k, v) { try { v == null ? localStorage.removeItem('nseid:' + k) : localStorage.setItem('nseid:' + k, v) } catch { /* private mode */ } }
function read(k) { try { return localStorage.getItem('nseid:' + k) } catch { return null } }

// true / false when the browser can tell whether the home-screen app is installed (Android Chrome), null when it can't.
async function installedNow() {
  if (!('getInstalledRelatedApps' in navigator)) return null
  try { return (await navigator.getInstalledRelatedApps()).length > 0 } catch { return null }
}

export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

// Count visits once per browser session.
function visits() {
  let n = Number(read('visits')) || 0
  try {
    if (!sessionStorage.getItem('nseid:visited')) { sessionStorage.setItem('nseid:visited', '1'); n += 1; store('visits', String(n)) }
  } catch { /* private mode */ }
  return n
}

const isMac = () => /Mac/.test(navigator.platform) && navigator.maxTouchPoints < 2

// 'phone' (phones / tablets) or 'desktop' when the nudge applies here, null inside the installed app.
export function useCanInstall() {
  const [, bump] = useState(0)
  useEffect(() => { const f = () => bump(x => x + 1); listeners.add(f); return () => listeners.delete(f) }, [])
  if (typeof window === 'undefined' || isStandalone()) return null
  return window.matchMedia(COMPACT).matches ? 'phone' : 'desktop'
}

export function openInstall() { listeners.forEach(f => f('open')) }

export default function InstallPrompt() {
  const [show, setShow] = useState(false)
  const [note, setNote] = useState(false)  // "won't show for 24 hours" message
  const [, bump] = useState(0)
  const [above, setAbove] = useState(null)  // px from the bottom: just above the phone's tab bar, whatever its height
  useEffect(() => {
    if (!show) return
    const bar = document.querySelector('.tabbar')
    const fit = () => setAbove(bar && bar.offsetHeight ? bar.offsetHeight + 10 : null)
    fit()
    const ro = bar && 'ResizeObserver' in window ? new ResizeObserver(fit) : null
    ro?.observe(bar)
    window.addEventListener('resize', fit)
    return () => { ro?.disconnect(); window.removeEventListener('resize', fit) }
  }, [show])
  useEffect(() => {
    const onChange = how => { if (how === 'open') setShow(true); bump(x => x + 1) }
    listeners.add(onChange)
    let t
    const n = visits()
    if (isStandalone()) { store('installedSeen', String(Date.now())); return () => listeners.delete(onChange) }  // opened from the home screen
    const snoozed = Number(read('installSnooze')) > Date.now()
    if (!snoozed)  // (an older "never" choice now counts as 24 hours, already passed)
      t = setTimeout(async () => {
        if (!deferred) {  // the browser didn't offer installing: maybe it is installed already
          const inst = await installedNow()
          if (inst) return
          if (inst === null && read('installedSeen') && !isIOS()) return
          if (inst === false) store('installedSeen', null)  // was installed, now removed
        }
        setShow(true)
      }, n <= 1 ? FIRST_DELAY_MS : LATER_DELAY_MS)
    return () => { listeners.delete(onChange); clearTimeout(t) }
  }, [])
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(false), 4500); return () => clearTimeout(t) }, [note])
  if (note) return <div className="install-note" role="status">👍 Got it: we won’t show this for the next 24 hours.</div>
  if (!show || isStandalone()) return null
  const desktop = !window.matchMedia(COMPACT).matches
  const ios = !desktop && !deferred && isIOS()
  const close = day => {
    setShow(false)
    store('installSnooze', String(Date.now() + (day ? HIDE_HOURS * 36e5 : SNOOZE_DAYS * 864e5)))
    if (day) setNote(true)
  }
  const install = async () => {
    const e = deferred
    if (!e) return
    e.prompt()
    const { outcome } = await e.userChoice.catch(() => ({ outcome: 'dismissed' }))
    deferred = null
    if (outcome === 'accepted') { setShow(false); store('installedSeen', String(Date.now())) } else close(false)
  }
  return <div className={'install-bar' + (desktop ? ' desk' : '')} role="dialog" aria-label={desktop ? 'Bookmark this site' : 'Install the app'}
    style={above != null && !desktop ? { bottom: above } : undefined}>
    <img src="/icon-192.png" alt="" width="40" height="40" />
    <button className="ib-x" aria-label="Not now" title="Not now" onClick={() => close(false)}>×</button>
    <div className="ib-text">
      <b>{desktop ? 'Bookmark NSE Sector Heatmap' : 'Add NSE Heatmap to your Home Screen'}</b>
      {desktop
        ? <span>Press <kbd>{isMac() ? '⌘' : 'Ctrl'}</kbd> + <kbd>D</kbd> to bookmark this page and come back in one click{deferred ? ', or install it as an app' : ''}.</span>
        : ios
        ? <span>Tap <ShareIcon /> <b>Share</b>, then <b>Add to Home Screen</b> ➕. It opens like an app, and you can get Market Bias and Nifty OI Change alerts.</span>
        : deferred
          ? <span>Opens full screen like an app, loads faster, and can send Market Bias and Nifty OI Change alerts.</span>
          : <span>Tap the browser menu <b>⋮</b> (top right), then <b>Install app</b> or <b>Add to Home screen</b>. It opens like an app and can send Market Bias and Nifty OI Change alerts.</span>}
      <span className="ib-actions">
        {deferred && <button className="btn primary sm" onClick={install}>Install app</button>}
        {desktop && <button className="btn sm" onClick={() => close(false)}>Done</button>}
        <button className="btn ghost sm" onClick={() => close(true)}>Don’t show again</button>
      </span>
    </div>
  </div>
}

const ShareIcon = () => <svg className="ib-share" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"
  strokeLinecap="round" strokeLinejoin="round" aria-label="Share"><path d="M12 3v12M8 7l4-4 4 4M5 11v9h14v-9" /></svg>
