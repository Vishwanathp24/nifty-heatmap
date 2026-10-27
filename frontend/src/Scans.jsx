import React, { useEffect, useMemo, useState } from 'react'
import { BiasPill, Empty, Seg, SortTh, StockLink, TopFilter, TopTag, useTopPass } from './components.jsx'
import { fmtNum, hhmmTo12, isNum, istTime, setSessionValue, sortRows, useSessionState } from './lib.js'
import Trend, { trendNeed, trendRows, useTrendSettings } from './Trend.jsx'
import { SectorMulti } from './Scanner.jsx'
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

function ConditionScan({ id, data }) {
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
      <table className="tbl trend-tbl cond-tbl">
        <thead><tr>
          <SortTh label="Symbol" k="symbol" {...sp} defaultDir="asc" />
          <SortTh label="Sector" k="sector" {...sp} defaultDir="asc" />
          <SortTh label="LTP" k="ltp" {...sp} num />
          <SortTh label="Chg %" k="pct_prev" {...sp} num />
          <SortTh label="Met" k="met" {...sp} num title={`Conditions met out of ${N}`} />
          <SortTh label="Time" k="since" {...sp} title="Time (IST) since when the stock has met every condition today (close of the first qualifying 15-min candle)" />
          {sc.conds.map(c => <SortTh key={c.k} label={c.label} k={'v_' + c.k} {...sp} num title={c.title} />)}
        </tr></thead>
        <tbody>{shown.map(r => <tr key={r.symbol}>
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

const TABS = [['iopt', 'Index Options'], ['trend', 'Trending Stocks'], ['bull', 'Bullish Intraday'], ['bear', 'Bearish Intraday'], ['btst', 'BTST Stocks'], ['common', 'Common Stocks'], ['chart', 'Live Chart']]

// Live Chart: NSE stock candles (Yahoo) on 1m ... 1M with the indicator table; the stock list
// follows the sector filter.
// Prices without the ₹ sign (cleaner).
const inr = v => !isNum(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const inrShort = v => !isNum(v) ? '—' : v >= 1000 ? Math.round(v).toLocaleString('en-IN') : inr(v)
// Common Stocks: F&O stocks that appear in every scan for one direction - Trending Stocks, Bullish /
// Bearish Intraday and the 15 / 30 / 60-minute ORB breakouts (breakdowns) - each list as its tab shows it.
const COMMON = [['trend', 'Trending'], ['intra', 'Intraday'], ['o15', '15 Min ORB'], ['o30', '30 Min ORB'], ['o60', '1 Hour ORB']]
function CommonStocks({ data, settings, orbLists, bias }) {
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
    <div className="tbl-wrap panel"><table className="tbl">
      <thead><tr><th>Symbol</th><th>Sector</th><th className="num">LTP</th><th className="num">Chg %</th><th className="num">In</th><th className="num" title="When the stock entered the last of its scans (IST): the latest of the times below">Captured</th>{COMMON.map(([k, l]) => <th key={k} className="num">{l}</th>)}</tr></thead>
      <tbody>{shown.map(r => <tr key={r.symbol}>
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
  const counts = useMemo(() => {
    const need = trendNeed(tfs)
    const c = { trend: data ? trendRows(data.rows, settings).filter(r => (universe === 'all' || r.fo) && r.score === need).length : null }
    for (const id of ['bull', 'bear', 'btst']) c[id] = data ? scanRows(data.rows, id).filter(r => r.met === SCANS[id].conds.length).length : null
    return c
  }, [data, dir, tfs, rsiMin, adxMin, universe])
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
        {label}{counts[v] != null && <span className="count">{counts[v]}</span>}</button>)}
    </div>
    {tab === 'iopt' ? <OptionsBoard market={INDIA} bias={live?.bias} />
      : tab === 'chart' ? <StockLive key={'sl' + chartReq} stocks={live?.stocks || []} selected={selected} bias={live?.bias?.label} nifty={live?.indices?.nifty50} />
      : !data ? <Empty>{trend.error || 'Loading scan data…'}</Empty>
      : !data.rows.length ? <Empty>Calculating for the first time — this takes about 2–3 minutes…</Empty>
        : tab === 'trend' ? <Trend key={'t' + resetKey} trend={trend} settings={settings} />
        : tab === 'common' ? <CommonStocks key={'c' + resetKey} data={data} settings={settings} orbLists={orbLists} bias={live?.bias?.label} />
        : <ConditionScan key={tab + resetKey} id={tab} data={data} />}
  </div>
}
