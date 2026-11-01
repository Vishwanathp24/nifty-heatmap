import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Section } from './components.jsx'

// "How to read this page" guides, written so a first-time reader (even a school student) can follow:
// one card per box on the page, a few steps for using them together, then the disclaimer.
// Market Overview adds its live 3-step check through children.

export function Disclaimer({ crypto = false }) {
  return <div className="howto-disclaimer">
    <b>⚠️ Disclaimer</b>
    <ul>
      <li>This page is for <b>learning and information only</b>. It is <b>not investment advice</b> and not a tip to buy or sell any share, option, coin or other product.</li>
      <li>We are <b>not a SEBI-registered investment adviser or research analyst</b>.</li>
      <li>The data comes from public sources ({crypto ? 'OKX, CoinGecko, Deribit, DEX data' : 'NSE, BSE, Yahoo Finance'}). It can be <b>late, incomplete or wrong</b>, and the readings (Bullish, Bearish, signals, scores and so on) are simple rules that can be wrong too.</li>
      {crypto
        ? <li>Crypto is <b>very risky</b> and is <b>not regulated by SEBI</b>. Prices can crash in minutes and small coins can go to zero. You can lose all of your money.</li>
        : <li>Trading in shares, and especially in futures & options, is <b>risky</b>. You can lose some or all of your money. Most F&O traders lose money.</li>}
      <li>Every decision you make is <b>your own</b>, and so is the result. Please talk to a SEBI-registered adviser before you invest.</li>
    </ul>
  </div>
}

// Phones: the guide starts closed (just the heading and a Show button; the disclaimer always shows).
// Desktop always shows it open.
export function PageGuide({ items, steps, stepsTitle = 'How to use this page, step by step', note, crypto, children }) {
  const [open, setOpen] = useState(false)
  return <Section title="How to read this page" subtitle="A simple guide: what each part means and how to use it" className={'howto' + (open ? '' : ' collapsed')}
    right={<button className="btn sm m-show" onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'Show'}</button>}>
    <div className="howto-grid">{items.map(([icon, title, text]) => <div key={title} className="howto-card">
      <div className="howto-t"><span aria-hidden="true">{icon}</span> {title}</div><p>{text}</p></div>)}</div>
    {children || (steps && <div className="howto-steps">
      <b>{stepsTitle}</b>
      <ol>{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      <p className="muted small">{note || 'Remember: these are clues, like a weather report. They do not tell you to buy or sell, and they can be wrong. Always check the price chart, and never risk money you cannot afford to lose.'}</p>
    </div>)}
    <div id="page-note-slot" />
    <Disclaimer crypto={crypto} />
  </Section>
}

// A page's data / source notes, shown at the end of the page (inside the guide, above the
// disclaimer) instead of under its table. Rendered through a portal into #page-note-slot.
export function PageNote({ children }) {
  const [el, setEl] = useState(null)
  useEffect(() => { setEl(document.getElementById('page-note-slot')) }, [])
  return el ? createPortal(<div className="page-note"><b>About the data</b><p>{children}</p></div>, el) : null
}

const GUIDES = {
  heatmap: {
    items: [
      ['🧭', 'Top cards', 'Market Bias (the overall mood), Nifty OI Change (what big option traders did), Nifty PCR (balance of option bets) and the two Breadth boxes (how many stocks went up vs down). The same as on Market Overview.'],
      ['🟩', 'Sector tiles', 'Each tile is one group of companies, like IT, Banks or Pharma. Green = the group went up. Red = it went down. The darker the colour, the bigger the move.'],
      ['🔁', 'vs Open / vs Prev Close', '"vs Open" compares with the price at 9:15 this morning. "vs Prev Close" compares with yesterday\'s last price. Daily / Weekly / Monthly changes how far back you look.'],
      ['👆', 'Click a tile', 'Opens the stocks inside that sector with their price, change and how far they are from their 1-year high and 1-year low.'],
      ['☑️', 'Select sectors', 'Tick sectors to send them to the ORB Scanner, so it only shows stocks from the groups you picked.'],
      ['🚀', 'Top 20 Gainers / Losers', 'The F&O stocks that went up the most and went down the most today, from the sectors you picked.'],
    ],
    steps: [
      <><b>Check the mood</b> in the top cards: is Market Bias Bullish, Bearish or Neutral?</>,
      <><b>Find the strong and weak groups:</b> dark green tiles are the strongest sectors, dark red the weakest.</>,
      <><b>Does it match the mood?</b> On a Bullish day, look closer at green sectors. On a Bearish day, at red ones. Mixed? Be extra careful.</>,
      <><b>Click a tile</b> to see which stocks are leading that sector, then open the chart before doing anything.</>,
    ],
  },
  scanner: {
    items: [
      ['⏱️', 'Opening range (ORB)', 'The highest and lowest price of a stock in the first few minutes after 9:15 (5, 15 or 30 minutes, or 1 hour). Think of it as the "starting box" for the day.'],
      ['⬆️', 'Breakout', 'The price closed above the top of the starting box, and the next 3-minute candle stayed above it too (that is the "confirmation").'],
      ['⬇️', 'Breakdown', 'The price closed below the bottom of the starting box, and the next 3-minute candle stayed below it.'],
      ['🕒', 'Break Time / Fresh', 'When the break happened, and how long ago. A NEW tag means it happened in the last 15 minutes.'],
      ['📈', 'Vol Ratio', 'How much the stock traded compared with a normal day at the same time. Above 1.5 means much more than usual, so the move has more people behind it.'],
      ['📏', 'Dist ORB %', 'How far the price has moved away from the edge of the starting box. Very far away means the easy part of the move may already be over.'],
      ['🧰', 'Filters', 'Narrow the list by volume, time, price, sector, market size and more. "Still beyond range" hides stocks that fell back inside the box.'],
      ['🧭', 'Ribbon on top', 'Market Bias, PCR, OI Change and Breadth: the mood of the whole market, so you can see if a signal goes with it or against it.'],
    ],
    steps: [
      <><b>Pick the box size</b> (5, 15, 30 min or 1 hour). Bigger boxes give fewer but steadier signals.</>,
      <><b>Check the ribbon:</b> on a Bullish day, Breakouts go with the mood. On a Bearish day, Breakdowns do.</>,
      <><b>Prefer strong signals:</b> high Vol Ratio, still beyond the range, and not too far from the box (small Dist ORB %).</>,
      <><b>Click a row</b> to open the stock and its chart, and check it yourself.</>,
    ],
  },
  trend: {
    items: [
      ['🧩', 'Index Options', 'The option chain for Nifty and other indices: PCR, max pain, expected move and where traders hold the most options.'],
      ['📈', 'Trending Stocks', 'Each stock gets a score from simple checks (price above its average lines, Supertrend, RSI, ADX). More checks passed = a stronger, cleaner trend.'],
      ['🟢', 'Bullish Intraday', 'Stocks that pass a list of "going up" conditions on the daily and 1-hour charts. Green ✓ = condition met.'],
      ['🔴', 'Bearish Intraday', 'The same idea for "going down" conditions.'],
      ['🌙', 'BTST Stocks', 'Stocks with very high volume, strong RSI and a close near their 1-year high today. BTST = "buy today, sell tomorrow" style lists. Bullish only.'],
      ['🔊', 'Volume Spike', 'Stocks trading more than 3 times their normal daily volume (today vs the 20-day average). Pick the list: F&O, Nifty 50, Nifty 500, Midcap 150 or Smallcap 250. Use All / Bullish / Bearish: Bullish = price up with the volume, Bearish = price down. The Top 20 buttons show only today\'s biggest F&O gainers or losers. Big volume means big players are active.'],
      ['🤝', 'Common Stocks', 'Stocks that show up in every scan for one direction at the same time (Trending + Intraday + ORB). When many scans agree, the signal is stronger.'],
      ['🕯️', 'Live Chart', 'A candle chart with indicators. Drag to move, use the price scale to zoom, and "Latest" to go back to now.'],
      ['👆', 'Click a row', 'Opens that stock\'s details and chart.'],
    ],
    steps: [
      <><b>Check the ribbon</b> on top for the market mood. The page also tells you which scans suit today's Market Bias.</>,
      <><b>Start with Common Stocks:</b> these passed several scans together.</>,
      <><b>Look at the score or the ✓ marks:</b> more ticks = more conditions agree.</>,
      <><b>Open the Live Chart</b> and check the price yourself before doing anything.</>,
    ],
  },
  crypto: {
    crypto: true,
    items: [
      ['🌐', 'Market Overview', 'The size of the whole crypto market, Bitcoin\'s share, the Fear & Greed meter (0 = very scared, 100 = very greedy) and Altcoin Season.'],
      ['🟩', 'Heatmap', 'Coins grouped by type. Green = up, red = down. The crypto day starts at 12:00 AM IST.'],
      ['🚀', 'Top Movers', 'Coins that went up the most, went down the most, and were traded the most.'],
      ['📈', 'Trending', 'Coins that pass a list of trend checks (average lines, Supertrend, RSI, ADX). More checks passed = stronger trend.'],
      ['⏱️', 'ORB', 'Like the stock ORB Scanner: a coin breaking above or below its "starting box" for the day.'],
      ['⚖️', 'Options', 'Bitcoin and Ethereum options: PCR, max pain, expected move and where traders hold the most bets.'],
      ['🕯️', 'Live Chart', 'A candle chart with indicators for any coin.'],
      ['🧪', 'CoinGecko Trending / DEX Pools', 'Coins people are searching for, and brand-new small coins on exchanges. These are the riskiest: many are scams or can fall to zero. Read the Safety check.'],
    ],
    steps: [
      <><b>Check the mood:</b> Fear & Greed and the Crypto Bias on the Market Overview tab.</>,
      <><b>See what is moving</b> on the Heatmap and Top Movers.</>,
      <><b>Look for agreement:</b> a coin that is Trending and also has an ORB signal in the same direction has more checks behind it.</>,
      <><b>Be extra careful</b> with small and new coins (DEX Pools): check liquidity and the Safety check first.</>,
    ],
  },
  ipo: {
    items: [
      ['📅', 'Upcoming IPOs', 'New companies selling shares to the public for the first time. Status shows if bidding is Upcoming, Open or Closed.'],
      ['🗓️', 'Dates', 'Subscription Period = the days you can apply. Last Day to Apply = the final day (UPI approval by the cut-off time). Listing Date = when the shares start trading.'],
      ['💰', 'Price Band, Lot, Amount / Lot', 'The price range per share, how many shares are in one lot, and how much money one lot needs. The HNI line shows the smallest amount for the HNI category.'],
      ['🔥', 'Subscription', 'How many times the issue is booked. 5x means people asked for 5 times more shares than are on offer.'],
      ['🟢', 'Coloured dot', 'A quick checklist rating from NSE data: green = most checks pass, yellow = mixed, red = several checks fail, blue = too early, bidding still open. Click the name for details.'],
      ['📈', 'Recent IPOs', 'Companies that already listed: issue price, listing price, listing gain and how they are doing now.'],
      ['🏛️', 'QIB', 'How many times the big institutions (banks, mutual funds, insurance companies) have booked their part. They often apply on the last day. Above 1x means their part is fully booked.'],
      ['🔗', 'GMP', 'Grey market premium: an unofficial guess of how much above (or below) the price the shares may list. +₹7 (+8.5%) means about ₹7 above the top price. It is not from the exchange and is often wrong.'],
    ],
    steps: [
      <><b>Check the dates</b> and the amount you need for one lot.</>,
      <><b>Click the company name</b> to read its checklist and how each investor group is subscribing.</>,
      <><b>Look at Subscription on the last day:</b> big institutions (QIB) often apply on the final day.</>,
      <><b>Read the company's prospectus</b> (RHP) before you apply. A high subscription does not guarantee a gain.</>,
    ],
  },
  learning: {
    items: [
      ['📚', 'Courses', 'Short lessons on the stock market, charts, options and risk, grouped by topic.'],
      ['🗂️', 'Categories', 'Pick a category to see only the lessons on that topic.'],
      ['🔖', 'Bookmarks', 'Save a lesson to come back to it later.'],
      ['🎯', 'Learn, then look', 'After a lesson, open the matching page (for example PCR or ORB) and see the idea on real data.'],
    ],
    steps: [
      <><b>Start with the basics</b> (what a share, an index and an option are) before the advanced topics.</>,
      <><b>Bookmark</b> the lessons you want to read again.</>,
      <><b>Practise on paper first:</b> note what you would have done and check later, without using real money.</>,
    ],
    note: 'Learning comes first: understand a tool fully before you use it with real money.',
  },
  journal: {
    items: [
      ['📝', 'Add a trade', 'Pick buyer or seller, the index or stock, the expiry and the strategy. Strikes and premiums fill in from the live option chain, and you can change them.'],
      ['📷', 'Scan broker screenshot', 'Upload a screenshot of your broker\'s order screen and the trades are read for you. The picture is never saved: it is deleted once the trade is added.'],
      ['💹', 'P&L and R', 'Profit or loss for each trade, and "R" = how many times your planned risk you made or lost.'],
      ['📆', 'Calendar', 'Each day coloured green (profit) or red (loss), so you can see good and bad days at a glance.'],
      ['📊', 'By strategy', 'Which strategies make or lose you money, and your win rate.'],
      ['🙂', 'Mood', 'How you felt when you traded. More than 2 trades in a day is marked "Revenge" by default, a warning sign of chasing losses.'],
      ['💾', 'Saving', 'Trades stay in this browser. Sign in, or use Export / Import CSV, to keep them on other devices.'],
    ],
    steps: [
      <><b>Write down every trade</b>, the winners and the losers.</>,
      <><b>Look at the calendar and By strategy</b> every week: what works for you, and what does not?</>,
      <><b>Watch your mood:</b> many trades in one day or "Revenge" trades usually lose money.</>,
    ],
    note: 'Your journal only shows your own numbers. It does not suggest any trade.',
  },
}

export function PageHowTo({ page }) {
  const g = GUIDES[page]
  return g ? <PageGuide {...g} /> : null
}
