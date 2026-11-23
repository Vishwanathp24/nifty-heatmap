import React, { useEffect, useState } from 'react'
import { Empty, Section, Seg } from './components.jsx'
import { api, fmtNum, fmtPct, isNum, tone, usePoll, useSessionState } from './lib.js'

// FII / DII page: NSE participant-wise open interest in F&O (FII, DII, Pro, Client) after each session,
// with the change from the session before, plus the cash-market FII / DII net (provisional).
const PARTIES = ['FII', 'DII', 'Pro', 'Client']
const SEGS = [['idx_fut', 'Index Futures', 'fut_long_pct'], ['idx_opt', 'Index Options', 'opt_bull_pct'], ['stk_fut', 'Stock Futures', null]]

// 1,23,456 -> 1.23L ; contracts, signed
const fmtL = v => !isNum(v) ? 'N/A' : (v > 0 ? '+' : v < 0 ? '−' : '') +
  (Math.abs(v) >= 1e5 ? (Math.abs(v) / 1e5).toFixed(2) + 'L' : Math.abs(v).toLocaleString('en-IN'))
const Num = ({ v, strong }) => <span className={'num ' + tone(v) + (strong ? ' strong' : '')}>{fmtL(v)}</span>
const shortDate = iso => new Date(iso + 'T00:00:00+05:30').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
const longDate = iso => new Date(iso + 'T00:00:00+05:30').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
const niftyPct = d => isNum(d.nifty) && isNum(d.nifty_prev) ? (d.nifty / d.nifty_prev - 1) * 100 : null

// Lean from the share of positions on the bullish side (futures: longs; options: long calls + short puts).
function lean(pct) {
  if (!isNum(pct)) return null
  if (pct >= 60) return ['Bullish', 'up']
  if (pct >= 52) return ['Mild Bullish', 'up']
  if (pct > 48) return ['Neutral', 'flat']
  if (pct > 40) return ['Mild Bearish', 'down']
  return ['Bearish', 'down']
}
const Lean = ({ pct }) => { const l = lean(pct); return l ? <span className={'fd-lean ' + l[1]} title={`${pct}% of positions on the bullish side`}>{l[0]} <small>{pct}%</small></span> : <span className="muted">—</span> }

function Summary({ day }) {
  return <div className="panel tbl-wrap"><table className="tbl fd-sum">
    <thead><tr><th>Participant</th><th>Segment</th><th>Lean</th><th className="num">Net OI</th><th className="num">Change</th></tr></thead>
    <tbody>{PARTIES.map(who => SEGS.map(([k, label, pk], i) => {
      const p = day.p[who]
      return <tr key={who + k} className={i === 0 ? 'fd-first' : ''}>
        {i === 0 && <td rowSpan={SEGS.length} className="strong">{who}</td>}
        <td>{label}</td><td>{pk ? <Lean pct={p[pk]} /> : <span className="muted">—</span>}</td>
        <td className="num"><Num v={p[k]} strong /></td><td className="num"><Num v={p.chg[k]} /></td>
      </tr>
    }))}</tbody>
  </table></div>
}

// Daily change bars for one series (newest on the right) with the Nifty close as a line.
const METRICS = [['idx_fut', 'Index Futures'], ['call', 'Index Calls'], ['put', 'Index Puts'], ['idx_opt', 'Options (net)']]
function Chart({ days, who, metric, mode }) {
  const rows = [...days].reverse()
  const val = d => mode === 'chg' ? d.p[who].chg[metric] : d.p[who][metric]
  const vals = rows.map(val), max = Math.max(1, ...vals.map(Math.abs))
  const closes = rows.map(d => d.nifty).filter(isNum), lo = Math.min(...closes), hi = Math.max(...closes)
  const W = 720, H = 220, pad = 8, bw = (W - pad * 2) / rows.length, mid = H / 2
  const ny = c => H - 14 - ((c - lo) / ((hi - lo) || 1)) * (H - 28)
  const line = rows.map((d, i) => isNum(d.nifty) ? `${pad + bw * i + bw / 2},${ny(d.nifty)}` : null).filter(Boolean).join(' ')
  return <div className="fd-chart">
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Daily bars with Nifty line">
      <line x1="0" x2={W} y1={mid} y2={mid} className="fd-axis" />
      {rows.map((d, i) => { const v = vals[i], h = Math.abs(v) / max * (mid - 6)
        return <rect key={d.date} x={pad + bw * i + bw * 0.18} width={bw * 0.64} y={v >= 0 ? mid - h : mid} height={Math.max(h, 0.5)}
          className={v >= 0 ? 'fd-bar up' : 'fd-bar down'}><title>{`${shortDate(d.date)}: ${fmtL(v)} · Nifty ${fmtNum(d.nifty)}`}</title></rect> })}
      {line && <polyline points={line} className="fd-nifty" fill="none" />}
    </svg>
    <div className="fd-xlab"><span>{shortDate(rows[0].date)}</span><span><i className="fd-key bar" /> {mode === 'chg' ? 'daily change' : 'net OI'} <i className="fd-key line" /> Nifty</span><span>{shortDate(rows[rows.length - 1].date)}</span></div>
  </div>
}

function History({ days, who }) {
  return <div className="panel tbl-wrap"><table className="tbl fd-hist">
    <thead><tr><th>Date</th><th className="num">Nifty</th>
      <th className="num">Index Fut</th><th className="num">Chg</th>
      <th className="num">Calls</th><th className="num">Chg</th>
      <th className="num">Puts</th><th className="num">Chg</th>
      <th className="num">Options net</th><th className="num">Chg</th>
      <th className="num">Stock Fut</th></tr></thead>
    <tbody>{days.map(d => { const p = d.p[who]
      return <tr key={d.date}><td className="nowrap">{shortDate(d.date)}</td>
        <td className="num nowrap">{fmtNum(d.nifty)} <span className={tone(niftyPct(d))}>{fmtPct(niftyPct(d))}</span></td>
        <td className="num"><Num v={p.idx_fut} strong /></td><td className="num"><Num v={p.chg.idx_fut} /></td>
        <td className="num"><Num v={p.call} /></td><td className="num"><Num v={p.chg.call} /></td>
        <td className="num"><Num v={p.put} /></td><td className="num"><Num v={p.chg.put} /></td>
        <td className="num"><Num v={p.idx_opt} strong /></td><td className="num"><Num v={p.chg.idx_opt} /></td>
        <td className="num"><Num v={p.stk_fut} /></td></tr> })}</tbody>
  </table></div>
}

function Cash({ cash }) {
  if (!cash?.length) return <Empty>Cash-market figures are not available yet.</Empty>
  const cr = v => isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + fmtNum(Math.abs(v)) : 'N/A'
  return <div className="panel tbl-wrap"><table className="tbl">
    <thead><tr><th>Date</th><th className="num">FII Buy</th><th className="num">FII Sell</th><th className="num">FII Net</th>
      <th className="num">DII Buy</th><th className="num">DII Sell</th><th className="num">DII Net</th></tr></thead>
    <tbody>{cash.map(r => <tr key={r.date}><td className="nowrap">{shortDate(r.date)}</td>
      <td className="num">{fmtNum(r.fii_buy)}</td><td className="num">{fmtNum(r.fii_sell)}</td><td className={'num strong ' + tone(r.fii)}>{cr(r.fii)}</td>
      <td className="num">{fmtNum(r.dii_buy)}</td><td className="num">{fmtNum(r.dii_sell)}</td><td className={'num strong ' + tone(r.dii)}>{cr(r.dii)}</td></tr>)}</tbody>
  </table></div>
}

// Positioning read: what the latest FII F&O changes say (from the backend), described, not forecast.
function Read({ r }) {
  if (!r) return null
  const emoji = r.key === 'bull' ? '🟢' : r.key === 'bear' ? '🔴' : '🟡'
  return <div className={'fd-read ' + r.key}>
    <div className="fd-read-top"><span className={'ol-pill ' + r.key}><span className="ol-dot">{emoji}</span>{r.label}</span>
      <span className="muted small">FII positioning after {longDate(r.date)}</span></div>
    <ul>{r.points.map(x => <li key={x}>{x}</li>)}</ul>
    <p className="muted small">Describes where FIIs added positions, not a forecast: FIIs often hold shorts as a hedge, and the market can move the other way. It is one of the signals in Market Outlook on Market Overview. Not a buy / sell recommendation.</p>
  </div>
}

export default function FiiDii() {
  const [loaded, setLoaded] = useState(false)
  const res = usePoll(() => api('/api/fii-dii'), loaded ? 300000 : 4000, [loaded])  // quick polls only until the first load
  useEffect(() => { if (res.data && !res.data.loading) setLoaded(true) }, [res.data])
  const [tab, setTab] = useSessionState('fd.tab', 'summary')
  const [who, setWho] = useSessionState('fd.who', 'FII')
  const [metric, setMetric] = useSessionState('fd.metric', 'idx_fut')
  const [mode, setMode] = useState('chg')
  const data = res.data
  const days = data?.days || []
  const day = days[0]
  const head = day && <div className="fd-head">
    <span>Data for <b>{longDate(day.date)}</b> (NSE publishes it after the close)</span>
    <span>Nifty <b>{fmtNum(day.nifty)}</b> <span className={tone(niftyPct(day))}>{fmtPct(niftyPct(day))}</span></span>
  </div>

  return <div className="fiidii">
    <div className="page-title"><h1>FII / DII Data</h1>
      <span className="muted small">Who holds what in index futures and options · source: NSE participant-wise open interest (contracts)</span></div>
    <div className="orb-switch" role="tablist" aria-label="FII / DII view">
      {[['summary', 'Summary'], ['fno', 'F&O History'], ['cash', 'Cash Market']].map(([v, label]) =>
        <button key={v} role="tab" aria-selected={tab === v} className={tab === v ? 'on' : ''} onClick={() => setTab(v)}>{label}</button>)}
    </div>
    <Section title={tab === 'summary' ? 'Participant positions' : tab === 'fno' ? 'Daily F&O positions' : 'Cash market (₹ Cr)'}
      subtitle={tab === 'cash' ? 'NSE provisional figures; one row is saved each day from when this page went live' : 'Net = long minus short contracts; Change = vs the session before'}>
      {res.error && !data && <div className="alert">{res.error}</div>}
      {!data || data.loading ? <Empty>Loading NSE participant data…</Empty> : !day ? <Empty>No data yet.</Empty> : <>
        {tab !== 'cash' && head}
        {tab === 'summary' && <Read r={data.read} />}
        {tab === 'summary' && <Summary day={day} />}
        {tab === 'fno' && <>
          <div className="fd-ctrls">
            <Seg value={who} onChange={setWho} options={PARTIES.map(p => ({ value: p, label: p }))} />
            <Seg value={metric} onChange={setMetric} options={METRICS.map(([value, label]) => ({ value, label }))} />
            <Seg value={mode} onChange={setMode} options={[{ value: 'chg', label: 'Daily change' }, { value: 'net', label: 'Net OI' }]} />
          </div>
          <Chart days={days} who={who} metric={metric} mode={mode} />
          <History days={days} who={who} />
        </>}
        {tab === 'cash' && <Cash cash={data.cash} />}
      </>}
    </Section>
  </div>
}
