import React, { useEffect, useMemo, useState } from 'react'
import { api, isNum, istTime, usePoll } from './lib.js'

// Index Options -> rule summary built on the user's own rules.
//  1. Rule summary    — the user's CE / PE conditions checked against live Nifty data (3-min, 5-min),
//                      shown as two meters + one status line inside the Option chain card.
// Nothing here picks a trade: each tool reports facts and the user's own limits.

const fmt = (v, d = 2) => isNum(v) ? v.toLocaleString('en-IN', { maximumFractionDigits: d }) : '—'
const rs = v => isNum(v) ? (v < 0 ? '−₹' : '₹') + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch { return d } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode: keep in memory only */ } },
}
const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })

// ---- 1. Rule checklist -------------------------------------------------------------------------
function ema(vals, n) {
  const k = 2 / (n + 1)
  let e = null
  for (const v of vals) e = e == null ? v : v * k + e * (1 - k)
  return e
}

function frameStats(candles, tfMin) {
  if (!candles?.length) return null
  const day = candles[candles.length - 1].d
  const nowIst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  const nowMin = nowIst.getHours() * 60 + nowIst.getMinutes()
  const isToday = day === todayIst()
  // last *closed* candle (the newest one may still be forming during the session)
  const closed = candles.filter(c => !isToday || c.d !== day || c.m + tfMin <= nowMin)
  const last = closed[closed.length - 1]
  const todays = candles.filter(c => c.d === day)
  const or = todays.filter(c => c.m >= 555 && c.m < 570)  // 9:15 – 9:30 opening range
  const closes = closed.map(c => c.c)
  return {
    day, last, at: last && `${String(Math.floor(last.m / 60)).padStart(2, '0')}:${String(last.m % 60).padStart(2, '0')}`,
    twap: todays.length ? todays.reduce((t, c) => t + (c.h + c.l + c.c) / 3, 0) / todays.length : null,
    ema9: ema(closes, 9), ema21: ema(closes, 21),
    orHigh: or.length ? Math.max(...or.map(c => c.h)) : null, orLow: or.length ? Math.min(...or.map(c => c.l)) : null,
  }
}

export function RuleSummary({ d, exp }) {
  const c3 = usePoll(() => api('/api/chart/candles?symbol=NIFTY&tf=3m'), 30000, [])
  const c5 = usePoll(() => api('/api/chart/candles?symbol=NIFTY&tf=5m'), 30000, [])
  const s3 = useMemo(() => frameStats(c3.data?.candles, 3), [c3.data])
  const s5 = useMemo(() => frameStats(c5.data?.candles, 5), [c5.data])
  // near-the-money OI (ATM ± 5 strikes) from the option chain
  const oi = useMemo(() => {
    const ch = exp?.chain || []
    if (!ch.length || !d?.spot) return null
    const i = ch.reduce((b, r, j) => Math.abs(r.k - d.spot) < Math.abs(ch[b].k - d.spot) ? j : b, 0)
    const cR = ch.slice(i, i + 6), pR = ch.slice(Math.max(0, i - 5), i + 1)
    const sum = (rows, side, key) => rows.reduce((t, r) => t + (r[side]?.[key] || 0), 0)
    const cOi = sum(cR, 'call', 'oi'), pOi = sum(pR, 'put', 'oi')
    const res = cR.reduce((a, r) => (r.call?.oi || 0) > (a.call?.oi || 0) ? r : a, cR[0])
    const sup = pR.reduce((a, r) => (r.put?.oi || 0) > (a.put?.oi || 0) ? r : a, pR[0])
    return { pcr: cOi ? pOi / cOi : null, cChg: sum(cR, 'call', 'oi_chg'), pChg: sum(pR, 'put', 'oi_chg'), res: res?.k, sup: sup?.k }
  }, [exp, d?.spot])
  if (!s3 || !s5 || !oi) return <div className="muted small">{c3.error || c5.error || 'Loading your rule check (Nifty 3-min / 5-min)…'}</div>

  const row = (label, f3, f5, note) => ({ label, f3, f5, note })
  const ce = [
    row('Close above opening-range high (9:15–9:30)', s3.last.c > s3.orHigh, s5.last.c > s5.orHigh, `OR high ${fmt(s3.orHigh)}`),
    row('Close above resistance (highest call OI, ATM→+5)', s3.last.c > oi.res, s5.last.c > oi.res, `${fmt(oi.res, 0)}`),
    row('Above session average (TWAP)', s3.last.c > s3.twap, s5.last.c > s5.twap, `${fmt(s3.twap)} / ${fmt(s5.twap)}`),
    row('EMA 9 above EMA 21', s3.ema9 > s3.ema21, s5.ema9 > s5.ema21, `${fmt(s3.ema9)} vs ${fmt(s3.ema21)} (3m)`),
    row('Near-the-money PCR ≥ 1 (put OI ≥ call OI)', oi.pcr >= 1, oi.pcr >= 1, `PCR ${fmt(oi.pcr)}`),
    row('Put OI added faster than call OI', oi.pChg > oi.cChg, oi.pChg > oi.cChg, `put ${fmt(oi.pChg * 65 / 1e5)}L vs call ${fmt(oi.cChg * 65 / 1e5)}L`),
  ]
  const pe = [
    row('Close below opening-range low (9:15–9:30)', s3.last.c < s3.orLow, s5.last.c < s5.orLow, `OR low ${fmt(s3.orLow)}`),
    row('Close below support (highest put OI, ATM→−5)', s3.last.c < oi.sup, s5.last.c < oi.sup, `${fmt(oi.sup, 0)}`),
    row('Below session average (TWAP)', s3.last.c < s3.twap, s5.last.c < s5.twap, `${fmt(s3.twap)} / ${fmt(s5.twap)}`),
    row('EMA 9 below EMA 21', s3.ema9 < s3.ema21, s5.ema9 < s5.ema21, `${fmt(s3.ema9)} vs ${fmt(s3.ema21)} (3m)`),
    row('Near-the-money PCR < 1 (call OI > put OI)', oi.pcr < 1, oi.pcr < 1, `PCR ${fmt(oi.pcr)}`),
    row('Call OI added faster than put OI', oi.cChg > oi.pChg, oi.cChg > oi.pChg, `call ${fmt(oi.cChg * 65 / 1e5)}L vs put ${fmt(oi.pChg * 65 / 1e5)}L`),
  ]
  const count = (rows, k) => rows.filter(r => r[k]).length
  const vix = d?.dvol, vixChg = d?.dvol_change_24h
  // Summary: which side your own conditions favour (both timeframes must agree), and what is missing.
  const met = rows => Math.min(count(rows, 'f3'), count(rows, 'f5'))
  const ceN = met(ce), peN = met(pe), N = ce.length
  const missing = rows => rows.filter(r => !(r.f3 && r.f5)).map(r => r.label.replace(/ \(.*\)$/, ''))
  let sum
  if (ceN >= 3 && peN >= 3) sum = { key: 'conflict', title: 'Conditions conflict', text: `CE ${ceN}/${N} and PE ${peN}/${N} are both partly met — your rules say no trade when signals conflict.` }
  else if (ceN === N) sum = { key: 'ce', title: 'All your CE conditions are met', text: 'On both 3-min and 5-min. Still confirm volume (futures), option liquidity / spread and your risk check before acting.' }
  else if (peN === N) sum = { key: 'pe', title: 'All your PE conditions are met', text: 'On both 3-min and 5-min. Still confirm volume (futures), option liquidity / spread and your risk check before acting.' }
  else if (ceN >= 4 && peN <= 2) sum = { key: 'ce-lean', title: `CE side leading — ${ceN}/${N} of your conditions`, text: 'Not all met yet. Missing: ' + missing(ce).join(' · ') + '.' }
  else if (peN >= 4 && ceN <= 2) sum = { key: 'pe-lean', title: `PE side leading — ${peN}/${N} of your conditions`, text: 'Not all met yet. Missing: ' + missing(pe).join(' · ') + '.' }
  else sum = { key: 'wait', title: 'Wait — neither side has enough of your conditions', text: `CE ${ceN}/${N} · PE ${peN}/${N}. Your rules: if the market is sideways or evidence is insufficient, wait.` }
  const ICON = { ce: '🟢', pe: '🟢', 'ce-lean': '🟡', 'pe-lean': '🟡', conflict: '🔴', wait: '⚪' }
  const meter = (label, n, tone) => <div className={'rule-meter ' + tone}><span>{label}</span>
    <span className="rule-bar">{Array.from({ length: N }, (_, i) => <i key={i} className={i < n ? 'on' : ''} />)}</span><b>{n}/{N}</b></div>
  // Compact summary shown inside the Option chain card (hover for each condition's status).
  const tip = [...ce.map(r => `CE · ${r.label}: ${r.f3 && r.f5 ? 'met' : 'not met'}`), ...pe.map(r => `PE · ${r.label}: ${r.f3 && r.f5 ? 'met' : 'not met'}`)].join('\n')
  return <div className={'rule-sum ' + sum.key} title={tip + `\n\nLast closed candle 3-min ${s3.at} · 5-min ${s5.at} IST. A condition counts when met on both timeframes. Not a buy / sell signal.`}>
    <div className="rule-meters">{meter('CE side', ceN, 'up')}{meter('PE side', peN, 'down')}</div>
    <div><b>{ICON[sum.key]} {sum.title}</b><div className="small">{sum.text}</div></div>
  </div>
}
