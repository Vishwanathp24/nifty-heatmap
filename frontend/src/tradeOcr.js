// Journal -> "Scan broker screenshot": reads a broker order / position / trade-book screenshot (or a
// camera photo) in the browser with Tesseract.js (nothing is uploaded) and pulls out option trades:
// underlying, strike, CE / PE, expiry, buy / sell, quantity, average prices, time.
// Broker layouts differ (Kite, Groww, Upstox, Angel, Dhan…), so parsing is pattern-based and every
// result is shown for the user to check before it fills the form.

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

// Scale up, grey-scale, flip dark-mode screenshots to dark-on-light and stretch contrast — OCR reads
// phone screenshots far better this way.
async function prepare(file) {
  const img = await createImageBitmap(file)
  const scale = Math.min(3, Math.max(1, 2600 / img.width))
  const c = document.createElement('canvas')
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale)
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0, c.width, c.height)
  const px = g.getImageData(0, 0, c.width, c.height), d = px.data
  let sum = 0
  for (let i = 0; i < d.length; i += 4) { const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = y; sum += y }
  const dark = sum / (d.length / 4) < 110
  let lo = 255, hi = 0
  for (let i = 0; i < d.length; i += 4) { let y = d[i]; if (dark) y = 255 - y; d[i] = y; if (y < lo) lo = y; if (y > hi) hi = y }
  // Stretch, then darken mid-greys hard: brokers draw closed / secondary rows in light grey (Angel One),
  // which OCR otherwise skips. White stays white.
  const k = 255 / Math.max(1, hi - lo)
  for (let i = 0; i < d.length; i += 4) { const y = 255 * ((d[i] - lo) * k / 255) ** 3; d[i] = d[i + 1] = d[i + 2] = y }
  g.putImageData(px, 0, 0)
  return c
}

let worker = null
export async function readImage(file, onProgress) {
  const { createWorker } = await import('tesseract.js')
  if (!worker) worker = await createWorker('eng', 1, { logger: m => m.status === 'recognizing text' && onProgress?.(m.progress) })
  const canvas = await prepare(file)
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true })
  return layoutText(data) || data.text || ''
}

// Broker screens are tables, often with side panels (watchlists, totals). Plain OCR text reads straight
// across the page and mixes them into the trade rows, so rebuild rows from word positions: group words
// into visual lines by height, then for every line holding an option symbol take only the words to the
// right of the symbol within its own row band (half-way to the neighbouring symbol rows). Each trade
// becomes its own block of text for parseTrades. Works for any layout; falls back to plain text.
function layoutText(data) {
  const words = []
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) {
    if (w.text?.trim()) words.push({ t: w.text.trim(), x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0, y1: w.bbox.y1, yc: (w.bbox.y0 + w.bbox.y1) / 2 })
  }
  if (!words.length) return ''
  words.sort((a, b) => a.yc - b.yc)
  const lines = []
  for (const w of words) {
    const h = w.y1 - w.y0, l = lines[lines.length - 1]
    if (l && Math.abs(w.yc - l.yc) < Math.max(h, l.h) * 0.5) { l.words.push(w); l.yc = (l.yc * (l.words.length - 1) + w.yc) / l.words.length }
    else lines.push({ yc: w.yc, h, words: [w] })
  }
  for (const l of lines) l.words.sort((a, b) => a.x0 - b.x0)
  // symbol lines: find where the match starts to know the row's left edge
  const rows = []
  for (const l of lines) {
    const text = l.words.map(w => w.t).join(' ')
    const up = clean(text.toUpperCase())
    const m = [...up.matchAll(SYM)].find(x => !SKIP.has(x[1]) && !MONTH.test(x[1])) || up.match(NONAME)
    if (!m) continue
    const first = m[0].trim().split(/\s+/)[0]
    const w0 = l.words.find(w => clean(w.t.toUpperCase()).startsWith(first.slice(0, 3))) || l.words[0]
    rows.push({ l, x: w0.x0 - 4 })
  }
  if (!rows.length) return ''
  return rows.map((r, i) => {
    const top = i ? (rows[i - 1].l.yc + r.l.yc) / 2 : r.l.yc - 3 * r.l.h
    const bot = i < rows.length - 1 ? (rows[i + 1].l.yc + r.l.yc) / 2 : r.l.yc + 3 * r.l.h
    return lines.filter(l => l.yc >= top && l.yc < bot)
      .map(l => l.words.filter(w => w.x1 > r.x).map(w => w.t).join(' '))
      .filter(Boolean).join('\n')
  }).join('\n\n')
}

const toNum = s => s == null ? null : +String(s).replace(/,/g, '')
const clean = t => t
  .replace(/[|]/g, ' ').replace(/₹|Rs\.?/gi, ' ')
  .replace(/(\d)\s*[oO](?=\d)/g, '$10')        // 23O00 -> 23000
  .replace(/\b(C|P)\s*E\b/g, '$1E')            // "C E" -> CE
  .replace(/\bCALL\b/gi, 'CE').replace(/\bPUT\b/gi, 'PE')
  .replace(/[(\[{]\s*(CE|PE)\b/g, ' $1')                                  // "(CE" pill badges
  .replace(/(\d)(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(20\d\d)/g, '$1 $2 $3')  // 27OCT2026
  .replace(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*(20\d\d)(\d{2,6})\s*(CE|PE)\b/g, '$1 $2 $3 $4')  // OCT 2026115 PE
  .replace(/\bNSEFO\b/g, 'NSE FO')
  .replace(/[ \t]+/g, ' ')

// Option symbol in its common broker spellings:
//   NIFTY 23000 CE · NIFTY 16 OCT 23000 CE · NIFTY 16th OCT 23000 CE · NIFTY24OCT23000CE · NIFTY2410223000CE
//   Nifty 23000 Call 17 Oct (Groww) · RELIANCE 1300 PE · PNB NSE FO 27 Oct 2026 115 PE (Angel One)
const SYM = /\b(BANKNIFTY|FINNIFTY|MIDCPNIFTY|NIFTY|SENSEX|BANKEX|[A-Z][A-Z&-]{1,14})(?:\s+(?:NSE|BSE|NFO|BFO)(?:\s*FO)?)?\s*((?:\d{1,2}(?:ST|ND|RD|TH)?\s*[A-Z]{3}(?:\s*\d{2,4}(?!\d))?)|(?:\d{2}[A-Z]{3})|(?:\d{2}[1-9OND]\d{2}))?\s*(\d{2,6}(?:\.\d+)?)\s*(CE|PE)\b/g
// Same, when the underlying's name was lost (light-grey text): "27 OCT 2026 115 PE" — filled from the
// other rows of the same screenshot afterwards.
const NONAME = /(?:^|\s)((?:\d{1,2}\s*)?(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?:\s*20\d\d)?)\s+(\d{2,6}(?:\.\d+)?)\s*(CE|PE)\b/
const MONTH = /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)$/
const SKIP = new Set(['BUY', 'SELL', 'QTY', 'AVG', 'LTP', 'PRICE', 'TOTAL', 'NSE', 'BSE', 'NFO', 'BFO', 'MIS', 'NRML', 'CNC', 'OPEN', 'EXECUTED', 'COMPLETE', 'FO', 'INT', 'CLOSED', 'LOT', 'LOTS', 'GAIN', 'LOSS'])

function expiryOf(s, after) {
  const m = (s || '').match(/(\d{1,2})(?:ST|ND|RD|TH)?\s*([A-Z]{3})/) || (after || '').match(/^\s*(\d{1,2})(?:ST|ND|RD|TH)?\s*([A-Z]{3})\b/i)
  if (!m) return null
  const mon = m[2].toUpperCase()
  return MONTHS.includes(mon) ? { day: +m[1], mon } : null
}

export function parseTrades(raw) {
  // layoutText() separates rows with blank lines: parse each row on its own
  const blocks = raw.split(/\n\s*\n/).filter(b => b.trim())
  const rows = blocks.length > 1 ? blocks.flatMap(b => parseBlock(b, true)) : parseBlock(raw, false)
  // underlying lost on a row -> the one the other rows share
  const counts = {}
  for (const r of rows) if (r.und) counts[r.und] = (counts[r.und] || 0) + 1
  const common = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
  const expC = rows.find(r => r.und === common && r.expiry)?.expiry
  for (const r of rows) if (!r.und) { r.und = common || '?'; r.undGuess = true; r.expiry = r.expiry || expC }
  return rows
}

function parseBlock(raw, single) {
  const text = clean(raw.toUpperCase())
  let hits = [...text.matchAll(SYM)].filter(m => !SKIP.has(m[1]) && !MONTH.test(m[1]))
  if (!hits.length && single) {
    const m = text.match(NONAME)
    if (m) hits = [Object.assign([m[0], null, m[1], m[2], m[3]], { index: m.index })]
  }
  const out = []
  hits.forEach((m, i) => {
    const start = Math.max(0, (hits[i - 1] ? hits[i - 1].index + hits[i - 1][0].length : 0), m.index - 120)
    const end = hits[i + 1]?.index ?? Math.min(text.length, m.index + m[0].length + 400)
    const before = text.slice(start, m.index), after = text.slice(m.index + m[0].length, end)
    let und = m[1]
    if (und && und === 'NIFTY' && /BANK/.test(before.slice(-12))) und = 'BANKNIFTY'
    const k = toNum(m[3]), t = m[4]
    // Labels (BUY, qty, time) usually sit just before the symbol (Kite) or after it (Groww); prices after it.
    const lastLines = before.split('\n').slice(-3).join(' ')
    const pick = (re, order) => { for (const part of order) { const x = part.match(re); if (x) return x } return null }
    const near2 = [lastLines, after]
    const act = (pick(/\b(BUY|SELL|BOUGHT|SOLD)\b/, near2) || [])[1]
    let a = act ? (/^B/.test(act) ? 'B' : 'S') : null
    // quantity: "Qty 65", "Qty. 65/65", "65 qty", "Quantity 130"
    const qm = pick(/\bQ(?:TY|UANTITY)\.?\s*[:\-]?\s*(\d[\d,]*)(?:\s*\/\s*(\d[\d,]*))?/, near2) || pick(/\b(\d[\d,]*)\s*(?:\/\s*(\d[\d,]*)\s*)?QTY\b/, near2)
      || pick(/\b(\d[\d,]*)\s*\/\s*(\d[\d,]*)\b/, near2)  // Kite orders: filled / total
    const qty = qm ? toNum(qm[2] || qm[1]) : null
    // prices
    const price = re => { const p = pick(re, [after, lastLines]); return p ? toNum(p[1]) : null }
    const buyAvg = price(/\bBUY\s*AVG\.?(?:\s*PRICE)?\s*[:\-]?\s*(\d[\d,]*\.?\d*)/)
    const sellAvg = price(/\bSELL\s*AVG\.?(?:\s*PRICE)?\s*[:\-]?\s*(\d[\d,]*\.?\d*)/)
    const avg = price(/\bAVG\.?(?:\s*PRICE)?\s*[:\-]?\s*(\d[\d,]*\.?\d*)/) ?? price(/\bPRICE\s*[:\-]?\s*(\d[\d,]*\.?\d*)/) ?? price(/@\s*(\d[\d,]*\.?\d*)/)
    const ltp = price(/\bLTP\s*[:\-]?\s*(\d[\d,]*\.?\d*)/)
    const pnl = price(/\bP\s*&?\s*L\s*:?\s*([+\-]?\d[\d,]*\.?\d*)/)
    // Angel One rows: "B 2.16" / "S 2.18" (buy / sell average), "1 Lot = 8000", gain & loss without a label
    const bPx = price(/(?:^|\n)\s*[B8]\s+(\d[\d,]*\.\d+)/), sPx = price(/(?:^|\n)\s*[S$5][S$]?\s+(\d[\d,]*\.\d+)/)
    const lotM = after.match(/\b1\s*LOT\s*=\s*(\d[\d,]*)/)
    const lot = lotM ? toNum(lotM[1]) : null
    const signed = [...after.matchAll(/([+\-−])\s?(\d[\d,]*\.\d{2})(?![\d%)])/g)]
    let gl = pnl ?? (signed.length ? toNum(signed[signed.length - 1][2]) * (signed[signed.length - 1][1] === '+' ? 1 : -1) : null)
    const time = pick(/\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/, near2) || []
    let entry = avg, exit = null
    if (buyAvg != null && sellAvg != null) {  // closed position: both averages shown
      if (!a) a = 'B'
      entry = a === 'B' ? buyAvg : sellAvg; exit = a === 'B' ? sellAvg : buyAvg
    } else if (buyAvg != null) { entry = buyAvg; a = a || 'B' } else if (sellAvg != null) { entry = sellAvg; a = a || 'S' }
    else if (bPx != null && sPx != null) { a = a || 'B'; entry = a === 'B' ? bPx : sPx; exit = a === 'B' ? sPx : bPx }
    else if (bPx != null) { entry = bPx; a = a || 'B' } else if (sPx != null) { entry = sPx; a = a || 'S' }
    // Closed position showing "0 Lot": work the traded quantity out of P&L ÷ price move, in whole lots.
    let q = qty
    if ((q == null || q === 0) && entry != null && exit != null && gl != null && entry !== exit) {
      const raw = Math.abs(gl / (exit - entry)), L = lot || 1
      q = Math.max(L, Math.round(raw / L) * L)
    }
    out.push({
      und, k, t, a: a || 'B', actionFound: !!a, qty: q || null, lot, entry, exit, ltp, pnl: gl,
      expiry: expiryOf(m[2], after), time: time[0] ? `${time[1].padStart(2, '0')}:${time[2]}` : null,
      text: m[0].trim(),
    })
  })
  // the same contract read twice (e.g. symbol in a header and a row) -> keep the richest reading
  const best = new Map()
  for (const r of out) {
    const key = [r.und, r.k, r.t, r.a, r.time].join('|'), score = [r.qty, r.entry, r.exit, r.time].filter(v => v != null).length
    if (!best.has(key) || score > best.get(key).score) best.set(key, { ...r, score })
  }
  // A BUY order and a later SELL order (or the reverse) for the same contract = one round trip.
  const rows = [...best.values()].sort((x, y) => (x.time || '').localeCompare(y.time || ''))
  const done = []
  for (const r of rows) {
    const o = done.find(x => x.exit == null && x.und === r.und && x.k === r.k && x.t === r.t && x.a !== r.a && r.exit == null && (x.qty == null || r.qty == null || x.qty === r.qty))
    if (o) o.exit = r.entry
    else done.push({ ...r })
  }
  return done
}
