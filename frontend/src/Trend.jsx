import React, { useMemo, useState } from 'react'
import { Empty, Seg, SortTh, StockLink } from './components.jsx'
import { fmtNum, hhmmTo12, isNum, sortRows, useSessionState } from './lib.js'

// Indicator checks per timeframe. Bullish: price above VWAP / EMA 5 / EMA 9,
// Supertrend up, RSI above the threshold, ADX above the threshold (trend strength),
// DI+ above DI-. Bearish mirrors each one (RSI below 100 - threshold, DI- above DI+).
const COLS = [
  ['vwap', 'VWAP'], ['ema5', 'EMA 5'], ['ema9', 'EMA 9'], ['st', 'ST'],
  ['rsi', 'RSI'], ['adx', 'ADX'], ['dip', 'DI +'], ['dim', 'DI −'],
]

function checks(t, bull, rsiMin, adxMin) {
  if (!t) return null
  const above = v => isNum(v) && (bull ? t.close > v : t.close < v)
  return {
    vwap: above(t.vwap), ema5: above(t.ema5), ema9: above(t.ema9),
    st: t.st_dir === (bull ? 1 : -1),
    rsi: isNum(t.rsi) && (bull ? t.rsi > rsiMin : t.rsi < 100 - rsiMin),
    adx: isNum(t.adx) && t.adx > adxMin,
    dip: isNum(t.dip) && isNum(t.dim) && (bull ? t.dip > t.dim : t.dim > t.dip),
  }
}
const passCount = c => c ? Object.values(c).filter(Boolean).length : 0

function Cells({ t, c, bull }) {
  if (!t) return COLS.map(([k]) => <td key={k} className="num muted">—</td>)
  return COLS.map(([k]) => {
    // DI−/DI+: the line against the chosen direction is shown neutral, as in the reference table.
    const neutral = (bull && k === 'dim') || (!bull && k === 'dip')
    const ok = k === 'dim' || k === 'dip' ? c.dip : c[k]
    const val = k === 'rsi' || k === 'adx' || k === 'dip' || k === 'dim' ? fmtNum(t[k], 1) : fmtNum(t[k], t[k] >= 1000 ? 1 : 2)
    return <td key={k} className={'num ind ' + (neutral ? 'neutral' : ok ? 'pass' : 'fail')}
      title={k === 'st' ? `Supertrend ${t.st_dir === 1 ? 'UP' : 'DOWN'}` : undefined}>{val}</td>
  })
}

// Rows with their pass/fail checks and score for the chosen settings.
const STEP_KEYS = ['close', 'vwap', 'ema5', 'ema9', 'st_dir', 'rsi', 'adx', 'dip', 'dim']
const unpack = a => a ? Object.fromEntries(STEP_KEYS.map((k, i) => [k, a[i]])) : null

// Replay today's 15-min candles: the time from which every selected condition has held.
function sinceFor(steps, bull, rsiMin, adxMin, use15, use60) {
  let since = null
  for (const [t, a15, a60] of steps || []) {
    const n = (use15 ? passCount(checks(unpack(a15), bull, rsiMin, adxMin)) : 0) + (use60 ? passCount(checks(unpack(a60), bull, rsiMin, adxMin)) : 0)
    const ok = n === (use15 ? 7 : 0) + (use60 ? 7 : 0)
    since = ok ? (since || t) : null
  }
  return since
}

export function trendRows(rows, { dir, tfs, rsiMin, adxMin }) {
  const bull = dir === 'bull', use15 = tfs !== '60', use60 = tfs !== '15'
  return (rows || []).map(r => {
    const c15 = checks(r.tf15, bull, rsiMin, adxMin), c60 = checks(r.tf60, bull, rsiMin, adxMin)
    const score = (use15 ? passCount(c15) : 0) + (use60 ? passCount(c60) : 0)
    return { ...r, c15, c60, score, since: sinceFor(r.steps, bull, rsiMin, adxMin, use15, use60), adx15: r.tf15?.adx, adx60: r.tf60?.adx, rsi15: r.tf15?.rsi, rsi60: r.tf60?.rsi }
  })
}
export const trendNeed = tfs => (tfs !== '60' ? 7 : 0) + (tfs !== '15' ? 7 : 0)

export function useTrendSettings() {
  const [dir, setDir] = useSessionState('trend.dir', 'bull')
  const [tfs, setTfs] = useSessionState('trend.tfs', 'both')
  const [rsiMin, setRsiMin] = useSessionState('trend.rsi', 60)
  const [adxMin, setAdxMin] = useSessionState('trend.adx', 25)
  const [universe, setUniverse] = useSessionState('trend.universe', 'fo')
  return { dir, setDir, tfs, setTfs, rsiMin, setRsiMin, adxMin, setAdxMin, universe, setUniverse }
}

export default function Trend({ trend, settings }) {
  const { dir, setDir, tfs, setTfs, rsiMin, setRsiMin, adxMin, setAdxMin, universe, setUniverse } = settings
  const [allOnly, setAllOnly] = useSessionState('trend.allOnly', true)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ key: 'score', dir: 'desc' })
  const data = trend.data
  const bull = dir === 'bull'
  const use15 = tfs !== '60', use60 = tfs !== '15'
  const need = (use15 ? 7 : 0) + (use60 ? 7 : 0)

  const rows = useMemo(() => trendRows(data?.rows, { dir, tfs, rsiMin, adxMin }), [data, dir, tfs, rsiMin, adxMin])
  const q = search.trim().toUpperCase()
  const base = rows.filter(r => (universe === 'all' || r.fo)
    && (!q || r.symbol.includes(q) || (r.company || '').toUpperCase().includes(q)))
  const full = base.filter(r => r.score === need)
  const shown = sortRows(allOnly ? full : base, sort.key, sort.dir)
  const sp = { sort, setSort }

  return <>
    <div className="toolbar">
      <Seg value={dir} onChange={setDir} options={[{ value: 'bull', label: 'Bullish', tone: 'up' }, { value: 'bear', label: 'Bearish', tone: 'down' }]} />
      <Seg value={tfs} onChange={setTfs} options={[{ value: 'both', label: '15 Min + 1 Hour' }, { value: '15', label: '15 Min only' }, { value: '60', label: '1 Hour only' }]} />
      <label className="field-inline">RSI {bull ? '>' : '<'}
        <select value={rsiMin} onChange={e => setRsiMin(Number(e.target.value))}>
          {[50, 55, 60, 65, 70].map(v => <option key={v} value={v}>{bull ? v : 100 - v}</option>)}</select></label>
      <label className="field-inline">ADX &gt;
        <select value={adxMin} onChange={e => setAdxMin(Number(e.target.value))}>
          {[20, 25, 30, 40].map(v => <option key={v} value={v}>{v}</option>)}</select></label>
      <Seg value={universe} onChange={setUniverse} options={[{ value: 'fo', label: 'F&O' }, { value: 'all', label: 'All' }]} />
      <input className="search" placeholder="Search symbol" value={search} onChange={e => setSearch(e.target.value)} />
      <label className="check-label"><input type="checkbox" checked={allOnly} onChange={e => setAllOnly(e.target.checked)} />Only stocks meeting all {need} conditions</label>
    </div>
    <p className="muted small qualify-line"><b className={bull ? 'up' : 'down'}>{full.length}</b> of {base.length} stocks meet all {need} {bull ? 'bullish' : 'bearish'} conditions
      VWAP · EMA 5 · EMA 9 · Supertrend (10, 3) · RSI 14 · ADX / DI 14 on 15-min and 1-hour candles ({bull ? `price above VWAP, EMA 5 and EMA 9 · Supertrend UP · RSI > ${rsiMin} · ADX > ${adxMin} · DI+ > DI−` : `price below VWAP, EMA 5 and EMA 9 · Supertrend DOWN · RSI < ${100 - rsiMin} · ADX > ${adxMin} · DI− > DI+`}
      {use15 && use60 ? ', on both 15-min and 1-hour' : use15 ? ', on 15-min' : ', on 1-hour'}).</p>
    {<div className="tbl-wrap panel trend-wrap">
        <table className="tbl trend-tbl">
          <thead>
            <tr className="grp"><th colSpan={6} />
              {use15 && <th colSpan={COLS.length} className="grp-h">15 Min</th>}
              {use60 && <th colSpan={COLS.length} className="grp-h">1 Hour</th>}</tr>
            <tr>
              <SortTh label="Symbol" k="symbol" {...sp} defaultDir="asc" />
              <SortTh label="Sector" k="sector" {...sp} defaultDir="asc" />
              <SortTh label="LTP" k="ltp" {...sp} num />
              <SortTh label="Chg %" k="pct_prev" {...sp} num />
              <SortTh label="Score" k="score" {...sp} num title={`Conditions met out of ${need}`} />
              <SortTh label="Time" k="since" {...sp} title="Time (IST) since when the stock has met every selected condition today (close of the first qualifying 15-min candle)" />
              {use15 && COLS.map(([k, l]) => k === 'rsi' ? <SortTh key={'a' + k} label={l} k="rsi15" {...sp} num /> : k === 'adx' ? <SortTh key={'a' + k} label={l} k="adx15" {...sp} num /> : <th key={'a' + k} className="num">{l}</th>)}
              {use60 && COLS.map(([k, l]) => k === 'rsi' ? <SortTh key={'b' + k} label={l} k="rsi60" {...sp} num /> : k === 'adx' ? <SortTh key={'b' + k} label={l} k="adx60" {...sp} num /> : <th key={'b' + k} className="num">{l}</th>)}
            </tr>
          </thead>
          <tbody>{shown.map(r => <tr key={r.symbol}>
            <td><StockLink symbol={r.symbol} company={r.company} className="strong" /></td>
            <td className="muted">{r.sector}</td>
            <td className="num">{fmtNum(r.ltp)}</td>
            <td className={'num ' + (r.pct_prev > 0 ? 'up' : r.pct_prev < 0 ? 'down' : '')}>{isNum(r.pct_prev) ? (r.pct_prev > 0 ? '+' : '') + r.pct_prev.toFixed(2) + '%' : '—'}</td>
            <td className={'num strong ' + (r.score === need ? (bull ? 'up' : 'down') : '')}>{r.score}/{need}</td>
            <td className="num">{r.score !== need ? '—' : r.since ? hhmmTo12(r.since) : 'just now'}</td>
            {use15 && <Cells t={r.tf15} c={r.c15} bull={bull} />}
            {use60 && <Cells t={r.tf60} c={r.c60} bull={bull} />}
          </tr>)}</tbody>
        </table>
        {!shown.length && <Empty>No stock meets every condition right now. Untick “Only stocks meeting all conditions” to see the closest ones (sort by Score).</Empty>}
      </div>}
    <p className="muted small">Green = condition met, red = not met, grey = the opposing DI line. Values use the latest candle, which is still forming during market hours, so they change through the day (Yahoo data can lag NSE by a minute or two). An indicator screen, not a buy/sell recommendation.</p>
  </>
}
