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

// The guide starts closed on every screen (just the heading and a Show button; the disclaimer always shows).
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
      ['🧭', 'Top cards', 'Market Bias (the overall mood), Nifty OI Change (what big option traders did; its tag CE side / PE side / Wait shows which side the fresh OI favours when price agrees), Nifty PCR (balance of option bets) and the two Breadth boxes (how many stocks went up vs down). The same as on Market Overview.'],
      ['🟩', 'Sector tiles', 'Each tile is one group of companies, like IT, Banks or Pharma. Green = the group went up. Red = it went down. The darker the colour, the bigger the move.'],
      ['🔁', 'vs Prev Close / vs Open', '"vs Prev Close" (the default, as on NSE\'s own heatmap) compares with yesterday\'s last price. "vs Open" compares with the price at 9:15 this morning: on a gap-up day a sector can be up vs yesterday but down since the open, so the two views can show different colours. Daily / Weekly / Monthly changes how far back you look.'],
      ['👆', 'Click a tile', 'Opens the stocks inside that sector with their price, 1-day / 1-week / 1-month % change and how far they are from their 1-year high and 1-year low.'],
      ['☑️', 'Select sectors', 'Tick sectors to send them to the ORB Scanner, so it only shows stocks from the groups you picked.'],
      ['🔄', 'Sector Rotation', 'Advanced only. Closed by default: use the Show / Hide button (or tap its title) to open or close it. Ranks every sector from strongest (1) to weakest by % change and shows how its rank changed: Daily = today vs yesterday, Weekly = this week vs last week, Monthly = this month vs last month. Each card shows the rank, a green ▲n badge when the sector climbed that many places (money moving in) or a red ▼n when it slipped (money moving out), and its earlier rank; click a card to open its stocks with the daily % change of each stock for the last 30 sessions (green up, red down), plus its 1-day, 1-week and 1-month change. Adv/Dec is the count today of rising / falling stocks in it. Follows the Daily / Weekly / Monthly switch. Median stock (the default) ranks by the middle % move of all the stocks in the sector, so every stock counts equally and a wide move ranks above one carried by a few big companies; Sector index ranks by the NSE index itself (weighted by company size).'],
      ['🚀', 'Top 20 Gainers / Losers', 'The F&O stocks that went up the most and went down the most today, from the sectors you picked, with their 1-day, 1-week and 1-month % change. Click a row for its chart, its 1-day / 1-week / 1-month % change and its daily % change for the last 30 sessions (green up, red down). The Copy button copies these symbols for a TradingView watchlist (NSE:SYMBOL, comma-separated: in TradingView click + Add symbol, paste, Enter). The same button sits beside All stocks and the 30-day grid when you open a sector.'],
    ],
    steps: [
      <><b>Check the mood</b> in the top cards: is Market Bias Bullish, Bearish or Neutral?</>,
      <><b>Find the strong and weak groups:</b> dark green tiles are the strongest sectors, dark red the weakest.</>,
      <><b>Does it match the mood?</b> On a Bullish day, look closer at green sectors. On a Bearish day, at red ones. Mixed? Be extra careful.</>,
      <><b>Check Sector Rotation:</b> a sector that keeps climbing the ranks is gaining strength; one that drops from the top is losing it.</>,
      <><b>Click a tile</b> to see which stocks are leading that sector, then open the chart before doing anything.</>,
    ],
  },
  scanner: {
    items: [
      ['⏱️', 'Opening range (ORB)', 'The highest and lowest price of a stock in the first few minutes after 9:15 (5, 15 or 30 minutes, or 1 hour). Think of it as the "starting box" for the day.'],
      ['⬆️', 'Breakout', 'The price closed above the top of the starting box, and the next 3-minute candle stayed above it too (that is the "confirmation").'],
      ['⬇️', 'Breakdown', 'The price closed below the bottom of the starting box, and the next 3-minute candle stayed below it.'],
      ['📋', 'Copy for TradingView', 'Copies the symbols in the list you are looking at (after the tab, sector, search and filters) as NSE:SYMBOL, separated by commas. In TradingView open your watchlist, click + (Add symbol), paste and press Enter: all of them are added at once so you can track them.'],
      ['🕒', 'Break Time / Fresh', 'When the break happened, and how long ago. A NEW tag means it happened in the last 15 minutes.'],
      ['📈', 'Vol Ratio', 'How much the stock traded compared with a normal day at the same time. Above 1.5 means much more than usual, so the move has more people behind it.'],
      ['📏', 'Dist ORB %', 'How far the price has moved away from the edge of the starting box. Very far away means the easy part of the move may already be over.'],
      ['🧰', 'Filters', 'Narrow the list by volume, time, price, sector, market size and more. "Still beyond range" hides stocks that fell back inside the box.'],
      ['🧭', 'Ribbon on top', 'Market Bias, PCR, OI Change and Breadth: the mood of the whole market, so you can see if a signal goes with it or against it.'],
      ['🚀', 'NSE → Momentum', 'Under the NSE tab: the stocks in two NSE momentum indices, as on NSE\'s heatmap: Nifty200 Momentum 30 (the 30 strongest of the top 200 companies) and Nifty500 Momentum 50 (the 50 strongest of the top 500). Strongest = the biggest 6- and 12-month price rise, adjusted for how jumpy the stock is; NSE updates the lists every June and December. All / Bullish / Bearish: Bullish = up today, Bearish = down today; it opens on the side that matches Market Bias (All when Neutral) until you pick one. Heatmap shows each stock coloured by today\'s move (green up, red down, darker = bigger); Table lists price, change, high, low, volume and weight in the index. The line on top shows the index level and how many members are up or down. The sector filter (shared with the Sector Heatmap) and the Top 20 gainers + losers button narrow the list; Copy for TradingView copies what is shown. Past strength, not a buy or sell call.'],
      ['🔄', 'NSE → Change in OI', 'NSE\'s own Change in OI lists, keeping only stock options and stock futures (index contracts left out). Four buttons: Rise in OI and Rise in Price, Slide in OI and Rise in Price, Rise in OI and Slide in Price, Slide in OI and Slide in Price. Each row is one contract (one option strike or one future). The Reading column says it simply: ▲ up or ▼ down for the stock, Strong when new money is coming in (OI rising) and Weak when people are leaving (OI falling), with the reason in plain words. For futures and calls: OI up + price up = strong up, OI down + price up = weak up, OI up + price down = strong down, OI down + price down = weak down. Puts read the other way round, because a put\'s price rises when the stock falls. It opens on a list that matches Market Bias and has stocks right now: when Bearish, Rise in OI and Slide in Price, else Slide in OI and Slide in Price; when Bullish or Neutral, Rise in OI and Rise in Price, else Slide in OI and Rise in Price (tap any other to switch). Rise in OI lists show the biggest jump first, Slide in OI lists the biggest drop first. NSE lists only its top 25 contracts and most are index options, so only a few stocks show each day. The sector filter and the Top 10 / Top 20 switch next to Clear filters (unticked at first here) narrow the list; Copy for TradingView copies what is shown. A positioning read, not a buy or sell call.'],
      ['🔊', 'NSE → Volume Gainers', 'The same list as NSE\'s Volume Gainers / Spurts page: the stocks (any NSE stock, not only F&O; ETFs and funds left out) trading the most compared with normal. × 1W = today\'s volume divided by the average of the last week (3× = three times more than usual); × 2W does the same for two weeks. Reading says it simply: ▲ Big buying = lots of trading and the price went up, ▼ Big selling = lots of trading and the price went down, ◆ Busy but flat = lots of trading but the price hardly moved. Huge = 5 times normal or more, Big = 2 times or more. The sector filter and the Top 10 / Top 20 switch next to Clear filters narrow it (unticked at first here, because most of these stocks are not F&O); Copy for TradingView copies what is shown. A screen, not a buy or sell call.'],
      ['🏆', 'NSE → Gainers / Losers', 'The same lists as NSE\'s Top Gainers / Losers page. Pick Gainers or Losers (it opens on Losers when Market Bias is Bearish, otherwise Gainers) and a group in the drop-down: F&O Securities, Nifty 50, Bank Nifty, Nifty Next 50, Securities above or below ₹20, or All Securities. Reading says it simply: ▲ Big rise / ▼ Big fall (5% or more), Good (2% or more) or Small, and where the price sits: close to its 1-year high or low, or near the day high or low. From 1Y high = how far below its 52-week high it trades. The list opens sorted by volume, most traded first. The sector filter and the Top 20 gainers + losers button narrow the list; Copy for TradingView copies what is shown. Today\'s biggest moves, not a buy or sell call.'],
      ['🆕', 'NSE → IPO in Gain', 'The same list as NSE\'s IPO tracker (IPO in Gain): every IPO from about the last year, with the issue price, how it did on listing day and where it trades now. Mainboard = regular companies, SME = small companies (thin trading). It opens on IPOs trading above their issue price, biggest gain first; Below issue price and All show the rest. Reading says it simply: ▲ Huge / Big / Some gain or ▼ loss for someone who bought in the IPO (Huge = 50% or more, Big = 20%+, Some = 5%+), and how it did on day one. The sector filter narrows the list (no Top 10 / 20 switch here: IPO stocks are rarely F&O); Copy for TradingView copies what is shown. Past results, not a buy or sell call.'],
      ['✅', 'Top 10 / Top 20 gainers + losers', 'Top 10 is ticked at first: the lists show only today\'s 10 biggest F&O gainers and 10 biggest losers, where most of the action is. Tick Top 20 for a longer list, or tap the ticked one to see every stock. Your choice applies to every tab (Intraday Scanner too), and the numbers on the tabs follow it.'],
    ],
    steps: [
      <><b>Pick the box size</b> (5, 15, 30 min or 1 hour). Bigger boxes give fewer but steadier signals.</>,
      <><b>Check the mood:</b> on a Bullish day, Breakouts go with the mood. On a Bearish day, Breakdowns do. The page picks the matching tab for you (Bullish → Breakout, Bearish → Breakdown, Neutral → All); tap another tab to choose yourself.</>,
      <><b>Prefer strong signals:</b> high Vol Ratio, still beyond the range, and not too far from the box (small Dist ORB %).</>,
      <><b>Click a row</b> to open the stock and its chart, and check it yourself.</>,
    ],
  },
  trend: {
    items: [
      ['📋', 'Copy for TradingView', 'Every scan has a Copy for TradingView button: it copies the stocks in the list you are looking at (after the filters, search and Top 20 choice) as NSE:SYMBOL, separated by commas. In TradingView open your watchlist, click + (Add symbol), paste and press Enter to add them all at once. On a phone the TradingView app takes one stock at a time, so the button opens a list instead: tap a stock to copy it, paste it in TradingView, come back and tap the next one (copied stocks get a ✓).'],
      ['🧭', 'Basic mode', 'In Basic, this page shows five tabs: NSE (Momentum, Change in OI, Volume Gainers, Gainers / Losers and IPO in Gain), Bullish Intraday, Bearish Intraday, Volume > 5 Days and Option Selling. Switch to Advanced for Trade Setup, F&O Stocks and the other scanners.'],
      ['🎯', 'Trade Setup', 'An intraday checklist for F&O stocks on 15-minute candles. 8 checks for a long (or short) trade: the market agrees, the stock is stronger (weaker) than Nifty, above (below) VWAP, 9 EMA above (below) 21 EMA, Supertrend up (down), RSI 55–75 (25–45), ADX 20+ in the right direction, and volume 1.2× normal. Stocks that pass enough checks get levels from fixed rules: Entry = a break of the last 15-minute candle, Stop = the 15-minute Supertrend (or 1.5 × ATR), T1 / T2 = 1 and 2 times the risk, Trail now = the Supertrend to follow, Qty = your risk per trade ÷ the distance to the stop. 15m ORB shows whether the stock broke its 9:15–9:30 opening range today and when (▲ up, ▼ down); tick Only 15-min ORB breakouts to keep just those. It opens on long setups on a bullish day and short setups on a bearish day. These are planning numbers from rules, not a recommendation: you decide, and you always keep the stop.'],
      ['🧮', 'Option Selling', 'For defined-risk option selling on F&O stocks. Each stock\'s regime is read from its daily and hourly trend: range-bound → Iron Condor, steady uptrend → Bull Put Spread, steady downtrend → Bear Call Spread; no clear regime → no trade. 6 checks score it (clear regime, liquid, calm today, RSI not extreme, ADX fits, Supertrend agrees). It opens on the structure that matches Market Bias. Click a stock for a strike plan from its option chain: short strikes beyond both the expected move and the biggest OI wall, a protective strike further out, the net credit, max profit, max loss, breakeven and exit rules for one lot. Index cards (Nifty 50, Bank Nifty, Sensex) are on the Unused Screeners page (link at the bottom), under Index Option Selling. Always check results dates yourself. Planning numbers, not advice.'],
      ['📃', 'F&O Stocks', 'Every stock that has futures and options on NSE. All / Bullish / Bearish: bullish = up on the day, above VWAP and 9 EMA above 21 EMA on 15-minute candles (bearish = the opposite); it opens on the side that matches Market Bias (a Neutral bias of +2 or more counts as bullish, −2 or less as bearish). Each stock shows its lot size (shares per contract this month) and contract value (lot × price, roughly what one futures lot controls). Tap a stock to open its option chain analysis at the top: PCR, max pain, where the most calls (resistance) and puts (support) are written, implied volatility, the expected move to expiry and OI change at each strike. Stock options are monthly; the expiry dates come from NSE.'],
      ['📈', 'Trending Stocks', 'Each stock gets a score from simple checks (price above its average lines, Supertrend, RSI, ADX). More checks passed = a stronger, cleaner trend. Pick the chart: 15 Min + 1 Hour (both must agree), 15 Min only, 30 Min only or 1 Hour only. On 30 Min only the Time column is not shown. Min score picks how many conditions must pass (out of 14 on 15 Min + 1 Hour, out of 7 on one chart); it opens on the strictest score that has stocks right now.'],
      ['🟢', 'Bullish Intraday', 'Stocks that pass a list of "going up" conditions on the daily and 1-hour charts. Green ✓ = condition met. Min score picks how many of the 6 must pass. It opens on the strictest score that has stocks right now (6 of 6, else 5 of 6, and so on); pick any score yourself to change it.'],
      ['🔴', 'Bearish Intraday', 'The same idea for "going down" conditions, with the same Min score choice.'],
      ['📊', 'Volume > 5 Days', 'F&O stocks trading more volume today than on each of the last 5 days (Chartink: daily volume above 1, 2, 3, 4 and 5 days ago). Price up / Price down splits them by today\'s change; it opens on the side that matches Market Bias (All when Neutral). × that = today\'s volume divided by the biggest of the last 5 days. During market hours today\'s volume is still growing, so the list grows through the day. Big volume means big players are active; it is a screen, not a signal.'],
      ['✅', 'Top 10 / Top 20 gainers + losers', 'Next to Clear filters. Top 10 is ticked at first: the lists show only today\'s 10 biggest F&O gainers and 10 biggest losers, where most of the action is. Tick Top 20 for a longer list, or tap the ticked one to see every stock. Your choice applies to every tab (Volume Gainers and IPO in Gain have their own switch, off at first), and the numbers on the tabs follow it. Clear filters goes back to Top 10.'],
      ['👆', 'Click a row', 'Opens that stock\'s details and chart.'],
    ],
    steps: [
      <><b>Check the ribbon</b> on top for the market mood. The page also tells you which scans suit today's Market Bias.</>,
      <><b>Look at the score or the ✓ marks:</b> more ticks = more conditions agree.</>,
      <><b>Tap the chart icon</b> next to a stock to open its Live Chart (on Unused Screeners) and check the price yourself before doing anything.</>,
    ],
  },
  unused: {
    items: [
      ['🗂️', 'What this page is', 'Screeners moved out of the Intraday Scanner to keep it simple: Common Stocks, Candlestick, Live Chart, Volume Spike, BTST Stocks, EMA 9/21 + RSI, Index Option Selling and Index Options. Open it from the Unused Screeners link at the bottom of any page. The chart icon next to a stock also opens the Live Chart here.'],
      ['🤝', 'Common Stocks', 'Stocks that show up in every scan for one direction at the same time (Trending + Intraday + ORB). When many scans agree, the signal is stronger.'],
      ['🕯️', 'Candlestick', 'Daily candle shapes on the F&O stocks: Marubozu (one side in control all day), Doji (indecision), Hammer / Hanging Man, Shooting Star / Inverted Hammer, Engulfing, Harami and Morning / Evening Star. Green pills lean bullish, red bearish, grey is indecision; hover a pill for what it means. Trend shows whether the stock was rising or falling over the last 5 sessions, because a hammer after a fall means something different from the same shape after a rise. Today\'s candle is live, so a pattern can change until 3:30 PM. The Read column spells out the setup: reversal after a fall, continuation, or a break from a range; the price that would confirm it (Confirms at), the price where it fails (Fails at) and how far that is (To fail), with a caution when the stock is already stretched or the fail level is far away. It describes the setup; it does not tell you to buy or sell.'],
      ['🕯️', 'Live Chart', 'A candle chart with indicators. Drag to move, use the price scale to zoom, and "Latest" to go back to now.'],
      ['🔊', 'Volume Spike', 'Stocks trading more than 3 times their normal daily volume (today vs the 20-day average). Pick the list: F&O, Nifty 50, Nifty 500, Midcap 150 or Smallcap 250. Use All / Bullish / Bearish: Bullish = price up with the volume, Bearish = price down. The Top 20 gainers + losers button (ticked at first) shows only today\'s biggest F&O movers; untick it to see every stock. Big volume means big players are active.'],
      ['🌙', 'BTST Stocks', 'Stocks with very high volume, strong RSI and a close near their 1-year high today. BTST = "buy today, sell tomorrow" style lists. Bullish only.'],
      ['📐', 'EMA 9/21 + RSI', 'Two checks together. Direction: is the fast 9 EMA above the slower 21 EMA (prices rising) or below it (falling)? Strength: is RSI above 60 (strong buying) or below 40 (strong selling)? Bullish = 9 above 21 and RSI above 60; Bearish = 9 below 21 and RSI below 40. Pick the chart: 15 Min, 1 Hour or Daily. Gap % shows how far apart the two averages are. Tick Fresh crossover only to see stocks whose averages crossed on the latest candle: the earliest signal, but also the least proven. Every stock\'s 5-minute chart (tap a stock) also draws the 9 EMA in orange and the 21 EMA in purple, marks the latest crossover with ▲ / ▼, and shows today\'s 9/21 + RSI reading under the chart. It is a condition screen, not a buy or sell call.'],
      ['🏦', 'Index Option Selling', 'Which option-selling structure today fits Nifty, Bank Nifty and Sensex: a Bull Put Spread in a steady uptrend, a Bear Call Spread in a steady downtrend, an Iron Condor in a sideways market. It says when the structure that matches the sentiment is not clean yet and what would make it fit. Each index card shows its 6 checks (dots), regime and structure; pick a structure and tap Strike plan for the strikes, credit, max loss and exits. See details shows the readings and the expiry. A guide from rules, not a recommendation.'],
      ['🧩', 'Index Options', 'The option chain for Nifty and other indices: PCR, max pain, expected move and where traders hold the most options.'],
      ['👆', 'Click a row', 'Opens that stock\'s details and chart.'],
    ],
    steps: [
      <><b>Start with Common Stocks:</b> these passed several scans together.</>,
      <><b>Open the Live Chart</b> and check the price yourself before doing anything.</>,
    ],
  },
  crypto: {
    crypto: true,
    items: [
      ['🔀', 'Opening Crypto', 'Pick Crypto in the Basic | Advanced | Crypto switch at the top. Pick Basic or Advanced to go back to the Indian market pages.'],
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
      ['🟢', 'Coloured dot', 'A quick checklist rating from NSE data: green = most checks pass, yellow = mixed, red = several checks fail, blue = too early, bidding still open. Click anywhere on a row for its details.'],
      ['📈', 'Recent IPOs', 'Companies that already listed: issue price, listing price, listing gain and how they are doing now. Copy for TradingView copies the listed symbols shown, for a TradingView watchlist.'],
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
  fiidii: {
    items: [
      ['🧭', 'Positioning read', 'The box at the top of Summary: whether FIIs added on the bullish or bearish side yesterday, from the change in index futures (5,000 contracts or more counts) and index options (50,000 or more). Both bullish = Bullish, one = Leans bullish, none or opposite = Mixed (same for bearish). The same read is one of the signals in Market Outlook. It describes positions, it is not a forecast.'],
      ['🏦', 'Who is who', 'FII = foreign institutions. DII = Indian institutions (mutual funds, insurers). Pro = brokers trading their own money. Client = everyone else, mostly retail traders.'],
      ['📋', 'Summary', 'One card per group. The coloured top edge follows its index futures lean (green bullish, red bearish, amber neutral). The small line at the top right shows its index futures net position over the last 10 sessions (green = it rose, red = it fell); the green / red bar under each segment shows how its positions split between the bullish and bearish side. For the last session: each group net position in Index Futures, Index Options and Stock Futures, and the change from the session before. Numbers are contracts, 1L = 1,00,000.'],
      ['➕', 'Net OI', 'Long contracts minus short contracts. For options, the bullish side (bought calls and sold puts) minus the bearish side (bought puts and sold calls). Green = more on the bullish side.'],
      ['🧭', 'Lean', 'The share of a group positions on the bullish side: 60% or more = Bullish, 52 to 60 = Mild Bullish, 48 to 52 = Neutral, 40 to 48 = Mild Bearish, below 40 = Bearish. It describes positions, it is not a forecast.'],
      ['📊', 'F&O History', 'Pick a group and a series (Index Futures, Calls, Puts or Options net). Bars show each day change (or the net position), the line is the Nifty close. The table lists the last 30 sessions, newest first.'],
      ['💵', 'Cash Market', 'NSE provisional buy, sell and net in crores for FII and DII. NSE only gives the latest day, so the list grows by one row each day.'],
    ],
    steps: [
      <><b>Start with FII Index Futures:</b> a big net short that keeps growing shows foreign money is hedged or bearish.</>,
      <><b>Compare FII and Client:</b> retail clients are often on the other side of FIIs.</>,
      <><b>Watch the change,</b> not only the total: a sudden swing in calls or puts shows fresh positions.</>,
      <><b>Use it as background,</b> next to price, PCR and breadth. It is published after the close, so it is not live.</>,
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
