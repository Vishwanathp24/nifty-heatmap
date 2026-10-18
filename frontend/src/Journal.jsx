import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, isNum, usePersistentState } from './lib.js'
import { VIEWS, BIAS_VIEW, BUYER, FIT, refStrikes } from './OptionTools.jsx'
import { IndexCard } from './Overview.jsx'

// Journal — the user's own options trade log. Pick option buyer / seller, the underlying (Nifty, Sensex,
// an F&O stock or a crypto coin), the expiry and a strategy; the legs (strikes, CE / PE, premiums) fill in
// from the live option chain and stay editable. The page works out P&L, R multiple, max profit / loss,
// win rate, per-trade blocks with the day total, a daily P&L calendar and a breakdown by strategy.
// Saved in this browser (localStorage); Export / Import CSV moves it between devices.
// Nothing here suggests a trade: every number comes from the user's own entries.

const SEGS = ['Nifty', 'Sensex', 'Stock', 'Crypto']
const COINS = ['BTC', 'ETH', 'SOL', 'XRP']
const MOODS = ['Calm', 'Confident', 'Hesitant', 'Fearful', 'Greedy', 'FOMO', 'Revenge']
const FIELDS = ['locked', 'date', 'time', 'role', 'seg', 'und', 'expiry', 'view', 'strategy', 'lots', 'lotSize', 'legs', 'sl', 'target', 'fees', 'setup', 'mood', 'rules', 'notes']
// Seller structures not in the strategy explainer (naked sells, short straddle / strangle).
const EXTRA = {
  bull: [['Sell put', 'Sell an out-of-the-money put. Keeps the premium if price stays above the strike; loss grows below it.', [['P', 'sell', 'p3']]]],
  bear: [['Sell call', 'Sell an out-of-the-money call. Keeps the premium if price stays below the strike; loss is open-ended above it.', [['C', 'sell', 'c3']]]],
  range: [
    ['Short straddle', 'Sell the ATM call and put. Largest credit; loses if price moves far either way (open-ended).', [['C', 'sell', 'atm'], ['P', 'sell', 'atm']]],
    ['Short strangle', 'Sell an out-of-the-money call and put. Earns the credit if price stays between them (open-ended).', [['C', 'sell', 'c3'], ['P', 'sell', 'p3']]],
  ],
  move: [],
}
// Same views as the Strategy explainer. A view can have no structure for one side (buyers have none
// for range-bound, sellers none for a big move) — the form then says so.
const VIEW_LABEL = { bull: 'Bullish', bear: 'Bearish', range: 'Range-bound', move: 'Big move' }
// Implied-volatility regime, as the explainer reads it: India VIX for Indian options (13–20 = normal),
// the coin's DVOL for crypto.
const IV_BANDS = { BTC: [40, 65], ETH: [55, 85], SOL: [55, 90], XRP: [55, 90] }
const regimeOf = (seg, und, live, d) => {
  const iv = seg === 'Crypto' ? d?.dvol : live?.indices?.indiavix?.ltp ?? d?.dvol, [lo, hi] = IV_BANDS[und] || [13, 20]
  return !isNum(iv) ? 'normal' : iv < lo ? 'low' : iv > hi ? 'high' : 'normal'
}
const fitOf = (role, view, regime) => FIT[role === 'buyer' ? 'buy' : 'sell'][view]?.[regime] || null
// strategies for a side + view, the one that fits current conditions first
const strategies = (role, view, fit) => [...(VIEWS[view]?.list || []), ...(EXTRA[view] || [])]
  .filter(s => (role === 'buyer') === BUYER.has(s[0])).sort((a, b) => (b[0] === fit) - (a[0] === fit))

const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const nowIst = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
const num = v => v === '' || v == null || isNaN(+v) ? null : +v
const money = (v, sign) => v == null ? '—' : (sign && v > 0 ? '+' : '') + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const tone = v => v > 0 ? 'up' : v < 0 ? 'down' : ''
const pct = v => v == null ? '—' : Math.round(v * 100) + '%'
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
const firstView = (role, bias) => BIAS_VIEW[bias?.label] || 'bull'  // follow the Market Bias, like the explainer
// More than 2 trades in a day (or in one screenshot) defaults the mood to Revenge — the user can change it.
const moodFor = n => n > 2 ? 'Revenge' : 'Calm'
const blank = (bias, keep = {}) => {
  const role = keep.role || 'buyer', view = firstView(role, bias)
  return { id: null, date: todayIst(), time: nowIst(), role, seg: keep.seg || 'Nifty', und: keep.und || 'NIFTY', expiry: '', view,
    strategy: strategies(role, view)[0]?.[0] || '', lots: 1, lotSize: '', legs: [], sl: '', target: '', fees: '', setup: '', mood: 'Calm', rules: true, notes: '', auto: true }
}

// ---- trade maths --------------------------------------------------------------------------------
const qtyOf = t => t.legs?.length ? (num(t.lots) || 0) * (num(t.lotSize) || 1) : num(t.qty) || 0
const legsOf = t => t.legs?.length ? t.legs : [{ a: t.side === 'Short' ? 'S' : 'B', t: '', k: '', entry: t.entry, exit: t.exit }]  // older free-form entries
function calc(t) {
  const legs = legsOf(t), q = qtyOf(t), sgn = l => l.a === 'S' ? -1 : 1
  const open = legs.some(l => num(l.entry) == null || num(l.exit) == null)
  const pnl = open ? null : legs.reduce((s, l) => s + (num(l.exit) - num(l.entry)) * q * sgn(l), 0) - (num(t.fees) || 0)
  const net = legs.every(l => num(l.entry) != null) ? legs.reduce((s, l) => s - sgn(l) * num(l.entry), 0) : null  // per unit: + credit, − debit
  // payoff at expiry -> max profit / max loss (null = open-ended)
  let maxP = null, maxL = null
  if (net != null && legs.every(l => l.t && num(l.k) != null)) {
    const pay = S => legs.reduce((s, l) => s + sgn(l) * (Math.max(0, l.t === 'CE' ? S - num(l.k) : num(l.k) - S) - num(l.entry)) * q, 0)
    const ks = legs.map(l => num(l.k)), hi = Math.max(...ks) * 3, pts = [0, ...ks, hi].map(pay)
    const tail = pay(hi * 2) - pay(hi)
    maxP = tail > 1e-9 ? null : Math.max(...pts)
    maxL = tail < -1e-9 ? null : Math.min(...pts)
  }
  const single = legs.length === 1, l0 = legs[0], e0 = num(l0.entry), sl = num(t.sl)
  const risk = single && e0 != null && sl != null && sl !== e0 ? Math.abs(e0 - sl) * q : maxL != null && maxL < 0 ? -maxL : null
  return { open, pnl, net, maxP, maxL, risk, r: pnl != null && risk ? pnl / risk : null }
}
function label(t) {
  if (!t.legs?.length) return t.symbol || '—'
  const und = t.und || t.seg
  if (t.legs.length === 1) { const l = t.legs[0]; return `${und} ${l.k} ${l.t}` }
  const ks = [...new Set(t.legs.map(l => l.k))].join('/'), ts = [...new Set(t.legs.map(l => l.t))].join('+')
  return `${und} ${ks} ${ts}`
}

function stats(list) {
  const closed = list.filter(t => !t.c.open).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
  const wins = closed.filter(t => t.c.pnl > 0), losses = closed.filter(t => t.c.pnl < 0)
  const sum = a => a.reduce((s, t) => s + t.c.pnl, 0)
  const gw = sum(wins), gl = sum(losses), net = gw + gl
  let eq = 0, peak = 0, dd = 0
  const curve = closed.map(t => { eq += t.c.pnl; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); return eq })
  let streak = 0
  for (let i = closed.length - 1; i >= 0; i--) {
    const s = Math.sign(closed[i].c.pnl)
    if (!s || (streak && Math.sign(streak) !== s)) break
    streak += s
  }
  const rs = closed.filter(t => t.c.r != null)
  return {
    n: closed.length, open: list.length - closed.length, net, curve, dd, streak,
    win: closed.length ? wins.length / closed.length : null,
    avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? gl / losses.length : null,
    pf: gl ? gw / -gl : null, exp: closed.length ? net / closed.length : null,
    best: closed.length ? Math.max(...closed.map(t => t.c.pnl)) : null, worst: closed.length ? Math.min(...closed.map(t => t.c.pnl)) : null,
    avgR: rs.length ? rs.reduce((s, t) => s + t.c.r, 0) / rs.length : null,
  }
}

function groupBy(list, key) {
  const m = new Map()
  for (const t of list) if (!t.c.open) {
    const k = key(t) || '(none)'
    const g = m.get(k) || { k, n: 0, w: 0, net: 0 }
    g.n++; g.net += t.c.pnl; if (t.c.pnl > 0) g.w++
    m.set(k, g)
  }
  return [...m.values()].sort((a, b) => b.net - a.net)
}

// ---- option chain for the form ------------------------------------------------------------------
const CHAINS = new Map()  // url -> { at, d }
function useChain(seg, und, live) {
  const url = seg === 'Nifty' ? '/api/index-options?symbol=NIFTY'
    : seg === 'Stock' && und ? '/api/index-options?symbol=' + encodeURIComponent(und)
      : seg === 'Crypto' ? '/api/crypto/options?ccy=' + und : null
  const [st, setSt] = useState({})
  useEffect(() => {
    if (!url) { setSt({}); return }
    const hit = CHAINS.get(url)
    if (hit && Date.now() - hit.at < 60000) { setSt({ url, d: hit.d }); return }
    let ok = true
    setSt({ url, loading: true })
    api(url).then(d => { CHAINS.set(url, { at: Date.now(), d }); ok && setSt({ url, d }) }).catch(e => ok && setSt({ url, error: e.message }))
    return () => { ok = false }
  }, [url])
  // Sensex: BSE's chain is not reachable from here, so strikes are a 100-point ladder around the live level.
  const sx = live?.indices?.sensex?.ltp
  return useMemo(() => {
    if (seg !== 'Sensex') return st.url === url ? st : url ? { loading: true } : {}  // never hand back the previous underlying's chain
    if (!sx) return { error: 'Sensex level not loaded yet.' }
    const atm = Math.round(sx / 100) * 100
    const chain = Array.from({ length: 81 }, (_, i) => ({ k: atm + (i - 40) * 100 }))
    return { d: { spot: sx, lot: 20, synthetic: true, expiries: [{ code: 'sx', chain, fwd: sx, atm_strike: atm }] } }
  }, [seg, sx, st, url])
}
const premOf = (exp, k, t) => {
  const q = exp?.chain?.find(r => r.k === +k)?.[t === 'CE' ? 'call' : 'put']
  const v = q?.mark ?? q?.ask ?? q?.bid
  return isNum(v) ? +v.toFixed(2) : ''
}
function buildLegs(spec, exp) {
  if (!exp?.chain?.length) return []
  const r = refStrikes(exp), ks = exp.chain.map(x => x.k)
  const step = (k, n) => ks[Math.min(ks.length - 1, Math.max(0, ks.indexOf(k) + n))]
  if (r.ch === r.c3) r.ch = step(r.c3, 3)
  if (r.ph === r.p3) r.ph = step(r.p3, -3)
  return spec.map(([cp, act, ref]) => {
    const t = cp === 'C' ? 'CE' : 'PE', k = r[ref]
    return { a: act === 'buy' ? 'B' : 'S', t, k, entry: premOf(exp, k, t), exit: '' }
  })
}

// ---- CSV ----------------------------------------------------------------------------------------
const csvCell = v => { const s = typeof v === 'object' && v ? JSON.stringify(v) : String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
function parseCsv(text) {
  const rows = [], row = [], push = () => { rows.push(row.splice(0)) }
  let cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') q = false; else cell += ch }
    else if (ch === '"') q = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; push() }
    else cell += ch
  }
  if (cell || row.length) { row.push(cell); push() }
  return rows.filter(r => r.some(c => c.trim()))
}

// ---- pieces -------------------------------------------------------------------------------------
// The chosen day (today unless a calendar day is clicked): one block per trade in the order taken,
// then a total block for the day.
function DayTrades({ list, day }) {
  const d = day || todayIst()
  const trades = list.filter(t => t.date === d).sort((a, b) => (a.time || '').localeCompare(b.time || ''))
  const closed = trades.filter(t => !t.c.open)
  const net = closed.reduce((s, t) => s + t.c.pnl, 0)
  const w = closed.filter(t => t.c.pnl > 0).length, l = closed.filter(t => t.c.pnl < 0).length
  const name = d === todayIst() ? 'Today' : new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  return <div className="jr-days">
    {trades.map((t, i) => <div key={t.id} className={'jr-day ' + (t.c.open ? '' : tone(t.c.pnl))} title={`${t.name} · ${t.strategy || ''}`}>
      <span className="jr-day-d">Trade {i + 1} <span className="muted">· {t.time}</span></span>
      <b className={'jr-day-p ' + tone(t.c.pnl)}>{t.c.open ? 'Open' : money(t.c.pnl, true)}</b>
      <span className="jr-day-n">{t.name}</span>
    </div>)}
    <div className={'jr-day total ' + (closed.length ? tone(net) : '')}>
      <span className="jr-day-d">{name} total</span>
      <b className={'jr-day-p ' + tone(net)}>{closed.length ? money(net, true) : '—'}</b>
      <span className="jr-day-n">{trades.length} trade{trades.length === 1 ? '' : 's'}{trades.length ? ` · ${w}W ${l}L` : ''}{trades.length - closed.length ? ` · ${trades.length - closed.length} open` : ''}</span>
    </div>
  </div>
}

function Calendar({ list, month, setMonth, day, setDay }) {
  const daily = useMemo(() => {
    const m = {}
    for (const t of list) if (!t.c.open) { const d = m[t.date] || (m[t.date] = { pnl: 0, n: 0 }); d.pnl += t.c.pnl; d.n++ }
    return m
  }, [list])
  const [Y, M] = month.split('-').map(Number)
  const first = new Date(Date.UTC(Y, M - 1, 1)), days = new Date(Date.UTC(Y, M, 0)).getUTCDate()
  const lead = (first.getUTCDay() + 6) % 7  // Monday first
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)]
  const max = Math.max(1, ...cells.filter(Boolean).map(d => Math.abs(daily[d]?.pnl || 0)))
  const monthNet = cells.reduce((s, d) => s + (d && daily[d] ? daily[d].pnl : 0), 0)
  const shift = n => { const d = new Date(Date.UTC(Y, M - 1 + n, 1)); setMonth(d.toISOString().slice(0, 7)) }
  return <div className="jr-cal">
    <div className="jr-cal-head">
      <button className="btn" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
      <b>{first.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</b>
      <button className="btn" onClick={() => shift(1)} aria-label="Next month">›</button>
      <span className={'num ' + tone(monthNet)}>{money(monthNet, true)}</span>
    </div>
    <div className="jr-cal-grid">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <span key={d} className="dow">{d}</span>)}
      {cells.map((d, i) => {
        if (!d) return <span key={i} />
        const v = daily[d], a = v ? .15 + .6 * Math.abs(v.pnl) / max : 0
        return <button key={d} className={'day' + (day === d ? ' on' : '') + (v ? ' ' + tone(v.pnl) : '')}
          style={v ? { '--a': a } : undefined} onClick={() => setDay(day === d ? null : d)}
          title={v ? `${d}: ${money(v.pnl, true)} · ${v.n} trade${v.n > 1 ? 's' : ''}` : d}>
          <span>{+d.slice(8)}</span>{v && <small>{Math.abs(v.pnl) >= 1000 ? (v.pnl / 1000).toFixed(1) + 'k' : Math.round(v.pnl)}</small>}
        </button>
      })}
    </div>
    <div className="muted small">Click a day to show only its trades.</div>
  </div>
}

function Breakdown({ title, rows }) {
  return <div className="jr-break">
    <h4>{title}</h4>
    {rows.length ? <table className="tbl"><thead><tr><th>{title.replace('By ', '')}</th><th className="num">Trades</th><th className="num">Win %</th><th className="num">Net P&amp;L</th></tr></thead>
      <tbody>{rows.map(g => <tr key={g.k}><td>{g.k}</td><td className="num">{g.n}</td><td className="num">{pct(g.w / g.n)}</td><td className={'num ' + tone(g.net)}>{money(g.net, true)}</td></tr>)}</tbody></table>
      : <div className="muted small">No closed trades yet.</div>}
  </div>
}

// "Scan broker screenshot": upload or take a photo of a broker order / position screen; OCR runs in the
// browser and each option trade found can fill the form. The image is never saved or uploaded: it lives
// only in memory while being read and is dropped (preview included) once the trade is added or the scan
// is closed.
const OCR_SEG = und => und === 'NIFTY' ? 'Nifty' : und === 'SENSEX' ? 'Sensex' : COINS.includes(und) ? 'Crypto' : 'Stock'
const OCR_STRAT = { BCE: ['buyer', 'bull', 'Long call'], BPE: ['buyer', 'bear', 'Long put'], SPE: ['seller', 'bull', 'Sell put'], SCE: ['seller', 'bear', 'Sell call'] }
const KNOWN_LOT = { NIFTY: 65, SENSEX: 20 }
// A scanned trade as a ready journal entry (used by "Add all"): lots from the lot size shown on the
// screen (or the index lot), expiry as read ("27 Oct").
function scanToTrade(r, base) {
  const [role, view, strategy] = OCR_STRAT[r.a + r.t]
  const L = r.lot || KNOWN_LOT[r.und], q = r.qty
  const [lots, lotSize] = q && L && q % L === 0 ? [q / L, L] : q ? [1, q] : [1, L || 1]
  const exp = r.expiry ? `${r.expiry.day} ${r.expiry.mon[0]}${r.expiry.mon.slice(1).toLowerCase()}` : ''
  return { ...base, role, view, strategy, seg: OCR_SEG(r.und), und: r.und, expiry: exp, time: r.time || base.time,
    legs: [{ a: r.a, t: r.t, k: r.k, entry: r.entry ?? '', exit: r.exit ?? '' }], lots, lotSize, notes: 'Added from a broker screenshot' }
}
function ScanTrade({ onUse, onAddAll, clearRef }) {
  const [saved, setSaved] = useState([])  // indexes of rows already saved
  const [mood, setMood] = useState('Calm')  // applied to every trade saved from this screenshot
  const [img, setImg] = useState(null)
  const [busy, setBusy] = useState(null)
  const [found, setFound] = useState(null)
  const [raw, setRaw] = useState('')  // OCR text, shown on request; dropped with the image
  const [err, setErr] = useState('')
  const camRef = useRef(null), fileRef = useRef(null)
  const clear = useCallback(() => {
    setImg(u => { if (u) URL.revokeObjectURL(u); return null })
    setFound(null); setErr(''); setBusy(null); setRaw(''); setSaved([])
    if (camRef.current) camRef.current.value = ''
    if (fileRef.current) fileRef.current.value = ''
  }, [])
  useEffect(() => { clearRef.current = clear; return () => clear() }, [clear, clearRef])
  const read = async file => {
    if (!file || !file.type.startsWith('image/')) return setErr('Choose an image (screenshot or photo).')
    clear(); setImg(URL.createObjectURL(file)); setBusy(0)
    try {
      const { readImage, parseTrades } = await import('./tradeOcr.js')
      const text = await readImage(file, p => setBusy(p))
      const rows = parseTrades(text)
      setFound(rows); setRaw(text); setMood(moodFor(rows.length))
      if (!rows.length) setErr('No option trade (like NIFTY 23000 CE) could be read. Try a clearer or cropped screenshot, or enter it by hand.')
    } catch (e) { setErr('Could not read the image: ' + e.message) }
    setBusy(null)
  }
  // Save rows straight to the journal; once every row is saved the screenshot is discarded.
  const saveRows = idx => {
    onAddAll(idx.map(i => found[i]), mood)
    const all = [...saved, ...idx]
    if (all.length >= found.length) clear(); else setSaved(all)
  }
  const onPaste = e => { const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/')); if (f) { e.preventDefault(); read(f) } }
  return <div className="jr-scan" onPaste={onPaste} tabIndex={-1}>
    <div className="jr-scan-bar">
      <b>📷 Add from broker screenshot</b>
      <button type="button" className="btn" onClick={() => camRef.current?.click()}>Take photo</button>
      <button type="button" className="btn" onClick={() => fileRef.current?.click()}>Upload screenshot</button>
      <span className="muted small">or paste (Ctrl / ⌘ V) here · read on your device, never saved</span>
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={e => read(e.target.files?.[0])} />
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => read(e.target.files?.[0])} />
      {img && <button type="button" className="btn ghost" onClick={clear}>✕ Discard</button>}
    </div>
    {img && <div className="jr-scan-body">
      <img src={img} alt="Broker screenshot being read" />
      <div className="jr-scan-res">
        {busy != null && <div className="muted small">Reading the image… {Math.round(busy * 100)}%<div className="jr-prog"><i style={{ width: busy * 100 + '%' }} /></div></div>}
        {err && <div className="down small">{err}</div>}
        {found?.map((r, i) => <div key={i} className={'jr-scan-row' + (saved.includes(i) ? ' done' : '')}>
          <span><span className={'jr-tag ' + (r.a === 'B' ? 'up' : 'down')}>{r.a === 'B' ? 'BUY' : 'SELL'}{r.actionFound ? '' : '?'}</span> <b>{r.und}{r.undGuess ? '?' : ''} {r.k} {r.t}</b>
            {r.expiry && <span className="muted"> · {r.expiry.day} {r.expiry.mon}</span>}</span>
          <span className="small">{r.qty != null ? `Qty ${r.qty}` : 'Qty ?'} · {r.entry != null ? `entry ${r.entry}` : 'entry ?'}{r.exit != null ? ` → exit ${r.exit}` : ''}{r.time ? ` · ${r.time}` : ''}{r.pnl != null ? ` · P&L ${r.pnl}` : ''}</span>
          {saved.includes(i) ? <span className="up jr-saved">✓ Saved</span> : <>
            <button type="button" className="btn ghost" onClick={() => onUse(r)} title="Fill the form to check / change it before adding">Edit first</button>
            <button type="button" className="btn primary" onClick={() => saveRows([i])}>Save this</button></>}
        </div>)}
        {found?.length > saved.length && <div className="jr-scan-all">
          {found.length - saved.length > 1 && <button type="button" className="btn primary" onClick={() => saveRows(found.map((_, i) => i).filter(i => !saved.includes(i)))}>Save all {found.length - saved.length} trades</button>}
          <label className="jr-scan-mood">Mood <select value={mood} onChange={e => setMood(e.target.value)}>{MOODS.map(m => <option key={m}>{m}</option>)}</select></label>
          <span className="muted small">used for the trades you save from this screenshot</span></div>}
        {found?.length > 0 && <div className="muted small">Saved trades appear in the Trades table below — check them there (OCR can misread digits; "?" = not read from the image). The screenshot is discarded once every trade is saved.</div>}
        {raw && <details className="jr-raw"><summary className="muted small">Show read text</summary><pre>{raw}</pre></details>}
      </div>
    </div>}
  </div>
}

// Add / edit form: role -> underlying -> expiry -> view -> strategy -> legs.
function TradeForm({ form, setForm, onSave, onAddAll, onCancel, live }) {
  const [err, setErr] = useState('')
  const bias = live?.bias
  const biasView = BIAS_VIEW[bias?.label]
  const fo = useMemo(() => (live?.stocks || []).filter(s => s.fo).map(s => s.symbol).sort(), [live?.stocks])
  const chain = useChain(form.seg, form.seg === 'Stock' && !fo.includes(form.und) ? '' : form.und, live)
  const d = chain.d
  const exps = d?.expiries || []
  const exp = exps.find(e => e.expiry_ist === form.expiry) || exps[0]
  const strikes = exp?.chain?.map(r => r.k) || []
  const regime = regimeOf(form.seg, form.und, live, d)
  const fit = fitOf(form.role, form.view, regime)
  const list = strategies(form.role, form.view, fit)
  const spec = list.find(s => s[0] === form.strategy)
  const stockQ = form.seg === 'Stock' ? live?.stocks?.find(x => x.symbol === form.und) : null
  const set = patch => setForm(f => ({ ...f, ...patch }))

  // Fill the legs (strikes + premiums) and lot size from the chain whenever the choice changes.
  useEffect(() => {
    if (!form.auto || !exp) return
    setForm(f => ({ ...f, legs: spec ? buildLegs(spec[2], exp) : f.legs, lotSize: d?.lot || (f.seg === 'Crypto' ? 1 : f.lotSize) || '',
      expiry: d?.synthetic ? f.expiry : exp.expiry_ist }))
  }, [form.auto, form.strategy, form.und, exp?.code, d, form.legs.length === 0])  // also refill after a save clears the form  // eslint-disable-line react-hooks/exhaustive-deps

  // A scanned trade arrives with its quantity / expiry as hints; turn them into lots and an expiry once
  // the chain (lot size, expiry list) for that underlying has loaded.
  useEffect(() => {
    if (form.auto || (form.qtyHint == null && !form.expHint) || !d) return
    const patch = {}
    if (form.qtyHint != null) {
      const L = d.lot || 1
      Object.assign(patch, form.qtyHint % L === 0 ? { lotSize: L, lots: form.qtyHint / L } : { lotSize: form.qtyHint, lots: 1 }, { qtyHint: null })
    }
    if (form.expHint) {
      const { day, mon } = form.expHint
      if (d.synthetic) {
        const y = new Date().getFullYear(), m = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(mon) + 1
        patch.expiry = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      } else {
        const e = exps.find(x => new RegExp('^0?' + day + ' ' + mon, 'i').test(x.expiry_ist || ''))
        if (e) patch.expiry = e.expiry_ist
      }
      patch.expHint = null
    }
    setForm(f => ({ ...f, ...patch }))
  }, [d, form.qtyHint, form.expHint])  // eslint-disable-line react-hooks/exhaustive-deps
  const scanClear = useRef(null)
  const useScan = r => {
    const [role, view, strategy] = OCR_STRAT[r.a + r.t]
    setForm(f => ({ ...f, auto: false, stratPicked: true, role, view, strategy, seg: OCR_SEG(r.und), und: r.und, expiry: '', time: r.time || f.time,
      legs: [{ a: r.a, t: r.t, k: r.k, entry: r.entry ?? '', exit: r.exit ?? '' }], lots: 1, lotSize: '', qtyHint: r.qty, expHint: r.expiry }))
    setErr('')
  }

  useEffect(() => {
    if (form.id || form.stratPicked || !list.length) return
    const want = list[0][0]
    if (want !== form.strategy) setForm(f => ({ ...f, strategy: want, auto: true }))
  }, [fit, form.view, form.role, list.length])  // eslint-disable-line react-hooks/exhaustive-deps
  const pick = patch => set({ ...patch, auto: true })
  const setRole = role => pick({ role, strategy: strategies(role, form.view, fitOf(role, form.view, regime))[0]?.[0] || '', legs: [], stratPicked: false })
  const setView = view => pick({ view, strategy: strategies(form.role, view, fitOf(form.role, view, regime))[0]?.[0] || '', legs: [], stratPicked: false })
  const setSeg = seg => pick({ seg, und: { Nifty: 'NIFTY', Sensex: 'SENSEX', Stock: '', Crypto: 'BTC' }[seg], expiry: '', lotSize: '', legs: [] })
  const setLeg = (i, patch) => set({ auto: false, legs: form.legs.map((l, j) => {
    if (j !== i) return l
    const n = { ...l, ...patch }
    if (('k' in patch || 't' in patch) && exp && !d?.synthetic) n.entry = premOf(exp, n.k, n.t)  // new strike -> its live premium
    return n
  }) })
  const addLeg = () => set({ auto: false, legs: [...form.legs, { a: form.role === 'buyer' ? 'B' : 'S', t: 'CE', k: exp?.atm_strike ?? strikes[Math.floor(strikes.length / 2)] ?? '', entry: '', exit: '' }] })
  const delLeg = i => set({ auto: false, legs: form.legs.filter((_, j) => j !== i) })

  const c = calc(form)
  const single = form.legs.length === 1
  const save = e => {
    e.preventDefault()
    if (!form.und) return setErr('Choose the stock.')
    if (!form.legs.length) return setErr('Add at least one leg (choose a strategy, or + Add leg).')
    if (form.legs.some(l => num(l.k) == null || num(l.entry) == null)) return setErr('Every leg needs a strike and an entry premium.')
    if (!(num(form.lots) > 0)) return setErr('Enter lots above 0.')
    setErr('')
    const { auto, qtyHint, expHint, stratPicked, ...t } = form
    if (qtyHint != null) Object.assign(t, { lots: 1, lotSize: qtyHint })  // chain never loaded: keep the scanned quantity
    onSave({ ...t, lotSize: num(t.lotSize) || 1 })
    scanClear.current?.()  // the screenshot is not kept once the trade is added
  }

  return <form className="panel jr-form" id="jr-form" onSubmit={save}>
    <div className="panel-head"><h3>{form.id ? 'Edit trade' : 'Add trade'}</h3>
      {form.id && <button type="button" className="btn ghost" onClick={onCancel}>Cancel edit</button>}</div>
    {!form.id && <ScanTrade onUse={useScan} onAddAll={onAddAll} clearRef={scanClear} />}
    <div className="jr-fields">
      <label className="wide"><span>I am an</span><div className="seg jr-seg">
        {[['buyer', 'Option buyer'], ['seller', 'Option seller']].map(([v, l]) =>
          <button type="button" key={v} className={form.role === v ? 'on' : ''} onClick={() => setRole(v)}>{l}</button>)}</div></label>
      <label><span>Date</span><input type="date" value={form.date} onChange={e => set({ date: e.target.value })} /></label>
      <label><span>Time</span><input type="time" value={form.time} onChange={e => set({ time: e.target.value })} /></label>

      <label className="wide"><span>Segment</span><div className="seg jr-seg">
        {SEGS.map(s => <button type="button" key={s} className={form.seg === s ? 'on' : ''} onClick={() => setSeg(s)}>{s}</button>)}</div></label>
      {form.seg === 'Stock' && <label><span>Stock</span>
        <input list="jr-fo" value={form.und} placeholder="Type F&amp;O stock" onChange={e => { const v = e.target.value.toUpperCase().trim(); pick({ und: fo.includes(v) ? v : e.target.value.toUpperCase(), legs: [], lotSize: '' }) }} />
        <datalist id="jr-fo">{fo.map(s => <option key={s} value={s} />)}</datalist>
        {stockQ && <em className="jr-ltp">LTP <b>{money(stockQ.ltp)}</b> <b className={tone(stockQ.change)}>{stockQ.pct_prev > 0 ? '+' : ''}{stockQ.pct_prev?.toFixed(2)}%</b></em>}</label>}
      {form.seg === 'Crypto' && <label><span>Coin</span><select value={form.und} onChange={e => pick({ und: e.target.value, legs: [], lotSize: '' })}>{COINS.map(s => <option key={s}>{s}</option>)}</select></label>}
      <label className={form.seg === 'Nifty' || form.seg === 'Sensex' ? 'wide' : ''}><span>Expiry</span>
        {d?.synthetic ? <input type="date" value={form.expiry} onChange={e => set({ expiry: e.target.value })} />
          : <select value={exp?.expiry_ist || ''} onChange={e => pick({ expiry: e.target.value })} disabled={!exps.length}>
            {!exps.length && <option value="">{chain.loading ? 'Loading chain…' : form.seg === 'Stock' && !fo.includes(form.und) ? 'Choose a stock first' : '—'}</option>}
            {exps.map(x => <option key={x.code} value={x.expiry_ist}>{x.expiry_ist}{x.days != null ? ` · ${(+x.days).toFixed(0)}d` : ''}</option>)}
          </select>}</label>

      <label className="full"><span>Market view {bias?.label && <em>· Market Bias now: <b className={biasView === 'bull' ? 'up' : biasView === 'bear' ? 'down' : ''}>{bias.label}</b></em>}</span>
        <div className="seg jr-seg">{Object.entries(VIEW_LABEL).map(([v, l]) =>
          <button type="button" key={v} className={(form.view === v ? 'on ' + (VIEWS[v].tone || '') : '')} onClick={() => setView(v)} title={v === biasView ? 'Matches the current Market Bias' : ''}>
            {l}{v === biasView && <span className="jr-dot" aria-label="matches Market Bias"> ●</span>}</button>)}</div></label>
      <label className="full"><span>Strategy</span>
        {list.length ? <div className="jr-strats">{list.map(s => s[0]).map(n =>
          <button type="button" key={n} className={'jr-chip' + (form.strategy === n ? ' on' : '')} onClick={() => pick({ strategy: n, stratPicked: true })}
            title={n === fit ? `Fits a ${VIEW_LABEL[form.view].toLowerCase()} view with ${regime} volatility, as in the Strategy explainer` : ''}>{n}{n === fit && <span className="jr-fit"> ✓ fits current conditions</span>}</button>)}</div>
          : <span className="jr-desc">{form.role === 'buyer' ? 'Option buyers have no structure for a range-bound view — it is a seller\u2019s setup.' : 'Option sellers have no structure for a big move either way — it is a buyer\u2019s setup.'}{' '}
            <button type="button" className="btn ghost" onClick={() => setRole(form.role === 'buyer' ? 'seller' : 'buyer')}>Switch to option {form.role === 'buyer' ? 'seller' : 'buyer'}</button></span>}
        {spec && <span className="jr-desc">{spec[1]}</span>}</label>
    </div>

    <div className="jr-legs">
      <div className="jr-legs-head"><b>Legs</b>
        <span className="muted small">{chain.error ? chain.error : d?.synthetic ? `Sensex ${money(d.spot)} — strikes every 100; type the premiums` : d ? `Spot ${money(d.spot)} · premiums from the live chain (edit if your fill differs)` : chain.loading ? 'Loading option chain…' : ''}</span>
        <button type="button" className="btn ghost" onClick={addLeg} disabled={!strikes.length}>+ Add leg</button></div>
      {form.legs.length ? <div className="tbl-wrap"><table className="tbl jr-legs-tbl"><thead><tr><th>Action</th><th>Strike</th><th>Type</th><th className="num">Entry premium</th><th className="num">Exit premium <em>(blank = open)</em></th><th /></tr></thead>
        <tbody>{form.legs.map((l, i) => <tr key={i}>
          <td><div className="seg">{[['B', 'Buy'], ['S', 'Sell']].map(([v, t]) => <button type="button" key={v} className={l.a === v ? 'on ' + (v === 'B' ? 'up' : 'down') : ''} onClick={() => setLeg(i, { a: v })}>{t}</button>)}</div></td>
          <td><select value={l.k} onChange={e => setLeg(i, { k: +e.target.value })}>
            {!strikes.includes(+l.k) && <option value={l.k}>{l.k}</option>}
            {strikes.map(k => <option key={k} value={k}>{k}{k === exp?.atm_strike ? '  (ATM)' : ''}</option>)}</select></td>
          <td><div className="seg">{['CE', 'PE'].map(v => <button type="button" key={v} className={l.t === v ? 'on' : ''} onClick={() => setLeg(i, { t: v })}>{v}</button>)}</div></td>
          <td><input type="number" step="any" inputMode="decimal" value={l.entry} onChange={e => setLeg(i, { entry: e.target.value })} /></td>
          <td><input type="number" step="any" inputMode="decimal" value={l.exit} onChange={e => setLeg(i, { exit: e.target.value })} /></td>
          <td><button type="button" className="btn ghost down" onClick={() => delLeg(i)} aria-label="Remove leg">✕</button></td>
        </tr>)}</tbody></table></div>
        : <div className="muted small jr-pad">{chain.loading ? 'Loading option chain…' : 'Choose a strategy to fill the legs, or + Add leg.'}</div>}
    </div>

    <div className="jr-fields">
      <label><span>Lots</span><input type="number" min="0" step="1" inputMode="numeric" value={form.lots} onChange={e => set({ lots: e.target.value })} /></label>
      <label><span>Lot size</span><input type="number" min="0" step="any" inputMode="decimal" value={form.lotSize} onChange={e => set({ lotSize: e.target.value })} /></label>
      <label><span>Quantity</span><div className="jr-ro">{qtyOf(form).toLocaleString('en-IN')}</div></label>
      <label><span>Charges</span><input type="number" min="0" step="any" inputMode="decimal" value={form.fees} onChange={e => set({ fees: e.target.value })} /></label>
      {single && <>
        <label><span>Stop-loss (premium)</span><input type="number" step="any" inputMode="decimal" value={form.sl} onChange={e => set({ sl: e.target.value })} /></label>
        <label><span>Target (premium)</span><input type="number" step="any" inputMode="decimal" value={form.target} onChange={e => set({ target: e.target.value })} /></label>
      </>}
      <label><span>Reason / setup</span><input value={form.setup} onChange={e => set({ setup: e.target.value })} placeholder="ORB breakout" /></label>
      <label><span>Mood</span><select value={form.mood} onChange={e => set({ mood: e.target.value })}>{MOODS.map(s => <option key={s}>{s}</option>)}</select></label>
      <label className="jr-check"><input type="checkbox" checked={!!form.rules} onChange={e => set({ rules: e.target.checked })} /> Followed my rules</label>
      <label className="full"><span>Notes</span><textarea rows="2" value={form.notes} onChange={e => set({ notes: e.target.value })} placeholder="Why I entered, how I managed it, what I learned" /></label>
    </div>

    <div className="jr-form-foot">
      <span className="jr-preview">
        {c.net != null && <>{c.net >= 0 ? 'Net credit' : 'Net debit'} <b>{money(Math.abs(c.net))}</b> × {qtyOf(form)} = <b>{money(Math.abs(c.net) * qtyOf(form))}</b></>}
        {c.net != null && <span className="muted"> · max profit <b className="up">{c.maxP == null ? 'open-ended' : money(c.maxP)}</b> · max loss <b className="down">{c.maxL == null ? 'open-ended' : money(c.maxL)}</b></span>}
        {c.pnl != null && <> · P&amp;L <b className={tone(c.pnl)}>{money(c.pnl, true)}</b>{c.r != null && <> (<b className={tone(c.r)}>{c.r.toFixed(2)} R</b>)</>}</>}
      </span>
      {err && <span className="down small">{err}</span>}
      <button className="btn primary" type="submit">{form.id ? 'Save changes' : 'Add trade'}</button>
    </div>
  </form>
}

// ---- account (Google sign-in) -------------------------------------------------------------------
// Trades are always kept in this browser. Signed in, they are also saved to the user's account on the
// server and merged across devices. The browser copy remembers its owner so two people sharing a browser
// never mix journals; signing out clears this browser's copy (it stays in the account).
const TOKEN_KEY = 'nseid:jr:token', USER_KEY = 'nseid:jr:user', OWNER_KEY = 'nseid:jr:owner'
const ls = {
  get: k => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch { /* private mode */ } },
}
const authApi = (path, opts = {}) => api(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ls.get(TOKEN_KEY), ...(opts.headers || {}) } })
let gisLoad = null
const loadGis = () => gisLoad || (gisLoad = new Promise((ok, fail) => {
  const el = document.createElement('script')
  el.src = 'https://accounts.google.com/gsi/client'; el.async = true
  el.onload = ok; el.onerror = () => { gisLoad = null; fail(new Error('Could not load Google sign-in.')) }
  document.head.appendChild(el)
}))

function useAccount(trades, setTrades) {
  const [cid, setCid] = useState(null)
  const [user, setUser] = useState(() => { try { return JSON.parse(ls.get(USER_KEY)) } catch { return null } })
  const [status, setStatus] = useState(user ? 'syncing' : '')
  const synced = useRef(false)

  useEffect(() => { api('/api/auth/config').then(c => setCid(c.google_client_id || '')).catch(() => setCid('')) }, [])
  const signOutLocal = () => { ls.set(TOKEN_KEY, null); ls.set(USER_KEY, null); ls.set(OWNER_KEY, null); synced.current = false; setUser(null); setStatus(''); setTrades([]) }
  // Pull the account's journal and merge it with this browser's copy (account wins on the same trade).
  const sync = async u => {
    setStatus('syncing'); synced.current = false
    try {
      const server = (await authApi('/api/journal')).trades || []
      const owner = ls.get(OWNER_KEY)
      setTrades(local => {
        const mine = owner && owner !== u.email ? [] : local
        const ids = new Set(server.map(t => t.id))
        const merged = [...server, ...mine.filter(t => !ids.has(t.id))]
        authApi('/api/journal', { method: 'PUT', body: JSON.stringify({ trades: merged }) })
          .then(() => { synced.current = true; setStatus('saved') }).catch(() => setStatus('error'))
        return merged
      })
      ls.set(OWNER_KEY, u.email)
    } catch (e) {
      if (e.status === 401) { signOutLocal(); setStatus('expired') } else setStatus('error')
    }
  }
  useEffect(() => { if (user) sync(user) }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  // Save every change to the account (debounced).
  useEffect(() => {
    if (!user || !synced.current) return
    setStatus('saving')
    const t = setTimeout(() => authApi('/api/journal', { method: 'PUT', body: JSON.stringify({ trades }) })
      .then(() => setStatus('saved'))
      .catch(e => { if (e.status === 401) { setStatus('expired'); ls.set(TOKEN_KEY, null); ls.set(USER_KEY, null); setUser(null); synced.current = false } else setStatus('error') }), 800)
    return () => clearTimeout(t)
  }, [trades])  // eslint-disable-line react-hooks/exhaustive-deps

  const onCredential = async ({ credential }) => {
    try {
      setStatus('syncing')
      const r = await api('/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) })
      const u = { email: r.email, name: r.name, picture: r.picture }
      ls.set(TOKEN_KEY, r.token); ls.set(USER_KEY, JSON.stringify(u)); setUser(u)
      await sync(u)
    } catch (e) { setStatus('error:' + e.message) }
  }
  const renderButton = useCallback(async el => {
    if (!el || !cid) return
    try {
      await loadGis()
      window.google.accounts.id.initialize({ client_id: cid, callback: onCredential, auto_select: false })
      window.google.accounts.id.renderButton(el, { theme: 'outline', size: 'medium', text: 'signin_with', shape: 'pill' })
    } catch (e) { setStatus('error:' + e.message) }
  }, [cid])  // eslint-disable-line react-hooks/exhaustive-deps
  const signOut = async () => {
    if (!window.confirm('Sign out? Your trades stay saved in your Google account; this browser\'s copy is cleared.')) return
    try { await authApi('/api/auth/logout', { method: 'POST' }) } catch { /* already gone */ }
    window.google?.accounts?.id?.disableAutoSelect?.()
    signOutLocal()
  }
  return { cid, user, status, renderButton, signOut }
}

function AccountBar({ acc, count }) {
  const { cid, user, status, renderButton, signOut } = acc
  const st = status.startsWith('error:') ? <span className="down">{status.slice(6)}</span>
    : { syncing: <span className="muted">Syncing…</span>, saving: <span className="muted">Saving…</span>, saved: <span className="up">✓ Saved to account</span>,
      error: <span className="down">Couldn't reach the server — kept in this browser, will retry on the next change</span>,
      expired: <span className="down">Session expired — sign in again</span> }[status]
  return <div className="jr-account">
    {user ? <>
      {user.picture && <img src={user.picture} alt="" referrerPolicy="no-referrer" />}
      <span title={'Signed in as ' + user.email}><b>{user.email}</b></span>{st}
      <button className="btn" onClick={signOut}>Sign out</button>
    </> : <>
      <span title="Trades are always saved in this browser. Sign in with Google to also keep them in your account and see them on any device.">💾 {count} trade{count === 1 ? '' : 's'} saved in this browser</span>
      {cid ? <div ref={renderButton} className="jr-gbtn" title="Keep your trades in your account and see them on any device" />
        : cid === '' && <span className="muted" title="Google sign-in needs GOOGLE_CLIENT_ID set on the server">· sign-in not set up yet</span>}
      {st}
    </>}
  </div>
}

// ---- page ---------------------------------------------------------------------------------------
export default function Journal({ live }) {
  const [trades, setTrades] = usePersistentState('journal', [])
  const acc = useAccount(trades, setTrades)
  // Shown beside the Market Bias / PCR pills at the top of the page (falls back to inline).
  const [slot, setSlot] = useState(null)
  useEffect(() => { setSlot(document.getElementById('journal-account-slot')) }, [])
  const todayN = ts => ts.filter(t => t.date === todayIst()).length
  const [form, setForm] = useState(() => ({ ...blank(live?.bias), mood: moodFor(todayN(trades) + 1) }))
  const [range, setRange] = useState('all')
  const [q, setQ] = useState('')
  const [result, setResult] = useState('all')
  const [day, setDay] = useState(null)
  const [month, setMonth] = useState(todayIst().slice(0, 7))
  const [sort, setSort] = useState({ k: 'date', dir: -1 })
  const fileRef = useRef(null)
  const [picked, setPicked] = useState([])  // ids ticked for "Delete selected"
  const [unlocked, setUnlocked] = useState(null)  // locked trade opened with the 🔒 icon for edit / delete
  const [closing, setClosing] = useState(null)  // { id, exits } — exit-only form for a locked open trade
  // Only the newest entry can be edited or deleted. Adding a trade permanently locks every earlier one,
  // so the record can't be rewritten later (deleting the newest does not unlock them).
  const locked = t => !!t.locked

  const all = useMemo(() => trades.map(t => ({ ...t, c: calc(t), name: label(t) })), [trades])
  const list = useMemo(() => {
    const today = todayIst(), d = new Date(today + 'T00:00:00Z')
    const weekStart = new Date(d - ((d.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10)
    const from = { today, week: weekStart, month: today.slice(0, 8) + '01', all: '' }[range]
    const s = q.trim().toLowerCase()
    return all.filter(t => (day ? t.date === day : t.date >= from)
      && (!s || [t.name, t.strategy, t.setup, t.notes, t.mood, t.seg].join(' ').toLowerCase().includes(s))
      && (result === 'all' || (result === 'open' ? t.c.open : !t.c.open && (result === 'win' ? t.c.pnl > 0 : t.c.pnl <= 0))))
  }, [all, range, q, result, day])
  const sorted = useMemo(() => {
    const val = t => ({ date: t.date + t.time, pnl: t.c.pnl ?? -Infinity, r: t.c.r ?? -Infinity, name: t.name })[sort.k] ?? String(t[sort.k] ?? '').toLowerCase()
    return [...list].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * sort.dir)
  }, [list, sort])
  const st = useMemo(() => stats(list), [list])

  const save = t => {
    if (t.locked && t.id !== unlocked) return  // locked entries change only after clicking their 🔒
    if (t.locked) setUnlocked(null)  // stays locked after the edit
    setTrades(ts => t.id ? ts.map(x => x.id === t.id ? t : x) : [...ts.map(x => x.locked ? x : { ...x, locked: true }), { ...t, id: newId() }])
    // keep role / segment / underlying for the next entry; the 3rd+ trade of the day starts as Revenge
    setForm({ ...blank(live?.bias, t), mood: moodFor(todayN(trades) + (t.id ? 1 : 2)) })
  }
  // "Add all" from a screenshot: every trade found becomes an entry; all but the newest are locked.
  const addAll = (rows, mood = 'Calm') => {
    const base = { ...blank(live?.bias), mood }
    const add = rows.filter(r => r.entry != null && r.k).map(r => { const { auto, ...t } = scanToTrade(r, base); return { ...t, id: newId() } })
    if (!add.length) return
    setTrades(ts => [...ts, ...add].map((x, i, all) => i < all.length - 1 && !x.locked ? { ...x, locked: true } : x))
  }
  const strip = t => { const { c, name, ...rest } = t; return rest }
  const edit = t => { setForm({ ...blank(live?.bias), ...strip(t), auto: false }); document.getElementById('jr-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  const dup = t => { const { id, ...rest } = strip(t); setForm({ ...blank(live?.bias), ...rest, legs: (rest.legs || []).map(l => ({ ...l, exit: '' })), date: todayIst(), time: nowIst(), auto: false, stratPicked: true }) }
  const saveClose = () => {
    const t = trades.find(x => x.id === closing.id)
    if (!t || closing.exits.some(v => num(v) == null)) return
    setTrades(ts => ts.map(x => x.id === closing.id ? { ...x, legs: x.legs.map((l, i) => ({ ...l, exit: closing.exits[i] })), closedAt: todayIst() + ' ' + nowIst() } : x))
    setClosing(null)
  }
  const shownIds = sorted.map(t => t.id)
  const allPicked = shownIds.length > 0 && shownIds.every(id => picked.includes(id))
  const togglePick = id => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])
  const pickAll = () => setPicked(p => allPicked ? p.filter(id => !shownIds.includes(id)) : [...new Set([...p, ...shownIds])])
  const delPicked = () => {
    const ids = picked.filter(id => trades.some(t => t.id === id))
    if (!ids.length) return
    const nLocked = trades.filter(t => ids.includes(t.id) && t.locked).length
    if (!window.confirm(`Delete ${ids.length} selected entr${ids.length === 1 ? 'y' : 'ies'}${nLocked ? ` (${nLocked} locked)` : ''}? This can't be undone.`)) return
    setTrades(ts => ts.filter(t => !ids.includes(t.id)))
    if (ids.includes(form.id)) setForm(blank(live?.bias))
    setPicked([])
  }
  const del = t => { if (window.confirm(`${t.locked ? 'This entry is locked. ' : ''}Delete ${t.name} on ${t.date}? This can't be undone.`)) { setTrades(ts => ts.filter(x => x.id !== t.id)); if (form.id === t.id) setForm(blank(live?.bias)) } }

  const exportCsv = () => {
    const text = [FIELDS.join(','), ...trades.map(t => FIELDS.map(k => csvCell(t[k])).join(','))].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
    a.download = `trade-journal-${todayIst()}.csv`
    a.click(); URL.revokeObjectURL(a.href)
  }
  const importCsv = async e => {
    const f = e.target.files?.[0]; e.target.value = ''
    if (!f) return
    const [head, ...rows] = parseCsv(await f.text())
    const idx = Object.fromEntries((head || []).map((h, i) => [h.trim(), i]))
    if (idx.legs == null || idx.date == null) return window.alert('This file needs the columns from Export CSV (date, legs, …).')
    const add = rows.map(r => {
      const t = blank()
      for (const k of FIELDS) if (idx[k] != null) t[k] = r[idx[k]] ?? ''
      try { t.legs = JSON.parse(t.legs || '[]') } catch { t.legs = [] }
      t.rules = String(t.rules).toLowerCase() !== 'false'
      t.locked = true  // imported history is read-only
      delete t.auto
      return { ...t, id: newId() }
    }).filter(t => t.legs.length)
    const key = t => [t.date, t.time, t.und, JSON.stringify(t.legs)].join('|')
    setTrades(ts => { const have = new Set(ts.map(key)); return [...ts, ...add.filter(t => !have.has(key(t)))] })
  }

  const th = (k, text, cls = '') => <th className={cls + ' sortable'} onClick={() => setSort(s => ({ k, dir: s.k === k ? -s.dir : -1 }))}>
    {text}{sort.k === k ? (sort.dir < 0 ? ' ▾' : ' ▴') : ''}</th>
  const prem = (t, k) => { const ls = legsOf(t); return ls.length === 1 ? (ls[0][k] === '' || ls[0][k] == null ? null : ls[0][k]) : null }

  const ix = live?.indices || {}
  const stockQ = form.seg === 'Stock' ? live?.stocks?.find(x => x.symbol === form.und) : null
  return <div className="journal">
    {slot ? createPortal(<AccountBar acc={acc} count={trades.length} />, slot) : <AccountBar acc={acc} count={trades.length} />}
    <div className="cards four">
      <IndexCard name="NIFTY 50" label="NIFTY 50" q={ix.nifty50} />
      <IndexCard name="NIFTY BANK" label="NIFTY BANK" q={ix.niftybank} />
      <IndexCard name="SENSEX" label="SENSEX" q={ix.sensex} />
      {stockQ ? <IndexCard name={stockQ.symbol} label={stockQ.symbol} q={stockQ} />
        : <div className="card"><div className="card-k">Stock</div><div className="card-v muted">—</div>
          <div className="card-n">{form.seg === 'Stock' && form.und ? `${form.und} not found in the F&O list` : 'Choose Stock in Add trade to see its LTP here'}</div></div>}
    </div>
    <div className="jr-stats">
      {[
        ['Net P&L', money(st.net, true), tone(st.net), `${st.n} closed · ${st.open} open`],
        ['Win rate', pct(st.win), '', st.streak ? `Current streak: ${Math.abs(st.streak)} ${st.streak > 0 ? 'win' : 'loss'}${Math.abs(st.streak) > 1 ? (st.streak > 0 ? 's' : 'es') : ''}` : 'No streak'],
        ['Avg win / avg loss', `${money(st.avgWin)} / ${money(st.avgLoss)}`, '', st.avgWin && st.avgLoss ? `Ratio ${(st.avgWin / -st.avgLoss).toFixed(2)}` : '—'],
        ['Profit factor', st.pf == null ? '—' : st.pf.toFixed(2), st.pf == null ? '' : st.pf >= 1 ? 'up' : 'down', 'Gross win ÷ gross loss'],
        ['Expectancy / trade', money(st.exp, true), tone(st.exp), st.avgR == null ? 'Add a stop-loss to see R' : `Avg ${st.avgR.toFixed(2)} R`],
        ['Max drawdown', money(st.dd), st.dd < 0 ? 'down' : '', `Best ${money(st.best, true)} · worst ${money(st.worst, true)}`],
      ].map(([k, v, c, n]) => <div className="card" key={k}><div className="card-k">{k}</div><div className={'card-v ' + c}>{v}</div><div className="card-n">{n}</div></div>)}
    </div>

    <div className="jr-top">
      <TradeForm form={form} setForm={setForm} onSave={save} onAddAll={addAll} onCancel={() => setForm(blank(live?.bias))} live={live} />
      <div className="panel jr-side-panel">
        <div className="panel-head"><h3>{day && day !== todayIst() ? day : "Today's"} trades</h3><span className="muted small">P&amp;L per trade and the day's total · pick another day on the calendar</span></div>
        <DayTrades list={all} day={day} />
        <Calendar list={all} month={month} setMonth={setMonth} day={day} setDay={setDay} />
        <div className="jr-side-break"><Breakdown title="By strategy" rows={groupBy(list, t => t.strategy || t.setup)} /></div>
      </div>
    </div>

    <div className="panel">
      <div className="panel-head jr-bar">
        <h3>Trades <span className="muted small">{list.length} shown of {trades.length}</span></h3>
        <div className="jr-filters">
          {day ? <button className="btn" onClick={() => setDay(null)}>Day {day} ✕</button>
            : <div className="seg">{[['all', 'All'], ['today', 'Today'], ['week', 'This week'], ['month', 'This month']].map(([v, l]) =>
              <button key={v} className={range === v ? 'on' : ''} onClick={() => setRange(v)}>{l}</button>)}</div>}
          <div className="seg">{[['all', 'All'], ['win', 'Wins'], ['loss', 'Losses'], ['open', 'Open']].map(([v, l]) =>
            <button key={v} className={result === v ? 'on' : ''} onClick={() => setResult(v)}>{l}</button>)}</div>
          <input className="jr-search" placeholder="Search trade, strategy, notes…" value={q} onChange={e => setQ(e.target.value)} />
          {picked.length > 0 && <button className="btn jr-del-sel" onClick={delPicked}>Delete selected ({picked.length})</button>}
          <button className="btn" onClick={exportCsv} disabled={!trades.length}>Export CSV</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>Import CSV</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={importCsv} />
        </div>
      </div>
      {sorted.length ? <div className="tbl-wrap"><table className="tbl jr-tbl">
        <thead><tr><th className="jr-pick"><input type="checkbox" checked={allPicked} onChange={pickAll} title="Select all shown" aria-label="Select all shown trades" /></th>{th('date', 'Date')}{th('name', 'Trade')}{th('strategy', 'Strategy')}<th className="num">Qty</th><th className="num">Entry</th><th className="num">Exit</th>
          {th('pnl', 'P&L', 'num')}{th('r', 'R', 'num')}{th('mood', 'Mood')}<th>Rules</th><th>Notes</th><th /></tr></thead>
        <tbody>{sorted.map(t => {
          const e = prem(t, 'entry'), x = prem(t, 'exit')
          const lk = locked(t)
          return <React.Fragment key={t.id}><tr className={(form.id === t.id ? 'editing' : '') + (lk ? ' locked' : '')}>
            <td className="jr-pick"><input type="checkbox" checked={picked.includes(t.id)} onChange={() => togglePick(t.id)} aria-label={'Select ' + t.name} /></td>
            <td className="nowrap">{t.date} <span className="muted">{t.time}</span></td>
            <td><b>{t.name}</b><div className="muted small">{[t.role === 'seller' ? 'Option seller' : t.role === 'buyer' ? 'Option buyer' : t.segment, t.expiry].filter(Boolean).join(' · ')}</div></td>
            <td>{t.strategy ? <span className={'jr-tag ' + (t.role === 'seller' ? 'amber' : 'up')}>{t.strategy}</span> : t.setup || '—'}</td>
            <td className="num">{qtyOf(t).toLocaleString('en-IN')}</td>
            <td className="num">{e ?? (t.c.net == null ? '—' : (t.c.net >= 0 ? 'Cr ' : 'Dr ') + Math.abs(t.c.net).toFixed(2))}</td>
            <td className="num">{t.c.open ? <span className="jr-tag amber">Open</span> : x ?? 'Closed'}</td>
            <td className={'num ' + tone(t.c.pnl)}><b>{money(t.c.pnl, true)}</b></td>
            <td className={'num ' + tone(t.c.r)}>{t.c.r == null ? '—' : t.c.r.toFixed(2)}</td>
            <td>{t.mood}</td>
            <td>{t.rules ? <span className="up">✓</span> : <span className="down">✗</span>}</td>
            <td className="jr-notes" title={[t.setup, t.notes].filter(Boolean).join(' — ')}>{[t.setup, t.notes].filter(Boolean).join(' — ')}</td>
            <td className="nowrap jr-act">
              {lk ? <>
                <button className={'btn ghost jr-lock' + (unlocked === t.id ? ' open' : '')} onClick={() => setUnlocked(u => u === t.id ? null : t.id)}
                  title={unlocked === t.id ? 'Lock again' : 'Locked — click to edit or delete this entry'}>{unlocked === t.id ? '🔓' : '🔒 Locked'}</button>
                {unlocked === t.id ? <>
                  <button className="btn ghost" onClick={() => edit(t)}>Edit</button>
                  <button className="btn ghost down" onClick={() => del(t)}>Delete</button>
                </> : t.c.open && t.legs?.length > 0 && <button className="btn ghost" onClick={() => setClosing({ id: t.id, exits: t.legs.map(l => l.exit ?? '') })} title="Only the exit premium can be added">Close</button>}
              </> : <>
                <button className="btn ghost" onClick={() => edit(t)}>{t.c.open ? 'Close / edit' : 'Edit'}</button>
                <button className="btn ghost down" onClick={() => del(t)}>Delete</button>
              </>}
              <button className="btn ghost" onClick={() => dup(t)} title="Copy into the form as a new trade">Copy</button>
            </td>
          </tr>
          {closing?.id === t.id && <tr className="jr-close-row"><td colSpan="13">
            <b>Close {t.name}</b> — exit premium for each leg:
            {t.legs.map((l, i) => <label key={i}>{l.a === 'S' ? 'Sell' : 'Buy'} {l.k} {l.t} <span className="muted">(entry {l.entry})</span>
              <input type="number" step="any" inputMode="decimal" value={closing.exits[i]} autoFocus={i === 0}
                onChange={e => setClosing(c => ({ ...c, exits: c.exits.map((v, j) => j === i ? e.target.value : v) }))} /></label>)}
            <button className="btn primary" onClick={saveClose} disabled={closing.exits.some(v => num(v) == null)}>Save exit</button>
            <button className="btn ghost" onClick={() => setClosing(null)}>Cancel</button>
          </td></tr>}
          </React.Fragment>
        })}</tbody>
      </table></div>
        : <div className="empty">{trades.length ? 'No trades match these filters.' : 'No trades yet — add your first one above.'}</div>}
    </div>

    <div className="muted small">🔒 Only the newest entry can be edited or deleted; once you add another trade, older ones are locked (an open trade can still get its exit price; click 🔒 to edit or delete one). Always saved in this browser; signed in, also saved to your account. Export CSV makes a backup file. Your own records — not a recommendation.</div>
  </div>
}
