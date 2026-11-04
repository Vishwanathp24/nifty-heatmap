import React, { useMemo, useState } from 'react'
import { Empty, Section, Seg } from './components.jsx'
import { OWNER_UNLOCKED, api, isNum, lockOwner, istTime, usePersistentState, usePoll } from './lib.js'
import { OiBars, oiSentiment, shares } from './Pcr.jsx'

// Kite Live: live index quotes and option-chain OI from the owner's own Zerodha Kite Connect app.
// Private (needs the dashboard access key: the owner's build, or a browser unlocked at /?owner). Kite access
// tokens end every morning, so the page asks for a Kite login once a day. OI change = live OI minus the
// previous close OI from the NSE option chain (Kite quotes don't carry it).

const INDICES = [['NIFTY', 'Nifty'], ['BANKNIFTY', 'Bank Nifty'], ['FINNIFTY', 'Fin Nifty'], ['MIDCPNIFTY', 'Midcap'], ['SENSEX', 'Sensex']]
const STRIKES = [{ value: 5, label: '±5' }, { value: 10, label: '±10' }, { value: 20, label: '±20' }]
const SPEEDS = [{ value: 3000, label: '3 s' }, { value: 5000, label: '5 s' }, { value: 15000, label: '15 s' }]
const n2 = v => isNum(v) ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'
const sign = v => !isNum(v) ? '' : v > 0 ? 'up' : v < 0 ? 'down' : ''
const pct = (a, b) => isNum(a) && isNum(b) && b ? (a - b) / Math.abs(b) * 100 : null

export default function Kite() {
  const [n, setN] = useState(0)
  const st = usePoll(() => api('/api/kite/status'), 60000, [n])
  const reload = () => setN(x => x + 1)
  const s = st.data
  return <div className="kite">
    {!s ? <Empty>{st.error || 'Checking your Kite connection…'}</Empty>
      : !s.configured ? <Setup onDone={reload} />
      : !s.logged_in ? <Login s={s} reload={reload} />
      : <Live s={s} reload={reload} />}
  </div>
}

const CALLBACK = window.location.origin + '/kite/callback'

function Setup({ onDone, initial }) {
  const [f, setF] = useState({ api_key: initial?.api_key || '', api_secret: '' })
  const [err, setErr] = useState(null), [busy, setBusy] = useState(false)
  const save = async e => {
    e.preventDefault(); setBusy(true); setErr(null)
    try { await api('/api/kite/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) }); onDone?.() }
    catch (x) { setErr(x.message) } finally { setBusy(false) }
  }
  const field = (k, label, type = 'text') => <label className="fy-field"><span>{label}</span>
    <input type={type} value={f[k]} autoComplete="off" spellCheck={false} onChange={e => setF({ ...f, [k]: e.target.value })} /></label>
  return <Section title="Connect your Zerodha Kite account" subtitle="One-time setup. Your API key and secret are kept in a private file on the server and are only sent to Zerodha.">
    <ol className="fy-steps">
      <li>Open <a href="https://developers.kite.trade/apps" target="_blank" rel="noopener noreferrer">developers.kite.trade</a>, log in and open your app.</li>
      <li>Set the <b>Redirect URL</b> to exactly: <code>{CALLBACK}</code></li>
      <li>Copy the <b>API key</b> and <b>API secret</b> into the boxes below and save. Live quotes need a paid <b>Kite Connect</b> app (the free Personal app has no market data).</li>
    </ol>
    <form className="fy-form" onSubmit={save}>
      {field('api_key', 'API key')}
      {field('api_secret', 'API secret', 'password')}
      <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      {err && <span className="down small">{err}</span>}
    </form>
  </Section>
}

function Login({ s, reload }) {
  const [err, setErr] = useState(null), [edit, setEdit] = useState(false)
  const go = async () => {
    setErr(null)
    try { window.location.href = (await api('/api/kite/login-url')).url } catch (x) { setErr(x.message) }
  }
  if (edit) return <Setup initial={s} onDone={() => { setEdit(false); reload() }} />
  return <Section title="Log in to Kite" subtitle="Kite logins end every morning, so this is needed once a day.">
    <p>API key <code>{s.api_key}</code> · comes back to <code>{CALLBACK}</code></p>
    <div className="fy-actions"><button className="btn primary" onClick={go}>Log in with Kite</button>
      <button className="btn ghost sm" onClick={() => setEdit(true)}>Change API key / secret</button></div>
    {err && <p className="down small">{err}</p>}
  </Section>
}

function Live({ s, reload }) {
  const [index, setIndex] = usePersistentState('kite.index', 'NIFTY')
  const [strikes, setStrikes] = usePersistentState('kite.strikes', 10)
  const [speed, setSpeed] = usePersistentState('kite.speed', 3000)
  const [expiry, setExpiry] = useState('')
  const res = usePoll(() => api(`/api/kite/live?index=${index}&strikes=${strikes}&expiry=${expiry}`), speed, [index, strikes, expiry, speed])
  const nse = usePoll(() => api('/api/index-options?symbol=NIFTY'), 30000, [])
  const d = res.data, c = d?.chain
  const sum = useMemo(() => {
    const ch = c?.chain || []
    if (!ch.length) return null
    const t = (side, k) => ch.reduce((a, r) => a + (Number(r[side]?.[k]) || 0), 0)
    const cc = t('call', 'oi_chg'), pc = t('put', 'oi_chg'), co = t('call', 'oi'), po = t('put', 'oi')
    return { cc, pc, co, po, pcr: co ? po / co : null, open: co - cc ? (po - pc) / (co - cc) : null, chgRatio: cc > 0 && pc > 0 ? pc / cc : null,
      lo: ch[0].k, hi: ch[ch.length - 1].k, sent: oiSentiment(cc, pc) }
  }, [c])
  const nearest = c && (!expiry || expiry === c.expiries?.[0]?.ts)
  const cmp = useMemo(() => {  // same strikes from the NSE option chain the rest of the site uses
    const e = nse.data?.expiries?.[0], lot = nse.data?.lot
    if (!sum || !e || !lot || index !== 'NIFTY' || !nearest) return null
    const ks = new Set(c.chain.map(r => r.k)), rows = (e.chain || []).filter(r => ks.has(r.k))
    if (!rows.length) return null
    const t = (side, k) => rows.reduce((a, r) => a + (Number(r[side]?.[k]) || 0), 0) * lot
    const co = t('call', 'oi'), po = t('put', 'oi')
    return { co, po, cc: t('call', 'oi_chg'), pc: t('put', 'oi_chg'), pcr: co ? po / co : null, at: nse.data.fetched_at, n: rows.length }
  }, [sum, nse.data, index, nearest, c])
  const logout = async () => { await api('/api/kite/logout', { method: 'POST' }).catch(() => {}); reload() }

  return <>
    <div className="fy-bar">
      <span className="fy-who">🟢 Kite: <b>{s.name || s.user_id || 'connected'}</b></span>
      <span className="muted small">Live · every {speed / 1000} s{d?.chain?.at && <> · {istTime(d.chain.at)} IST</>}</span>
      <Seg options={SPEEDS} value={speed} onChange={setSpeed} />
      <button className="btn ghost sm" onClick={logout}>Log out</button>
      {OWNER_UNLOCKED && <button className="btn ghost sm" title="Forget the owner key in this browser" onClick={() => { lockOwner(); window.location.replace('/') }}>Lock this browser</button>}
    </div>
    {res.error && <div className="alert">{res.error}{/expired|log in/i.test(res.error) && <> <button className="btn sm" onClick={reload}>Log in again</button></>}</div>}
    {d && <div className="cards fy-quotes">{d.quotes.map(q => <div key={q.symbol} className={'card tinted ' + sign(q.chg)}>
      <div className="card-k">{q.name}</div>
      <div className="card-v">{n2(q.ltp)}</div>
      <div className={'card-n ' + sign(q.chg)}>{q.chg > 0 ? '+' : ''}{n2(q.chg)} <span>({q.chg_pct > 0 ? '+' : ''}{n2(q.chg_pct)}%)</span></div>
      <div className="card-n muted small">O {n2(q.open)} · H {n2(q.high)} · L {n2(q.low)}</div>
    </div>)}</div>}

    <Section title={`${INDICES.find(i => i[0] === index)?.[1]} OI Change (Kite live)`}
      subtitle={c ? `Spot ${n2(c.spot)} · ATM ${n2(c.atm)} · strikes ${n2(sum?.lo)}–${n2(sum?.hi)} · OI in shares` : 'Loading the option chain…'}
      right={<div className="fy-ctrls">
        <Seg options={INDICES.map(([value, label]) => ({ value, label }))} value={index} onChange={v => { setIndex(v); setExpiry('') }} />
        <Seg options={STRIKES} value={strikes} onChange={setStrikes} />
        {c?.expiries?.length > 0 && <select className="fy-exp" value={expiry || c.expiry} onChange={e => setExpiry(e.target.value === c.expiries[0].ts ? '' : e.target.value)}>
          {c.expiries.slice(0, 8).map(x => <option key={x.ts} value={x.ts}>{x.label}</option>)}</select>}
      </div>} className="oi-section">
      {c && !c.has_prev && <div className="alert">OI change isn’t available for this index / expiry (no previous-close OI from NSE), so only total OI is meaningful here.</div>}
      {!sum ? <Empty>{res.error || 'Loading the Kite option chain…'}</Empty> : <div className="oi-grid">
        <div className={'bias-main oi-sent ' + sum.sent.key}>
          <div className="k">Market Sentiment (OI)</div>
          <div className="bias-label">{sum.sent.label}</div>
          {isNum(sum.sent.pct) && <div className="bias-score">{sum.sent.key === 'bear' ? 'Calls' : 'Puts'} {sum.sent.pct}% of fresh OI</div>}
          <div className="oi-pcr">PCR <b>{sum.pcr?.toFixed(2) ?? '—'}</b>{isNum(sum.open) && <span className={sum.pcr >= sum.open ? 'up' : 'down'}> ({sum.pcr >= sum.open ? '+' : ''}{(sum.pcr - sum.open).toFixed(2)})</span>}
            <br />PCR OI change <b>{sum.chgRatio ? sum.chgRatio.toFixed(2) : '—'}</b></div>
        </div>
        <OiBars title="Open Interest Change" c={sum.cc} p={sum.pc} signed />
        <OiBars title="Total Open Interest" c={sum.co} p={sum.po} />
        <div className="oi-read"><b>Analysis</b>
          <p>Calls {sum.cc > 0 ? '+' : ''}{shares(sum.cc)}, puts {sum.pc > 0 ? '+' : ''}{shares(sum.pc)} since the previous close. {sum.sent.why}</p>
          {isNum(sum.open) && <p>PCR moved from {sum.open.toFixed(2)} at the open to {sum.pcr.toFixed(2)}.</p>}
          <p className="muted small">A positioning read, not a buy/sell signal.</p></div>
      </div>}
    </Section>

    {cmp && <Section title="Kite vs NSE option chain" subtitle={`Same ${cmp.n} strikes, nearest expiry · NSE read at ${istTime(cmp.at)} IST (refreshes about every 30 s), Kite live`}>
      <table className="tbl compact fy-cmp"><thead><tr><th></th><th className="num">Kite</th><th className="num">NSE (site)</th><th className="num">Difference</th></tr></thead>
        <tbody>{[['Call OI', sum.co, cmp.co, shares], ['Put OI', sum.po, cmp.po, shares], ['Call OI change', sum.cc, cmp.cc, shares], ['Put OI change', sum.pc, cmp.pc, shares], ['PCR', sum.pcr, cmp.pcr, v => v?.toFixed(2)]].map(([l, a, b, f]) => {
          const p = pct(a, b)
          return <tr key={l}><td>{l}</td><td className="num">{f(a)}</td><td className="num">{f(b)}</td><td className={'num ' + (isNum(p) && Math.abs(p) > 2 ? 'amber' : 'muted')}>{isNum(p) ? `${p > 0 ? '+' : ''}${p.toFixed(1)}%` : '—'}</td></tr>
        })}</tbody></table>
    </Section>}

    {c?.chain?.length > 0 && <Section title="Option chain (Kite live)" subtitle="OI and OI change in shares; LTP change vs previous close. ATM strike highlighted.">
      <div className="tbl-wrap"><table className="tbl compact fy-chain">
        <thead><tr><th className="num">Call OI</th><th className="num">OI chg</th><th className="num">Vol</th><th className="num">LTP</th><th className="num fy-k">Strike</th><th className="num">LTP</th><th className="num">Vol</th><th className="num">OI chg</th><th className="num">Put OI</th></tr></thead>
        <tbody>{c.chain.map(r => <tr key={r.k} className={r.k === c.atm ? 'fy-atm' : ''}>
          <td className="num">{shares(r.call?.oi || 0)}</td><td className={'num ' + sign(r.call?.oi_chg)}>{shares(r.call?.oi_chg || 0)}</td>
          <td className="num muted">{shares(r.call?.vol || 0)}</td><td className={'num ' + sign(r.call?.chg)}>{n2(r.call?.ltp)}</td>
          <td className="num fy-k"><b>{n2(r.k)}</b></td>
          <td className={'num ' + sign(r.put?.chg)}>{n2(r.put?.ltp)}</td><td className="num muted">{shares(r.put?.vol || 0)}</td>
          <td className={'num ' + sign(r.put?.oi_chg)}>{shares(r.put?.oi_chg || 0)}</td><td className="num">{shares(r.put?.oi || 0)}</td>
        </tr>)}</tbody></table></div>
    </Section>}

    <details className="panel fy-guide"><summary><b>How to read this page</b></summary><ul>
      <li><b>Private:</b> only you see this view (your own build, or a browser you unlocked with the owner key). It uses your Zerodha Kite login.</li>
      <li><b>Login:</b> Kite logins end every morning, so tap “Log in with Kite” once a day.</li>
      <li><b>Index cards:</b> live price, change from the previous close, and today’s open / high / low.</li>
      <li><b>OI Change:</b> the same reading as the site’s Nifty OI Change panel, but with live OI from Kite, refreshed every few seconds. Kite doesn’t give yesterday’s OI, so the change is live OI minus the previous close OI from the NSE option chain. Pick the index, the strikes (±5 / ±10 / ±20 around the at-the-money strike) and the expiry.</li>
      <li><b>Kite vs NSE:</b> for Nifty’s nearest expiry, the same strikes from the NSE chain the rest of the site uses, with the difference. Small gaps are normal because NSE’s chain updates every 30–60 s.</li>
      <li><b>Option chain:</b> calls on the left, puts on the right; the at-the-money strike is highlighted. Not a buy / sell signal.</li>
    </ul></details>
  </>
}
