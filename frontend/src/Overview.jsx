import React, { useMemo, useState } from 'react'
import { BreadthBar, Empty, IndexLink, Pct, Section, StockLink } from './components.jsx'
import { fmtCr, fmtNum, fmtPct, fmtRatio, fmtSigned, fmtVol, istDate, istTime, isNum, nseTs, tone, useClock } from './lib.js'

const biasClass = l => l === 'BULLISH' ? 'bull' : l === 'BEARISH' ? 'bear' : 'neutral'

function MarketBias({ bias }) {
  return <Section title="Market Bias" subtitle="Breadth-based read of the current session" className="bias-section">
    <div className="bias-grid">
      <div className={'bias-main ' + biasClass(bias.label)}>
        <div className="k">Overall Market Bias</div>
        <div className="bias-label">{bias.label}</div>
        <div className="bias-score">Score {bias.score > 0 ? '+' : ''}{bias.score} / 5</div>
        <div className="bias-scale">+3 to +5 Bullish · −2 to +2 Neutral · −3 to −5 Bearish</div>
      </div>
      <table className="tbl compact bias-table">
        <thead><tr><th>Component</th><th>Reading</th></tr></thead>
        <tbody>{bias.components.map(c => <tr key={c.key}>
          <td>{c.label}</td><td className={'strong ' + tone(c.points)} title={c.basis}>{c.detail}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </Section>
}

// India VIX reads inversely: falling volatility is bullish, rising is bearish.
function vixRead(p) {
  if (!isNum(p)) return null
  return p < 0 ? ['Bullish', 'bull'] : p > 0 ? ['Bearish', 'bear'] : ['Neutral', 'neutral']
}

function IndexCard({ name, label, q, vix }) {
  const read = vix ? vixRead(q?.pct_prev) : null
  return <div className="card">
    <div className="card-k"><IndexLink name={name} label={label} />
      {read && <span className={'vix-tag ' + read[1]} title={`India VIX ${q.pct_prev < 0 ? 'falling' : q.pct_prev > 0 ? 'rising' : 'flat'} vs previous close`}>{read[0]}</span>}</div>
    <div className="card-v">{fmtNum(q?.ltp)}</div>
    <div className={'card-d ' + tone(q?.change)}>{fmtSigned(q?.change)} <span>{fmtPct(q?.pct_prev)}</span></div>
    <div className="card-n">vs prev close · open {fmtPct(q?.pct_open)}</div>
  </div>
}

function SummaryCards({ live }) {
  const { indices } = live
  return <div className="cards four">
    <IndexCard name="INDIA VIX" label="India VIX" q={indices.indiavix} vix />
    <IndexCard name="NIFTY 50" label="NIFTY 50" q={indices.nifty50} />
    <IndexCard name="NIFTY BANK" label="NIFTY BANK" q={indices.niftybank} />
    <IndexCard name="SENSEX" label="SENSEX" q={indices.sensex} />
  </div>
}

function BreadthPanel({ title, subtitle, b, alt, rows, showTotal }) {
  const [open, setOpen] = useState(false)
  const pctUp = b.total ? Math.round(b.up / b.total * 100) : 0
  const pctDn = b.total ? Math.round(b.down / b.total * 100) : 0
  const sorted = useMemo(() => [...rows].sort((a, c) => (c.pct_prev ?? -1e9) - (a.pct_prev ?? -1e9)), [rows])
  return <Section title={title} subtitle={subtitle} className="half"
    right={<button className="btn ghost sm" onClick={() => setOpen(o => !o)}>{open ? 'Hide stocks' : 'Show stocks'}</button>}>
    <div className="breadth-stats">
      <div><div className="k">Advancing</div><div className="big up">{b.up}</div></div>
      <div><div className="k">Declining</div><div className="big down">{b.down}</div></div>
      <div><div className="k">Unchanged</div><div className="big flat">{b.unchanged}</div></div>
      {showTotal && <div><div className="k">Total</div><div className="big">{b.total}</div></div>}
      <div><div className="k">A/D Ratio</div><div className="big">{isNum(b.ad_ratio) ? b.ad_ratio.toFixed(2) : 'N/A'}</div></div>
    </div>
    <BreadthBar up={b.up} down={b.down} unchanged={b.unchanged} />
    <div className="bbar-legend"><span className="up">{pctUp}% Advancing</span><span className="down">{pctDn}% Declining</span></div>
    {alt && <div className="muted small">vs today's open: {alt.up} up / {alt.down} down / {alt.unchanged} unchanged</div>}
    {open && <div className="chip-grid">{sorted.map(s => <a key={s.symbol} className={'chip ' + tone(s.pct_prev)}
      href={'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent('NSE:' + s.symbol)} target="_blank" rel="noopener noreferrer"
      title={`${s.company} · ${fmtPct(s.pct_prev)} vs prev close · open NSE:${s.symbol} on TradingView`}>
      {s.symbol}<b>{fmtPct(s.pct_prev)}</b></a>)}</div>}
  </Section>
}

function MoversTable({ title, rows, note }) {
  return <div className="panel">
    <div className="panel-head"><h3>{title}</h3>{note && <span className="muted small">{note}</span>}</div>
    <div className="tbl-wrap"><table className="tbl compact">
      <thead><tr><th>Symbol</th><th>Sector</th><th className="num">LTP</th><th className="num" title="vs previous close">Chg %</th><th className="num hide-m">Volume</th><th className="num hide-m" title="Volume vs 5-day average: time-adjusted vs recorded sessions during market hours; full day vs NSE bhavcopy 5-day average after the close">Vol vs 5D</th></tr></thead>
      <tbody>{rows.length ? rows.map(s => <tr key={s.symbol}>
        <td><StockLink symbol={s.symbol} company={s.company} className="strong" /></td>
        <td className="muted">{s.sector}</td>
        <td className="num">{fmtNum(s.ltp)}</td>
        <td className="num"><Pct v={s.pct_prev} /></td>
        <td className="num hide-m">{fmtVol(s.volume)}</td>
        <td className={'num hide-m ' + (s.vol_ratio >= 1.5 ? 'strong' : '')}>{fmtRatio(s.vol_ratio)}</td>
      </tr>) : <tr><td colSpan="6" className="muted">N/A</td></tr>}</tbody>
    </table></div>
  </div>
}

function TopMovers({ stocks, baseline }) {
  const fo = stocks.filter(s => s.fo && isNum(s.pct_prev))
  const byChg = [...fo].sort((a, b) => b.pct_prev - a.pct_prev)
  const haveRatio = fo.some(s => isNum(s.vol_ratio))
  const byVol = [...fo].sort((a, b) => haveRatio ? (b.vol_ratio ?? -1) - (a.vol_ratio ?? -1) : (b.volume ?? 0) - (a.volume ?? 0))
  return <Section title="Top Movers" subtitle="F&O universe · change vs previous close">
    <div className="movers">
      <MoversTable title="Top 5 Gainers" rows={byChg.slice(0, 5)} />
      <MoversTable title="Top 5 Losers" rows={byChg.slice(-5).reverse()} />
      <MoversTable title="High Volume" rows={byVol.slice(0, 5)}
        note={haveRatio ? 'ranked by ' + (fo.find(s => isNum(s.vol_ratio))?.vol_basis || 'volume ratio') : 'ranked by raw volume · no time-adjusted baseline recorded yet'} />
    </div>
  </Section>
}

function GlobalCues({ ctx }) {
  const g = ctx?.global
  return <Section title="Global Cues" subtitle="Context only, not a trading signal"
    right={g?.fetched_at && <span className="muted small">Fetched {istTime(g.fetched_at)}{g.error ? ' · refresh failed, showing last data' : ''}</span>}>
    <div className="cards six">{(g?.data || ['GIFT Nifty', 'Dow Jones', 'S&P 500', 'Nasdaq', 'Nikkei 225', 'Hang Seng'].map(label => ({ label }))).map(r =>
      <div className="card" key={r.label}>
        <div className="card-k">{r.label}<span className={'status-tag ' + (r.status || '').toLowerCase().replace(/\s/g, '-')}>{r.status || 'N/A'}</span></div>
        <div className="card-v">{fmtNum(r.last)}</div>
        <div className={'card-d ' + tone(r.change)}>{fmtSigned(r.change)} <span>{fmtPct(r.pct)}</span></div>
        <div className="card-n">{r.as_of ? `as of ${istDate(r.as_of)} ${istTime(r.as_of).slice(0, 5)} IST` : 'N/A'}{r.note ? ' · ' + r.note.replace(/-\d{4}$/, '') : ''}</div>
      </div>)}</div>
  </Section>
}

function FiiDii({ ctx }) {
  const f = ctx?.fii_dii
  const d = f?.data
  const date = d?.fii?.date || d?.dii?.date || 'N/A'
  const signed = v => isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + fmtNum(Math.abs(v)) : 'N/A'
  const row = (label, x) => <tr><td className="strong">{label}</td><td className="num">{fmtNum(x?.buy)}</td><td className="num">{fmtNum(x?.sell)}</td>
    <td className={'num strong ' + tone(x?.net)}>{signed(x?.net)}</td></tr>
  return <Section title={`FII / DII Activity (Data date - ${date})`} subtitle="Cash market, provisional (NSE) — not live intraday">
    <div className="panel tbl-wrap"><table className="tbl compact">
      <thead><tr><th>₹ Cr</th><th className="num">Buy</th><th className="num">Sell</th><th className="num">Net</th></tr></thead>
      <tbody>{row('FII / FPI', d?.fii)}{row('DII', d?.dii)}</tbody>
    </table></div>
  </Section>
}

export default function Overview({ live, ctx }) {
  if (!live) return <Empty>Loading live market data…</Empty>
  const n50 = live.stocks.filter(s => s.n50)
  const fo = live.stocks.filter(s => s.fo)
  return <>
    <div className="page-title"><h1>Market Overview</h1>
      <span className="muted small">Quotes as of {live.source_ts ? istTime(nseTs(live.source_ts)) : 'N/A'} IST (latest exchange tick)</span></div>
    <div className="two-col wide-left">
      <GlobalCues ctx={ctx} />
      <FiiDii ctx={ctx} />
    </div>
    <div className="bias-row">
      <MarketBias bias={live.bias} />
      <BreadthPanel title="Nifty 50 Breadth" subtitle="Advance / decline vs previous close (NSE convention)" b={live.breadth.nifty50} alt={live.breadth.nifty50_open} rows={n50} />
      <BreadthPanel title="F&O Universe Breadth" subtitle="NSE stocks with F&O contracts · vs previous close" b={live.breadth.fo} alt={live.breadth.fo_open} rows={fo} showTotal />
    </div>
    <SummaryCards live={live} />
    <TopMovers stocks={live.stocks} baseline={live.volume_baseline} />
  </>
}
