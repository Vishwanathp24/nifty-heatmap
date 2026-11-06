import React, { useEffect, useMemo, useState } from 'react'
import { BiasPill, Empty, Seg, SortTh, StockLink, TopFilter, TopTag, useTopPass } from './components.jsx'
import { api, fmtNum, fmtVol, hhmmTo12, isNum, istTime, setSessionValue, sortRows, usePersistentState, usePoll, useSessionState } from './lib.js'
import Trend, { trendNeed, trendRows, useTrendSettings } from './Trend.jsx'
import { SectorMulti, StockDrawer } from './Scanner.jsx'
import { INDIA, OptionsBoard } from './CryptoOptions.jsx'
import { ChartView } from './Chart.jsx'
import { OS_CHECKS, OS_KIND, OsPlan, osRegime } from './OptSell.jsx'

// Condition scans modelled on the Chartink screens the user follows. "Daily" = today's
// candle (NSE official open/high/low/last/volume) on top of Yahoo daily history;
// "1 hour" = 09:15-aligned hourly candles, the latest one still forming in market hours.
const n2 = v => fmtNum(v, 2)
const gt = (a, b) => isNum(a) && isNum(b) && a > b
const lt = (a, b) => isNum(a) && isNum(b) && a < b

const SCANS = {
  bull: {
    title: 'Bullish Intraday', universe: 'fo', tone: 'up',
    about: 'F&O stocks (futures segment) where the daily and hourly close are above their 20-period SMA and above the highs of the previous 5 candles, with RSI above 60 on both.',
    conds: [
      { k: 'dsma', label: 'D SMA 20', title: 'Daily close > daily SMA(close, 20)', val: r => r.daily?.sma20, pass: r => gt(r.daily?.close, r.daily?.sma20) },
      { k: 'dhi', label: 'D 5-day High', title: 'Daily close > high of each of the last 5 days', val: r => r.daily?.hi5, pass: r => gt(r.daily?.close, r.daily?.hi5) },
      { k: 'hsma', label: '1H SMA 20', title: '1-hour close > 1-hour SMA(close, 20)', val: r => r.hourly?.sma20, pass: r => gt(r.hourly?.close, r.hourly?.sma20) },
      { k: 'hhi', label: '1H 5-bar High', title: '1-hour close > high of each of the previous 5 hourly candles', val: r => r.hourly?.hi5, pass: r => gt(r.hourly?.close, r.hourly?.hi5) },
      { k: 'drsi', label: 'D RSI', title: 'Daily RSI(14) > 60', val: r => r.daily?.rsi, fmt: v => fmtNum(v, 1), pass: r => gt(r.daily?.rsi, 60) },
      { k: 'hrsi', label: '1H RSI', title: '1-hour RSI(14) > 60', val: r => r.hourly?.rsi, fmt: v => fmtNum(v, 1), pass: r => gt(r.hourly?.rsi, 60) },
    ],
  },
  bear: {
    title: 'Bearish Intraday', universe: 'fo', tone: 'down',
    about: 'F&O stocks (futures segment) where the daily and hourly close are below their 20-period SMA and below the lows of the previous 5 candles, with RSI below 40 on both.',
    conds: [
      { k: 'dsma', label: 'D SMA 20', title: 'Daily close < daily SMA(close, 20)', val: r => r.daily?.sma20, pass: r => lt(r.daily?.close, r.daily?.sma20) },
      { k: 'dlo', label: 'D 5-day Low', title: 'Daily close < low of each of the last 5 days', val: r => r.daily?.lo5, pass: r => lt(r.daily?.close, r.daily?.lo5) },
      { k: 'hsma', label: '1H SMA 20', title: '1-hour close < 1-hour SMA(close, 20)', val: r => r.hourly?.sma20, pass: r => lt(r.hourly?.close, r.hourly?.sma20) },
      { k: 'hlo', label: '1H 5-bar Low', title: '1-hour close < low of each of the previous 5 hourly candles', val: r => r.hourly?.lo5, pass: r => lt(r.hourly?.close, r.hourly?.lo5) },
      { k: 'drsi', label: 'D RSI', title: 'Daily RSI(14) < 40', val: r => r.daily?.rsi, fmt: v => fmtNum(v, 1), pass: r => lt(r.daily?.rsi, 40) },
      { k: 'hrsi', label: '1H RSI', title: '1-hour RSI(14) < 40', val: r => r.hourly?.rsi, fmt: v => fmtNum(v, 1), pass: r => lt(r.hourly?.rsi, 40) },
    ],
  },
  btst: {
    title: 'BTST Stocks', universe: 'fo', tone: 'up',
    about: 'F&O stocks (futures segment) with volume above 3× the 5-day average, daily RSI above 65, open and close above yesterday’s, and close within 15% of the 250-day high.',
    conds: [
      { k: 'vol', label: 'Vol × 5D avg', title: 'Daily volume > 3 × SMA(daily volume, 5)', val: r => r.daily?.vol_sma5 ? r.daily.vol / r.daily.vol_sma5 : null, fmt: v => isNum(v) ? v.toFixed(2) + '×' : '—', pass: r => gt(r.daily?.vol, 3 * (r.daily?.vol_sma5 ?? NaN)) },
      { k: 'drsi', label: 'D RSI', title: 'Daily RSI(14) > 65', val: r => r.daily?.rsi, fmt: v => fmtNum(v, 1), pass: r => gt(r.daily?.rsi, 65) },
      { k: 'open', label: 'Prev Open', title: 'Daily open > yesterday’s open', val: r => r.daily?.prev_open, pass: r => gt(r.daily?.open, r.daily?.prev_open) },
      { k: 'close', label: 'Prev Close', title: 'Daily close > yesterday’s close', val: r => r.daily?.prev_close, pass: r => gt(r.daily?.close, r.daily?.prev_close) },
      { k: 'h250', label: '% of 250D High', title: 'Daily close ≥ 0.85 × highest high of the last 250 days', val: r => r.daily?.high250 ? r.daily.close / r.daily.high250 * 100 : null, fmt: v => isNum(v) ? v.toFixed(1) + '%' : '—', pass: r => isNum(r.daily?.close) && isNum(r.daily?.high250) && r.daily.close >= 0.85 * r.daily.high250 },
    ],
  },
}

export function scanRows(rows, id) {
  const sc = SCANS[id]
  return (rows || []).filter(r => sc.universe === 'all' || r.fo).map(r => {
    const res = sc.conds.map(c => c.pass(r))
    return { ...r, met: res.filter(Boolean).length, res, since: r.since?.[id] || null }
  })
}

function ConditionScan({ id, data, onPick, picked }) {
  const sc = SCANS[id]
  const [allOnly, setAllOnly] = useSessionState('scan.allOnly.' + id, true)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ key: 'met', dir: 'desc' })
  const rows = useMemo(() => scanRows(data?.rows, id).map(r => ({ ...r, ...Object.fromEntries(sc.conds.map(c => ['v_' + c.k, c.val(r)])) })), [data, id])
  const q = search.trim().toUpperCase()
  const base = rows.filter(r => !q || r.symbol.includes(q) || (r.company || '').toUpperCase().includes(q))
  const full = base.filter(r => r.met === sc.conds.length)
  const topPass = useTopPass()
  const shown = topPass(sortRows(allOnly ? full : base, sort.key, sort.dir))
  const sp = { sort, setSort }
  const N = sc.conds.length
  return <>
    <p className="muted small qualify-line"><b className={sc.tone}>{full.length}</b> of {base.length} stocks meet all {N} conditions. {sc.about}</p>
    <div className="toolbar">
      <input className="search" placeholder="Search symbol" value={search} onChange={e => setSearch(e.target.value)} />
      <label className="check-label"><input type="checkbox" checked={allOnly} onChange={e => setAllOnly(e.target.checked)} />Only stocks meeting all {N} conditions</label>
      <TopFilter />
    </div>
    <div className="tbl-wrap panel trend-wrap">
      <table className="tbl trend-tbl cond-tbl pickable">
        <thead><tr>
          <SortTh label="Symbol" k="symbol" {...sp} defaultDir="asc" />
          <SortTh label="Sector" k="sector" {...sp} defaultDir="asc" />
          <SortTh label="LTP" k="ltp" {...sp} num />
          <SortTh label="Chg %" k="pct_prev" {...sp} num />
          <SortTh label="Met" k="met" {...sp} num title={`Conditions met out of ${N}`} />
          <SortTh label="Time" k="since" {...sp} title="Time (IST) since when the stock has met every condition today (close of the first qualifying 15-min candle)" />
          {sc.conds.map(c => <SortTh key={c.k} label={c.label} k={'v_' + c.k} {...sp} num title={c.title} />)}
        </tr></thead>
        <tbody>{shown.map(r => <tr key={r.symbol} onClick={() => onPick(r)} className={picked === r.symbol ? 'active' : undefined}>
          <td><StockLink symbol={r.symbol} company={r.company} className="strong" /><TopTag symbol={r.symbol} /></td>
          <td className="muted">{r.sector}</td>
          <td className="num">{fmtNum(r.ltp)}</td>
          <td className={'num ' + (r.pct_prev > 0 ? 'up' : r.pct_prev < 0 ? 'down' : '')}>{isNum(r.pct_prev) ? (r.pct_prev > 0 ? '+' : '') + r.pct_prev.toFixed(2) + '%' : '—'}</td>
          <td className={'num strong ' + (r.met === N ? sc.tone : '')}>{r.met}/{N}</td>
          <td className="num">{r.met === N ? (r.since ? hhmmTo12(r.since) : 'just now') : '—'}</td>
          {sc.conds.map((c, i) => <td key={c.k} className={'num ind ' + (r.res[i] ? 'pass' : 'fail')} title={c.title}>{(c.fmt || n2)(r['v_' + c.k], r)}</td>)}
        </tr>)}</tbody>
      </table>
      {!shown.length && <Empty>No stock meets every condition right now. Untick “Only stocks meeting all conditions” to see the closest ones (sorted by conditions met).</Empty>}
    </div>
    <p className="muted small">Each cell shows the level the condition compares against (hover for the exact rule); green = met, red = not met. Daily values use today’s live candle, so results change during the session. Condition screen, not a buy/sell recommendation.</p>
  </>
}

// Volume Spike: Daily Volume > Daily SMA(volume, 20) × 3 (the average includes today, as on Chartink),
// for the chosen list. Data from /api/volscan (NSE index lists for today + Yahoo daily history).
// Bullish = price up on the day with the volume, Bearish = price down, All = both.
const VOL_LISTS = [{ value: 'fo', label: 'F&O' }, { value: 'n50', label: 'Nifty 50' }, { value: 'n500', label: 'Nifty 500' },
  { value: 'mid', label: 'Midcap 150' }, { value: 'small', label: 'Smallcap 250' }]
const VOL_X = 3
const volDir = (r, dir) => dir === 'all' || (dir === 'bull' ? r.pct_prev > 0 : r.pct_prev < 0)
const volHits = (data, list, dir = 'all') => data ? data.rows.filter(r => r.lists.includes(list) && r.ratio > VOL_X && volDir(r, dir)) : null

function VolumeSpike({ vol, stocks, list, setList, onPick, picked }) {
  const [dir, setDir] = useSessionState('vol.dir', 'all')
  const [allRows, setAllRows] = useSessionState('vol.all', false)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ key: 'ratio', dir: 'desc' })
  const d = vol.data
  const sector = useMemo(() => Object.fromEntries((stocks || []).map(s => [s.symbol, s.sector])), [stocks])
  const q = search.trim().toUpperCase()
  const base = (d?.rows || []).filter(r => r.lists.includes(list) && volDir(r, dir) && (!q || r.symbol.includes(q) || (r.company || '').toUpperCase().includes(q)))
    .map(r => ({ ...r, sector: sector[r.symbol] || '—' }))
  const hits = base.filter(r => r.ratio > VOL_X)
  const topPass = useTopPass()
  const shown = topPass(sortRows(allRows ? base : hits, sort.key, sort.dir))  // Top 20 gainers / losers filter, as on the other scans
  const sp = { sort, setSort }
  const p = d?.progress
  const listName = VOL_LISTS.find(l => l.value === list)?.label
  const n = k => d ? topPass(volHits(d, list, k)).length : ''  // follow the Top 20 button, like the list
  return <>
    <div className="toolbar">
      <Seg value={dir} onChange={setDir} className="vol-dir" options={[{ value: 'all', label: <>All <span className="count">{n('all')}</span></> },
        { value: 'bull', label: <>Bullish <span className="count">{n('bull')}</span></>, tone: 'up' },
        { value: 'bear', label: <>Bearish <span className="count">{n('bear')}</span></>, tone: 'down' }]} />
      <TopFilter />
      <Seg options={VOL_LISTS} value={list} onChange={setList} />
      <input className="search" placeholder="Search symbol" value={search} onChange={e => setSearch(e.target.value)} />
      <label className="check-label"><input type="checkbox" checked={allRows} onChange={e => setAllRows(e.target.checked)} />Show all stocks (sorted by × average)</label>
    </div>
    <p className="muted small qualify-line"><b className={dir === 'bear' ? 'down' : 'up'}>{hits.length}</b> of {base.length} {listName} stocks{dir === 'bull' ? ' trading up' : dir === 'bear' ? ' trading down' : ''} with <b>Daily Volume &gt; Daily SMA(volume, 20) × {VOL_X}</b> (today's volume more than 3 times its 20-day average, today included){dir === 'all' ? '' : dir === 'bull' ? '; bullish = price up on the day' : '; bearish = price down on the day'}.</p>
    {!d ? <Empty>{vol.error || 'Loading volume data…'}</Empty> : <div className="tbl-wrap panel trend-wrap">
      <table className="tbl trend-tbl pickable">
        <thead><tr>
          <SortTh label="Symbol" k="symbol" {...sp} defaultDir="asc" />
          <SortTh label="Sector" k="sector" {...sp} defaultDir="asc" />
          <SortTh label="LTP" k="ltp" {...sp} num />
          <SortTh label="Chg %" k="pct_prev" {...sp} num />
          <SortTh label="Volume" k="vol" {...sp} num title="Today's traded volume (NSE)" />
          <SortTh label="SMA 20 Vol" k="sma20" {...sp} num title="Average daily volume of the last 20 sessions, today included" />
          <SortTh label="× Avg" k="ratio" {...sp} num title="Today's volume ÷ SMA(volume, 20); above 3 = signal" />
        </tr></thead>
        <tbody>{shown.map(r => <tr key={r.symbol} onClick={() => onPick(r)} className={picked === r.symbol ? 'active' : undefined}>
          <td><StockLink symbol={r.symbol} company={r.company} className="strong" /><TopTag symbol={r.symbol} /></td>
          <td className="muted">{r.sector}</td>
          <td className="num">{fmtNum(r.ltp)}</td>
          <td className={'num ' + (r.pct_prev > 0 ? 'up' : r.pct_prev < 0 ? 'down' : '')}>{isNum(r.pct_prev) ? (r.pct_prev > 0 ? '+' : '') + r.pct_prev.toFixed(2) + '%' : '—'}</td>
          <td className="num">{fmtVol(r.vol)}</td>
          <td className="num muted">{fmtVol(r.sma20)}</td>
          <td className={'num strong ind ' + (r.ratio > VOL_X ? 'pass' : 'fail')}>{isNum(r.ratio) ? r.ratio.toFixed(2) + '×' : '—'}</td>
        </tr>)}</tbody>
      </table>
      {!shown.length && <Empty>{p && p.done < p.total ? `Loading 20-day volume history… ${p.done} of ${p.total} stocks` : `No ${listName} stock has more than ${VOL_X}× its average volume right now.`}</Empty>}
    </div>}
    <p className="muted small">Volume and price: NSE index lists (session {d?.session || '…'}{d?.quotes_at ? `, updated ${istTime(d.quotes_at)} IST` : ''}; every 2 minutes in market hours). Earlier daily volumes: Yahoo Finance, refreshed once a day{p && p.done < p.total ? ` (loading ${p.done}/${p.total})` : ''}. During the session today's volume is still growing, so early in the day only very heavy volume shows up. Condition screen, not a buy/sell signal.</p>
  </>
}

const ALL_TABS = [['setup', 'Trade Setup'], ['iopt', 'Index Options'], ['fno', 'F&O Stocks'], ['osell', 'Option Selling'], ['trend', 'Trending Stocks'], ['bull', 'Bullish Intraday'], ['bear', 'Bearish Intraday'], ['btst', 'BTST Stocks'], ['vol', 'Volume Spike'], ['ema', 'EMA 9/21 + RSI'], ['candle', 'Candlestick'], ['common', 'Common Stocks'], ['chart', 'Live Chart']]
// Extra scanners: hidden unless "More scanners" is switched on (remembered in this browser)
const HIDDEN_TABS = ['iopt', 'btst', 'vol', 'ema', 'candle']
const BASE_TABS = ALL_TABS.filter(([v]) => !HIDDEN_TABS.includes(v))
// Basic mode: just these four scans
const BASIC_TABS = [['bull', 'Bullish Intraday'], ['bear', 'Bearish Intraday'], ['t15', '15 Min Trend']]

// Live Chart: NSE stock candles (Yahoo) on 1m ... 1M with the indicator table; the stock list
// follows the sector filter.
// Prices without the ₹ sign (cleaner).
const inr = v => !isNum(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const inrShort = v => !isNum(v) ? '—' : v >= 1000 ? Math.round(v).toLocaleString('en-IN') : inr(v)
// Common Stocks: F&O stocks that appear in every scan for one direction - Trending Stocks, Bullish /
// Bearish Intraday and the 15 / 30 / 60-minute ORB breakouts (breakdowns) - each list as its tab shows it.
const COMMON = [['trend', 'Trending'], ['intra', 'Intraday'], ['o15', '15 Min ORB'], ['o30', '30 Min ORB'], ['o60', '1 Hour ORB']]
function CommonStocks({ data, settings, orbLists, bias, onPick, picked }) {
  const [dir, setDir] = useState(bias === 'BEARISH' ? 'bear' : 'bull')
  const [allOnly, setAllOnly] = useSessionState('common.allOnly', true)
  const bull = dir === 'bull', sig = bull ? 'BREAKOUT' : 'BREAKDOWN'
  const rows = useMemo(() => {
    const need = trendNeed(settings.tfs), intra = bull ? 'bull' : 'bear'
    const sets = {
      trend: trendRows(data.rows, { ...settings, dir }).filter(r => (settings.universe === 'all' || r.fo) && r.score === need),
      intra: scanRows(data.rows, intra).filter(r => r.met === SCANS[intra].conds.length),
      o15: (orbLists[15] || []).filter(r => r.signal === sig), o30: (orbLists[30] || []).filter(r => r.signal === sig), o60: (orbLists[60] || []).filter(r => r.signal === sig),
    }
    const info = Object.fromEntries(data.rows.map(r => [r.symbol, r]))
    const hits = new Map()
    // time each list caught the stock: ORB = break candle, Trending / Intraday = start of today's qualifying run
    for (const [k] of COMMON) for (const r of sets[k]) { const h = hits.get(r.symbol) || { symbol: r.symbol, company: r.company, sector: r.sector, ltp: r.ltp, pct_prev: r.pct_prev, ...info[r.symbol], in: {} }; h.in[k] = r.break_time || r.since || true; hits.set(r.symbol, h) }
    return [...hits.values()].map(h => { const ts = Object.values(h.in).filter(t => typeof t === 'string'); return { ...h, n: Object.keys(h.in).length, at: ts.sort().pop() || null } })
      .sort((a, b) => b.n - a.n || (b.at || '').localeCompare(a.at || '') || a.symbol.localeCompare(b.symbol))
  }, [data, settings, orbLists, dir])
  const topPass = useTopPass()
  const N = COMMON.length, all = rows.filter(r => r.n === N), shown = topPass(allOnly ? all : rows.filter(r => r.n >= 2))
  return <>
    <div className="toolbar">
      <Seg value={dir} onChange={setDir} options={[{ value: 'bull', label: 'Bullish', tone: 'up' }, { value: 'bear', label: 'Bearish', tone: 'down' }]} />
      <label className="check-label"><input type="checkbox" checked={allOnly} onChange={e => setAllOnly(e.target.checked)} />Only stocks in all {N} scans</label>
      <TopFilter />
    </div>
    <p className="muted small qualify-line"><b className={bull ? 'up' : 'down'}>{all.length}</b> stock{all.length === 1 ? '' : 's'} in all {N} {bull ? 'bullish' : 'bearish'} scans: Trending Stocks, {bull ? 'Bullish' : 'Bearish'} Intraday and the 15 Min, 30 Min and 1 Hour ORB {bull ? 'breakouts' : 'breakdowns'} (each with the filters set on its own tab).</p>
    <div className="tbl-wrap panel"><table className="tbl pickable">
      <thead><tr><th>Symbol</th><th>Sector</th><th className="num">LTP</th><th className="num">Chg %</th><th className="num">In</th><th className="num" title="When the stock entered the last of its scans (IST): the latest of the times below">Captured</th>{COMMON.map(([k, l]) => <th key={k} className="num">{l}</th>)}</tr></thead>
      <tbody>{shown.map(r => <tr key={r.symbol} onClick={() => onPick(r)} className={picked === r.symbol ? 'active' : undefined}>
        <td><StockLink symbol={r.symbol} company={r.company} className="strong" /><TopTag symbol={r.symbol} /></td>
        <td className="muted">{r.sector}</td>
        <td className="num">{fmtNum(r.ltp)}</td>
        <td className={'num ' + (r.pct_prev > 0 ? 'up' : r.pct_prev < 0 ? 'down' : '')}>{isNum(r.pct_prev) ? (r.pct_prev > 0 ? '+' : '') + r.pct_prev.toFixed(2) + '%' : '—'}</td>
        <td className={'num strong ' + (r.n === N ? (bull ? 'up' : 'down') : '')}>{r.n}/{N}</td>
        <td className="num strong">{r.at ? hhmmTo12(r.at) : '—'}</td>
        {COMMON.map(([k]) => <td key={k} className={'num ind ' + (r.in[k] ? 'pass' : 'fail')}>{r.in[k] ? '✓' + (typeof r.in[k] === 'string' ? ' ' + hhmmTo12(r.in[k]) : '') : '—'}</td>)}
      </tr>)}</tbody>
    </table>
    {!shown.length && <Empty>{allOnly ? `No stock is in all ${N} ${bull ? 'bullish' : 'bearish'} scans right now. Untick “Only stocks in all ${N} scans” to see the closest ones.` : 'No stock is in two or more of these scans right now.'}</Empty>}</div>
    <p className="muted small">✓ = the stock is in that scan right now (green), with the time it entered (ORB: break candle; Trending / Intraday: start of today’s qualifying run, blank when the replay has no start); — = not in it. Captured = the latest of those times. Lists follow each tab’s own filters and the sector selection, so changing a filter there changes this list. Condition screen, not a buy/sell recommendation.</p>
  </>
}

function StockLive({ stocks, selected, bias, nifty }) {
  const [sym, setSym] = useSessionState('slive.sym', 'NIFTY')  // Nifty 50 index first and by default
  const opts = useMemo(() => {
    const list = stocks.filter(r => !selected.length || r.sectors.some(x => selected.includes(x)))
      .map(r => ({ symbol: r.symbol, name: r.company })).sort((a, b) => a.symbol.localeCompare(b.symbol))
    if (sym !== 'NIFTY' && !list.some(c => c.symbol === sym)) { const r = stocks.find(r => r.symbol === sym); list.unshift({ symbol: sym, name: r?.company || '' }) }
    return [{ symbol: 'NIFTY', name: 'Nifty 50 index' }, ...list]
  }, [stocks, selected, sym])
  const st = sym === 'NIFTY' ? nifty && { ...nifty, sector: 'Index', fo: true } : stocks.find(r => r.symbol === sym)
  const chg = st && st.prev_close ? (st.ltp - st.prev_close) / st.prev_close * 100 : null
  return <ChartView prefix="slive" label="Stock" opts={opts} sym={sym} onPick={setSym}
    candlesUrl={(s, tf, before) => `/api/chart/candles?symbol=${encodeURIComponent(s)}&tf=${tf}` + (before ? `&before=${before}` : '')}
    indUrl={s => '/api/chart/indicators?symbol=' + encodeURIComponent(s)}
    fmt={inr} fmtShort={inrShort} pollMs={15000} indSource="Yahoo Finance candles; 3m built from 1m, 2h / 3h / 4h from 1h inside each session"
    sourceLine={() => `Yahoo Finance ${sym === 'NIFTY' ? '^NSEI (index, no volume)' : sym + '.NS'} · refreshes every 15 sec`}
    head={st && <span className="muted small">{st.sector} · LTP {inr(st.ltp)} <span className={chg > 0 ? 'up' : chg < 0 ? 'down' : ''}>{isNum(chg) ? (chg > 0 ? '+' : '') + chg.toFixed(2) + '%' : ''}</span> vs prev close</span>}
    bias={bias} biasName="Market Bias" chainUrl={st?.fo ? s => '/api/index-options?symbol=' + encodeURIComponent(s) : null}
    optMarket={{ key: 'slopt', cur: '', locale: 'en-IN', biasName: 'Market Bias', vol: 'ATM IV', unit: 'share', underlying: sym, ivBands: {} }}
    optNote={sym === 'NIFTY' ? 'Nifty 50 option chain (NSE) is used for the strikes below.' : st?.fo ? `${sym} is in the F&O segment, so its NSE option chain is used for the strikes below (lot sizes differ per stock).` : `${sym} is not in the F&O segment, so it has no listed options.`}
    note="The stock list follows the sector filter. Yahoo keeps 1-min candles for about 30 days and 5 – 60-min candles for 60 days, so dragging back stops there on those timeframes." />
}

// Which scans suit the current market bias (same 5-vote bias as the ORB Scanner).
// Compact Market Bias pill for pages other than Market Overview (which shows the full detail).

export function BiasBanner({ bias, onPick }) {
  const label = bias?.label
  const tone = label === 'BULLISH' ? 'bull' : label === 'BEARISH' ? 'bear' : 'neutral'
  const fit = label === 'BULLISH' ? [['trend', 'Trending Stocks (Bullish)'], ['bull', 'Bullish Intraday'], ['btst', 'BTST Stocks']]
    : label === 'BEARISH' ? [['trend', 'Trending Stocks (Bearish)'], ['bear', 'Bearish Intraday']] : null
  return <div className={'bias-banner ' + tone}>
    <span className={'bias-pill ' + tone}>Market Bias: {label || 'N/A'}{isNum(bias?.score) ? ` (${bias.score > 0 ? '+' : ''}${bias.score})` : ''}</span>
    <span className="bias-text">{fit ? <>Intraday Scanner tabs aligned with the market: {fit.map(([id, l], i) => <React.Fragment key={id}>{i ? ' · ' : ''}<button className="link-btn" onClick={() => onPick(id)} title="Open in Intraday Scanner">{l}</button></React.Fragment>)}</>
      : label ? 'Mixed market: no clear direction, so neither the bullish nor the bearish scans have the market behind them.' : 'Bias appears once live market data loads.'}</span>
    {bias?.components && <span className="bias-comps muted small">{bias.components.map(c => <span key={c.key} className={c.points > 0 ? 'up' : c.points < 0 ? 'down' : ''} title={c.detail + ' · ' + c.basis}>{c.label} {c.points > 0 ? '+1' : c.points < 0 ? '−1' : '0'}</span>)}</span>}
  </div>
}

export default function Scans({ basic = false, trend: trendRaw, live, selected, setSelected, chartReq = 0, orbLists = {} }) {
  const [more, setMore] = usePersistentState('scans.more', false)  // show BTST, Index Options, Volume Spike, EMA 9/21 + RSI, Candlestick
  const TABS = basic ? BASIC_TABS : more ? ALL_TABS : BASE_TABS
  const [tabRaw, setTab] = useSessionState('scans.tab', 'setup')  // Trade Setup is the first tab
  const tab = TABS.some(([v]) => v === tabRaw) ? tabRaw : basic ? (sideFromBias(live?.bias) === 'bear' ? 'bear' : 'bull') : 'setup'  // a hidden tab opens the default one
  useEffect(() => { if (chartReq) setTab('chart') }, [chartReq])  // chart icon clicked on a stock
  const base = useTrendSettings()
  // Bullish/Bearish follows the Market Bias until the user picks one by hand
  // (kept for the visit; "Clear filters" hands control back to the bias).
  const [dirManual, setDirManual] = useSessionState('trend.dirManual', false)
  const settings = useMemo(() => ({ ...base, setDir: v => { setDirManual(true); base.setDir(v) } }), [base])
  const biasLabel = live?.bias?.label
  useEffect(() => {
    if (dirManual) return
    if (biasLabel === 'BEARISH' && base.dir !== 'bear') base.setDir('bear')
    if (biasLabel === 'BULLISH' && base.dir !== 'bull') base.setDir('bull')
  }, [biasLabel, dirManual])
  const [resetKey, setResetKey] = useState(0)
  const [pick, setPick] = useState(null)  // stock whose details drawer is open (row click, as on the ORB Scanner)
  const pp = { onPick: r => setPick(r), picked: pick?.symbol }
  // Clear filters: sectors, Trending settings, search, sort and the "all conditions only" boxes.
  const clearAll = () => {
    setSelected([])
    setDirManual(false); base.setDir(biasLabel === 'BEARISH' ? 'bear' : 'bull'); settings.setTfs('both'); settings.setRsiMin(60); settings.setAdxMin(25); settings.setUniverse('fo')
    for (const k of ['trend.allOnly', 'scan.allOnly.bull', 'scan.allOnly.bear', 'scan.allOnly.btst']) setSessionValue(k, true)
    setResetKey(k => k + 1)  // remount the tables so search / sort / checkboxes start fresh
  }
  // Sector selection is shared with the Sector Heatmap and the ORB Scanner.
  const trend = useMemo(() => !trendRaw.data || !selected.length ? trendRaw
    : { ...trendRaw, data: { ...trendRaw.data, rows: trendRaw.data.rows.filter(r => r.sectors.some(s => selected.includes(s))) } }, [trendRaw, selected])
  const data = trend.data
  const { dir, tfs, rsiMin, adxMin, universe } = settings
  // Tab counts = what each list shows by default, after the sector and Top 20 filters (same as the tables)
  const topPass = useTopPass()
  const counts = useMemo(() => {
    const need = trendNeed(tfs)
    const c = { trend: data ? topPass(trendRows(data.rows, settings).filter(r => (universe === 'all' || r.fo) && r.score === need)).length : null }
    for (const id of ['bull', 'bear', 'btst']) c[id] = data ? topPass(scanRows(data.rows, id).filter(r => r.met === SCANS[id].conds.length)).length : null
    return c
  }, [data, dir, tfs, rsiMin, adxMin, universe, topPass])
  const [volList, setVolList] = useSessionState('vol.list', 'fo')
  const vol = usePoll(() => api('/api/volscan'), tab === 'vol' ? 60000 : 300000, [tab === 'vol'])
  const cp = usePoll(() => api('/api/candle-patterns'), tab === 'candle' ? 60000 : 300000, [tab === 'candle'])
  const cpRows = useMemo(() => (cp.data?.rows || []).filter(r => !selected.length || r.sectors.some(x => selected.includes(x))), [cp.data, selected])
  const [emaTf] = useSessionState('ema.tf', 'tf15')
  const emaN = data ? topPass(emaRows(data.rows, emaTf).filter(r => r.side)).length : null
  const tabCounts = { ...counts, ema: emaN, vol: vol.data ? topPass(volHits(vol.data, volList)).length : null, candle: cp.data ? topPass(cpRows).length : null }
  const cyc = data?.cycle
  return <div className="trend-page">
    <div className="page-title"><h1>Intraday Scanner</h1>
      <span className="muted small">Indicator and condition scans · candles from Yahoo Finance (15-min, 1-hour, daily), today’s daily candle from NSE
        {cyc?.finished ? ` · last full pass ${istTime(cyc.finished)}` : ''}{cyc?.state === 'running' ? ` · refreshing ${cyc.done}/${cyc.total}` : ''}</span></div>
    <div className="toolbar"><SectorMulti sectors={live?.sectors || []} selected={selected} setSelected={setSelected} />
      {selected.length > 0 && <button className="btn sm clear-sectors" onClick={() => setSelected([])} title="Clear the sector filter (also clears the heatmap and ORB selection)">✕ Clear sectors ({selected.length})</button>}
      <button className="btn sm" onClick={clearAll} title="Reset every Intraday Scanner filter to its default (Bullish · 15 Min + 1 Hour · RSI 60 · ADX 25 · F&O · all sectors)">Clear filters</button></div>
    <div className="orb-switch learn-cats scan-tabs" role="tablist" aria-label="Scan">
      {TABS.map(([v, label]) => <button key={v} role="tab" aria-selected={tab === v} className={tab === v ? 'on' : ''} onClick={() => setTab(v)}>
        {label}{tabCounts[v] != null && <span className="count">{tabCounts[v]}</span>}</button>)}
      {!basic && <button className={'scan-more' + (more ? ' on' : '')} onClick={() => setMore(m => !m)} aria-pressed={more}
        title={more ? 'Hide BTST, Index Options, Volume Spike, EMA 9/21 + RSI and Candlestick' : 'Show BTST, Index Options, Volume Spike, EMA 9/21 + RSI and Candlestick'}>
        {more ? '− Fewer scanners' : `+ More scanners (${HIDDEN_TABS.length})`}</button>}
    </div>
    {tab === 'iopt' ? <OptionsBoard market={INDIA} bias={live?.bias} />
      : tab === 'fno' ? <FnoStocks key={'f' + resetKey} stocks={live?.stocks || []} selected={selected} bias={live?.bias} trendRows={data?.rows} />
      : tab === 't15' ? (!data ? <Empty>{trend.error || 'Loading scan data…'}</Empty> : <Trend15 key={'t15' + resetKey} data={data} live={live} {...pp} />)
      : tab === 'mom' ? (!data ? <Empty>{trend.error || 'Loading scan data…'}</Empty> : <HighMomentum key={'mo' + resetKey} data={data} live={live} {...pp} />)
      : tab === 'osell' ? (!data ? <Empty>{trend.error || 'Loading scan data…'}</Empty> : <OptionSelling key={'os' + resetKey} data={data} live={live} />)
      : tab === 'setup' ? (!data ? <Empty>{trend.error || 'Loading scan data…'}</Empty> : <TradeSetup key={'ts' + resetKey} data={data} live={live} {...pp} />)
      : tab === 'vol' ? <VolumeSpike key={'v' + resetKey} vol={vol} stocks={live?.stocks} list={volList} setList={setVolList} {...pp} />
      : tab === 'ema' ? (!data ? <Empty>{trend.error || 'Loading scan data…'}</Empty> : <EmaRsi key={'e' + resetKey} data={data} {...pp} />)
      : tab === 'candle' ? <CandleScan key={'cs' + resetKey} res={cp} rows={cpRows} {...pp} />
      : tab === 'chart' ? <StockLive key={'sl' + chartReq} stocks={live?.stocks || []} selected={selected} bias={live?.bias?.label} nifty={live?.indices?.nifty50} />
      : !data ? <Empty>{trend.error || 'Loading scan data…'}</Empty>
      : !data.rows.length ? <Empty>Calculating for the first time — this takes about 2–3 minutes…</Empty>
        : tab === 'trend' ? <Trend key={'t' + resetKey} trend={trend} settings={settings} {...pp} />
        : tab === 'common' ? <CommonStocks key={'c' + resetKey} data={data} settings={settings} orbLists={orbLists} bias={live?.bias?.label} {...pp} />
        : <ConditionScan key={tab + resetKey} id={tab} data={data} {...pp} />}
    {pick && <StockDrawer stock={live?.stocks?.find(s => s.symbol === pick.symbol) || pick} onClose={() => setPick(null)} />}
  </div>
}

// Candlestick tab: daily candle patterns on the F&O stocks (today's candle from the live NSE feed).
const CANDLE_SIDES = [{ value: 'all', label: 'All' }, { value: 'bull', label: 'Bullish', tone: 'up' }, { value: 'bear', label: 'Bearish', tone: 'down' }, { value: 'neutral', label: 'Indecision' }]
const PATTERN_HELP = [
  ['Marubozu', 'a full body with almost no shadows: one side was in control all day'],
  ['Doji', 'open ≈ close: indecision (dragonfly = long lower shadow, gravestone = long upper shadow)'],
  ['Hammer / Hanging Man', 'small body at the top, long lower shadow: after a fall = hammer, after a rise = hanging man'],
  ['Shooting Star / Inverted Hammer', 'small body at the bottom, long upper shadow: after a rise = shooting star, after a fall = inverted hammer'],
  ['Engulfing', "today's body covers all of yesterday's opposite-colour body"],
  ['Harami', "a small candle inside yesterday's big body: the move is slowing"],
  ['Morning / Evening Star', 'big candle, small candle, then a strong candle the other way: a three-day turn'],
]
function CandleScan({ res, rows, onPick, picked }) {
  const [side, setSide] = useSessionState('candle.side', 'all')
  const [pat, setPat] = useSessionState('candle.pat', '')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ key: 'symbol', dir: 'asc' })
  const d = res.data
  const topPass = useTopPass()
  const q = search.trim().toUpperCase()
  const names = useMemo(() => [...new Set(rows.flatMap(r => r.patterns.map(p => p.name)))].sort(), [rows])
  const base = rows.filter(r => (!q || r.symbol.includes(q) || (r.company || '').toUpperCase().includes(q))
    && r.patterns.some(p => (side === 'all' || p.side === side) && (!pat || p.name === pat)))
  const shown = topPass(sortRows(base, sort.key, sort.dir))
  const n = k => topPass(rows.filter(r => r.patterns.some(p => k === 'all' || p.side === k))).length
  const sp = { sort, setSort }
  return <>
    <div className="toolbar">
      <Seg value={side} onChange={setSide} options={CANDLE_SIDES.map(o => ({ ...o, label: <>{o.label} <span className="count">{d ? n(o.value) : ''}</span></> }))} />
      <TopFilter />
      <select className="search" value={pat} onChange={e => setPat(e.target.value)} aria-label="Pattern">
        <option value="">Every pattern</option>{names.map(x => <option key={x} value={x}>{x}</option>)}</select>
      <input className="search" placeholder="Search symbol" value={search} onChange={e => setSearch(e.target.value)} />
    </div>
    <p className="muted small qualify-line"><b>{shown.length}</b> of {d?.universe ?? '…'} F&amp;O stocks show a candlestick pattern on the {d?.session_date ? new Date(d.session_date + 'T12:00:00+05:30').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : 'latest'} daily candle{d?.loading ? ` (loading history for ${d.loading} more)` : ''}. Trend = close vs 5 sessions earlier.</p>
    {!d ? <Empty>{res.error || 'Loading candlestick patterns…'}</Empty> : <div className="tbl-wrap panel trend-wrap">
      <table className="tbl trend-tbl pickable">
        <thead><tr>
          <SortTh label="Symbol" k="symbol" {...sp} defaultDir="asc" />
          <SortTh label="Sector" k="sector" {...sp} defaultDir="asc" />
          <SortTh label="LTP" k="ltp" {...sp} num />
          <SortTh label="Chg %" k="pct" {...sp} num />
          <th>Pattern · read</th>
          <SortTh label="Trend" k="trend" {...sp} defaultDir="asc" title="Close vs the close 5 sessions earlier: up / down (±2%) or flat" />
          <SortTh label="Confirms at" k="confirm" {...sp} num title="Bullish: a close above the pattern's high. Bearish: a close below its low. Patterns often fail the next day, so many traders wait for this." />
          <SortTh label="Fails at" k="fail" {...sp} num title="Bullish: a close below the pattern's low. Bearish: a close above its high. Beyond this level the pattern no longer holds." />
          <SortTh label="To fail" k="risk_pct" {...sp} num title="How far the fail level is from the close, in %: the move against you before the pattern is proven wrong" />
        </tr></thead>
        <tbody>{shown.map(r => <tr key={r.symbol} onClick={() => onPick(r)} className={picked === r.symbol ? 'active' : undefined}>
          <td><StockLink symbol={r.symbol} company={r.company} className="strong" /><TopTag symbol={r.symbol} /></td>
          <td className="muted">{r.sector}</td>
          <td className="num">{fmtNum(r.ltp)}</td>
          <td className={'num ' + (r.pct > 0 ? 'up' : r.pct < 0 ? 'down' : '')}>{isNum(r.pct) ? (r.pct > 0 ? '+' : '') + r.pct.toFixed(2) + '%' : '—'}</td>
          <td className="cp-cell">{r.patterns.map(p => <span key={p.name} className={'cp-pill ' + p.side} title={p.note}>{p.name}</span>)}
            <div className="cp-read" title={`Pattern candle(s): high ${fmtNum(r.pat_hi)}, low ${fmtNum(r.pat_lo)} · today O ${fmtNum(r.o)} H ${fmtNum(r.h)} L ${fmtNum(r.l)} C ${fmtNum(r.c)} · ${r.stretch > 0 ? '+' : ''}${r.stretch}% vs 20-day average`}>{r.read}</div></td>
          <td className={'muted ' + (r.trend === 'up' ? 'up' : r.trend === 'down' ? 'down' : '')}>{r.trend === 'up' ? '↑ up' : r.trend === 'down' ? '↓ down' : '→ flat'}</td>
          <td className={'num ' + (r.bias === 'bull' ? 'up' : r.bias === 'bear' ? 'down' : 'muted')}>{isNum(r.confirm) ? fmtNum(r.confirm) : '—'}</td>
          <td className="num muted">{isNum(r.fail) ? fmtNum(r.fail) : '—'}</td>
          <td className={'num ' + (r.risk_pct >= 5 ? 'amber' : 'muted')}>{isNum(r.risk_pct) ? r.risk_pct.toFixed(1) + '%' : '—'}</td>
        </tr>)}</tbody>
      </table>
      {!shown.length && <Empty>{d.loading ? `Loading daily history… ${d.universe - d.loading} of ${d.universe} stocks` : 'No stock matches these filters.'}</Empty>}
    </div>}
    <details className="panel cp-help"><summary><b>What the patterns mean</b></summary><ul>
      {PATTERN_HELP.map(([k, v]) => <li key={k}><b>{k}</b>: {v}.</li>)}</ul>
      <p><b>Reading the levels:</b> <b>Confirms at</b> is where the pattern would be proven (a close above the pattern's high for a bullish one, below its low for a bearish one). <b>Fails at</b> is where it stops being valid. <b>To fail</b> is that distance in %: a wide one means a bigger move against the idea before it is proven wrong. <b>Stretched</b> means the price is already far from its 20-day average, where moves often pause.</p>
      <p className="muted small">Hover a pattern for a one-line explanation. A pattern is a chart shape, not a buy / sell signal: check volume, the trend and the levels before acting, and wait for the next candle to confirm.</p></details>
    <p className="muted small">Daily history: Yahoo Finance (last 3 months, refreshed twice a day). Today's candle: NSE live open / high / low / last price, so during the session a pattern can still change until the close.</p>
  </>
}

// EMA 9/21 + RSI tab: trend direction from the 9 / 21 EMA, strength from RSI(14).
// Bullish = 9 EMA above 21 EMA and RSI above 60; bearish = 9 EMA below 21 EMA and RSI below 40.
const EMA_TFS = [{ value: 'tf15', label: '15 Min' }, { value: 'tf60', label: '1 Hour' }, { value: 'daily', label: 'Daily' }]
export function emaRows(rows, tf) {
  return (rows || []).filter(r => r.fo).map(r => {
    const x = r[tf] || {}
    const { ema9: e9, ema21: e21, ema9_p: p9, ema21_p: p21, rsi } = x
    const up = gt(e9, e21), dn = lt(e9, e21)
    const side = up && gt(rsi, 60) ? 'bull' : dn && lt(rsi, 40) ? 'bear' : null
    const cross = isNum(p9) && isNum(p21) ? (up && p9 <= p21 ? 'up' : dn && p9 >= p21 ? 'down' : null) : null
    const gap = isNum(e9) && isNum(e21) && e21 ? (e9 - e21) / e21 * 100 : null
    return { ...r, e9, e21, rsi, side, cross, gap, close: x.close ?? r.ltp }
  })
}
function EmaRsi({ data, onPick, picked }) {
  const [tf, setTf] = useSessionState('ema.tf', 'tf15')
  const [side, setSide] = useSessionState('ema.side', 'bull')
  const [fresh, setFresh] = useSessionState('ema.fresh', false)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ key: 'rsi', dir: 'desc' })
  const topPass = useTopPass()
  const q = search.trim().toUpperCase()
  const all = useMemo(() => emaRows(data.rows, tf), [data, tf])
  const pick = all.filter(r => r.side === side && (!fresh || r.cross) && (!q || r.symbol.includes(q) || (r.company || '').toUpperCase().includes(q)))
  const shown = topPass(sortRows(pick, sort.key, side === 'bear' && sort.key === 'rsi' ? (sort.dir === 'desc' ? 'asc' : 'desc') : sort.dir))
  const n = k => topPass(all.filter(r => r.side === k && (!fresh || r.cross))).length
  const sp = { sort, setSort }
  const tfName = EMA_TFS.find(t => t.value === tf)?.label
  return <>
    <div className="toolbar">
      <Seg value={side} onChange={setSide} options={[{ value: 'bull', label: <>Bullish <span className="count">{n('bull')}</span></>, tone: 'up' },
        { value: 'bear', label: <>Bearish <span className="count">{n('bear')}</span></>, tone: 'down' }]} />
      <Seg value={tf} onChange={setTf} options={EMA_TFS} />
      <TopFilter />
      <label className="check-label" title="Only stocks whose 9 EMA crossed the 21 EMA on the latest candle"><input type="checkbox" checked={fresh} onChange={e => setFresh(e.target.checked)} />Fresh crossover only</label>
      <input className="search" placeholder="Search symbol" value={search} onChange={e => setSearch(e.target.value)} />
    </div>
    <p className="muted small qualify-line"><b className={side === 'bear' ? 'down' : 'up'}>{shown.length}</b> F&amp;O stocks on the <b>{tfName}</b> chart with {side === 'bull'
      ? <><b>9 EMA above the 21 EMA</b> and <b>RSI(14) above 60</b> (uptrend with strength)</>
      : <><b>9 EMA below the 21 EMA</b> and <b>RSI(14) below 40</b> (downtrend with weakness)</>}{fresh ? ', crossed on the latest candle' : ''}. The latest candle is still forming during market hours.</p>
    <div className="tbl-wrap panel trend-wrap">
      <table className="tbl trend-tbl pickable">
        <thead><tr>
          <SortTh label="Symbol" k="symbol" {...sp} defaultDir="asc" />
          <SortTh label="Sector" k="sector" {...sp} defaultDir="asc" />
          <SortTh label="LTP" k="ltp" {...sp} num />
          <SortTh label="Chg %" k="pct_prev" {...sp} num />
          <SortTh label="EMA 9" k="e9" {...sp} num />
          <SortTh label="EMA 21" k="e21" {...sp} num />
          <SortTh label="Gap %" k="gap" {...sp} num title="(EMA 9 − EMA 21) ÷ EMA 21: how far apart the two averages are" />
          <SortTh label="RSI 14" k="rsi" {...sp} num />
          <th title="Did the 9 EMA cross the 21 EMA on the latest candle?">Crossover</th>
        </tr></thead>
        <tbody>{shown.map(r => <tr key={r.symbol} onClick={() => onPick(r)} className={picked === r.symbol ? 'active' : undefined}>
          <td><StockLink symbol={r.symbol} company={r.company} className="strong" /><TopTag symbol={r.symbol} /></td>
          <td className="muted">{r.sector}</td>
          <td className="num">{fmtNum(r.ltp)}</td>
          <td className={'num ' + (r.pct_prev > 0 ? 'up' : r.pct_prev < 0 ? 'down' : '')}>{isNum(r.pct_prev) ? (r.pct_prev > 0 ? '+' : '') + r.pct_prev.toFixed(2) + '%' : '—'}</td>
          <td className="num">{n2(r.e9)}</td>
          <td className="num muted">{n2(r.e21)}</td>
          <td className={'num ' + (r.gap > 0 ? 'up' : r.gap < 0 ? 'down' : '')}>{isNum(r.gap) ? (r.gap > 0 ? '+' : '') + r.gap.toFixed(2) + '%' : '—'}</td>
          <td className={'num strong ' + (side === 'bull' ? 'up' : 'down')}>{fmtNum(r.rsi, 1)}</td>
          <td>{r.cross ? <span className={'cp-pill ' + (r.cross === 'up' ? 'bull' : 'bear')}>{r.cross === 'up' ? 'Crossed up now' : 'Crossed down now'}</span> : <span className="muted small">earlier</span>}</td>
        </tr>)}</tbody>
      </table>
      {!shown.length && <Empty>No F&amp;O stock meets these conditions on the {tfName} chart right now.</Empty>}
    </div>
    <p className="muted small">EMA 9 / 21 and RSI(14, Wilder) on Yahoo Finance candles (15-minute and 1-hour on NSE's 09:15 clock, daily with today's NSE candle). Condition screen: it shows where the averages and momentum line up, not when to buy or sell. A fresh crossover is the earliest and least proven; RSI far above 70 or below 30 means the move is already stretched.</p>
  </>
}

// F&O Stocks tab: every stock with futures & options on NSE (lot size, contract value), and the option
// chain analysis for the one you pick (PCR, max pain, OI walls, IV, expected move, OI change by strike).
function stockMarket(sym, lot) {
  return { ...INDIA, key: 'sopt.' + sym, symbols: [[sym, sym]], spotNote: 'NSE stock', ivBands: {},
    oiNote: 'Open interest in contracts for strikes within ±20% of the stock price.', expiryNote: 'NSE stock options are monthly contracts; each expires at 3:30 PM IST on the date shown.',
    lot: lot || null, pnl: lot ? { [sym]: lot } : null }
}
export const fnoSide = (s, t) => {
  if (!t || !isNum(s.pct_prev)) return null
  if (s.pct_prev > 0 && gt(t.close, t.vwap) && gt(t.ema9, t.ema21)) return 'bull'
  if (s.pct_prev < 0 && lt(t.close, t.vwap) && lt(t.ema9, t.ema21)) return 'bear'
  return null
}
// Market Bias -> side: Bullish / Bearish, and a Neutral reading that still leans (score +2 / -2) counts too.
const sideFromBias = b => b?.label === 'BULLISH' || (isNum(b?.score) && b.score >= 2) ? 'bull'
  : b?.label === 'BEARISH' || (isNum(b?.score) && b.score <= -2) ? 'bear' : 'all'
const biasNote = b => !b?.label ? '…' : b.label === 'NEUTRAL' && isNum(b.score) && Math.abs(b.score) >= 2
  ? `neutral, leaning ${b.score > 0 ? 'bullish' : 'bearish'} ${b.score > 0 ? '+' : ''}${b.score}` : b.label.toLowerCase()
function FnoStocks({ stocks, selected, bias, trendRows }) {
  const lots = usePoll(() => api('/api/fo-lots'), 3600000, [])
  const [manual, setManual] = useSessionState('fno.sideManual', null)  // follows Market Bias until the user picks a side
  const side = manual || sideFromBias(bias)
  const T = useMemo(() => Object.fromEntries((trendRows || []).map(r => [r.symbol, r.tf15])), [trendRows])
  const [sym, setSym] = useSessionState('fno.sym', '')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ key: 'turn', dir: 'desc' })
  const topPass = useTopPass()
  const L = lots.data?.lots || {}
  const q = search.trim().toUpperCase()
  const rows = useMemo(() => stocks.filter(s => s.fo).map(s => ({ ...s, lot: L[s.symbol] ?? null, value: L[s.symbol] && s.ltp ? L[s.symbol] * s.ltp : null, turn: (s.ltp || 0) * (s.volume || 0), side: fnoSide(s, T[s.symbol]) })), [stocks, L, T])
  const nSide = k => topPass(rows.filter(r => k === 'all' || r.side === k)).length
  const base = rows.filter(r => (side === 'all' || r.side === side) && (!selected.length || (r.sectors || []).some(x => selected.includes(x))) && (!q || r.symbol.includes(q) || (r.company || '').toUpperCase().includes(q)))
  const shown = topPass(sortRows(base, sort.key, sort.dir))
  const sp = { sort, setSort }
  const pick = rows.find(r => r.symbol === sym)
  return <>
    {pick && <div className="panel fno-chain">
      <div className="fno-chain-head"><b>{pick.symbol}</b> <span className="muted">{pick.company}</span>
        <span className="muted small"> · lot {pick.lot ?? '—'} · LTP {fmtNum(pick.ltp)} <span className={pick.pct_prev >= 0 ? 'up' : 'down'}>{isNum(pick.pct_prev) ? (pick.pct_prev > 0 ? '+' : '') + pick.pct_prev.toFixed(2) + '%' : ''}</span></span>
        <button className="btn ghost sm" onClick={() => setSym('')}>✕ Close option chain</button></div>
      <OptionsBoard key={pick.symbol} market={stockMarket(pick.symbol, pick.lot)} bias={bias} />
    </div>}
    <div className="toolbar">
      <Seg value={side} onChange={setManual} options={[{ value: 'all', label: <>All <span className="count">{nSide('all')}</span></> },
        { value: 'bull', label: <>Bullish <span className="count">{nSide('bull')}</span></>, tone: 'up' }, { value: 'bear', label: <>Bearish <span className="count">{nSide('bear')}</span></>, tone: 'down' }]} />
      {!manual && bias?.label && <span className="muted small" title="Opens on the side that matches Market Bias (a Neutral bias of +2 or more leans bullish, −2 or less bearish); pick another to override">follows Market Bias ({biasNote(bias)})</span>}
      <TopFilter />
      <input className="search" placeholder="Search F&O stock" value={search} onChange={e => setSearch(e.target.value)} />
      <span className="muted small">Tap a stock to open its option chain analysis.</span>
    </div>
    <p className="muted small qualify-line"><b>{shown.length}</b> of {rows.length} stocks with futures &amp; options on NSE{side === 'bull' ? ' that are bullish now (up on the day, above VWAP, 9 EMA above 21 EMA on 15-min candles)' : side === 'bear' ? ' that are bearish now (down on the day, below VWAP, 9 EMA below 21 EMA on 15-min candles)' : ''}{lots.data ? '' : ' (loading lot sizes…)'}. Contract value = lot size × price: roughly what one futures lot controls.</p>
    <div className="tbl-wrap panel trend-wrap">
      <table className="tbl trend-tbl pickable">
        <thead><tr>
          <SortTh label="Symbol" k="symbol" {...sp} defaultDir="asc" />
          <SortTh label="Sector" k="sector" {...sp} defaultDir="asc" />
          <SortTh label="LTP" k="ltp" {...sp} num />
          <SortTh label="Chg %" k="pct_prev" {...sp} num />
          <SortTh label="Lot size" k="lot" {...sp} num title="Shares per F&O contract this month (NSE)" />
          <SortTh label="Contract value" k="value" {...sp} num title="Lot size × LTP, in ₹" />
          <SortTh label="Volume" k="volume" {...sp} num />
          <SortTh label="Vol vs 5D" k="vol_ratio" {...sp} num title="Today's volume ÷ the 5-day average" />
        </tr></thead>
        <tbody>{shown.map(r => <tr key={r.symbol} onClick={() => { setSym(r.symbol); window.scrollTo({ top: 0, behavior: 'smooth' }) }} className={sym === r.symbol ? 'active' : undefined}>
          <td><StockLink symbol={r.symbol} company={r.company} className="strong" /><TopTag symbol={r.symbol} /></td>
          <td className="muted">{r.sector}</td>
          <td className="num">{fmtNum(r.ltp)}</td>
          <td className={'num ' + (r.pct_prev > 0 ? 'up' : r.pct_prev < 0 ? 'down' : '')}>{isNum(r.pct_prev) ? (r.pct_prev > 0 ? '+' : '') + r.pct_prev.toFixed(2) + '%' : '—'}</td>
          <td className="num">{r.lot ?? '—'}</td>
          <td className="num">{isNum(r.value) ? '₹' + Math.round(r.value).toLocaleString('en-IN') : '—'}</td>
          <td className="num muted">{fmtVol(r.volume)}</td>
          <td className={'num ' + (r.vol_ratio >= 1.5 ? 'up strong' : 'muted')}>{isNum(r.vol_ratio) ? r.vol_ratio.toFixed(2) + '×' : '—'}</td>
        </tr>)}</tbody>
      </table>
      {!shown.length && <Empty>No F&amp;O stock matches.</Empty>}
    </div>
  </>
}


// Trade Setup: an intraday checklist on 15-minute candles for the F&O stocks, with mechanical levels.
// Each stock is scored on 8 checks; for the ones that pass enough, the levels come from fixed rules:
// entry = a break of the last completed 15-min candle, stop = the 15-min Supertrend (or 1.5 × ATR),
// targets = 1R and 2R, trail = the Supertrend after T1. Rules, not advice: the trader decides.
const SETUP_CHECKS = {
  bull: [
    ['Market', 'Market Bias is Bullish', (r, m) => m.bias === 'BULLISH'],
    ['Strength', 'Stock up more than Nifty today (relative strength)', (r, m) => gt(r.pct_prev, m.nifty)],
    ['VWAP', 'Price above VWAP (buyers in control today)', r => gt(r.t.close, r.t.vwap)],
    ['EMA', '9 EMA above 21 EMA (short-term uptrend)', r => gt(r.t.ema9, r.t.ema21)],
    ['Supertrend', 'Supertrend (10, 3) is up', r => r.t.st_dir === 1],
    ['RSI', 'RSI(14) between 55 and 75: strong, not yet overbought', r => isNum(r.t.rsi) && r.t.rsi >= 55 && r.t.rsi <= 75],
    ['ADX', 'ADX(14) at least 20 with DI+ above DI−: a real trend', r => isNum(r.t.adx) && r.t.adx >= 20 && gt(r.t.dip, r.t.dim)],
    ['Volume', 'Volume at least 1.2× the 5-day average', r => isNum(r.vol_ratio) && r.vol_ratio >= 1.2],
  ],
  bear: [
    ['Market', 'Market Bias is Bearish', (r, m) => m.bias === 'BEARISH'],
    ['Weakness', 'Stock down more than Nifty today (relative weakness)', (r, m) => lt(r.pct_prev, m.nifty)],
    ['VWAP', 'Price below VWAP (sellers in control today)', r => lt(r.t.close, r.t.vwap)],
    ['EMA', '9 EMA below 21 EMA (short-term downtrend)', r => lt(r.t.ema9, r.t.ema21)],
    ['Supertrend', 'Supertrend (10, 3) is down', r => r.t.st_dir === -1],
    ['RSI', 'RSI(14) between 25 and 45: weak, not yet oversold', r => isNum(r.t.rsi) && r.t.rsi >= 25 && r.t.rsi <= 45],
    ['ADX', 'ADX(14) at least 20 with DI− above DI+: a real trend', r => isNum(r.t.adx) && r.t.adx >= 20 && gt(r.t.dim, r.t.dip)],
    ['Volume', 'Volume at least 1.2× the 5-day average', r => isNum(r.vol_ratio) && r.vol_ratio >= 1.2],
  ],
}
// Why each check matters, in plain words (shown under the Trade Setup table, same order as the dots).
const SETUP_WHY = {
  bull: [
    'Most stocks follow the market. Long trades work better on days when the whole market is rising.',
    'If the stock is rising more than Nifty, buyers prefer it today. Leaders keep leading more often than laggards catch up.',
    'VWAP is the average price everyone paid today. Above it, today’s buyers are in profit and tend to defend the price.',
    'The 9 EMA (fast average) above the 21 EMA (slow average) means recent prices are rising faster: a short-term uptrend.',
    'Supertrend is a trend line that flips when the trend changes. Up = the trend is still up, and the line doubles as a stop level.',
    'RSI measures momentum from 0 to 100. Above 55 = buyers are strong; above 75 the move is often stretched and may pause.',
    'ADX measures how strong a trend is, not its direction. 20+ = a real trend, not sideways noise; DI+ above DI− says the trend is up.',
    'Higher volume than usual means big players are active. Moves on high volume are more likely to continue.',
  ],
  bear: [
    'Most stocks follow the market. Short trades work better on days when the whole market is falling.',
    'If the stock is falling more than Nifty, sellers prefer it today. Laggards keep lagging more often than they recover.',
    'VWAP is the average price everyone paid today. Below it, today’s buyers are at a loss and often sell into rises.',
    'The 9 EMA (fast average) below the 21 EMA (slow average) means recent prices are falling faster: a short-term downtrend.',
    'Supertrend is a trend line that flips when the trend changes. Down = the trend is still down, and the line doubles as a stop level.',
    'RSI measures momentum from 0 to 100. Below 45 = sellers are strong; below 25 the fall is often stretched and may bounce.',
    'ADX measures how strong a trend is, not its direction. 20+ = a real trend, not sideways noise; DI− above DI+ says the trend is down.',
    'Higher volume than usual means big players are active. Moves on high volume are more likely to continue.',
  ],
}

// When did the stock's current run in the list begin? Replays today's 15-minute candles (r.steps:
// [time, [close, vwap, ema5, ema9, st_dir, rsi, adx, dip, dim, ema21], ...]) for the five candle checks;
// Market Bias, strength vs Nifty and volume use their current values (they are not kept per candle).
function setupSince(r, side, res, minScore) {
  const fixed = [0, 1, 7].filter(i => res[i]).length
  const long = side === 'bull'
  let since = null
  for (const [t, a] of r.steps || []) {
    if (!a) { since = null; continue }
    const [close, vwap, , e9, st, rsi, adx, dip, dim, e21] = a
    const ok = [long ? gt(close, vwap) : lt(close, vwap), long ? gt(e9, e21) : lt(e9, e21), st === (long ? 1 : -1),
      isNum(rsi) && (long ? rsi >= 55 && rsi <= 75 : rsi >= 25 && rsi <= 45), isNum(adx) && adx >= 20 && (long ? gt(dip, dim) : gt(dim, dip))]
    if (fixed + ok.filter(Boolean).length >= minScore) since = since || t
    else since = null
  }
  return since
}

function setupLevels(r, side, risk) {
  const t = r.t, ltp = r.ltp ?? t.close, atr = t.atr
  if (!isNum(ltp) || !isNum(atr) || atr <= 0) return null
  const long = side === 'bull'
  const trig = long ? t.prev_hi : t.prev_lo
  const already = isNum(trig) && (long ? ltp > trig : ltp < trig)
  const entry = isNum(trig) && !already ? trig : ltp
  const stOk = isNum(t.st) && (long ? t.st < entry : t.st > entry) && Math.abs(entry - t.st) >= 0.25 * atr && Math.abs(entry - t.st) <= 3 * atr
  const stop = stOk ? t.st : long ? entry - 1.5 * atr : entry + 1.5 * atr
  const R = Math.abs(entry - stop)
  if (!R) return null
  const qty = isNum(risk) && risk > 0 ? Math.floor(risk / R) : null
  return { entry, trig, already, stop, stopBy: stOk ? 'Supertrend' : '1.5 × ATR', R, t1: long ? entry + R : entry - R, t2: long ? entry + 2 * R : entry - 2 * R,
    riskPct: R / entry * 100, qty, capital: qty ? qty * entry : null, trail: t.st }
}
const isFresh = hhmm => {  // joined within the last 30 minutes (IST)
  const n = new Date(Date.now() + 330 * 60000), now = n.getUTCHours() * 60 + n.getUTCMinutes()
  const [h, mm] = hhmm.split(':').map(Number)
  return now - (h * 60 + mm) <= 30 && now - (h * 60 + mm) >= 0
}
// The indicator rows carry no volume ratio, and their price can lag: take price, change and volume
// ratio from the live NSE feed for each stock.
const withLive = (rows, live) => {
  const L = Object.fromEntries((live?.stocks || []).map(s => [s.symbol, s]))
  return (rows || []).map(r => { const s = L[r.symbol]; return s ? { ...r, ltp: s.ltp ?? r.ltp, pct_prev: s.pct_prev ?? r.pct_prev, vol_ratio: s.vol_ratio } : r })
}
function TradeSetup({ data, live, onPick, picked }) {
  const [manual, setManual] = useSessionState('setup.sideManual', null)
  const side = manual || (sideFromBias(live?.bias) === 'bear' ? 'bear' : 'bull')
  const [minScore, setMinScore] = usePersistentState('setup.min', 6)
  const [risk, setRisk] = usePersistentState('setup.risk', 1000)
  const [sort, setSort] = useState({ key: 'score', dir: 'desc' })
  const [orbOnly, setOrbOnly] = useSessionState('setup.orbOnly', false)
  const orb = usePoll(() => api('/api/orb?tf=15&confirm=1&orm=15'), 60000, [])  // 15-min opening range (9:15–9:30) breakouts
  const O = useMemo(() => Object.fromEntries((orb.data?.rows || []).map(r => [r.symbol, r])), [orb.data])
  const topPass = useTopPass()
  const m = { bias: live?.bias?.label, nifty: live?.indices?.nifty50?.pct_prev }
  const scored = useMemo(() => withLive(data.rows, live).filter(r => r.fo && r.tf15).map(r => {
    const x = { ...r, t: r.tf15 }
    const res = SETUP_CHECKS[side].map(([, , f]) => !!f(x, m))
    const score = res.filter(Boolean).length
    return { ...x, res, score, lv: setupLevels(x, side, Number(risk)), since: score >= minScore ? setupSince(x, side, res, minScore) : null }
  }), [data, live, side, m.bias, m.nifty, risk, minScore])
  const orbHit = r => { const o = O[r.symbol]; return !!o && o.signal === (side === 'bull' ? 'BREAKOUT' : 'BREAKDOWN') }
  const pass = scored.filter(r => r.score >= minScore && r.lv && (!orbOnly || orbHit(r))).map(r => ({ ...r, orb: O[r.symbol], orbT: orbHit(r) ? O[r.symbol].break_time : '' }))
  const shown = topPass(sortRows(pass.map(r => ({ ...r, entry: r.lv.entry, riskPct: r.lv.riskPct })), sort.key, sort.dir))
  const sp = { sort, setSort }
  const checks = SETUP_CHECKS[side]
  const f2 = v => fmtNum(v, 2)
  return <>
    <div className="toolbar">
      <Seg value={side} onChange={setManual} options={[{ value: 'bull', label: 'Long setups', tone: 'up' }, { value: 'bear', label: 'Short setups', tone: 'down' }]} />
      {!manual && <span className="muted small">follows Market Bias ({biasNote(live?.bias)})</span>}
      <label className="check-label">Min score <select value={minScore} onChange={e => setMinScore(Number(e.target.value))}>{[5, 6, 7, 8].map(v => <option key={v} value={v}>{v} of 8</option>)}</select></label>
      <label className="check-label" title={`Only stocks whose price has closed ${side === 'bull' ? 'above' : 'below'} the 15-minute opening range (9:15–9:30) today, confirmed on 3-minute candles, as in the ORB Scanner`}><input type="checkbox" checked={orbOnly} onChange={e => setOrbOnly(e.target.checked)} />Only 15-min ORB {side === 'bull' ? 'breakouts' : 'breakdowns'}</label>
      <label className="check-label" title="How much you are willing to lose on one trade if the stop is hit (₹). Quantity = this ÷ the distance to the stop.">Risk per trade ₹<input className="search setup-risk" type="number" min="100" step="100" value={risk} onChange={e => setRisk(e.target.value)} /></label>
      <TopFilter />
    </div>
    <p className="muted small qualify-line"><b className={side === 'bull' ? 'up' : 'down'}>{shown.length}</b> F&amp;O stocks pass at least <b>{minScore} of 8</b> {side === 'bull' ? 'long' : 'short'} checks on 15-minute candles. Hover the dots to see which checks passed. Levels follow fixed rules (see “How the levels are worked out” below).</p>
    <div className="tbl-wrap panel trend-wrap">
      <table className="tbl trend-tbl pickable setup-tbl">
        <thead><tr>
          <SortTh label="Symbol" k="symbol" {...sp} defaultDir="asc" />
          <SortTh label="LTP" k="ltp" {...sp} num />
          <SortTh label="Chg %" k="pct_prev" {...sp} num />
          <SortTh label="Score" k="score" {...sp} num title="How many of the 8 checks pass" />
          <SortTh label="15m ORB" k="orbT" {...sp} title="15-minute opening range breakout (range 9:15–9:30, confirmed on 3-min candles, as in the ORB Scanner): ▲ broke above the range high, ▼ broke below the range low, with the time" />
          <SortTh label="In list since" k="since" {...sp} title="When the stock's current run in this list began (close time of the first 15-minute candle that qualified, IST). Market Bias, strength vs Nifty and volume use their current values." />
          <th className="num" title="Entry trigger: a break of the last completed 15-minute candle's high (long) or low (short)">Entry</th>
          <th title="On break = waiting for the price to cross the last 15-min candle; Chasing = the price is already past it, so the entry is the current price">Entry type</th>
          <th className="num" title="Initial stop-loss: the 15-minute Supertrend line (ST), or 1.5 × ATR when Supertrend is too close or too far">Stop</th>
          <th className="num" title="Target 1 = 1 × risk (R) from entry">T1</th>
          <th className="num" title="Target 2 = 2 × risk (R) from entry">T2</th>
          <th title="Trailing stop now: the 15-minute Supertrend line. Raise (long) / lower (short) the stop to it as it moves; after T1, at least to the entry price">Trail now</th>
          <SortTh label="Risk %" k="riskPct" {...sp} num title="Distance from entry to stop, in % of the entry price" />
          <th className="num" title="Shares so that hitting the stop loses about your risk per trade (before costs)">Qty</th>
          <th className="num" title="Qty × entry: the money the position needs (intraday margin is usually lower)">Value</th>
        </tr></thead>
        <tbody>{shown.map(r => { const v = r.lv; return <tr key={r.symbol} onClick={() => onPick(r)} className={picked === r.symbol ? 'active' : undefined}>
          <td><StockLink symbol={r.symbol} company={r.company} className="strong" /><TopTag symbol={r.symbol} />
            <span className="setup-dots">{checks.map(([k, d], i) => <i key={k} className={r.res[i] ? 'ok' : ''} title={(r.res[i] ? '✓ ' : '✗ ') + d} />)}</span></td>
          <td className="num">{fmtNum(r.ltp)}</td>
          <td className={'num ' + (r.pct_prev > 0 ? 'up' : r.pct_prev < 0 ? 'down' : '')}>{isNum(r.pct_prev) ? (r.pct_prev > 0 ? '+' : '') + r.pct_prev.toFixed(2) + '%' : '—'}</td>
          <td className={'num strong ' + (r.score >= 7 ? (side === 'bull' ? 'up' : 'down') : '')}>{r.score}/8</td>
          <td>{r.orb && r.orb.signal ? <span className={'setup-tag ' + ((r.orb.signal === 'BREAKOUT') === (side === 'bull') ? 'orb-with' : 'orb-against')}
            title={`${r.orb.signal === 'BREAKOUT' ? 'Broke above' : 'Broke below'} the 9:15–9:30 range (${fmtNum(r.orb.or_low)} – ${fmtNum(r.orb.or_high)}) at ${hhmmTo12(r.orb.break_time)}${(r.orb.signal === 'BREAKOUT') === (side === 'bull') ? '' : ': against this setup'}`}>
            {r.orb.signal === 'BREAKOUT' ? '▲' : '▼'} {hhmmTo12(r.orb.break_time)}</span> : <span className="muted" title="No 15-min ORB break yet">—</span>}</td>
          <td className="num">{r.since ? <span className={'setup-since' + (isFresh(r.since) ? ' fresh' : '')} title={isFresh(r.since) ? 'Joined the list in the last 30 minutes' : undefined}>{hhmmTo12(r.since)}</span> : <span className="muted">—</span>}</td>
          <td className="num"><b>{f2(v.entry)}</b></td>
          <td>{v.already ? <span className="setup-tag amber" title={`Already ${side === 'bull' ? 'above' : 'below'} the last 15-min ${side === 'bull' ? 'high' : 'low'} (${f2(v.trig)})`}>Chasing</span>
            : <span className="setup-tag" title={`Waiting for a ${side === 'bull' ? 'break above' : 'break below'} ${f2(v.trig)}`}>On break</span>}</td>
          <td className="num down"><b>{f2(v.stop)}</b> <span className="muted small">{v.stopBy === 'Supertrend' ? 'ST' : '1.5 ATR'}</span></td>
          <td className={'num ' + (side === 'bull' ? 'up' : 'down')}>{f2(v.t1)}</td>
          <td className={'num ' + (side === 'bull' ? 'up' : 'down')}>{f2(v.t2)}</td>
          <td className="num">{f2(v.trail)}</td>
          <td className={'num ' + (v.riskPct > 2 ? 'amber' : 'muted')}>{v.riskPct.toFixed(2)}%</td>
          <td className="num"><b>{v.qty ?? '—'}</b></td>
          <td className="num muted">{v.capital ? '₹' + Math.round(v.capital).toLocaleString('en-IN') : '—'}</td>
        </tr> })}</tbody>
      </table>
      {!shown.length && <Empty>No F&amp;O stock passes {minScore} of 8 {side === 'bull' ? 'long' : 'short'} checks right now. That is information too: on a mixed day, fewer clean setups is normal.</Empty>}
    </div>
    <details className="panel cp-help setup-checks" open><summary><b>The 8 checks behind the score</b> <span className="muted small">(the dots next to each stock, left to right · green = passed)</span></summary>
      <ol>{checks.map(([k, d], i) => <li key={k}><span className="setup-ck"><i className="ok" />{i + 1}. {k}</span> <b>{d}.</b> <span className="muted">{SETUP_WHY[side][i]}</span></li>)}</ol>
      <p className="muted small"><b>15m ORB</b> = whether the stock broke out of its first 15 minutes (9:15–9:30) today, and when: ▲ above the range high, ▼ below the range low (green when it agrees with this side, red when it is against it). A setup that also has a 15-min ORB break in the same direction has one more independent sign; tick “Only 15-min ORB breakouts” to see just those.</p>
      <p className="muted small"><b>In list since</b> = when the stock’s current run in this list began: the close time of the first 15-minute candle today from which it has qualified without a break (green when it joined in the last 30 minutes). An early time means the setup has held for a while; a fresh one is new and less proven. Score = how many of the 8 pass. 8/8 = everything lines up; 6/8 = most do. No single check is enough on its own: the idea is that several independent signs agree. Change the minimum with “Min score”.</p>
    </details>
    <details className="panel cp-help" open><summary><b>How the levels are worked out</b></summary><ul>
      <li><b>Entry:</b> a break of the last completed 15-minute candle’s {side === 'bull' ? 'high' : 'low'}. If the price is already beyond it, the entry shown is the current price, which means chasing: the risk to the stop is bigger.</li>
      <li><b>Stop:</b> the 15-minute Supertrend (10, 3) line, the level where the short-term trend would turn. If that line is very close (under ¼ ATR) or very far (over 3 ATR), 1.5 × ATR(14) from the entry instead.</li>
      <li><b>Targets:</b> R = entry − stop. T1 = 1R, T2 = 2R from the entry. A common way to manage it: book part at T1, then move the stop on the rest to the entry (no-loss trade).</li>
      <li><b>Trailing exit:</b> follow the 15-minute Supertrend (“Trail now”): {side === 'bull' ? 'raise' : 'lower'} the stop to it as it moves and exit when a 15-minute candle closes {side === 'bull' ? 'below' : 'above'} it. Exit everything by 3:15 PM in an intraday trade.</li>
      <li><b>Quantity:</b> risk per trade ÷ R, so a stop-out costs about the amount you set (plus brokerage, taxes and slippage).</li>
    </ul></details>
    <details className="panel cp-help"><summary><b>Rules most consistently profitable traders follow</b></summary><ul>
      <li><b>Risk small:</b> 0.5–1% of your trading capital per trade. With ₹1,00,000, that is ₹500–1,000 a trade.</li>
      <li><b>Stop for the day:</b> after 2–3 losing trades or a loss of 2–3% of capital, stop trading that day.</li>
      <li><b>Trade with the market:</b> long setups on bullish days, short setups on bearish days (this screen follows Market Bias for that reason).</li>
      <li><b>Only take trades where T2 makes sense:</b> if a resistance (or support) sits before T2, the trade has little room.</li>
      <li><b>Don’t chase:</b> when the entry says “already above”, waiting for a pull-back often gives a smaller stop.</li>
      <li><b>Avoid the first 15 minutes</b> and news hours (results, RBI policy): spreads and swings are widest then.</li>
      <li><b>Keep a journal</b> (Learn &amp; Track → Journal): write the reason, entry, stop and result of every trade. Your own numbers show what works for you.</li>
      <li><b>Win rate is not everything:</b> with 2R targets, being right 40% of the time is already profitable before costs; cutting losses at the stop is what makes that true.</li>
    </ul></details>
    <p className="muted small">Indicators on Yahoo Finance 15-minute candles (the latest one is still forming); prices and volume from NSE. Levels are rule-based calculations to help you plan, not a recommendation to buy or sell. Trading involves risk of loss.</p>
  </>
}

function OptionSelling({ data, live }) {
  const lots = usePoll(() => api('/api/fo-lots'), 3600000, [])
  const b = live?.bias?.label
  const [manual, setManual] = useSessionState('os.kindManual', null)
  const lean = sideFromBias(live?.bias)
  const kind = manual || (lean === 'bull' ? 'bull' : lean === 'bear' ? 'bear' : 'range')
  const [open, setOpen] = useSessionState('os.open', '')
  const [minScore, setMinScore] = usePersistentState('os.min', 5)
  const [sort, setSort] = useState({ key: 'score', dir: 'desc' })
  const topPass = useTopPass()
  const L = lots.data?.lots || {}
  const all = useMemo(() => withLive(data.rows, live).filter(r => r.fo && r.daily && r.tf60).map(r => {
    const k = osRegime(r), res = OS_CHECKS.map(([, , f]) => !!f(r, k))
    return { ...r, kind: k, res, score: res.filter(Boolean).length, lot: L[r.symbol] ?? null, drsi: r.daily?.rsi, hadx: r.tf60?.adx }
  }), [data, live, L])
  const n = k => topPass(all.filter(r => r.kind === k && r.score >= minScore)).length
  const shown = topPass(sortRows(all.filter(r => r.kind === kind && r.score >= minScore), sort.key, sort.dir))
  const sp = { sort, setSort }
  const K = OS_KIND[kind]
  return <>
    <div className="toolbar">
      <Seg value={kind} onChange={setManual} options={['range', 'bull', 'bear'].map(k => ({ value: k, tone: OS_KIND[k].tone === 'neutral' ? undefined : OS_KIND[k].tone,
        label: <>{OS_KIND[k].strat} <span className="count">{n(k)}</span></> }))} />
      {!manual && <span className="muted small">follows Market Bias ({biasNote(live?.bias)})</span>}
      <label className="check-label">Min score <select value={minScore} onChange={e => setMinScore(Number(e.target.value))}>{[4, 5, 6].map(v => <option key={v} value={v}>{v} of 6</option>)}</select></label>
      <TopFilter />
    </div>
    <p className="muted small qualify-line"><b>{shown.length}</b> F&amp;O stocks look <b>{K.label.toLowerCase()}</b> and pass at least {minScore} of 6 option-selling checks → <b>{K.strat}</b>: {K.what} Click a stock for its strike plan.</p>
    <div className="tbl-wrap panel trend-wrap">
      <table className="tbl trend-tbl pickable setup-tbl">
        <thead><tr>
          <SortTh label="Symbol" k="symbol" {...sp} defaultDir="asc" />
          <SortTh label="LTP" k="ltp" {...sp} num />
          <SortTh label="Chg %" k="pct_prev" {...sp} num />
          <SortTh label="Score" k="score" {...sp} num title="How many of the 6 option-selling checks pass" />
          <SortTh label="Daily RSI" k="drsi" {...sp} num />
          <SortTh label="1H ADX" k="hadx" {...sp} num title="Hourly trend strength: under 20 = sideways" />
          <SortTh label="Lot" k="lot" {...sp} num />
          <th>Structure</th>
          <th />
        </tr></thead>
        <tbody>{shown.map(r => [<tr key={r.symbol} onClick={() => setOpen(open === r.symbol ? '' : r.symbol)} className={open === r.symbol ? 'active' : undefined}>
          <td><StockLink symbol={r.symbol} company={r.company} className="strong" /><TopTag symbol={r.symbol} />
            <span className="setup-dots">{OS_CHECKS.map(([k, d], i) => <i key={k} className={r.res[i] ? 'ok' : ''} title={(r.res[i] ? '✓ ' : '✗ ') + d} />)}</span></td>
          <td className="num">{fmtNum(r.ltp)}</td>
          <td className={'num ' + (r.pct_prev > 0 ? 'up' : r.pct_prev < 0 ? 'down' : '')}>{isNum(r.pct_prev) ? (r.pct_prev > 0 ? '+' : '') + r.pct_prev.toFixed(2) + '%' : '—'}</td>
          <td className="num strong">{r.score}/6</td>
          <td className="num">{fmtNum(r.drsi, 1)}</td>
          <td className="num">{fmtNum(r.hadx, 1)}</td>
          <td className="num">{r.lot ?? '—'}</td>
          <td><span className={'cp-pill ' + (K.tone === 'up' ? 'bull' : K.tone === 'down' ? 'bear' : '')}>{K.strat}</span></td>
          <td className="muted small">{open === r.symbol ? '▲ hide plan' : '▼ strike plan'}</td>
        </tr>, open === r.symbol && <tr key={r.symbol + '-plan'} className="os-plan-row"><td colSpan={9}><OsPlan r={r} kind={kind} lot={r.lot} /></td></tr>])}</tbody>
      </table>
      {!shown.length && <Empty>No F&amp;O stock fits a {K.strat.toLowerCase()} with {minScore}+ checks right now.</Empty>}
    </div>
    <details className="panel cp-help setup-checks" open><summary><b>The 6 checks</b> <span className="muted small">(dots next to each stock, left to right)</span></summary>
      <ol>{OS_CHECKS.map(([k, d], i) => <li key={k}><span className="setup-ck"><i className="ok" />{i + 1}. {k}</span> {d}.</li>)}</ol>
      <p className="muted small"><b>Regime:</b> Range-bound = hourly ADX under 20, daily RSI 40–60, less than 1.5% move today. Bullish = daily close above its 20-day average, hourly 9 EMA above 21 EMA, daily RSI 50–70. Bearish = the mirror. Anything else: no clear regime, so no trade.</p>
    </details>
    <details className="panel cp-help" open><summary><b>How the strikes are chosen</b></summary><ul>
      <li><b>Expiry:</b> the nearest monthly expiry with at least 5 days left (time decay works for the seller, but the last days carry sharp swings).</li>
      <li><b>Short strike:</b> beyond <b>both</b> the expected move to expiry (from option prices) <b>and</b> the biggest open-interest wall (where option writers defend): above for calls, below for puts.</li>
      <li><b>Protection:</b> a strike further out is bought, so the worst case is capped: max loss = (spread width − credit) × lot. Stocks use the next strike; indices use a wider spread (Nifty 200 points, Bank Nifty and Sensex 500) so the credit is worth the risk.</li>
      <li><b>Credit check:</b> under 15% of the strike gap is flagged as too little reward; a short strike with no bid or no OI is flagged as thin.</li>
    </ul></details>
    <details className="panel cp-help"><summary><b>Option-selling checklist (read before every trade)</b></summary><ul>
      <li><b>Defined risk only:</b> naked (unhedged) selling has unlimited loss and needs ₹1–2 lakh+ margin per lot. Spreads cap the loss and need far less margin.</li>
      <li><b>No events inside the expiry:</b> check results dates, AGMs, dividends and big news before selling. A results gap can blow through any strike. (This screen cannot see the corporate calendar.)</li>
      <li><b>Size by max loss:</b> keep the max loss of one trade under 1–2% of your capital, and total open risk under 5–6%.</li>
      <li><b>Sell when premiums are rich:</b> higher implied volatility (IV) = more credit for the same distance. Compare the stock's ATM IV with its usual level and with India VIX.</li>
      <li><b>Take profit early:</b> booking 50–70% of the credit and moving on is how sellers keep a high win rate.</li>
      <li><b>Respect the stop:</b> if the stock closes beyond the short strike or the spread doubles, exit. One unmanaged loss can wipe out many small wins.</li>
      <li><b>Mind costs:</b> four legs mean four sets of brokerage, STT and slippage. Small credits can disappear in costs.</li>
      <li><b>Learn on paper first:</b> run the plan for a few expiries without money to see how it behaves.</li>
    </ul></details>
    <p className="muted small">Regime from Yahoo Finance daily and hourly candles; option chain, lot sizes and quotes from NSE. Strikes and P&amp;L are rule-based estimates from mid prices before costs, not a recommendation to trade. Options can lose more than expected if the stock gaps.</p>
  </>
}

// 15 Min Trend: every 15-minute indicator in one table. Bullish = price above VWAP, EMA 5, 9 and 21,
// Supertrend up, DI+ above DI−, RSI above 60 and ADX above 25 (bearish = the mirror, RSI below 40).
const T15_COLS = [['VWAP', 'vwap'], ['EMA 5', 'ema5'], ['EMA 9', 'ema9'], ['EMA 21', 'ema21']]
function t15Checks(t, bull) {
  const c = t.close, side = (v) => isNum(v) && (bull ? c > v : c < v)
  return [...T15_COLS.map(([, k]) => side(t[k])), t.st_dir === (bull ? 1 : -1), bull ? gt(t.dip, t.dim) : gt(t.dim, t.dip),
    isNum(t.rsi) && (bull ? t.rsi > 60 : t.rsi < 40), isNum(t.adx) && t.adx > 25]
}
function t15Since(steps, bull, need) {  // steps: [time, [close, vwap, ema5, ema9, st_dir, rsi, adx, dip, dim, ema21]]
  let since = null
  for (const [t, a] of steps || []) {
    if (!a) { since = null; continue }
    const [close, vwap, ema5, ema9, st_dir, rsi, adx, dip, dim, ema21] = a
    const n = t15Checks({ close, vwap, ema5, ema9, ema21, st_dir, rsi, adx, dip, dim }, bull).filter(Boolean).length
    since = n >= need ? since || t : null
  }
  return since
}
function Trend15({ data, live, onPick, picked }) {
  const [manual, setManual] = useSessionState('t15.sideManual', null)
  const side = manual || (sideFromBias(live?.bias) === 'bear' ? 'bear' : 'bull')
  const [need, setNeed] = usePersistentState('t15.need8', 8)  // 8 checks (DI+ vs DI− is one check, shown in two columns)
  const [sort, setSort] = useState({ key: 'score', dir: 'desc' })
  const topPass = useTopPass()
  const bull = side === 'bull'
  const rows = useMemo(() => withLive(data.rows, live).filter(r => r.fo && r.tf15).map(r => {
    const res = t15Checks(r.tf15, bull), score = res.filter(Boolean).length
    return { ...r, t: r.tf15, res, score, since: score >= need ? t15Since(r.steps, bull, need) : null, rsi: r.tf15.rsi, adx: r.tf15.adx }
  }), [data, live, bull, need])
  const n = b => topPass(withLive(data.rows, live).filter(r => r.fo && r.tf15 && t15Checks(r.tf15, b).filter(Boolean).length >= need)).length
  const shown = topPass(sortRows(rows.filter(r => r.score >= need), sort.key, sort.dir))
  const sp = { sort, setSort }
  const cell = (ok, v, d = 2) => <td className={'num ind ' + (ok ? 'pass' : 'fail')}>{fmtNum(v, d)}</td>
  return <>
    <div className="toolbar">
      <Seg value={side} onChange={setManual} options={[{ value: 'bull', label: <>Bullish <span className="count">{n(true)}</span></>, tone: 'up' }, { value: 'bear', label: <>Bearish <span className="count">{n(false)}</span></>, tone: 'down' }]} />
      {!manual && <span className="muted small">follows Market Bias ({biasNote(live?.bias)})</span>}
      <label className="check-label">Show <select value={need} onChange={e => setNeed(Number(e.target.value))}>{[8, 7, 6].map(v => <option key={v} value={v}>{v === 8 ? 'all 8 checks' : `${v}+ of 8`}</option>)}</select></label>
      <TopFilter />
    </div>
    <p className="muted small qualify-line"><b className={bull ? 'up' : 'down'}>{shown.length}</b> F&amp;O stocks on <b>15-minute candles</b> with price {bull ? 'above' : 'below'} VWAP, EMA 5, EMA 9 and EMA 21, Supertrend {bull ? 'up' : 'down'}, {bull ? 'DI+ above DI−' : 'DI− above DI+'}, RSI {bull ? 'above 60' : 'below 40'} and ADX above 25{need < 8 ? ` (at least ${need} of the 8)` : ''}. Green = passed.</p>
    <div className="tbl-wrap panel trend-wrap">
      <table className="tbl trend-tbl pickable setup-tbl">
        <thead><tr>
          <SortTh label="Symbol" k="symbol" {...sp} defaultDir="asc" />
          <SortTh label="LTP" k="ltp" {...sp} num />
          <SortTh label="Chg %" k="pct_prev" {...sp} num />
          <SortTh label="Score" k="score" {...sp} num />
          <SortTh label="Since" k="since" {...sp} title="When the stock's current run of passing began (close time of the first 15-minute candle today)" />
          {T15_COLS.map(([l]) => <th key={l} className="num">{l}</th>)}
          <th className="num">ST</th><th className="num">DI+</th><th className="num">DI−</th><SortTh label="RSI" k="rsi" {...sp} num /><SortTh label="ADX" k="adx" {...sp} num />
        </tr></thead>
        <tbody>{shown.map(r => <tr key={r.symbol} onClick={() => onPick(r)} className={picked === r.symbol ? 'active' : undefined}>
          <td><StockLink symbol={r.symbol} company={r.company} className="strong" /><TopTag symbol={r.symbol} /></td>
          <td className="num">{fmtNum(r.ltp)}</td>
          <td className={'num ' + (r.pct_prev > 0 ? 'up' : r.pct_prev < 0 ? 'down' : '')}>{isNum(r.pct_prev) ? (r.pct_prev > 0 ? '+' : '') + r.pct_prev.toFixed(2) + '%' : '—'}</td>
          <td className={'num strong ' + (r.score === 8 ? (bull ? 'up' : 'down') : '')}>{r.score}/8</td>
          <td className="num">{r.since ? hhmmTo12(r.since) : '—'}</td>
          {T15_COLS.map(([, k], i) => <React.Fragment key={k}>{cell(r.res[i], r.t[k])}</React.Fragment>)}
          <td className={'num ind ' + (r.res[4] ? 'pass' : 'fail')}>{r.t.st_dir === 1 ? '▲' : r.t.st_dir === -1 ? '▼' : '—'} {fmtNum(r.t.st)}</td>
          {cell(r.res[5], r.t.dip, 1)}{cell(r.res[5], r.t.dim, 1)}{cell(r.res[6], r.t.rsi, 1)}{cell(r.res[7], r.t.adx, 1)}
        </tr>)}</tbody>
      </table>
      {!shown.length && <Empty>No F&amp;O stock passes {need === 8 ? 'all 8' : `${need}+ of the 8`} {bull ? 'bullish' : 'bearish'} 15-minute checks right now.</Empty>}
    </div>
    <p className="muted small">15-minute candles from Yahoo Finance (the latest is still forming); VWAP from today’s candles; Supertrend (10, 3); RSI, ADX, DI+ / DI− (14, Wilder). Condition screen, not a buy / sell signal.</p>
  </>
}

// High Momentum (Chartink "High Momentum Stocks", F&O only): daily RSI above 50 and above each of the
// last 3 days, MACD line above its signal, CCI(20) above 0, close above SMA 200 and EMA 200, MFI(14) above 60.
// Chartink's "dividend > 0" needs company fundamentals the dashboard doesn't have, so it is left out.
// The user's version adds 15-minute candle conditions: the previous 15-min candle red, the current one green
// (high ≥ open, close ≥ open) and closing more than 1% above the previous 15-min close. Their screen also had
// "current close < current open", which contradicts "close ≥ open" (no stock could pass), so it is left out.
const MOM_CHECKS = [
  ['RSI', 'Daily RSI(14) above 50', d => gt(d.rsi, 50)],
  ['RSI rising', 'Daily RSI above each of the last 3 days', d => gt(d.rsi, d.rsi_max3)],
  ['MACD', 'MACD line (12, 26) above its 9-day signal', d => gt(d.macd, d.macd_sig)],
  ['CCI', 'CCI(20) above 0', d => gt(d.cci20, 0)],
  ['SMA 200', 'Close above its 200-day simple average', d => gt(d.close, d.sma200)],
  ['EMA 200', 'Close above its 200-day exponential average', d => gt(d.close, d.ema200)],
  ['MFI', 'Money Flow Index(14) above 60', d => gt(d.mfi14, 60)],
  ['15m high', 'Latest 15-min candle: high at or above its open', (d, t) => isNum(t?.high) && isNum(t?.open) && t.high >= t.open],
  ['15m green', 'Latest 15-min candle is green (close at or above its open)', (d, t) => isNum(t?.close) && isNum(t?.open) && t.close >= t.open],
  ['15m +1%', 'Latest 15-min close more than 1% above the previous 15-min close', (d, t) => isNum(t?.prev_close) && gt(t?.close, t.prev_close * 1.01)],
  ['Prev red', 'Previous 15-min candle was red (close below its open)', (d, t) => lt(t?.prev_close, t?.prev_open)],
]
const MOM_N = MOM_CHECKS.length
function HighMomentum({ data, live, onPick, picked }) {
  const [sort, setSort] = useState({ key: 'rsi', dir: 'desc' })
  const [push, setPush] = usePersistentState('mom.push2', true)  // on (default) = the 7 daily rules + the 15-minute conditions; off = daily rules only
  const topPass = useTopPass()
  const rows = useMemo(() => withLive(data.rows, live).filter(r => r.fo && r.daily).map(r => {
    const d = r.daily, t = r.tf15 || {}, res = MOM_CHECKS.map(([, , f]) => !!f(d, t))
    return { ...r, d, t, res, score: res.filter(Boolean).length, rsi: d.rsi, mfi: d.mfi14, cci: d.cci20, j15: isNum(t.close) && t.prev_close ? (t.close / t.prev_close - 1) * 100 : null }
  }), [data, live])
  const ok = r => (push ? r.res : r.res.slice(0, 7)).every(Boolean)
  const shown = topPass(sortRows(rows.filter(ok), sort.key, sort.dir))
  const sp = { sort, setSort }
  const pass = (ok, v, d = 1) => <td className={'num ind ' + (ok ? 'pass' : 'fail')}>{fmtNum(v, d)}</td>
  return <>
    <div className="toolbar">
      <label className="check-label" title="Also require a fresh 15-minute push: the previous 15-min candle red, the latest one green and closing more than 1% above the previous 15-min close"><input type="checkbox" checked={push} onChange={e => setPush(e.target.checked)} />15-minute conditions</label>
      <TopFilter />
    </div>
    <p className="muted small qualify-line"><b className="up">{shown.length}</b> F&amp;O stocks pass Chartink’s High Momentum rules: daily RSI above 50 and above its last 3 days, MACD above its signal, CCI above 0, price above its 200-day averages and MFI above 60{push ? <>, <b>plus</b> a fresh 15-minute push (previous 15-min candle red, latest one green and closing more than 1% above the previous close)</> : ''}.</p>
    <div className="tbl-wrap panel trend-wrap">
      <table className="tbl trend-tbl pickable setup-tbl">
        <thead><tr>
          <SortTh label="Symbol" k="symbol" {...sp} defaultDir="asc" />
          <SortTh label="LTP" k="ltp" {...sp} num />
          <SortTh label="Chg %" k="pct_prev" {...sp} num />
          <SortTh label="Score" k="score" {...sp} num />
          <SortTh label="RSI" k="rsi" {...sp} num />
          <th className="num" title="Highest daily RSI of the previous 3 sessions">RSI 3D max</th>
          <th className="num">MACD / Signal</th>
          <SortTh label="CCI 20" k="cci" {...sp} num />
          <th className="num">SMA 200</th><th className="num">EMA 200</th>
          <SortTh label="MFI 14" k="mfi" {...sp} num />
          <SortTh label="15m move" k="j15" {...sp} num title="Latest 15-min close vs the previous 15-min close" />
          <th title="15-minute checks: high ≥ open · green · +1% · previous candle red">15m checks</th>
        </tr></thead>
        <tbody>{shown.map(r => <tr key={r.symbol} onClick={() => onPick(r)} className={picked === r.symbol ? 'active' : undefined}>
          <td><StockLink symbol={r.symbol} company={r.company} className="strong" /><TopTag symbol={r.symbol} /></td>
          <td className="num">{fmtNum(r.ltp)}</td>
          <td className={'num ' + (r.pct_prev > 0 ? 'up' : r.pct_prev < 0 ? 'down' : '')}>{isNum(r.pct_prev) ? (r.pct_prev > 0 ? '+' : '') + r.pct_prev.toFixed(2) + '%' : '—'}</td>
          <td className="num strong up">{push ? `${r.score}/${MOM_N}` : `${r.res.slice(0, 7).filter(Boolean).length}/7`}</td>
          {pass(r.res[0], r.d.rsi)}
          {pass(r.res[1], r.d.rsi_max3)}
          <td className={'num ind ' + (r.res[2] ? 'pass' : 'fail')}>{fmtNum(r.d.macd)} / {fmtNum(r.d.macd_sig)}</td>
          {pass(r.res[3], r.d.cci20, 0)}
          {pass(r.res[4], r.d.sma200, 2)}{pass(r.res[5], r.d.ema200, 2)}
          {pass(r.res[6], r.d.mfi14)}
          <td className={'num ind ' + (r.res[9] ? 'pass' : 'fail')}>{isNum(r.j15) ? (r.j15 > 0 ? '+' : '') + r.j15.toFixed(2) + '%' : '—'}</td>
          <td><span className="setup-dots">{MOM_CHECKS.slice(7).map(([k, dsc], i) => <i key={k} className={r.res[7 + i] ? 'ok' : ''} title={(r.res[7 + i] ? '✓ ' : '✗ ') + dsc} />)}</span></td>
        </tr>)}</tbody>
      </table>
      {!shown.length && <Empty>No F&amp;O stock passes {push ? 'the momentum rules plus the 15-minute push' : 'the momentum rules'} right now.{push ? ' The 15-minute push (a red candle, then a green one up more than 1%) is rare, so an empty list is common: untick “15-minute conditions” to see the daily rules alone.' : ''}</Empty>}
    </div>
    <p className="muted small">Daily candles from Yahoo Finance with today’s NSE candle; 15-minute candles from Yahoo Finance (the latest one is still forming in market hours). MACD (12, 26, 9), CCI (20), MFI (14), RSI (14, Wilder). Chartink’s “dividend paid” rule is left out (no company fundamentals here). With “+ 15-min push”, “latest close below its open” from your version is left out because it contradicts “close at or above open”. Momentum screen, not a buy / sell signal.</p>
  </>
}

