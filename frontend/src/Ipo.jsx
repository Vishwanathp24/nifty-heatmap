import React, { useMemo, useState } from 'react'
import { Drawer, Empty, Seg, SortTh, StockLink } from './components.jsx'
import { api, fmtNum, fmtVol, isNum, istTime, sortRows, usePoll, useSessionState } from './lib.js'

// GMP is unofficial (no exchange publishes it), so link out instead of showing a number.
// Per-IPO web search: works for every issue, mainboard and SME.
const gmpUrl = company => 'https://www.google.com/search?q=' + encodeURIComponent(`${(company || '').replace(/ Limited$/i, '')} IPO GMP today`)
// Calendar days from the listing date to today (IST).
const daysSince = iso => iso ? Math.floor((Date.now() - new Date(iso + 'T00:00:00+05:30').getTime()) / 86400000) : null
// SEBI T+3: shares list on the 3rd trading day after bidding closes.
// shortcut: skips weekends only, not exchange holidays; read NSE's listing notice when one falls in between.
const tPlus3 = iso => {
  if (!iso) return null
  const t = new Date(iso + 'T00:00:00Z')
  for (let n = 0; n < 3;) { t.setUTCDate(t.getUTCDate() + 1); if (t.getUTCDay() % 6) n++ }
  return t.toISOString().slice(0, 10)
}
const chg = v => isNum(v) ? <span className={v >= 0 ? 'up' : 'down'}>{v >= 0 ? '⇡' : '⇣'} {Math.abs(v).toFixed(2)}%</span> : '—'
// Fixed "30 Sep 2026" style (Intl's en-GB writes "Sept", unlike the other months).
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const d = (iso, withYear) => {
  if (!iso) return 'N/A'
  const [y, m, day] = iso.split('-')
  return `${day} ${MON[Number(m) - 1]}` + (withYear ? ` ${y}` : '')
}

// Click a company -> detail drawer: issue facts, live subscription by investor category, a
// fact-based checklist (👍 / 👎 per factor) and what to verify in the prospectus. No overall verdict.
const CAT_LABEL = { qib: 'QIB (institutions)', nii: 'NII (HNIs) — total', bnii: 'NII above ₹10 L', snii: 'NII ₹2–10 L', rii: 'Retail (RII)', emp: 'Employees' }
const ICON = { up: '👍', down: '👎', neutral: '➖' }
const cr = v => isNum(v) ? '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 0 }) + ' Cr' : '—'

function IpoDetail({ row, onClose, page }) {  // page: render the review inline (blog article) instead of in a drawer
  const series = row.board === 'NSE SME' ? 'SME' : 'EQ'
  const res = usePoll(() => api(`/api/ipo/detail?symbol=${encodeURIComponent(row.symbol)}&series=${series}`), 120000, [row.symbol])
  const d = res.data && res.data.symbol === row.symbol ? res.data : null
  const ups = d ? d.checks.filter(c => c.verdict === 'up').length : 0, downs = d ? d.checks.filter(c => c.verdict === 'down').length : 0
  const body = <>{!d ? <Empty>{res.error || 'Loading issue details from NSE…'}</Empty> : <div className="ipo-detail">
      {(() => { const rt = ipoRating(d, row); return <div className={'ipo-rate-banner ' + rt.key}>
        <b>{RATING_ICON[rt.key]} {rt.label}</b> <span>{rt.ups} 👍 · {rt.downs} 👎 — {rt.why}</span>
        <div className="small muted">Based only on exchange data (demand, issue structure, size, board, anchors) — not on valuation or financials, and not a buy / sell verdict.</div></div> })()}
      <div className="ipo-facts">
        <div><span>Symbol</span><b>{d.symbol}</b></div>
        <div><span>Board</span><b>{row.board}</b></div>
        <div><span>Issue period</span><b>{d.period || '—'}</b></div>
        <div><span>Price band</span><b>{d.price_lo && d.price_hi ? `₹${d.price_lo} – ₹${d.price_hi}` : d.price_range || '—'}</b></div>
        <div><span>Lot size</span><b>{d.lot ? d.lot + ' shares' : '—'}</b></div>
        <div><span>Min. investment</span><b>{isNum(d.min_investment) ? '₹' + d.min_investment.toLocaleString('en-IN') : '—'}</b></div>
        <div><span>Issue size</span><b>{cr(d.size_cr)}</b></div>
        <div><span>Fresh issue</span><b>{cr(d.fresh_cr)}</b></div>
        <div><span>Offer for sale</span><b>{cr(d.ofs_cr)}</b></div>
        <div><span>Face value</span><b>{d.face_value || '—'}</b></div>
        {d.employee_discount && <div><span>Employee discount</span><b>{d.employee_discount}</b></div>}
        <div className="wide"><span>Lead managers</span><b>{d.lead_managers || '—'}</b></div>
        <div className="wide"><span>Registrar (allotment status)</span><b>{d.registrar || '—'}</b></div>
      </div>

      <h4>Subscription so far {isNum(d.total_times) && <span className="ipo-total">{d.total_times}× overall</span>}</h4>
      <table className="tbl compact"><thead><tr><th>Category</th><th className="num">Shares offered</th><th className="num">Shares bid</th><th className="num">Times</th></tr></thead>
        <tbody>{Object.entries(d.subscription).map(([k, x]) => <tr key={k}><td>{CAT_LABEL[k] || x.label}</td><td className="num">{fmtVol(x.offered)}</td><td className="num">{fmtVol(x.bid)}</td>
          <td className={'num strong ' + (x.times >= 1 ? 'up' : 'down')}>{x.times}×</td></tr>)}</tbody></table>

      <h4>Checklist <span className="muted small">{ups} 👍 · {downs} 👎 — factors IPO investors commonly look at</span></h4>
      <div className="ipo-checks">{d.checks.map(c => <div key={c.key} className={'ipo-check ' + c.verdict}>
        <span className="ipo-ico">{ICON[c.verdict]}</span><div><b>{c.label}</b><div className="small">{c.detail}</div></div></div>)}</div>

      <h4>Check in the prospectus before applying</h4>
      <ul className="ipo-todo">
        <li><b>Business & objects of the issue</b> — what the company does and what the fresh money will be used for (debt repayment vs growth).</li>
        <li><b>Financials (3 years)</b> — revenue and profit trend, margins, debt-to-equity, cash flow from operations.</li>
        <li><b>Valuation</b> — P/E or EV/EBITDA at the upper band vs listed peers (the “Basis for Issue Price” section).</li>
        <li><b>Promoter holding after the issue</b> and who is selling in the offer for sale.</li>
        <li><b>Risk factors & litigation</b> — client concentration, pending cases, regulatory risk.</li>
        <li><b>Grey market premium (GMP)</b> is unofficial and can change fast — not a reliable guide.</li>
      </ul>
      <div className="ipo-links">
        {d.links.rhp && <a className="btn sm" href={d.links.rhp} target="_blank" rel="noopener noreferrer">Red Herring Prospectus ↗</a>}
        {d.links.ratios && <a className="btn sm" href={d.links.ratios} target="_blank" rel="noopener noreferrer">Basis of issue price / ratios ↗</a>}
        {d.links.anchor && <a className="btn sm" href={d.links.anchor} target="_blank" rel="noopener noreferrer">Anchor allocation ↗</a>}
        <a className="btn sm" href={gmpUrl(row.company)} target="_blank" rel="noopener noreferrer">GMP search ↗</a>
      </div>
      <div className="ipo-more">
        <b>Want to read more?</b>
        <div className="ipo-more-links">
          <a href={`https://www.nseindia.com/market-data/issue-information?symbol=${encodeURIComponent(d.symbol)}&series=${encodeURIComponent(series)}&type=Active`} target="_blank" rel="noopener noreferrer">📄 Full issue details on NSE ↗</a>
          {d.links.rhp && <a href={d.links.rhp} target="_blank" rel="noopener noreferrer">📘 Read the prospectus (RHP) — business, financials, risks ↗</a>}
          <a href={'https://www.google.com/search?q=' + encodeURIComponent(`${row.company.replace(/ Limited$/i, '')} IPO review`)} target="_blank" rel="noopener noreferrer">🔎 IPO reviews & analysis ↗</a>
          <a href={'https://news.google.com/search?q=' + encodeURIComponent(`${row.company.replace(/ Limited$/i, '')} IPO`)} target="_blank" rel="noopener noreferrer">📰 Latest news about this IPO ↗</a>
          <a href={'https://www.google.com/search?q=' + encodeURIComponent(`${row.company.replace(/ Limited$/i, '')} company business financials`)} target="_blank" rel="noopener noreferrer">🏢 About the company ↗</a>
        </div>
      </div>
      <div className="muted small">Data: NSE IPO feed · updated {istTime(d.fetched_at)} IST. The checklist rates individual factors from exchange data; it is not an overall recommendation — read the prospectus and decide for yourself. Not investment advice.</div>
    </div>}</>
  return page ? body : <Drawer open onClose={onClose} wide title={row.company}>{body}</Drawer>
}

// Traffic-light rating of how an IPO scores on the checklist (exchange data only — not a buy / sell
// verdict; valuation and financials are in the prospectus). Demand flags (QIB / overall
// subscription) count only from the last bidding day, since most QIB bids arrive then.
export function ipoRating(d, row) {
  if (!d) return null
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  const lastDay = !row?.close || row.close <= today
  const demand = new Set(['qib', 'total'])
  const ups = d.checks.filter(c => c.verdict === 'up'), downs = d.checks.filter(c => c.verdict === 'down')
  const hard = downs.filter(c => lastDay || !demand.has(c.key))  // demand flags wait for the last day
  if (!lastDay && downs.some(c => demand.has(c.key)) && hard.length <= 1)
    return { key: 'early', label: 'Early — demand still building', ups: ups.length, downs: downs.length, why: 'Bidding is still open; QIB money usually comes on the last day. Re-check on the closing day.' }
  if (hard.length >= 3 || (lastDay && (d.subscription?.qib?.times ?? 1) < 1 && (d.total_times ?? 1) < 1))
    return { key: 'weak', label: 'Weak on checklist', ups: ups.length, downs: downs.length, why: 'Several checks failed (' + hard.map(c => c.label).join(', ') + ').' }
  if (ups.length >= 4 && hard.length <= 1 && d.checks.find(c => c.key === 'qib')?.verdict !== 'down')
    return { key: 'strong', label: 'Strong on checklist', ups: ups.length, downs: downs.length, why: 'Most checks pass' + (hard.length ? ' (one flag: ' + hard[0].label + ')' : '') + '.' }
  return { key: 'mixed', label: 'Mixed', ups: ups.length, downs: downs.length, why: 'Some checks pass, some flag caution — read the details.' }
}
const RATING_ICON = { strong: '🟢', mixed: '🟡', weak: '🔴', early: '🔵' }


const d_ = d  // date formatter (inside IpoRow `d` is the detail data)

// One IPO row: rating dot before the name; the name opens the details panel (rating, checklist, subscription).
function IpoRow({ r, onDetails }) {
  const series = r.board === 'NSE SME' ? 'SME' : 'EQ'
  const res = usePoll(() => api(`/api/ipo/detail?symbol=${encodeURIComponent(r.symbol)}&series=${series}`), 300000, [r.symbol])
  const d = res.data && res.data.symbol === r.symbol ? res.data : null
  const rt = ipoRating(d, r)
  return <>
    <tr className={'ipo-row' + (rt ? ' rate-' + rt.key : '')}>
      <td><div className="ipo-name">
        <span className={'ipo-dot ' + (rt?.key || 'loading')} title={rt ? `${rt.label} — ${rt.why}` : 'Loading checklist…'} />
        <div><button className="link-btn strong" onClick={onDetails} title="Open company / issue details, subscription and checklist">{r.company}</button>
          <div className="muted small">{r.symbol}</div></div></div></td>
      <td className="muted">{r.board}</td>
      <td><span className={'ipo-status ' + (r.status === 'Open' ? 'open' : 'soon')}>{r.status}</span></td>
      <td>{d_(r.open)} – {d_(r.close)}</td>
      <td>{d_(r.close)}{/upto ([^)]+)\)/i.test(d?.upi_cutoff || '') && <div className="muted small">UPI by {d.upi_cutoff.match(/upto ([^)]+)\)/i)[1]}</div>}</td>
      <td>{r.close ? d_(tPlus3(r.close)) : 'N/A'}</td>
      <td className="num">{r.price_band || 'N/A'}</td>
      <td className="num">{d?.lot ? fmtNum(d.lot, 0) : r.lot_size ? fmtNum(r.lot_size, 0) : 'N/A'}</td>
      <td className="num">{fmtVol(r.issue_shares)}</td>
      <td className="num strong">{isNum(d?.total_times) ? d.total_times.toFixed(2) + 'x' : isNum(r.subscription) ? r.subscription.toFixed(2) + 'x' : '—'}</td>
      <td><a className="tv-link" href={gmpUrl(r.company)} target="_blank" rel="noopener noreferrer" title={`Search “${r.company} IPO GMP today” — GMP is unofficial`}>GMP<span className="ext">↗</span></a></td>
    </tr>
  </>
}

function Upcoming({ rows, board }) {
  const [sort, setSort] = useState({ key: 'open', dir: 'asc' })
  const [open, setOpen] = useState(null)       // detail drawer
  const shown = sortRows(rows.filter(r => board === 'all' || (board === 'sme') === (r.board === 'NSE SME')), sort.key, sort.dir)
  const sp = { sort, setSort }
  return <div className="tbl-wrap panel">
    <table className="tbl">
      <thead><tr>
        <SortTh label="Company" k="company" {...sp} defaultDir="asc" />
        <SortTh label="Board" k="board" {...sp} defaultDir="asc" />
        <SortTh label="Status" k="status" {...sp} defaultDir="asc" />
        <SortTh label="Subscription Period" k="open" {...sp} defaultDir="asc" />
        <SortTh label="Last Day to Apply" k="close" {...sp} defaultDir="asc" title="Bidding closes on this day; UPI mandates must be accepted by the cut-off time NSE lists for the issue." />
        <SortTh label="Listing Date" k="close" {...sp} defaultDir="asc" title="3rd trading day after bidding closes (SEBI T+3). Weekends skipped; an exchange holiday in between moves it a day later." />
        <th className="num">Price Band</th>
        <SortTh label="Lot Size" k="lot_size" {...sp} num />
        <SortTh label="Issue Size (shares)" k="issue_shares" {...sp} num />
        <SortTh label="Subscription" k="subscription" {...sp} num title="Times subscribed so far (NSE, all categories)" />
        <th title="Grey market premium is unofficial and unregulated; opens a web search for this IPO's GMP in a new tab">GMP</th>
      </tr></thead>
      <tbody>{shown.map(r => <IpoRow key={r.symbol} r={r} onDetails={() => setOpen(r)} />)}</tbody>
    </table>
    {!shown.length && <Empty>No upcoming or open IPOs on NSE{board !== 'all' ? ' for this board' : ''}.</Empty>}
    {open && <IpoDetail row={open} onClose={() => setOpen(null)} />}
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

// Blog: IPO updates & reviews, as compact cards (status, issue name, dates, price band, updated time).
// Written from the same NSE data as the tables; click a card for the full review.
const dd = iso => { if (!iso) return 'N/A'; const [y, m, day] = iso.split('-'); return `${day}-${MON[Number(m) - 1]}-${y}` }
const band = b => b ? b.replace(/₹\s*/g, 'Rs. ') + ' per Equity Share' : 'Price band not announced yet'
const upd = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : ''
// Top 4 YouTube results for the IPO, embedded at the end of a post. No autoplay; privacy-enhanced player.
function IpoVideo({ company }) {
  const q = (company || '').replace(/ Limited$/i, '') + ' IPO review'
  const res = usePoll(() => api('/api/ipo/video?q=' + encodeURIComponent(q)), 3.6e6, [q])
  const search = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q)
  return <section className="blog-video">
    <h3>Videos</h3>
    {res.data?.ids?.length ? <div className="blog-videos">{res.data.ids.map(id => <iframe key={id} src={`https://www.youtube-nocookie.com/embed/${id}`} title={`YouTube: ${q}`} loading="lazy"
      allow="encrypted-media; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />)}</div>
      : <p className="muted">{res.data || res.error ? 'No videos found.' : 'Finding videos…'}</p>}
    <p className="muted small">Top YouTube results for “{q}”, picked automatically; views in videos are the creators’, not a recommendation. <a href={search} target="_blank" rel="noopener noreferrer">More on YouTube</a></p>
  </section>
}
const listedLine = r => `Listed ${dd(r.listing_date)} · Issue Rs. ${fmtNum(r.issue_price)}` + (isNum(r.listing_gain) ? ` · listing ${r.listing_gain >= 0 ? '+' : '−'}${Math.abs(r.listing_gain).toFixed(2)}%` : '') + (isNum(r.pct_vs_issue) ? ` · now ${r.pct_vs_issue >= 0 ? '+' : '−'}${Math.abs(r.pct_vs_issue).toFixed(2)}% vs issue` : '')
const pill = p => p.r.listing_date ? ['listed', 'Listed'] : p.r.status === 'Open' ? ['open', 'Open'] : ['soon', 'Upcoming']
function Blog({ data, board }) {
  const [sel, setSel] = useState(null)  // key of the open post
  const onBoard = r => board === 'all' || (board === 'sme') === (r.board === 'NSE SME')
  const when = 'Updated ' + upd(data.fetched_at)
  const posts = [...data.upcoming.filter(onBoard).map(r => ({ key: 'u' + r.symbol, r })),
    ...[...data.recent].filter(onBoard).sort((a, b) => b.listing_date.localeCompare(a.listing_date)).slice(0, 12).map(r => ({ key: 'l' + r.symbol + r.listing_date, r }))]
  const open = k => { setSel(k); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  const post = posts.find(p => p.key === sel)
  if (post) {
    const r = post.r, [cls, label] = pill(post)
    return <div className="blog-page">
      <article className="blog-article">
        <button className="btn sm" onClick={() => setSel(null)}>All posts</button>
        <span className={'blog-pill ' + cls}>{label}</span>
        <h2>{r.company} IPO</h2>
        <p className="muted">{r.listing_date ? listedLine(r) : `${dd(r.open)} to ${dd(r.close)} · ${band(r.price_band)}`}<br />{when}</p>
        {r.listing_date && isNum(r.ltp) && <p>{r.company} listed on {dd(r.listing_date)} at Rs. {fmtNum(r.listing_price)} against an issue price of Rs. {fmtNum(r.issue_price)}. It now trades at Rs. {fmtNum(r.ltp)}. <StockLink symbol={r.symbol} company={r.company}>Chart</StockLink></p>}
        <IpoDetail row={r} page />
        <IpoVideo company={r.company} />
      </article>
      <aside className="blog-side">
        <h3>Latest posts</h3>
        {posts.filter(p => p.key !== sel).slice(0, 6).map(p => { const [c, l] = pill(p); return <button key={p.key} className="blog-side-item" onClick={() => open(p.key)}>
          <span className={'blog-pill ' + c}>{l}</span><b>{p.r.company} IPO</b></button> })}
      </aside>
    </div>
  }
  return <>
    <div className="blog">
      {posts.map(p => { const r = p.r, [cls, label] = pill(p); return <button key={p.key} className="blog-card" onClick={() => open(p.key)} title="Read the full post">
        <span className={'blog-pill ' + cls}>{label}</span>
        <b>{r.company} IPO</b>
        <span className="muted">{r.listing_date ? listedLine(r) : `${dd(r.open)} to ${dd(r.close)} · ${band(r.price_band)}`}</span>
        <span className="muted">{when}</span>
      </button> })}
    </div>
    {!posts.length && <Empty>No IPO news for this board yet.</Empty>}
  </>
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
      {[['upcoming', 'Upcoming IPOs'], ['recent', 'Recent IPOs'], ['blog', 'IPO updates & reviews']].map(([v, label, sub]) =>
        <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
          {label}{sub && <small> {sub}</small>}{counts[v] != null && <span className="count">{counts[v]}</span>}</button>)}
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
      : view === 'upcoming' ? <Upcoming rows={data.upcoming} board={board} /> : view === 'blog' ? <Blog data={data} board={board} /> : <Recent rows={data.recent} board={board} below={below} search={search} />}
    <p className="muted small">BSE-only SME issues are not included (NSE data only). Subscription is NSE's live “times subscribed” across all categories. Listing price = opening price on the listing day (NSE bhavcopy). GMP links open a web search for “[company] IPO GMP today” (GMP is unofficial; no exchange publishes it). % vs Issue Price uses NSE's official close after market hours and the live price during the session. The checklist rates individual factors from NSE data — it is not a buy / sell verdict. Not investment advice.</p>
  </div>
}
