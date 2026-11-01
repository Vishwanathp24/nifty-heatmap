import React, { useEffect, useState } from 'react'

// "Add to Home Screen" nudge for phones and tablets that are not using the installed app yet.
// Android / Chrome: our button opens the browser's own install dialog (beforeinstallprompt).
// iPhone / iPad: Apple has no install API, so the banner shows the Share → Add to Home Screen steps.
// Shown from the second visit, 15 s after the page opens; "Not now" hides it for 7 days, "Don't show again" for good.

const COMPACT = '(max-width: 600px), (pointer: coarse) and (max-width: 1366px)'
const SNOOZE_DAYS = 7
const DELAY_MS = 15000

let deferred = null  // Chrome's install event, kept for our button (it fires once, early, so listen at load)
const listeners = new Set()
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; listeners.forEach(f => f()) })
  window.addEventListener('appinstalled', () => { deferred = null; store('installNever', '1'); listeners.forEach(f => f()) })
}

function store(k, v) { try { v == null ? localStorage.removeItem('nseid:' + k) : localStorage.setItem('nseid:' + k, v) } catch { /* private mode */ } }
function read(k) { try { return localStorage.getItem('nseid:' + k) } catch { return null } }

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

// Whether this device can install the app now (for the "Install app" menu item).
export function useCanInstall() {
  const [, bump] = useState(0)
  useEffect(() => { const f = () => bump(x => x + 1); listeners.add(f); return () => listeners.delete(f) }, [])
  if (typeof window === 'undefined' || isStandalone()) return false
  return !!deferred || isIOS()
}

export function openInstall() { listeners.forEach(f => f('open')) }

export default function InstallPrompt() {
  const [show, setShow] = useState(false)
  const [, bump] = useState(0)
  useEffect(() => {
    const onChange = how => { if (how === 'open') setShow(true); bump(x => x + 1) }
    listeners.add(onChange)
    let t
    const n = visits()
    const snoozed = Number(read('installSnooze')) > Date.now()
    if (!isStandalone() && window.matchMedia(COMPACT).matches && n >= 2 && !read('installNever') && !snoozed)
      t = setTimeout(() => (deferred || isIOS()) && setShow(true), DELAY_MS)
    return () => { listeners.delete(onChange); clearTimeout(t) }
  }, [])
  if (!show || isStandalone()) return null
  const ios = !deferred && isIOS()
  if (!deferred && !ios) return null
  const close = never => { setShow(false); never ? store('installNever', '1') : store('installSnooze', String(Date.now() + SNOOZE_DAYS * 864e5)) }
  const install = async () => {
    const e = deferred
    if (!e) return
    e.prompt()
    const { outcome } = await e.userChoice.catch(() => ({ outcome: 'dismissed' }))
    deferred = null
    close(outcome === 'accepted')
  }
  return <div className="install-bar" role="dialog" aria-label="Install the app">
    <img src="/icon-192.png" alt="" width="40" height="40" />
    <div className="ib-text">
      <b>Add NSE Heatmap to your Home Screen</b>
      {ios
        ? <span>Tap <ShareIcon /> <b>Share</b>, then <b>Add to Home Screen</b> ➕. It opens like an app, and you can get Market Bias and Nifty OI Change alerts.</span>
        : <span>Opens full screen like an app, loads faster, and can send Market Bias and Nifty OI Change alerts.</span>}
      <span className="ib-actions">
        {!ios && <button className="btn primary sm" onClick={install}>Install app</button>}
        <button className="btn sm" onClick={() => close(false)}>Not now</button>
        <button className="btn ghost sm" onClick={() => close(true)}>Don’t show again</button>
      </span>
    </div>
  </div>
}

const ShareIcon = () => <svg className="ib-share" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"
  strokeLinecap="round" strokeLinejoin="round" aria-label="Share"><path d="M12 3v12M8 7l4-4 4 4M5 11v9h14v-9" /></svg>
