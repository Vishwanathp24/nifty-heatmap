import React, { useMemo, useState } from 'react'
import { Empty, Section, Seg, SortTh } from './components.jsx'
import { heatClass, isNum, istTime, setSessionValue, sortRows, tvCrypto, useSessionState } from './lib.js'
import Trend, { useTrendSettings } from './Trend.jsx'
import CryptoOptions from './CryptoOptions.jsx'
import { CgTrending, ChartBtn, ChartCtx, LiveChart, Pools } from './CryptoLive.jsx'

// Crypto tab. Prices in USD (OKX USDT pairs, CoinGecko for coins OKX does not list).
// The crypto "day" starts at 12:00 AM IST; all times are IST.

const fmtPx = v => {
  if (!isNum(v)) return '—'
  const d = v >= 1000 ? 2 : v >= 1 ? 3 : v >= 0.01 ? 5 : 8
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d })
}
const fmtBig = v => !isNum(v) ? '—' : '$' + (v >= 1e12 ? (v / 1e12).toFixed(2) + 'T' : v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : (v / 1e6).toFixed(1) + 'M')
const pct = v => isNum(v) ? <span className={v > 0 ? 'up' : v < 0 ? 'down' : ''}>{v > 0 ? '+' : ''}{v.toFixed(2)}%</span> : '—'
const bigPct = v => isNum(v) ? <span className={v > 0 ? 'up' : v < 0 ? 'down' : ''}>{v > 0 ? '+' : ''}{Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1)}%</span> : '—'
const hhmm12 = t => { if (!t) return '—'; const [h, m] = t.split(':').map(Number); return `${(h + 11) % 12 + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}` }
const CoinLink = ({ c }) => <><a className="tv-link strong" href={tvCrypto(c.symbol)} target="_blank" rel="noopener noreferrer"
  title={`${c.name} · open OKX:${c.symbol}USDT on TradingView`}>{c.symbol}<span className="ext">↗</span></a> <ChartBtn symbol={c.symbol} id={c.id} /></>
const dayPct = c => isNum(c.pct_day) ? c.pct_day : c.pct_24h

function Bias({ bias }) {
  const tone = bias.label === 'BULLISH' ? 'bull' : bias.label === 'BEARISH' ? 'bear' : 'neutral'
  return <div className={'bias-banner ' + tone}>
    <span className={'bias-pill ' + tone}>Crypto Bias: {bias.label} ({bias.score > 0 ? '+' : ''}{bias.score})</span>
    <span className="bias-text">Top-100 coins · day starts 12:00 AM IST</span>
    <span className="bias-comps muted small">{bias.components.map(c => <span key={c.key} className={c.points > 0 ? 'up' : c.points < 0 ? 'down' : ''} title={c.detail}>{c.label} {c.points > 0 ? '+1' : c.points < 0 ? '−1' : '0'}</span>)}</span>
  </div>
}

// Crypto Market Overview: market cap, volume, dominance, Fear & Greed, Altcoin Season.
function MarketOverview({ data }) {
  const g = data.global, fg = data.fear_greed, alt = data.altseason
  const fgTone = !fg ? '' : fg.value < 45 ? 'down' : fg.value > 55 ? 'up' : ''
  return <div className="crypto-market">
    <div className="cm-card"><div className="cm-k">Total Market Cap</div><div className="cm-v">{fmtBig(g?.mcap)}</div><div className="cm-n">{pct(g?.mcap_change_24h)} <span className="muted">24h</span></div></div>
    <div className="cm-card" title="Sum of the 24h trading volume of the top 100 coins (CoinGecko's all-coin total is inflated by low-quality exchanges)"><div className="cm-k">24h Volume</div><div className="cm-v">{fmtBig(data.coins.reduce((t, c) => t + (c.volume || 0), 0))}</div><div className="cm-n muted">top 100 coins</div></div>
    <div className="cm-card"><div className="cm-k">Dominance</div><div className="cm-v">BTC {isNum(g?.btc_dom) ? g.btc_dom.toFixed(1) + '%' : '—'}</div><div className="cm-n muted">ETH {isNum(g?.eth_dom) ? g.eth_dom.toFixed(1) + '%' : '—'}</div></div>
    <div className="cm-card"><div className="cm-k">Fear &amp; Greed Index</div>
      <div className={'cm-v ' + fgTone}>{fg ? fg.value : '—'} <span className="cm-lab">{fg?.label}</span></div>
      <div className="meter fg"><span style={{ left: (fg?.value ?? 0) + '%' }} /></div>
      <div className="cm-n muted">{isNum(fg?.yesterday) ? `yesterday ${fg.yesterday}` : 'alternative.me'}</div></div>
    <div className="cm-card"><div className="cm-k">Altcoin Season Index</div>
      <div className="cm-v">{alt ? alt.value : '—'} <span className="cm-lab">{alt?.label || 'calculating…'}</span></div>
      <div className="meter alt"><span style={{ left: (alt?.value ?? 0) + '%' }} /></div>
      <div className="cm-n muted" title="Share of the top-50 altcoins that beat Bitcoin over the last 90 days. 75+ = Altcoin Season, 25 or less = Bitcoin Season.">{alt ? `${Math.round(alt.value * alt.coins / 100)} of ${alt.coins} alts beat BTC (${alt.btc_90d > 0 ? '+' : ''}${alt.btc_90d}%) over 90 days` : 'top-50 alts vs BTC, 90 days'}</div></div>
  </div>
}

function Coins({ coins }) {
  const [sort, setSort] = useState({ key: 'rank', dir: 'asc' })
  const [q, setQ] = useState('')
  const rows = sortRows(coins.filter(c => !q || c.symbol.includes(q.toUpperCase()) || (c.name || '').toLowerCase().includes(q.toLowerCase()) || c.category.toLowerCase().includes(q.toLowerCase())), sort.key, sort.dir)
  const sp = { sort, setSort }
  return <>
    <div className="toolbar"><input className="search" placeholder="Search coin / category" value={q} onChange={e => setQ(e.target.value)} /></div>
    <div className="tbl-wrap panel trend-wrap"><table className="tbl">
      <thead><tr>
        <SortTh label="#" k="rank" {...sp} num defaultDir="asc" title="Rank by market cap (stablecoins, gold and fund tokens excluded)" />
        <SortTh label="Coin" k="symbol" {...sp} defaultDir="asc" />
        <SortTh label="Category" k="category" {...sp} defaultDir="asc" />
        <SortTh label="Price" k="price" {...sp} num />
        <SortTh label="Today %" k="pct_day" {...sp} num title="Change since 12:00 AM IST" />
        <SortTh label="24h %" k="pct_24h" {...sp} num />
        <SortTh label="From ATH %" k="from_ath" {...sp} num title="How far below the all-time high" />
        <SortTh label="From 1Y Low %" k="from_low_1y" {...sp} num title="How far above the lowest price of the last 365 days" />
        <SortTh label="Market Cap" k="market_cap" {...sp} num />
        <SortTh label="24h Volume" k="volume" {...sp} num />
      </tr></thead>
      <tbody>{rows.map(c => <tr key={c.symbol}>
        <td className="num muted">{c.rank}</td>
        <td><CoinLink c={c} /> <span className="muted small">{c.name}</span></td>
        <td className="muted">{c.category}</td>
        <td className="num">{fmtPx(c.price)}</td>
        <td className="num strong">{pct(c.pct_day)}</td><td className="num">{pct(c.pct_24h)}</td>
        <td className="num" title={isNum(c.ath) ? `ATH ${fmtPx(c.ath)} on ${c.ath_date}` : ''}>{bigPct(c.from_ath)}</td>
        <td className="num" title={isNum(c.low_1y) ? `1-year low ${fmtPx(c.low_1y)} on ${c.low_1y_date}` : 'OKX daily history not available'}>{bigPct(c.from_low_1y)}</td>
        <td className="num">{fmtBig(c.market_cap)}</td><td className="num">{fmtBig(c.volume)}</td>
      </tr>)}</tbody>
    </table></div>
  </>
}

function Heatmap({ coins }) {
  const [sel, setSel] = useState(null)
  const cats = useMemo(() => {
    const m = {}
    for (const c of coins) { const v = dayPct(c); if (isNum(v)) (m[c.category] ||= []).push(v) }
    return Object.entries(m).map(([category, v]) => ({ category, pct: v.reduce((a, b) => a + b, 0) / v.length, coins: v.length, up: v.filter(x => x > 0).length, down: v.filter(x => x < 0).length }))
      .sort((a, b) => b.pct - a.pct)
  }, [coins])
  const list = coins.filter(c => !sel || c.category === sel).sort((a, b) => (dayPct(b) ?? -1e9) - (dayPct(a) ?? -1e9))
  return <>
    <div className="heatmap">{cats.map(c => <button key={c.category} className={'tile ' + heatClass(c.pct) + (sel === c.category ? ' selected' : '')}
      onClick={() => setSel(s => s === c.category ? null : c.category)} title="Click to show its coins">
      <div className="tile-name">{c.category}</div>
      <div className="tile-pct">{c.pct > 0 ? '+' : ''}{c.pct.toFixed(2)}%</div>
      <div className="tile-sub">{c.up}↑ {c.down}↓ · {c.coins} coins</div>
    </button>)}</div>
    <h3 className="sub-h">{sel ? `${sel} coins` : 'All coins'} · today % since 12:00 AM IST {sel && <button className="btn sm" onClick={() => setSel(null)}>✕ Show all</button>}</h3>
    <div className="heatmap coins">{list.map(c => <a key={c.symbol} className={'tile ' + heatClass(dayPct(c))} href={tvCrypto(c.symbol)} target="_blank" rel="noopener noreferrer" title={c.name}>
      <div className="tile-name">{c.symbol}</div>
      <div className="tile-pct">{isNum(dayPct(c)) ? (dayPct(c) > 0 ? '+' : '') + dayPct(c).toFixed(2) + '%' : '—'}</div>
      <div className="tile-sub">{fmtPx(c.price)}</div>
    </a>)}</div>
  </>
}

const orbSignals = (coins, orm, side, holding) => coins.map(c => ({ ...c, o: c['orb' + orm] })).filter(c => c.o?.signal)
  .map(c => ({ ...c, signal: c.o.signal, time: c.o.time, dist: c.o.dist_pct, hold: c.o.holding }))
  .filter(c => (side === 'all' || c.signal === side) && (!holding || c.hold))

// Same layout as the stock ORB page: 15 Min / 1 Hour switch with signal counts, then the table.
function Orb({ coins, bias }) {
  const [orm, setOrm] = useSessionState('corb.orm', 15)
  // Breakout / Breakdown follows the Crypto Bias until the user picks one by hand (kept for the visit).
  const [sidePick, setSidePick] = useSessionState('corb.side', null)
  const side = sidePick || (bias === 'BULLISH' ? 'BREAKOUT' : bias === 'BEARISH' ? 'BREAKDOWN' : 'all')
  const setSide = setSidePick
  const [holding, setHolding] = useState(true)
  const [sort, setSort] = useState({ key: 'time', dir: 'desc' })
  const shown = sortRows(orbSignals(coins, orm, side, holding), sort.key, sort.dir)
  const sp = { sort, setSort }
  const pending = coins.some(c => c['orb' + orm] && !c['orb' + orm].complete)
  return <>
    <div className="crypto-orb-row"><div className="orb-switch" role="tablist" aria-label="Opening range">
      {[[15, '15 Min ORB', '12:00–12:15 AM'], [60, '1 Hour ORB', '12:00–1:00 AM']].map(([v, label, range]) =>
        <button key={v} role="tab" aria-selected={orm === v} className={orm === v ? 'on' : ''} onClick={() => setOrm(v)}>
          {label} <small>{range} IST</small><span className="count">{orbSignals(coins, v, side, holding).length}</span></button>)}
    </div></div>
    <p className="muted small qualify-line">Range = high / low from 12:00 AM IST for {orm === 15 ? '15 minutes' : '1 hour'} · signal = first 1-min candle closing beyond the range, confirmed by the next 1-min candle closing beyond the break candle’s close. Coins with OKX candles only.{pending ? ' Opening range still forming.' : ''}</p>
    <div className="toolbar">
      <Seg value={side} onChange={setSide} options={[{ value: 'all', label: 'All' }, { value: 'BREAKOUT', label: 'Breakout', tone: 'up' }, { value: 'BREAKDOWN', label: 'Breakdown', tone: 'down' }]} />
      <label className="check-label"><input type="checkbox" checked={holding} onChange={e => setHolding(e.target.checked)} />Still beyond range</label>
      <span className="muted small">{shown.length} signals</span>
    </div>
    <div className="tbl-wrap panel trend-wrap"><table className="tbl">
      <thead><tr>
        <SortTh label="#" k="rank" {...sp} num defaultDir="asc" /><SortTh label="Coin" k="symbol" {...sp} defaultDir="asc" /><SortTh label="Category" k="category" {...sp} defaultDir="asc" />
        <SortTh label="Signal" k="signal" {...sp} defaultDir="asc" /><SortTh label="Price" k="price" {...sp} num />
        <th className="num">OR High</th><th className="num">OR Low</th><th className="num">Break Candle</th><th className="num">Break Close</th><th className="num">1-min Close</th>
        <SortTh label="Signal Time" k="time" {...sp} /><SortTh label="Dist ORB %" k="dist" {...sp} num /><th className="num" title="Breaks whose 1-min confirmation failed">Rejected</th>
      </tr></thead>
      <tbody>{shown.map(c => <tr key={c.symbol}>
        <td className="num muted">{c.rank}</td><td><CoinLink c={c} /></td><td className="muted">{c.category}</td>
        <td><span className={'sig ' + (c.signal === 'BREAKOUT' ? 'up' : 'down')}>{c.signal}</span></td>
        <td className="num">{fmtPx(c.price)}</td><td className="num">{fmtPx(c.o.high)}</td><td className="num">{fmtPx(c.o.low)}</td>
        <td className="num">{hhmm12(c.o.break_candle)}</td><td className="num">{fmtPx(c.o.break_close)}</td><td className="num">{fmtPx(c.o.confirm_close)}</td>
        <td className="num strong">{hhmm12(c.time)}</td><td className="num">{pct(c.dist)}</td><td className="num muted">{c.o.rejected?.length || 0}</td>
      </tr>)}</tbody>
    </table>{!shown.length && <Empty>No ORB signals match{holding ? ' (untick “Still beyond range” to include signals that have reversed)' : ''}.</Empty>}</div>
  </>
}

// Top Movers across the top 100 coins (whatever the Show filter), laid out like the stock
// Overview's Top Movers: gainers, losers and high volume (24h volume / market cap = turnover).
function MoversPanel({ title, rows, val, note }) {
  return <div className="panel">
    <div className="panel-head"><h3>{title}</h3>{note && <span className="muted small">{note}</span>}</div>
    <div className="tbl-wrap"><table className="tbl compact">
      <thead><tr><th>Coin</th><th>Category</th><th className="num">Price</th><th className="num">Chg %</th><th className="num hide-m">Volume</th>
        <th className="num hide-m" title="24h volume ÷ market cap: how much of the coin changed hands in a day">Vol / MCap</th></tr></thead>
      <tbody>{rows.length ? rows.map(c => <tr key={c.symbol}>
        <td><CoinLink c={c} /></td><td className="muted">{c.category}</td>
        <td className="num">{fmtPx(c.price)}</td><td className="num">{pct(val(c))}</td>
        <td className="num hide-m">{fmtBig(c.volume)}</td>
        <td className={'num hide-m ' + (c.turnover >= 0.2 ? 'strong' : '')}>{isNum(c.turnover) ? (c.turnover * 100).toFixed(1) + '%' : '—'}</td>
      </tr>) : <tr><td colSpan="6" className="muted">N/A</td></tr>}</tbody>
    </table></div>
  </div>
}

function Movers({ coins }) {
  const [basis, setBasis] = useSessionState('crypto.movers', 'day')
  const val = c => basis === 'day' ? dayPct(c) : c.pct_24h
  const rows = coins.map(c => ({ ...c, turnover: c.volume && c.market_cap ? c.volume / c.market_cap : null }))
  const byChg = rows.filter(c => isNum(val(c))).sort((a, b) => val(b) - val(a))
  const byVol = rows.filter(c => isNum(c.turnover)).sort((a, b) => b.turnover - a.turnover)
  return <Section className="crypto-movers" title="Top Movers" subtitle={`Top 100 coins · ${basis === 'day' ? 'change since 12:00 AM IST' : 'change over the last 24 hours'}`}
    right={<Seg value={basis} onChange={setBasis} options={[{ value: 'day', label: 'Today' }, { value: '24h', label: 'Last 24h' }]} />}>
    <div className="movers">
      <MoversPanel title="Top 10 Gainers" rows={byChg.filter(c => val(c) > 0).slice(0, 10)} val={val} />
      <MoversPanel title="Top 10 Losers" rows={byChg.filter(c => val(c) < 0).reverse().slice(0, 10)} val={val} />
      <MoversPanel title="High Volume" rows={byVol.slice(0, 10)} val={val} note="ranked by 24h volume ÷ market cap" />
    </div>
  </Section>
}

const TABS = [['overview', 'Market Overview'], ['heatmap', 'Heatmap'], ['movers', 'Top Movers'], ['trend', 'Trending'], ['orb', 'ORB'], ['options', 'Options'],
  ['chart', 'Live Chart'], ['cgtrend', 'CoinGecko Trending'], ['pools', 'DEX Pools']]

export default function Crypto({ crypto }) {
  const [tab, setTab] = useSessionState('crypto.tab', 'overview')
  // Market Overview opens on the Top 5; switching to another tab widens to the Top 100 so its
  // scan shows every coin. The Show buttons still change it by hand on any tab.
  const [top, setTop] = useSessionState('crypto.top', tab === 'overview' ? 5 : 100)
  const openTab = v => { if (v !== tab) { setTab(v); if (v !== 'chart') setTop(v === 'overview' ? 5 : 100) } }  // Live Chart keeps the Top N (its coin list)
  const openChart = (symbol, id) => { setSessionValue('clive.sym', symbol); setSessionValue('clive.id', id || ''); openTab('chart'); window.scrollTo({ top: 0 }) }
  const base = useTrendSettings('ctrend')
  // Trending: Bullish / Bearish follows the Crypto Bias until the user picks one by hand.
  const [dirManual, setDirManual] = useSessionState('ctrend.dirManual', false)
  const biasLabel = crypto.data?.bias?.label
  const biasDir = biasLabel === 'BEARISH' ? 'bear' : biasLabel === 'BULLISH' ? 'bull' : null
  const settings = { ...base, dir: !dirManual && biasDir ? biasDir : base.dir, setDir: v => { setDirManual(true); base.setDir(v) } }
  const data = crypto.data
  const coins = useMemo(() => (data?.coins || []).filter(c => c.rank <= top), [data, top])
  const cyc = data?.cycle
  return <ChartCtx.Provider value={openChart}><div className="trend-page crypto-page">
    <div className="page-title"><h1>Crypto</h1>
      <span className="muted small">{data ? `Top 100 coins by market cap · prices in USD · day starts 12:00 AM IST · updated ${istTime(data.fetched_at)} IST` : 'Loading…'}
        {cyc?.state === 'running' ? ` · scanning candles ${cyc.done}/${cyc.total}` : ''}</span></div>
    {!data ? <Empty>{crypto.error || 'Loading crypto data…'}</Empty> : <>
      <Bias bias={data.bias} />
      <MarketOverview data={data} />
      <div className="toolbar crypto-top">
        <span className="muted small">Show</span>
        <Seg value={top} onChange={setTop} options={[5, 20, 50, 100].map(n => ({ value: n, label: `Top ${n}` }))} />
        <span className="muted small">coins by market cap</span>
      </div>
      <div className="orb-switch learn-cats scan-tabs" role="tablist" aria-label="Crypto">
        {TABS.map(([v, l]) => <button key={v} role="tab" aria-selected={tab === v} className={tab === v ? 'on' : ''} onClick={() => openTab(v)}>{l}</button>)}
      </div>
      {tab === 'overview' && <><Coins coins={coins} />{top === 5 && <Movers coins={data.coins} />}</>}
      {tab === 'movers' && <Movers coins={data.coins} />}
      {tab === 'heatmap' && <Heatmap coins={coins} />}
      {tab === 'trend' && (coins.some(c => c.tf15) ? <Trend trend={{ data: { rows: coins.filter(c => c.tf15) } }} settings={settings} prefix="ctrend" link={c => <CoinLink c={c} />} fmtLtp={fmtPx} noun="coin" either />
        : <Empty>Loading candles for the indicator scan… ({cyc?.done || 0}/{cyc?.total || '…'})</Empty>)}
      {tab === 'orb' && <Orb coins={coins} bias={biasLabel} />}
      {tab === 'options' && <CryptoOptions bias={data.bias} />}
      {tab === 'chart' && <LiveChart coins={coins} allCoins={data.coins} bias={biasLabel} />}
      {tab === 'cgtrend' && <CgTrending coins={data.coins} />}
      {tab === 'pools' && <Pools />}
      <p className="muted small">Crypto trades 24×7; “today” runs from 12:00 AM IST. Prices: OKX (USDT ≈ USD), or CoinGecko for coins OKX doesn’t list (those have no Trending / ORB data). Market cap, ATH / ATL, dominance: CoinGecko · Fear &amp; Greed: alternative.me. Market data only, not a buy/sell recommendation.</p>
    </>}
  </div></ChartCtx.Provider>
}
