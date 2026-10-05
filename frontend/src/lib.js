import { useEffect, useRef, useState } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE_URL || ''
// Only set for the Netlify build; must match backend/.access_key.
const DASHBOARD_KEY = import.meta.env.VITE_DASHBOARD_KEY || ''

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status }
}

export async function api(path, options) {
  let response
  try {
    response = await fetch(API_BASE + path, {
      ...options,
      headers: { ...(DASHBOARD_KEY ? { 'X-Dashboard-Key': DASHBOARD_KEY } : {}), ...(options?.headers || {}) },
    })
  } catch {
    throw new ApiError('Cannot reach the backend.', 0)
  }
  let data
  try { data = await response.json() } catch { throw new ApiError('Backend returned a non-JSON response (HTTP ' + response.status + ').', response.status) }
  if (!response.ok) throw new ApiError(data.detail || 'Request failed.', response.status)
  return data
}

// ---- TradingView ------------------------------------------------------------------

// Explicit mapping — TradingView index tickers don't follow the NSE display names
// (e.g. NIFTY IT -> CNXIT, NIFTY PVT BANK -> NIFTYPVTBANK). Each was checked
// against TradingView's symbol search.
export const TV_INDEX = {
  'NIFTY 50': 'NSE:NIFTY',
  'NIFTY BANK': 'NSE:BANKNIFTY',
  'SENSEX': 'BSE:SENSEX',
  'INDIA VIX': 'NSE:INDIAVIX',
  'NIFTY IT': 'NSE:CNXIT',
  'NIFTY AUTO': 'NSE:CNXAUTO',
  'NIFTY PHARMA': 'NSE:CNXPHARMA',
  'NIFTY METAL': 'NSE:CNXMETAL',
  'NIFTY REALTY': 'NSE:CNXREALTY',
  'NIFTY FMCG': 'NSE:CNXFMCG',
  'NIFTY MEDIA': 'NSE:CNXMEDIA',
  'NIFTY CEMENT': 'NSE:NIFTY_CEMENT',
  'NIFTY PSU BANK': 'NSE:CNXPSUBANK',
  'NIFTY PVT BANK': 'NSE:NIFTYPVTBANK',
  'NIFTY CAPITAL MKT': 'NSE:NIFTY_CAPITAL_MKT',
  'NIFTY FIN SERVICE': 'NSE:CNXFINANCE',
  'NIFTY CONSR DURBL': 'NSE:NIFTY_CONSR_DURBL',
  'NIFTY CHEMICALS': 'NSE:NIFTY_CHEMICALS',
  'NIFTY OIL AND GAS': 'NSE:NIFTY_OIL_AND_GAS',
  'NIFTY HEALTHCARE': 'NSE:NIFTY_HEALTHCARE',
  'NIFTY IND DEFENCE': 'NSE:NIFTY_IND_DEFENCE',
  'NIFTY ENERGY': 'NSE:CNXENERGY',
  'NIFTY IND DIGITAL': 'NSE:NIFTY_IND_DIGITAL',
  'NIFTY INFRA': 'NSE:CNXINFRA',
  'NIFTY CONSUMPTION': 'NSE:CNXCONSUMPTION',
  'NIFTY COMMODITIES': 'NSE:CNXCOMMODITIES',
  'NIFTY PSE': 'NSE:CNXPSE',
  'NIFTY CPSE': 'NSE:CPSE',
  'NIFTY MNC': 'NSE:CNXMNC',
  'NIFTY SERV SECTOR': 'NSE:CNXSERVICE',
}

const tvUrl = sym => 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(sym)
export const tvStock = symbol => tvUrl('NSE:' + symbol)
export const tvIndex = name => TV_INDEX[name] ? tvUrl(TV_INDEX[name]) : null

// ---- formatting ---------------------------------------------------------------------

const NA = 'N/A'
export const isNum = v => typeof v === 'number' && Number.isFinite(v)
export const fmtNum = (v, d = 2) => isNum(v) ? v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }) : NA
export const fmtPrice = v => isNum(v) ? '₹' + fmtNum(v) : NA
export const fmtSigned = (v, d = 2) => isNum(v) ? (v > 0 ? '+' : '') + fmtNum(v, d) : NA
export const fmtPct = (v, d = 2) => isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(d) + '%' : NA
export const fmtRatio = v => isNum(v) ? v.toFixed(2) + 'x' : NA
export const tone = v => !isNum(v) ? '' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat'

export function fmtVol(v) {
  if (!isNum(v)) return NA
  if (v >= 1e7) return (v / 1e7).toFixed(2) + ' Cr'
  if (v >= 1e5) return (v / 1e5).toFixed(2) + ' L'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + ' K'
  return String(v)
}

export function fmtCr(v) {
  return isNum(v) ? '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) + ' Cr' : NA
}

const IST_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const IST_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })
export const istTime = d => d ? IST_TIME.format(new Date(d)) : NA
export const istDate = d => d ? IST_DATE.format(new Date(d)) : NA

// NSE timestamps arrive as naive IST ("2026-09-25T16:00:28"); pin them to +05:30.
export const nseTs = s => s ? (/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s + '+05:30') : null

export function hhmmTo12(hhmm) {
  if (!hhmm) return NA
  const [h, m] = hhmm.split(':').map(Number)
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}

export function sessionLabel(isoDate) {
  if (!isoDate) return NA
  return istDate(isoDate + 'T12:00:00+05:30')
}

// ---- heat colour ----------------------------------------------------------------------

// Stepped intensity: near-zero grey, then light / medium / dark by magnitude.
export function heatClass(pct) {
  if (!isNum(pct)) return 'heat-na'
  const a = Math.abs(pct)
  if (a < 0.1) return 'heat-0'
  const step = a < 0.5 ? 1 : a < 1 ? 2 : a < 2 ? 3 : 4
  return (pct > 0 ? 'heat-up-' : 'heat-dn-') + step
}

// ---- state persistence ---------------------------------------------------------------

export function usePersistentState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem('nseid:' + key)
      return raw == null ? initial : JSON.parse(raw)
    } catch { return initial }
  })
  useEffect(() => {
    try { localStorage.setItem('nseid:' + key, JSON.stringify(value)) } catch { /* private mode */ }
  }, [key, value])
  return [value, setValue]
}

// Like useState, but kept in memory across page switches within one visit.
// A page reload clears it, so every reload starts from the default filters.
const sessionValues = new Map()
export const setSessionValue = (key, value) => sessionValues.set(key, value)
export function useSessionState(key, initial) {
  const [value, setValue] = useState(() => sessionValues.has(key) ? sessionValues.get(key) : initial)
  useEffect(() => { sessionValues.set(key, value) }, [key, value])
  return [value, setValue]
}

// Poll `fn` every `ms`, keeping the last good data when a refresh fails.
export function usePoll(fn, ms, deps = [], onAuthError) {
  const [state, setState] = useState({ data: null, error: null, lastOk: null, loading: true })
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    let alive = true, timer = null, inflight = false
    async function tick() {
      if (inflight) return
      inflight = true
      try {
        const data = await fnRef.current()
        if (alive) setState({ data, error: null, lastOk: new Date(), loading: false })
      } catch (err) {
        if (err.status === 401 && onAuthError) onAuthError()
        if (alive) setState(s => ({ ...s, error: err.message || 'Refresh failed', loading: false }))
      } finally {
        inflight = false
      }
    }
    setState(s => ({ ...s, loading: true }))
    tick()
    timer = setInterval(tick, ms)
    return () => { alive = false; clearInterval(timer) }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

export function useClock(ms = 1000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), ms); return () => clearInterval(t) }, [ms])
  return now
}

// Generic sort with nulls always last.
export function sortRows(rows, key, dir) {
  if (!key) return rows
  const mul = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key]
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    if (typeof x === 'string') return x.localeCompare(y) * mul
    return (x - y) * mul
  })
}
