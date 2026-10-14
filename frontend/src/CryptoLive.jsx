import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Empty, Seg, SortTh } from './components.jsx'
import { api, isNum, istTime, sortRows, usePoll, useSessionState } from './lib.js'
import { ChartView } from './Chart.jsx'
import { CRYPTO } from './CryptoOptions.jsx'

// Crypto -> live views: Live Chart (OKX candles; CoinGecko for coins OKX doesn't list), CoinGecko Trending (most-searched coins) and DEX Pools (GeckoTerminal trending pools
// with a basic safety screen). Read-only market data, not a buy/sell recommendation.

const fmtPx = v => {
  if (!isNum(v)) return '—'
  const d = v >= 1000 ? 2 : v >= 1 ? 3 : v >= 0.01 ? 5 : 8
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d })
}
const fmtBig = v => !isNum(v) ? '—' : '$' + (v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v.toFixed(0))
const pct = (v, d = 2) => isNum(v) ? <span className={v > 0 ? 'up' : v < 0 ? 'down' : ''}>{v > 0 ? '+' : ''}{Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(d)}%</span> : '—'
const IST = { timeZone: 'Asia/Kolkata', hour12: false }
const ago = iso => { if (!iso) return '—'; const s = Math.max(0, (Date.now() - new Date(iso)) / 1000); return s < 60 ? `${s.toFixed(0)}s ago` : s < 3600 ? `${(s / 60).toFixed(0)}m ago` : `${(s / 3600).toFixed(1)}h ago` }

// Open a coin in the Live Chart from any crypto tab (provided by the Crypto page).
export const ChartCtx = createContext(null)
export function ChartBtn({ symbol, id }) {
  const open = useContext(ChartCtx)
  return open ? <button className="chart-btn" title={`Open ${symbol} in the Live Chart`} aria-label={`Live chart ${symbol}`}
    onClick={e => { e.preventDefault(); open(symbol, id) }}><svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">
      <path d="M3 2v10M7 4v8M11 1v9" stroke="currentColor" strokeWidth="1" /><rect x="1.8" y="5" width="2.4" height="4" fill="currentColor" />
      <rect x="5.8" y="6" width="2.4" height="3.5" fill="currentColor" /><rect x="9.8" y="3" width="2.4" height="4" fill="currentColor" /></svg></button> : null
}

// ---- Live chart (shared chart component, OKX / CoinGecko data) -------------------------------
const pxShort = v => !isNum(v) ? '—' : v >= 1000 ? '$' + Math.round(v).toLocaleString('en-US') : fmtPx(v)

export function LiveChart({ coins, allCoins = coins, bias }) {
  const [sym, setSym] = useSessionState('clive.sym', 'BTC')
  const [cgId, setCgId] = useSessionState('clive.id', '')
  // Dropdown = the coins of the Top 5 / 20 / 50 / 100 filter (plus the coin on screen if it came from elsewhere).
  const opts = useMemo(() => {
    const list = coins.map(c => ({ symbol: c.symbol, name: c.name, id: c.id }))
    if (!list.some(c => c.symbol === sym)) { const c = allCoins.find(c => c.symbol === sym); list.unshift({ symbol: sym, name: c?.name || '', id: c?.id || cgId }) }
    return list
  }, [coins, allCoins, sym, cgId])
  const coin = allCoins.find(c => c.symbol === sym)
  return <ChartView prefix="clive" label="Coin" opts={opts} sym={sym}
    onPick={s => { const c = opts.find(c => c.symbol === s); setSym(s); setCgId(c?.id || '') }}
    candlesUrl={(s, tf, before) => `/api/crypto/candles?symbol=${encodeURIComponent(s)}&tf=${tf}` + (before ? `&before=${before}` : `&id=${encodeURIComponent(cgId)}`)}
    indUrl={s => '/api/crypto/indicators?symbol=' + encodeURIComponent(s)}
    fmt={fmtPx} fmtShort={pxShort} pollMs={5000} indSource="OKX candles; 3h built from 1h"
    fallback={d => d.source === 'CoinGecko'}
    sourceLine={d => d.source === 'CoinGecko' ? `CoinGecko ${sym}/USD · ${d.bar} candles (${sym} is not on OKX) · refreshes every 2 min` : `OKX ${sym}/USDT · refreshes every 5 sec`}
    head={coin && <span className="muted small">Today {isNum(coin.pct_day) ? (coin.pct_day > 0 ? '+' : '') + coin.pct_day.toFixed(2) + '%' : '—'} · 24h {isNum(coin.pct_24h) ? (coin.pct_24h > 0 ? '+' : '') + coin.pct_24h.toFixed(2) + '%' : '—'}</span>}
    bias={bias} biasName="Crypto Bias" chainUrl={['BTC', 'ETH', 'SOL', 'XRP'].includes(sym) ? s => '/api/crypto/options?ccy=' + s : null}
    optMarket={CRYPTO}
    optNote={['BTC', 'ETH', 'SOL', 'XRP'].includes(sym) ? `${sym} options trade on Deribit — strikes below come from its live chain (payoff calculator in the Options tab).` : `${sym} has no listed options on Deribit (BTC, ETH, SOL and XRP do).`}
    note="The coin list follows the Top 5 / 20 / 50 / 100 choice. Coins not on OKX chart from CoinGecko (30-min candles, or 4-hour on 1D / 1W / 1M; no volume or older history)." />
}

// ---- CoinGecko trending ---------------------------------------------------------------------
export function CgTrending({ coins }) {
  const res = usePoll(() => api('/api/crypto/trending'), 120000, [])
  const d = res.data
  const onList = new Set(coins.map(c => c.id))
  return <div>
    <div className="toolbar"><span className="muted small">Most-searched coins on CoinGecko in the last 24 hours — where attention is moving, not a quality signal · refreshes every 2 min{d ? ` · updated ${istTime(d.fetched_at)} IST` : ''}</span></div>
    {!d ? <Empty>{res.error || 'Loading trending coins…'}</Empty> : <div className="tbl-wrap trend-wrap"><table className="tbl">
      <thead><tr><th className="num">#</th><th>Coin</th><th className="num">Market-cap rank</th><th className="num">Price</th><th className="num">24h %</th><th className="num">Market cap</th><th className="num">24h Volume</th><th /></tr></thead>
      <tbody>{d.rows.map(r => <tr key={r.id}>
        <td className="num muted">{r.pos}</td>
        <td><a className="tv-link strong" href={`https://www.coingecko.com/en/coins/${r.id}`} target="_blank" rel="noopener noreferrer">
          {r.thumb && <img src={r.thumb} alt="" className="coin-ico" />}{r.symbol}<span className="ext">↗</span></a> <ChartBtn symbol={r.symbol} id={r.id} /> <span className="muted small">{r.name}</span></td>
        <td className="num">{r.rank ? '#' + r.rank : '—'}</td>
        <td className="num strong">{fmtPx(r.price)}</td><td className="num">{pct(r.pct_24h)}</td>
        <td className="num">{r.market_cap || '—'}</td><td className="num">{r.volume || '—'}</td>
        <td className="small">{onList.has(r.id) ? <span className="chip">in Top 100</span> : r.rank && r.rank > 500 ? <span className="chip warn" title="Small coin: thin liquidity, large swings">small cap</span> : ''}</td>
      </tr>)}</tbody>
    </table></div>}
  </div>
}

// ---- DEX pools + safety check -----------------------------------------------------------------
const RISK = { ok: ['No flags', 'up'], watch: ['1 flag', 'warn'], high: ['2+ flags', 'down'] }

export function Pools() {
  const res = usePoll(() => api('/api/crypto/pools'), 60000, [])
  const d = res.data
  const [risk, setRisk] = useSessionState('cpools.risk', 'all')
  const [sort, setSort] = useState({ key: 'volume', dir: 'desc' })
  const rows = useMemo(() => d ? sortRows(d.rows.filter(r => risk === 'all' || r.risk === risk), sort.key, sort.dir) : [], [d, risk, sort])
  const sp = { sort, setSort }
  const n = k => d ? d.rows.filter(r => r.risk === k).length : 0
  return <div>
    <div className="toolbar">
      <Seg value={risk} onChange={setRisk} options={[{ value: 'all', label: 'All' }, { value: 'ok', label: `No flags (${n('ok')})`, tone: 'up' }, { value: 'watch', label: `1 flag (${n('watch')})` }, { value: 'high', label: `2+ flags (${n('high')})`, tone: 'down' }]} />
      <span className="muted small">GeckoTerminal trending on-chain pools (all networks) · refreshes every minute{d ? ` · updated ${istTime(d.fetched_at)} IST` : ''}</span>
    </div>
    {!d ? <Empty>{res.error || 'Loading DEX pools…'}</Empty> : <>
      <div className="tbl-wrap trend-wrap"><table className="tbl">
        <thead><tr>
          <SortTh label="Pool" k="name" {...sp} defaultDir="asc" /><SortTh label="Network · DEX" k="network" {...sp} defaultDir="asc" />
          <SortTh label="Price" k="price" {...sp} num /><SortTh label="1h %" k="pct_1h" {...sp} num /><SortTh label="24h %" k="pct_24h" {...sp} num />
          <SortTh label="Liquidity" k="liquidity" {...sp} num title="USD locked in the pool; low liquidity = big price impact and easy to manipulate" />
          <SortTh label="24h Volume" k="volume" {...sp} num /><SortTh label="Buys / Sells 24h" k="buys" {...sp} num />
          <SortTh label="Age" k="age_h" {...sp} num defaultDir="asc" /><SortTh label="Safety check" k="risk" {...sp} defaultDir="asc" />
        </tr></thead>
        <tbody>{rows.map(r => <tr key={r.url}>
          <td><a className="tv-link strong" href={r.url} target="_blank" rel="noopener noreferrer">{r.name}<span className="ext">↗</span></a></td>
          <td className="muted small">{r.network} · {r.dex}</td>
          <td className="num">{fmtPx(r.price)}</td><td className="num">{pct(r.pct_1h, 1)}</td><td className="num">{pct(r.pct_24h, 1)}</td>
          <td className="num">{fmtBig(r.liquidity)}</td><td className="num">{fmtBig(r.volume)}</td>
          <td className="num">{r.buys.toLocaleString('en-US')} / {r.sells.toLocaleString('en-US')}</td>
          <td className="num">{!isNum(r.age_h) ? '—' : r.age_h < 48 ? r.age_h.toFixed(0) + 'h' : (r.age_h / 24).toFixed(0) + 'd'}</td>
          <td className="small"><span className={'chip ' + RISK[r.risk][1]}>{RISK[r.risk][0]}</span>{r.flags.length > 0 && <div className="muted pool-flags">{r.flags.join(' · ')}</div>}</td>
        </tr>)}</tbody>
      </table></div>
      <div className="note-box small">
        <b>Safety check</b> (from CoinGecko's bot-screening rules, shown as warnings only): liquidity under ${d.rules.min_liquidity / 1000}K, 24h volume under ${d.rules.min_volume / 1000}K,
        fewer than {d.rules.min_buys} buys in 24h, almost no sells (possible honeypot — tokens that can be bought but not sold), pool younger than {d.rules.new_hours}h, or volume far above liquidity (possible wash trading).
        <div className="muted">“No flags” does not mean safe: DEX tokens can still be scams or lose most of their value quickly.</div>
      </div>
    </>}
  </div>
}
