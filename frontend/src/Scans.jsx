import React, { useMemo, useState } from 'react'
import { Empty, SortTh, StockLink } from './components.jsx'
import { fmtNum, hhmmTo12, isNum, istTime, sortRows, useSessionState } from './lib.js'
import Trend, { trendNeed, trendRows, useTrendSettings } from './Trend.jsx'

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
  const shown = sortRows(allOnly ? full : base, sort.key, sort.dir)
  const sp = { sort, setSort }
  const N = sc.conds.length
  return <>
    <p className="muted small qualify-line"><b className={sc.tone}>{full.length}</b> of {base.length} stocks meet all {N} conditions. {sc.about}</p>
    <div className="toolbar">
      <input className="search" placeholder="Search symbol" value={search} onChange={e => setSearch(e.target.value)} />
      <label className="check-label"><input type="checkbox" checked={allOnly} onChange={e => setAllOnly(e.target.checked)} />Only stocks meeting all {N} conditions</label>
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
          <td><StockLink symbol={r.symbol} company={r.company} className="strong" /></td>
          <td className="muted">{r.sector}</td>
          <td className="num">{fmtNum(r.ltp)}</td>
          <td className={'num ' + (r.pct_prev > 0 ? 'up' : r.pct_prev < 0 ? 'down' : '')}>{isNum(r.pct_prev) ? (r.pct_prev > 0 ? '+' : '') + r.pct_prev.toFixed(2) + '%' : '—'}</td>
          <td className={'num strong ' + (r.met === N ? sc.tone : '')}>{r.met}/{N}</td>
          <td className="num">{r.met === N ? (r.since ? hhmmTo12(r.since) : 'just now') : '—'}</td>
          {sc.conds.map((c, i) => <td key={c.k} className={'num ind ' + (r.res[i] ? 'pass' : 'fail')} title={c.title}>{(c.fmt || n2)(r['v_' + c.k])}</td>)}
        </tr>)}</tbody>
      </table>
      {!shown.length && <Empty>No stock meets every condition right now. Untick “Only stocks meeting all conditions” to see the closest ones (sorted by conditions met).</Empty>}
    </div>
    <p className="muted small">Each cell shows the level the condition compares against (hover for the exact rule); green = met, red = not met. Daily values use today’s live candle, so results change during the session. Condition screen, not a buy/sell recommendation.</p>
  </>
}

const TABS = [['trend', 'Trending Stocks'], ['bull', 'Bullish Intraday'], ['bear', 'Bearish Intraday'], ['btst', 'BTST Stocks']]

// Which scans suit the current market bias (same 5-vote bias as the ORB Scanner).
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

export default function Scans({ trend, live }) {
  const [tab, setTab] = useSessionState('scans.tab', 'trend')
  const settings = useTrendSettings()
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
    <BiasBanner bias={live?.bias} onPick={setTab} />
    <div className="orb-switch learn-cats scan-tabs" role="tablist" aria-label="Scan">
      {TABS.map(([v, label]) => <button key={v} role="tab" aria-selected={tab === v} className={tab === v ? 'on' : ''} onClick={() => setTab(v)}>
        {label}{counts[v] != null && <span className="count">{counts[v]}</span>}</button>)}
    </div>
    {!data ? <Empty>{trend.error || 'Loading scan data…'}</Empty>
      : !data.rows.length ? <Empty>Calculating for the first time — this takes about 2–3 minutes…</Empty>
        : tab === 'trend' ? <Trend trend={trend} settings={settings} /> : <ConditionScan key={tab} id={tab} data={data} />}
  </div>
}
