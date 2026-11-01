import React, { useMemo, useState } from 'react'
import { BreadthBar, Empty, IndexLink, Pct, Section, StockLink } from './components.jsx'
import { OiChange, useOiChange } from './Pcr.jsx'
import { PageGuide } from './guides.jsx'
import { api, fmtCr, fmtNum, fmtPct, fmtRatio, fmtSigned, fmtVol, istDate, istTime, isNum, nseTs, tone, tvStock, tvSymbol, useClock, usePoll } from './lib.js'

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

export function IndexCard({ name, label, q, vix }) {
  const read = vix ? vixRead(q?.pct_prev) : null
  const tint = vix ? { bull: 'up', bear: 'down' }[read?.[1]] : tone(q?.change)  // VIX: rising = red
  return <div className={'card tinted ' + (tint || '')}>
    <div className="card-k"><IndexLink name={name} label={label} />
      {read && <span className={'vix-tag ' + read[1]} title={`India VIX ${q.pct_prev < 0 ? 'falling' : q.pct_prev > 0 ? 'rising' : 'flat'} vs previous close`}>{read[0]}</span>}</div>
    <div className="card-v">{fmtNum(q?.ltp)}</div>
    <div className={'card-d ' + tone(q?.change)}>{fmtSigned(q?.change)} <span>{fmtPct(q?.pct_prev)}</span></div>
    <div className="card-n">vs prev close · open {fmtPct(q?.pct_open)}</div>
  </div>
}

// NSE pre-open session (9:00-9:08 IST): each card's estimate = its stocks' pre-open % change weighted by
// free-float market cap (how Nifty is weighted). Stays on the last session's pre-open until the next one.
const GAP = 0.25  // % beyond which the open counts as a gap
function PreOpenCard({ res, which, label, short }) {
  const d = res.data?.data, g = d?.[which], p = g?.est_pct
  const [day, time] = (d?.at || '').split(' ')
  const gap = !isNum(p) ? null : p > GAP ? ['Gap up', 'bull'] : p < -GAP ? ['Gap down', 'bear'] : ['Flat', 'neutral']
  const list = xs => xs.map(([s, v]) => `${s} ${fmtPct(v)}`).join(', ') || 'none'
  return <div className={'card tinted ' + tone(p)}
    title={g ? `${label} pre-open ${d.at} IST · top gainers: ${list(g.gainers)} · losers: ${list(g.losers)}. Estimate only: the real open can differ.` : undefined}>
    <div className="card-k"><span className="ck-t">Pre-Open {short ? <><span className="c-hide">{label}</span><span className="c-only">{short}</span></> : label}</span>{gap && <span className={'vix-tag ' + gap[1]}>{gap[0]}</span>}</div>
    <div className={'card-v ' + tone(p)}>{isNum(p) ? fmtPct(p) : '—'}</div>
    <div className="card-d muted">{g ? <><span className="c-hide">{g.up} up · {g.down} down · {g.unchanged} unch</span><span className="c-only">{g.up}↑ {g.down}↓</span></> : res.error || res.data?.error ? 'Pre-open data unavailable' : 'Loading…'}</div>
    <div className="card-n">{d ? `${day.split('-').slice(0, 2).join(' ')} · ${time?.slice(0, 5)} IST (9:00–9:08)` : 'NSE pre-open, 9:00–9:08 IST'}</div>
  </div>
}

function SummaryCards({ live }) {
  const { indices } = live
  const pre = usePoll(() => api('/api/preopen'), 60000, [])
  return <div className="cards four idx-five idx-six">
    <PreOpenCard res={pre} which="nifty50" label="Nifty 50" short="N50" />
    <PreOpenCard res={pre} which="fo" label="F&O" />
    <IndexCard name="INDIA VIX" label="India VIX" q={indices.indiavix} vix />
    <IndexCard name="NIFTY 50" label="NIFTY 50" q={indices.nifty50} />
    <IndexCard name="NIFTY BANK" label="NIFTY BANK" q={indices.niftybank} />
    <IndexCard name="SENSEX" label="SENSEX" q={indices.sensex} />
  </div>
}

// card: compact version shown inside the FII / DII box (title + stats + bar; stocks list under the button).
export function BreadthPanel({ title, subtitle, b, alt, rows, showTotal, noStocks = false, card = false }) {
  const [open, setOpen] = useState(false)
  const pctUp = b.total ? Math.round(b.up / b.total * 100) : 0
  const pctDn = b.total ? Math.round(b.down / b.total * 100) : 0
  const sorted = useMemo(() => [...rows].sort((a, c) => (c.pct_prev ?? -1e9) - (a.pct_prev ?? -1e9)), [rows])
  const toggle = !noStocks && <button className="btn ghost sm" onClick={() => setOpen(o => !o)}>{open ? 'Hide stocks' : 'Show stocks'}</button>
  const wrap = card ? children => <div className="panel breadth-card" title={subtitle}><div className="panel-head"><h3>{title}</h3>{toggle}</div>{children}</div>
    : children => <Section title={title} subtitle={subtitle} className="half" right={toggle}>{children}</Section>
  return wrap(<>
    <div className="breadth-stats">{[  // short labels in the small cards so the numbers fit one row
      ['Advancing', 'Adv', b.up, 'up'], ['Declining', 'Dec', b.down, 'down'], ['Unchanged', 'Unch', b.unchanged, 'flat'],
      ...(showTotal ? [['Total', 'Total', b.total, '']] : []), ['A/D Ratio', 'A/D', isNum(b.ad_ratio) ? b.ad_ratio.toFixed(2) : 'N/A', '']]
      .map(([full, short, v, cls]) => <div key={full} title={full}><div className="k">{card ? short : full}</div><div className={'big ' + cls}>{v}</div></div>)}
    </div>
    <BreadthBar up={b.up} down={b.down} unchanged={b.unchanged} />
    <div className="bbar-legend"><span className="up">{pctUp}% Advancing</span><span className="down">{pctDn}% Declining</span></div>
    {alt && <div className="muted small">vs today's open: {alt.up} up / {alt.down} down / {alt.unchanged} unchanged</div>}
    {open && <div className="chip-grid">{sorted.map(s => <a key={s.symbol} className={'chip ' + tone(s.pct_prev)}
      href={tvStock(s.symbol)} target="_blank" rel="noopener noreferrer"
      title={`${s.company} · ${fmtPct(s.pct_prev)} vs prev close · open ${tvSymbol(s.symbol)} on TradingView`}>
      {s.symbol}<b>{fmtPct(s.pct_prev)}</b></a>)}</div>}
  </>)
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
  return <Section title="Global Cues" subtitle="Context only, not a trading signal" className="cues"
    right={g?.fetched_at && <span className="muted small">Fetched {istTime(g.fetched_at)}{g.error ? ' · refresh failed, showing last data' : ''}</span>}>
    <div className="cards six">{(g?.data || ['GIFT Nifty', 'Dow Jones', 'S&P 500', 'Nasdaq', 'Nikkei 225', 'Hang Seng'].map(label => ({ label }))).map(r =>
      <div className={'card tinted ' + tone(r.change)} key={r.label}>
        <div className="card-k">{r.label}<span className={'status-tag ' + (r.status || '').toLowerCase().replace(/\s/g, '-')}>{r.status || 'N/A'}</span></div>
        <div className="card-v">{fmtNum(r.last)}</div>
        <div className={'card-d ' + tone(r.change)}>{fmtSigned(r.change)} <span>{fmtPct(r.pct)}</span></div>
        <div className="card-n">{r.as_of ? `as of ${istDate(r.as_of)} ${istTime(r.as_of).slice(0, 5)} IST` : 'N/A'}{r.note ? ' · ' + r.note.replace(/-\d{4}$/, '') : ''}</div>
      </div>)}</div>
  </Section>
}

function FiiDii({ ctx, children }) {
  const f = ctx?.fii_dii
  const d = f?.data
  const date = d?.fii?.date || d?.dii?.date || 'N/A'
  const signed = v => isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + fmtNum(Math.abs(v)) : 'N/A'
  const row = (label, x) => <tr><td className="strong">{label}</td><td className="num">{fmtNum(x?.buy)}</td><td className="num">{fmtNum(x?.sell)}</td>
    <td className={'num strong ' + tone(x?.net)}>{signed(x?.net)}</td></tr>
  return <Section title={`FII / DII Activity (Data date - ${date})`} subtitle="Cash market, provisional (NSE) — not live intraday" className="c-hide">
    <div className="panel tbl-wrap"><table className="tbl compact">
      <thead><tr><th>₹ Cr</th><th className="num">Buy</th><th className="num">Sell</th><th className="num">Net</th></tr></thead>
      <tbody>{row('FII / FPI', d?.fii)}{row('DII', d?.dii)}</tbody>
    </table></div>
    {children}
  </Section>
}

// Plain-language guide at the bottom of Market Overview (written for a first-time reader).
const HOW_TO = [
  ['🌍', 'Global Cues', 'How markets in other countries did. Like checking the weather in nearby towns before you go out. It is a hint, not a rule.'],
  ['📊', 'Nifty 50, Nifty Bank, Sensex', 'Each one is a "score" for a group of big Indian companies. Green and + means the score went up today. Red and − means it went down.'],
  ['😨', 'India VIX', 'The "fear meter". When it goes up, people are more worried. When it goes down, people are calmer.'],
  ['📏', 'Expected Move (pill beside Nifty PCR)', 'How far option traders expect Nifty to move by this expiry. ±234 means Nifty will probably stay between the two numbers shown, about 2 times out of 3. Higher fear (VIX) = a wider range. It shrinks as expiry gets closer.'],
  ['🌅', 'Pre-Open', 'NSE runs a short "warm-up" from 9:00 to 9:08 am where prices are set before the market opens. The two Pre-Open cards turn the warm-up prices of the Nifty 50 stocks and of the F&O stocks into one number each. Gap up = the day is likely to start higher than yesterday\'s close. Gap down = lower. Flat = about the same. It is only a starting hint: the market can turn after 9:15.'],
  ['🏦', 'FII / DII', 'What the big money did yesterday. FII = big foreign investors, DII = big Indian investors. + means they bought more than they sold. − means they sold more.'],
  ['🔔', 'Alerts (🔕 Bias button at the top)', 'Tap it and allow notifications. Your phone then beeps when Market Bias or Nifty OI Change turns Bullish, Neutral or Bearish during market hours, even when it is locked. On iPhone, first add the site to your Home Screen (the site shows you how).'],
  ['📱', 'On a phone', 'The small cards at the top show the short version: Market Bias, Nifty OI Change, Nifty PCR, Expected Move, the up/down counts and FII / DII. Each card has its name on top and its value below. Green = good sign, red = bad sign, amber = mixed. Want every number? Turn on the Full data switch at the top to see the big panels instead.'],
  ['🧮', 'Breadth (Nifty 50 and F&O)', 'Counts how many stocks went up and how many went down. Like a class test: if most students scored better, the class did well. If only the toppers did well, it was not a good day for everyone.'],
  ['🧭', 'Market Bias', 'A vote of 5 simple checks (Nifty, fear meter, and three up/down counts). Each check gives +1 or −1. Bullish = most checks are happy. Bearish = most checks are sad. Neutral = mixed.'],
  ['⚖️', 'Nifty PCR (OI)', 'Compares two kinds of option bets on Nifty. Around 1 = balanced. Very high (above 1.5) = everyone is too sure the market will go up, so it may cool down. Very low (below 0.7) = everyone is too scared, so it may bounce back.'],
  ['🧱', 'Nifty OI Change', 'Where big option traders put new money today. More new puts = they are building a "floor" under Nifty (Bullish). More new calls = they are building a "ceiling" over Nifty (Bearish).'],
  ['🚀', 'Top Movers', 'The stocks that went up the most, went down the most, and were traded the most today.'],
]

// Live check for the 3 steps: Market Bias, Nifty OI Change and F&O breadth (most stocks) each read
// as up / down / mixed. Green = all 3 up, red = all 3 down, amber = they disagree.
export function useAgreement(live) {
  const { s } = useOiChange()
  const bias = live?.bias?.label, fo = live?.breadth?.fo  // live is null until the first snapshot
  const steps = [
    ['Market Bias', bias === 'BULLISH' ? 'up' : bias === 'BEARISH' ? 'down' : 'mixed', bias ? bias[0] + bias.slice(1).toLowerCase() : 'N/A'],
    ['Nifty OI Change', !s ? null : s.sent.key === 'bull' ? 'up' : s.sent.key === 'bear' ? 'down' : 'mixed', s ? s.sent.label : 'Loading…'],
    ['Breadth (F&O stocks)', !fo ? null : fo.up > fo.down ? 'up' : fo.down > fo.up ? 'down' : 'mixed', fo ? `${fo.up} up / ${fo.down} down` : 'N/A'],
  ]
  if (steps.some(x => !x[1])) return { steps, key: 'wait', label: 'Checking…', text: 'Waiting for data.' }
  const dirs = steps.map(x => x[1])
  if (dirs.every(d => d === 'up')) return { steps, key: 'up', label: 'Clear: all 3 Bullish', text: 'Mood, big traders and most stocks all point up.' }
  if (dirs.every(d => d === 'down')) return { steps, key: 'down', label: 'Clear: all 3 Bearish', text: 'Mood, big traders and most stocks all point down.' }
  return { steps, key: 'amber', label: 'Mixed: they disagree', text: 'The 3 checks do not agree. Slow down and wait for the market to show its way.' }
}

function HowToRead({ live }) {
  const a = useAgreement(live)
  return <PageGuide items={HOW_TO}>
    <div className="howto-steps">
      <div className="howto-now">
        <span className={'howto-dot ' + a.key} aria-hidden="true" />
        <b>Putting it together, in 3 steps</b>
        <span className={'howto-verdict ' + a.key}>Right now: {a.label}</span>
        <span className="muted small">{a.text}</span>
        <span className="howto-checks">{a.steps.map(([k, d, v], i) => <span key={k} className={'howto-chk ' + (d || 'wait')}>
          <i className={'howto-dot sm ' + (d === 'mixed' ? 'amber' : d || 'wait')} />{i + 1}. {k}: <b>{v}</b></span>)}</span>
      </div>
      <ol>
        <li><b>What is the mood?</b> Look at <b>Market Bias</b>: Bullish, Bearish or Neutral.</li>
        <li><b>Do the big traders agree?</b> Look at <b>Nifty OI Change</b>. Is it the same as Market Bias?</li>
        <li><b>Are most stocks joining in?</b> Look at the <b>Breadth</b> boxes. Are more stocks going up or going down?</li>
      </ol>
      <div className="howto-read">
        <span className="up">All 3 say the same thing</span> → the picture is clear. ·
        <span className="amber"> They disagree</span> → the picture is mixed: slow down and wait for the market to show its way. (Example: Nifty up, but most stocks down = only a few big stocks are pulling Nifty up.)
      </div>
      <p className="muted small">Remember: these boxes are clues, like a weather report. They do not tell you to buy or sell, and they can be wrong. Always check the price chart, and never risk money you cannot afford to lose.</p>
    </div>
  </PageGuide>
}

// Same layout in Basic and Advanced (the PCR bar above the page is set in main.jsx): Global Cues | FII/DII
// (with the breadth cards), Indian Markets (index cards), Market Bias beside Nifty OI Change, Top Movers,
// then "How to read this page" with the live 3-step check and the disclaimer.
export default function Overview({ live, ctx }) {
  if (!live) return <Empty>Loading live market data…</Empty>
  const n50 = live.stocks.filter(s => s.n50)
  const fo = live.stocks.filter(s => s.fo)
  return <div className="ov">
    <div className="page-title"><h1>Market Overview</h1>
      <span className="muted small">Quotes as of {live.source_ts ? istTime(nseTs(live.source_ts)) : 'N/A'} IST (latest exchange tick)</span></div>
    <div className="two-col wide-left">
      <GlobalCues ctx={ctx} />
      <FiiDii ctx={ctx}><div className="breadth-cards">
        <BreadthPanel card noStocks title="Nifty 50 Breadth" subtitle="Advance / decline vs previous close (NSE convention)" b={live.breadth.nifty50} rows={n50} />
        <BreadthPanel card noStocks title="F&O Universe Breadth" subtitle="NSE stocks with F&O contracts · vs previous close" b={live.breadth.fo} rows={fo} showTotal />
      </div></FiiDii>
    </div>
    <Section title="Indian Markets" subtitle="Pre-open, India VIX and indices · change vs previous close" className="idx-section"><SummaryCards live={live} /></Section>
    <div className="bias-row oi c-hide">  {/* compact phone view: Market Bias and OI Change are in the small cards at the top */}
      <MarketBias bias={live.bias} />
      <OiChange nifty={live.indices.nifty50} />
    </div>
    <TopMovers stocks={live.stocks} baseline={live.volume_baseline} />
    <HowToRead live={live} />
  </div>
}
