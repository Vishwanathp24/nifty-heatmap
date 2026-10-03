import React, { useMemo, useState } from 'react'
import { Empty, Seg, SortTh, StockLink } from './components.jsx'
import { fmtNum, fmtVol, isNum, istTime, sortRows, useSessionState } from './lib.js'

// GMP is unofficial (no exchange publishes it), so link out instead of showing a number.
// Per-IPO web search: works for every issue, mainboard and SME.
const gmpUrl = company => 'https://www.google.com/search?q=' + encodeURIComponent(`${(company || '').replace(/ Limited$/i, '')} IPO GMP today`)
// Calendar days from the listing date to today (IST).
const daysSince = iso => iso ? Math.floor((Date.now() - new Date(iso + 'T00:00:00+05:30').getTime()) / 86400000) : null
const chg = v => isNum(v) ? <span className={v >= 0 ? 'up' : 'down'}>{v >= 0 ? '⇡' : '⇣'} {Math.abs(v).toFixed(2)}%</span> : '—'
// Fixed "30 Sep 2026" style (Intl's en-GB writes "Sept", unlike the other months).
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const d = (iso, withYear) => {
  if (!iso) return 'N/A'
  const [y, m, day] = iso.split('-')
  return `${day} ${MON[Number(m) - 1]}` + (withYear ? ` ${y}` : '')
}

function Upcoming({ rows, board }) {
  const [sort, setSort] = useState({ key: 'open', dir: 'asc' })
  const shown = sortRows(rows.filter(r => board === 'all' || (board === 'sme') === (r.board === 'NSE SME')), sort.key, sort.dir)
  const sp = { sort, setSort }
  return <div className="tbl-wrap panel">
    <table className="tbl">
      <thead><tr>
        <SortTh label="Company" k="company" {...sp} defaultDir="asc" />
        <SortTh label="Board" k="board" {...sp} defaultDir="asc" />
        <SortTh label="Status" k="status" {...sp} defaultDir="asc" />
        <SortTh label="Subscription Period" k="open" {...sp} defaultDir="asc" />
        <th className="num">Price Band</th>
        <SortTh label="Lot Size" k="lot_size" {...sp} num />
        <SortTh label="Issue Size (shares)" k="issue_shares" {...sp} num />
        <SortTh label="Subscription" k="subscription" {...sp} num title="Times subscribed so far (NSE, all categories)" />
        <th title="Grey market premium is unofficial and unregulated; opens a web search for this IPO's GMP in a new tab">GMP</th>
      </tr></thead>
      <tbody>{shown.map(r => <tr key={r.symbol}>
        <td><div className="strong">{r.company}</div><div className="muted small">{r.symbol}</div></td>
        <td className="muted">{r.board}</td>
        <td><span className={'ipo-status ' + (r.status === 'Open' ? 'open' : 'soon')}>{r.status}</span></td>
        <td>{d(r.open)} – {d(r.close)}</td>
        <td className="num">{r.price_band || 'N/A'}</td>
        <td className="num">{r.lot_size ? fmtNum(r.lot_size, 0) : 'N/A'}</td>
        <td className="num">{fmtVol(r.issue_shares)}</td>
        <td className="num strong">{isNum(r.subscription) ? r.subscription.toFixed(2) + 'x' : '—'}</td>
        <td><a className="tv-link" href={gmpUrl(r.company)} target="_blank" rel="noopener noreferrer" title={`Search “${r.company} IPO GMP today” — GMP is unofficial`}>GMP<span className="ext">↗</span></a></td>
      </tr>)}</tbody>
    </table>
    {!shown.length && <Empty>No upcoming or open IPOs on NSE{board !== 'all' ? ' for this board' : ''}.</Empty>}
  </div>
}

function Recent({ rows, board, below, search }) {
  const [sort, setSort] = useState({ key: 'listing_date', dir: 'desc' })
  const q = search.trim().toUpperCase()
  const shown = sortRows(rows.map(r => ({ ...r, days: daysSince(r.listing_date) })).filter(r =>
    (board === 'all' || (board === 'sme') === (r.board === 'NSE SME')) &&
    (!below || (isNum(r.pct_vs_issue) && r.pct_vs_issue < 0)) &&
    (!q || r.symbol.includes(q) || (r.company || '').toUpperCase().includes(q))), sort.key, sort.dir)
  const sp = { sort, setSort }
  return <div className="tbl-wrap panel">
    <table className="tbl">
      <thead><tr>
        <SortTh label="Company" k="company" {...sp} defaultDir="asc" />
        <SortTh label="Board" k="board" {...sp} defaultDir="asc" />
        <SortTh label="Listing Date" k="listing_date" {...sp} />
        <SortTh label="Issue Price" k="issue_price" {...sp} num />
        <SortTh label="Listing Price" k="listing_price" {...sp} num title="Opening price on the listing day (NSE bhavcopy)" />
        <SortTh label="Listing Gain" k="listing_gain" {...sp} num title="Listing price vs issue price" />
        <SortTh label="Current Price" k="ltp" {...sp} num />
        <SortTh label="% Since Listing" k="pct_since_listing" {...sp} num title="Current price vs listing price" />
        <SortTh label="% vs Issue Price" k="pct_vs_issue" {...sp} num />
        <SortTh label="Since Listing" k="days" {...sp} num defaultDir="asc" title="Calendar days since the listing date" />
      </tr></thead>
      <tbody>{shown.map(r => <tr key={r.symbol + r.listing_date}>
        <td><StockLink symbol={r.symbol} company={r.company} className="strong" /><div className="muted small ellipsis">{r.company}</div></td>
        <td className="muted">{r.board}</td>
        <td>{d(r.listing_date, true)}</td>
        <td className="num">{isNum(r.issue_price) ? '₹' + fmtNum(r.issue_price) : 'N/A'}</td>
        <td className="num">{isNum(r.listing_price) ? '₹' + fmtNum(r.listing_price) : <span className="muted">—</span>}</td>
        <td className="num">{chg(r.listing_gain)}</td>
        <td className="num">{isNum(r.ltp) ? '₹' + fmtNum(r.ltp) : <span className="muted">loading…</span>}</td>
        <td className="num strong">{chg(r.pct_since_listing)}</td>
        <td className="num strong">{chg(r.pct_vs_issue)}</td>
        <td className="num">{r.days == null ? 'N/A' : `${r.days} ${r.days === 1 ? 'day' : 'days'}`}</td>
      </tr>)}</tbody>
    </table>
    {!shown.length && <Empty>No recent IPOs match.</Empty>}
  </div>
}

export default function Ipo({ ipo }) {
  const [view, setView] = useSessionState('ipo.view', 'upcoming')
  const [board, setBoard] = useSessionState('ipo.board', 'all')
  const [below, setBelow] = useState(false)
  const [search, setSearch] = useState('')
  const data = ipo.data
  const counts = useMemo(() => ({ upcoming: data?.upcoming?.length, recent: data?.recent?.length }), [data])

  return <div className="ipo-page">
    <div className="page-title"><h1>IPOs</h1>
      <span className="muted small">NSE mainboard and NSE SME issues · source: NSE public issue data{data?.fetched_at ? ` · updated ${istTime(data.fetched_at)}` : ''}</span></div>
    <div className="orb-switch" role="tablist" aria-label="IPO list">
      {[['upcoming', 'Upcoming IPOs', 'open & forthcoming'], ['recent', 'Recent IPOs', `listed in last ${data?.recent_days || 120} days`]].map(([v, label, sub]) =>
        <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
          {label} <small>{sub}</small>{counts[v] != null && <span className="count">{counts[v]}</span>}</button>)}
    </div>
    <div className="toolbar">
      <Seg value={board} onChange={setBoard} options={[{ value: 'all', label: 'All' }, { value: 'main', label: 'Mainboard' }, { value: 'sme', label: 'NSE SME' }]} />
      {view === 'recent' && <>
        <input className="search" placeholder="Search company / symbol" value={search} onChange={e => setSearch(e.target.value)} />
        <label className="check-label"><input type="checkbox" checked={below} onChange={e => setBelow(e.target.checked)} />Below IPO price</label>
        {data && data.prices_loaded < data.recent.length && <span className="muted small">loading current prices {data.prices_loaded}/{data.recent.length}…</span>}
      </>}
    </div>
    {!data ? <Empty>{ipo.error || 'Loading IPO data from NSE…'}</Empty>
      : view === 'upcoming' ? <Upcoming rows={data.upcoming} board={board} /> : <Recent rows={data.recent} board={board} below={below} search={search} />}
    <p className="muted small">BSE-only SME issues are not included (NSE data only). Subscription is NSE's live “times subscribed” across all categories. Listing price = opening price on the listing day (NSE bhavcopy). GMP links open a web search for “[company] IPO GMP today” (GMP is unofficial; no exchange publishes it). % vs Issue Price uses NSE's official close after market hours and the live price during the session. Not investment advice.</p>
  </div>
}
