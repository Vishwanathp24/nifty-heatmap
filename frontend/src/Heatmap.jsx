import React, { useEffect, useMemo, useState } from 'react'
import { BreadthBar, ChartIcon, Drawer, Empty, IndexLink, Pct, Seg, SortTh, StockLink } from './components.jsx'
import { api, fmtNum, fmtPct, fmtRatio, fmtSigned, fmtVol, heatClass, isNum, istTime, sortRows, tone, useSessionState } from './lib.js'

const pctOf = (s, basis) => s.quote?.[basis === 'open' ? 'pct_open' : 'pct_prev']

// Live constituents straight from NSE for this index (refreshed every 10 s while open).
function useSectorStocks(symbol) {
  const [state, setState] = useState({ data: null, error: null, at: null })
  useEffect(() => {
    let alive = true
    setState({ data: null, error: null, at: null })
    const load = () => api('/api/sector?symbol=' + encodeURIComponent(symbol))
      .then(d => alive && setState({ data: d, error: null, at: new Date() }))
      .catch(e => alive && setState(s => ({ ...s, error: e.message })))
    load()
    const t = setInterval(load, 10000)
    return () => { alive = false; clearInterval(t) }
  }, [symbol])
  return state
}

function SectorPanel({ sector, basis, selected, toggle }) {
  const live = useSectorStocks(sector.symbol)
  const members = live.data?.stocks || []
  const key = basis === 'open' ? 'pct_open' : 'pct_prev'
  const byChg = members.filter(s => isNum(s[key])).sort((a, b) => b[key] - a[key])
  const haveRatio = members.some(s => isNum(s.vol_ratio))
  const byVol = [...members].sort((a, b) => haveRatio ? (b.vol_ratio ?? -1) - (a.vol_ratio ?? -1) : (b.volume ?? 0) - (a.volume ?? 0))
  const b = live.data?.breadth || { up: 0, down: 0, unchanged: 0, total: 0 }
  const breadthPct = b.total ? Math.round(b.up / b.total * 100) : null
  const q = sector.quote
  const isSel = selected.includes(sector.symbol)
  const [sort, setSort] = useSessionState('hm.panelSort', { key: key, dir: 'desc' })
  const all = sortRows(members, sort.key, sort.dir)
  const sp = { sort, setSort }
  const list = (rows, title) => <div className="mini-list">
    <h4>{title}</h4>
    {rows.length ? rows.map(s => <div className="mini-row" key={s.symbol}>
      <StockLink symbol={s.symbol} company={s.company} className="strong" /><span />
      <Pct v={s[key]} />
    </div>) : <div className="muted small">N/A</div>}
  </div>
  return <div className="sector-panel">
    <div className="sp-top">
      <div>
        <div className="k">Sector Index</div>
        <div className="sp-name"><IndexLink name={sector.symbol} /></div>
        <div className="sp-val">{fmtNum(q?.ltp)} <Pct v={q?.pct_open} /> <span className="muted small">vs open</span> · <Pct v={q?.pct_prev} /> <span className="muted small">vs prev close</span></div>
      </div>
      <button className={'btn sm ' + (isSel ? 'primary' : '')} onClick={() => toggle(sector.symbol)}>{isSel ? '✓ Selected for scanner' : 'Select for scanner'}</button>
    </div>
    <div className="breadth-stats">
      <div><div className="k">Advancing</div><div className="big up">{b.up}</div></div>
      <div><div className="k">Declining</div><div className="big down">{b.down}</div></div>
      <div><div className="k">Unchanged</div><div className="big flat">{b.unchanged}</div></div>
      <div><div className="k">Sector Breadth</div><div className="big">{isNum(breadthPct) ? breadthPct + '%' : 'N/A'}</div></div>
    </div>
    <BreadthBar up={b.up} down={b.down} unchanged={b.unchanged} />
    <p className="muted small">Constituent advance/decline vs today's open ({b.total} stocks with live quotes). A strong index move with weak breadth means a few heavyweights are carrying it.</p>
    {live.error && <div className="alert">{live.error}{live.data ? ' — showing last data' : ''}</div>}
    {!live.data && !live.error && <div className="muted small">Loading constituents from NSE…</div>}
    <h4>All stocks in {sector.label} <span className="muted small">{members.length} · live from NSE{live.at ? ' · ' + istTime(live.at) : ''} · click a symbol to open TradingView</span></h4>
    <div className="tbl-wrap sp-table"><table className="tbl compact">
      <thead><tr>
        <SortTh label="Symbol" k="symbol" {...sp} defaultDir="asc" />
        <SortTh label="LTP" k="ltp" {...sp} num />
        <SortTh label="Chg %" k="pct_prev" {...sp} num title="Change vs previous close" />
        <SortTh label="Open" k="open" {...sp} num title="Today's open price" />
        <SortTh label="Volume" k="volume" {...sp} num />
      </tr></thead>
      <tbody>{all.map(s => <tr key={s.symbol}>
        <td><StockLink symbol={s.symbol} company={s.company} className="strong" /></td>
        <td className="num">{fmtNum(s.ltp)}</td><td className="num"><Pct v={s.pct_prev} /></td>
        <td className="num">{fmtNum(s.open)}</td><td className="num">{fmtVol(s.volume)}</td></tr>)}</tbody>
    </table></div>
    <div className="sp-lists">
      {list(byChg.slice(0, 3), 'Top 3 Gainers')}
      {list(byChg.slice(-3).reverse(), 'Top 3 Losers')}
      <div className="mini-list">
        <h4 title={haveRatio ? members.find(s => isNum(s.vol_ratio))?.vol_basis : 'raw volume (no volume baseline yet)'}>Highest Volume</h4>
        {byVol.slice(0, 3).map(s => <div className="mini-row" key={s.symbol}>
          <StockLink symbol={s.symbol} company={s.company} className="strong" /><span className="muted small">{fmtVol(s.volume)}</span><span className="num">{fmtRatio(s.vol_ratio)}</span>
        </div>)}
      </div>
    </div>
  </div>
}

// Top 20 F&O gainers / losers by % change vs previous close (same basis as NSE's
// "Top Gainers / Losers" page), from the F&O quotes polled every 10 s.
function FoMovers({ stocks, selected, labels }) {
  // Follows the heatmap selection: with sectors ticked, only their F&O stocks are ranked.
  const fo = stocks.filter(s => s.fo && isNum(s.pct_prev) && (!selected.length || s.sectors.some(x => selected.includes(x))))
    .sort((a, b) => b.pct_prev - a.pct_prev)
  const n = Math.min(20, Math.floor(fo.length / 2) || fo.length)
  const scope = selected.length ? selected.map(x => labels[x] || x).join(', ') : 'All sectors'
  const table = (title, rows, cls) => <div className="panel">
    <div className="panel-head"><h3 className={cls}>{title}</h3><span className="muted small">F&O · {scope} · vs prev close</span></div>
    <div className="tbl-wrap"><table className="tbl compact">
      <thead><tr><th className="num">#</th><th>Symbol</th><th>Sector</th><th className="num">LTP</th><th className="num hide-m">Chg</th><th className="num">Chg %</th><th className="num hide-m">Volume</th></tr></thead>
      <tbody>{rows.map((s, i) => <tr key={s.symbol}>
        <td className="num muted">{i + 1}</td>
        <td><StockLink symbol={s.symbol} company={s.company} className="strong" /></td>
        <td className="muted" title={s.sectors.map(x => labels[x] || x).join(', ')}>{s.sector}</td>
        <td className="num">{fmtNum(s.ltp)}</td>
        <td className={'num hide-m ' + tone(s.change)}>{fmtSigned(s.change)}</td>
        <td className="num strong"><Pct v={s.pct_prev} /></td>
        <td className="num hide-m">{fmtVol(s.volume)}</td>
      </tr>)}</tbody>
    </table></div>
    {!rows.length && <Empty>No F&O stocks in the selected sectors.</Empty>}
  </div>
  // With few stocks selected, split them so no stock appears in both lists.
  return <div className="fo-movers">
    {table(`Top ${n} Gainers`, fo.slice(0, n), 'up')}
    {table(`Top ${n} Losers`, fo.slice(-n).reverse(), 'down')}
  </div>
}

export default function Heatmap({ live, selected, setSelected, toggle, goto }) {
  const [search, setSearch] = useState('')
  const [view, setView] = useSessionState('hm.view', 'all')
  const [sort, setSort] = useSessionState('hm.sort', 'desc')
  const [basis, setBasis] = useSessionState('hm.basis', 'open')
  const [detail, setDetail] = useState(null)

  const sectors = live?.sectors || []
  const shown = useMemo(() => {
    let rows = sectors.filter(s => s.label.toLowerCase().includes(search.toLowerCase()) || s.symbol.toLowerCase().includes(search.toLowerCase()))
    if (view === 'pos') rows = rows.filter(s => pctOf(s, basis) > 0)
    if (view === 'neg') rows = rows.filter(s => pctOf(s, basis) < 0)
    const byPct = (a, b) => (pctOf(b, basis) ?? -1e9) - (pctOf(a, basis) ?? -1e9)
    if (view === 'gain') rows = [...rows].sort(byPct).slice(0, 5)
    if (view === 'lose') rows = [...rows].sort(byPct).reverse().filter(s => isNum(pctOf(s, basis))).slice(0, 5)
    if (sort === 'alpha') return [...rows].sort((a, b) => a.label.localeCompare(b.label))
    rows = [...rows].sort(byPct)
    return sort === 'asc' ? rows.reverse() : rows
  }, [sectors, search, view, sort, basis])

  if (!live) return <Empty>Loading sectors…</Empty>
  const pos = sectors.filter(s => pctOf(s, basis) > 0).map(s => s.symbol)
  const neg = sectors.filter(s => pctOf(s, basis) < 0).map(s => s.symbol)
  const detailSector = detail && sectors.find(s => s.symbol === detail)

  return <>
    <div className="page-title"><h1>Sector Heatmap</h1>
      <span className="muted small">Click a card to see its stocks · ☐ selects it for the ORB Scanner · ↗ opens the TradingView chart</span></div>
    <div className="toolbar">
      <input className="search" placeholder="Search sector" value={search} onChange={e => setSearch(e.target.value)} />
      <Seg value={view} onChange={setView} options={[{ value: 'all', label: 'All' }, { value: 'pos', label: 'Positive' }, { value: 'neg', label: 'Negative' }, { value: 'gain', label: 'Top Gainers' }, { value: 'lose', label: 'Top Losers' }]} />
      <select value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort sectors">
        <option value="desc">% Change High → Low</option><option value="asc">% Change Low → High</option><option value="alpha">Alphabetical</option>
      </select>
      <Seg value={basis} onChange={setBasis} options={[{ value: 'open', label: 'vs Open', title: "Colour and sort by change vs today's open" }, { value: 'prev', label: 'vs Prev Close', title: 'Colour and sort by change vs previous close' }]} />
    </div>
    <div className="toolbar sel-bar">
      <span className="strong">Selected Sectors: {selected.length}</span>
      <button className="btn sm" onClick={() => setSelected(sectors.map(s => s.symbol))}>Select All</button>
      <button className="btn sm" onClick={() => setSelected([])}>Clear All</button>
      <button className="btn sm" onClick={() => setSelected(pos)}>Select Positive Sectors ({pos.length})</button>
      <button className="btn sm" onClick={() => setSelected(neg)}>Select Negative Sectors ({neg.length})</button>
      <span className="grow" />
      <button className="btn primary sm" onClick={() => goto('scanner')}>Open ORB Scanner{selected.length ? ` · ${selected.length} sectors` : ''} →</button>
    </div>
    <div className="heatmap">
      {shown.map(s => {
        const p = pctOf(s, basis)
        const other = basis === 'open' ? s.quote?.pct_prev : s.quote?.pct_open
        const isSel = selected.includes(s.symbol)
        return <div key={s.symbol} role="button" tabIndex={0}
          className={'tile ' + heatClass(p) + (isSel ? ' selected' : '') + (detail === s.symbol ? ' viewing' : '')}
          onClick={() => setDetail(s.symbol)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setDetail(s.symbol))}
          title={`${s.symbol} — click to see its stocks`}>
          <div className="tile-head">
            <button className={'sel-box' + (isSel ? ' on' : '')} aria-pressed={isSel}
              aria-label={`${isSel ? 'Remove' : 'Add'} ${s.symbol} ${isSel ? 'from' : 'to'} scanner filter`}
              title={isSel ? 'Selected for ORB Scanner — click to remove' : 'Select for ORB Scanner'}
              onClick={e => { e.stopPropagation(); toggle(s.symbol) }} onKeyDown={e => e.stopPropagation()}>{isSel ? '✓' : ''}</button>
            <span className="tile-name">{s.symbol}</span>
            <ChartIcon name={s.symbol} />
          </div>
          <div className="tile-val">{fmtNum(s.quote?.ltp)}</div>
          <div className="tile-pct">{fmtPct(p)} <small>{basis === 'open' ? 'vs open' : 'vs prev'}</small></div>
          <div className="tile-foot"><span>{basis === 'open' ? 'prev' : 'open'} {fmtPct(other)}</span><span title="NSE advances / declines vs previous close">{s.nse_breadth.up}↑ {s.nse_breadth.down}↓</span></div>
        </div>
      })}
      {!shown.length && <Empty>No sectors match.</Empty>}
    </div>
    <div className="legend">
      <span>Colour scale ({basis === 'open' ? 'vs open' : 'vs prev close'}):</span>
      {[['heat-dn-4', '≤ −2%'], ['heat-dn-3', '−1 to −2%'], ['heat-dn-2', '−0.5 to −1%'], ['heat-dn-1', '−0.1 to −0.5%'], ['heat-0', '±0.1%'], ['heat-up-1', '+0.1 to +0.5%'], ['heat-up-2', '+0.5 to +1%'], ['heat-up-3', '+1 to +2%'], ['heat-up-4', '≥ +2%']].map(([c, l]) =>
        <span key={c} className="legend-item"><i className={c} />{l}</span>)}
    </div>
    <FoMovers stocks={live.stocks} selected={selected} labels={Object.fromEntries(sectors.map(x => [x.symbol, x.label]))} />
    <Drawer open={!!detailSector} onClose={() => setDetail(null)} wide title={detailSector?.label ? `${detailSector.label} · ${detailSector.symbol}` : ''}>
      {detailSector && <SectorPanel sector={detailSector} basis={basis} selected={selected} toggle={toggle} />}
    </Drawer>
  </>
}
