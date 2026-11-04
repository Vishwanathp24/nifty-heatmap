import React, { useEffect, useMemo, useState } from 'react'
import { BiasPill, Empty, Seg, SortTh, StockLink, TopFilter, TopTag, useTopPass } from './components.jsx'
import { api, fmtNum, fmtVol, hhmmTo12, isNum, istTime, setSessionValue, sortRows, usePoll, useSessionState } from './lib.js'
import Trend, { trendNeed, trendRows, useTrendSettings } from './Trend.jsx'
import { SectorMulti, StockDrawer } from './Scanner.jsx'
import { INDIA, OptionsBoard } from './CryptoOptions.jsx'
import { ChartView } from './Chart.jsx'

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

const TABS = [['iopt', 'Index Options'], ['trend', 'Trending Stocks'], ['bull', 'Bullish Intraday'], ['bear', 'Bearish Intraday'], ['btst', 'BTST Stocks'], ['vol', 'Volume Spike'], ['ema', 'EMA 9/21 + RSI'], ['candle', 'Candlestick'], ['common', 'Common Stocks'], ['chart', 'Live Chart']]

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

export default function Scans({ trend: trendRaw, live, selected, setSelected, chartReq = 0, orbLists = {} }) {
  const [tab, setTab] = useSessionState('scans.tab', 'iopt')  // Index Options is the first tab
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
    </div>
    {tab === 'iopt' ? <OptionsBoard market={INDIA} bias={live?.bias} />
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

