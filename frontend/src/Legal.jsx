import React from 'react'

// Site information pages linked from the footer: About, Contact, Privacy Policy, Terms of Use and
// Disclaimer (what Google AdSense and visitors expect to find). Plain language, no buy/sell advice.
export const CONTACT_EMAIL = '[contact email]'  // placeholder: set the real address before going live
const SITE = 'moneymaau.com'
const UPDATED = '11 November 2026'

export const INFO_PAGES = [
  { id: 'about', path: '/about', label: 'About' },
  { id: 'contact', path: '/contact', label: 'Contact' },
  { id: 'privacy', path: '/privacy-policy', label: 'Privacy Policy' },
  { id: 'terms', path: '/terms', label: 'Terms of Use' },
  { id: 'disclaimer', path: '/disclaimer', label: 'Disclaimer' },
]

const Mail = () => <a href={'mailto:' + CONTACT_EMAIL}>{CONTACT_EMAIL}</a>

function About() {
  return <>
    <h1>About NSE Sector Heatmap</h1>
    <p>NSE Sector Heatmap ({SITE}) is a free market dashboard for people who follow the Indian stock market. It puts the numbers a trader
      usually checks in many places on one screen, and explains each of them in plain language.</p>
    <h2>What you can find here</h2>
    <ul>
      <li><b>Market Overview</b>: Nifty put-call ratio (PCR), market bias, FII / DII activity, pre-open, breadth, global cues and top movers.</li>
      <li><b>Sector Heatmap</b>: which NSE sectors and F&O stocks are up or down today.</li>
      <li><b>ORB Scanner</b> and <b>Intraday Scanner</b>: stocks that meet opening range breakout and indicator conditions (VWAP, EMA, Supertrend, RSI, ADX, volume).</li>
      <li><b>IPO</b>: open and upcoming IPOs with price band, lot size, subscription and grey market premium.</li>
      <li><b>Crypto</b> and a <b>Learning</b> section.</li>
    </ul>
    <h2>Our approach</h2>
    <p>The dashboard is a decision-support and learning tool. It shows data and conditions; it never tells you to buy or sell, and it does not
      give targets or stop-losses. Every page has a “How to read this page” guide written so that a beginner can follow it.</p>
    <h2>Where the data comes from</h2>
    <p>Prices and market data come from public sources such as NSE, BSE, Yahoo Finance and other public market-data and IPO websites. Data can be
      delayed, incomplete or wrong; always confirm with your broker or the exchange before acting on it.</p>
    <h2>Not a SEBI-registered adviser</h2>
    <p>NSE Sector Heatmap is not registered with SEBI as an investment adviser or research analyst. Nothing on this site is investment advice.
      See the <a href="/disclaimer">Disclaimer</a>.</p>
    <p>Questions or feedback: <Mail />.</p>
  </>
}

function Contact() {
  return <>
    <h1>Contact</h1>
    <p>We would like to hear from you: questions about the dashboard, data errors you spotted, feature ideas, advertising or anything else.</p>
    <p className="info-big">Email: <Mail /></p>
    <p>We usually reply within 2–3 working days.</p>
    <h2>Before you write</h2>
    <ul>
      <li><b>Wrong or missing data</b>: tell us the page, the stock or index, and the time you saw it (IST).</li>
      <li><b>Privacy requests</b>: to see or delete data linked to your Journal sign-in, write from the same Google account email.</li>
      <li><b>Trading advice</b>: we cannot advise you on what to buy or sell. Please speak to a SEBI-registered adviser.</li>
    </ul>
  </>
}

function Privacy() {
  return <>
    <h1>Privacy Policy</h1>
    <p className="muted">Last updated: {UPDATED}</p>
    <p>This policy explains what information NSE Sector Heatmap ({SITE}, “we”, “the site”) collects, how it is used and the choices you have.
      By using the site you agree to this policy.</p>

    <h2>1. Information we collect</h2>
    <ul>
      <li><b>Nothing to sign up for.</b> Most of the site works without an account, and we do not ask for your name, phone number or address.</li>
      <li><b>Journal sign-in (optional).</b> If you sign in with Google to use the Journal, we receive your Google account email, name and profile
        picture, and we store the trades you enter so you can see them on any device.</li>
      <li><b>Notifications (optional).</b> If you turn on alerts, your browser gives us a push subscription address so we can send them. It does not
        identify you by name.</li>
      <li><b>Analytics.</b> We use Google Analytics (through Google Tag Manager) to see how the site is used: pages visited, device and browser type, approximate location and time spent. Google sets cookies for this; it does not tell us who you are. You can block it with the <a href="https://tools.google.com/dlpage/gaoptout" target="_blank" rel="noopener noreferrer">Google Analytics opt-out add-on</a> or your browser's cookie settings.</li>
      <li><b>Microsoft Clarity.</b> We use Microsoft Clarity to understand how people use the site, through heatmaps and session replays (clicks, scrolls and mouse movement). Clarity hides text you type and other sensitive content by default, and sets its own cookies. See the <a href="https://privacy.microsoft.com/privacystatement" target="_blank" rel="noopener noreferrer">Microsoft Privacy Statement</a>.</li>
      <li><b>Visitor count.</b> The site keeps a random id in your browser to count how many people used it in the last 24 hours. The id is not linked to you.</li>
      <li><b>Settings in your browser.</b> Your choices (for example Basic / Advanced, Full data, filters) are kept in your own browser’s storage, not on our server.</li>
      <li><b>Server logs.</b> Like most websites, our server records technical details of requests (IP address, browser type, page and time) to keep the site
        secure and working. Logs are kept for a short time.</li>
    </ul>

    <h2>2. Cookies and advertising</h2>
    <p>We may show advertisements served by <b>Google AdSense</b> and other advertising partners. These third-party vendors, including Google, use cookies to
      serve ads based on your previous visits to this and other websites. Google’s use of advertising cookies enables it and its partners to serve ads to you
      based on your visits to this site and/or other sites on the Internet.</p>
    <ul>
      <li>You can opt out of personalised advertising in <a href="https://adssettings.google.com" target="_blank" rel="noopener noreferrer">Google Ads Settings</a>,
        or opt out of some third-party vendors’ cookies at <a href="https://www.aboutads.info/choices/" target="_blank" rel="noopener noreferrer">aboutads.info</a>.</li>
      <li>How Google uses data when you use partner sites: <a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noopener noreferrer">policies.google.com/technologies/partner-sites</a>.</li>
      <li>Visitors in the EU, EEA, UK or Switzerland are asked for consent before personalised ads are shown.</li>
    </ul>

    <h2>3. How we use information</h2>
    <ul>
      <li>To run the dashboard, your Journal and the alerts you asked for.</li>
      <li>To count visitors, fix problems and protect the site from abuse.</li>
      <li>To show advertising that keeps the site free.</li>
    </ul>
    <p>We do <b>not</b> sell your personal information.</p>

    <h2>4. Third-party services</h2>
    <p>The site uses Google Sign-In (Journal), Google Analytics, Google Tag Manager and Microsoft Clarity (usage statistics), Google AdSense (advertising) and links to TradingView charts and other websites. These services have their own
      privacy policies, and we are not responsible for how they handle your data.</p>

    <h2>5. Keeping and deleting data</h2>
    <p>Journal data is kept until you delete it or ask us to. You can sign out at any time, and you can email <Mail /> from your sign-in email to have your
      Journal data deleted. Turning off alerts in your browser removes the push subscription.</p>

    <h2>6. Children</h2>
    <p>The site is meant for adults. We do not knowingly collect information from anyone under 18.</p>

    <h2>7. Your rights</h2>
    <p>Depending on where you live (for example under India’s Digital Personal Data Protection Act, 2023 or the GDPR), you may have the right to access,
      correct or delete your personal data. Write to <Mail /> and we will respond.</p>

    <h2>8. Changes to this policy</h2>
    <p>We may update this policy. The date at the top shows the latest version.</p>

    <h2>9. Contact</h2>
    <p>Privacy questions: <Mail />.</p>
  </>
}

function Terms() {
  return <>
    <h1>Terms of Use</h1>
    <p className="muted">Last updated: {UPDATED}</p>
    <p>By using NSE Sector Heatmap ({SITE}) you agree to these terms. If you do not agree, please do not use the site.</p>
    <h2>1. Information only</h2>
    <p>The site provides market data, scanners and educational content for information and learning. It is not investment, trading, tax or legal advice,
      and nothing on it is an offer or a recommendation to buy or sell any security, derivative, IPO or crypto asset. See the <a href="/disclaimer">Disclaimer</a>.</p>
    <h2>2. No guarantee of accuracy</h2>
    <p>Data comes from third-party public sources and may be delayed, incomplete or incorrect. The site is provided “as is” and “as available”, without
      warranties of any kind. It may be unavailable at times.</p>
    <h2>3. Your responsibility</h2>
    <p>You are solely responsible for your trading and investment decisions and for any profit or loss. Trading in equities, futures, options and crypto
      involves a high risk of loss.</p>
    <h2>4. Acceptable use</h2>
    <ul>
      <li>Do not copy, resell or redistribute the site’s data or content in bulk, or scrape it with automated tools.</li>
      <li>Do not try to break, overload or gain unauthorised access to the site.</li>
      <li>Do not use the site for anything unlawful.</li>
    </ul>
    <h2>5. Third-party links and advertising</h2>
    <p>The site links to and may show ads for third-party websites and products. We do not control or endorse them and are not responsible for their content,
      products or services. Please check an advertiser yourself, especially any offer about investments.</p>
    <h2>6. Limitation of liability</h2>
    <p>To the extent allowed by law, the site and its owner are not liable for any loss or damage, direct or indirect, arising from the use of the site or
      reliance on its content.</p>
    <h2>7. Changes</h2>
    <p>We may change these terms or the site at any time. Continued use means you accept the updated terms.</p>
    <h2>8. Governing law</h2>
    <p>These terms are governed by the laws of India.</p>
    <h2>9. Contact</h2>
    <p><Mail /></p>
  </>
}

function Disclaimer() {
  return <>
    <h1>Disclaimer</h1>
    <p className="muted">Last updated: {UPDATED}</p>
    <ul className="info-list">
      <li><b>Not investment advice.</b> Everything on NSE Sector Heatmap is for information and education only. It is not a recommendation to buy, sell or
        hold any security, derivative, IPO or crypto asset.</li>
      <li><b>Not SEBI-registered.</b> We are not registered with SEBI as an investment adviser or research analyst. Please consult a SEBI-registered adviser
        before making investment decisions.</li>
      <li><b>Signals are conditions, not calls.</b> Scanner results (ORB, VWAP, EMA, Supertrend, RSI, ADX, volume spikes), market bias, PCR, OI change,
        expected move and pre-open estimates only show whether certain conditions are met. They can be wrong and they change during the day.</li>
      <li><b>Data may be delayed or wrong.</b> Data comes from public sources (NSE, BSE, Yahoo Finance and others) and may be delayed, incomplete or incorrect.
        Always verify with your broker or the exchange.</li>
      <li><b>IPO and grey market premium (GMP).</b> GMP is unofficial and unregulated; it is shown for information only and is not a reliable predictor of listing price.</li>
      <li><b>Crypto.</b> Crypto assets are unregulated in India and highly risky.</li>
      <li><b>Risk.</b> Trading in equities, futures and options carries a high risk of loss. Most individual traders in equity F&O lose money. Past
        performance does not guarantee future results.</li>
      <li><b>Advertisements.</b> Ads on this site are from third parties. Showing an ad is not an endorsement of the advertiser or its products.</li>
    </ul>
    <p>By using the site you accept that you alone are responsible for your decisions. Questions: <Mail />.</p>
  </>
}

const BODY = { about: About, contact: Contact, privacy: Privacy, terms: Terms, disclaimer: Disclaimer }

export default function InfoPage({ id }) {
  const Body = BODY[id]
  return <article className="info-page panel">{Body && <Body />}</article>
}

// Footer links to the information pages (opened inside the app, no reload).
export function InfoLinks({ go }) {
  return <nav className="info-links" aria-label="Site information">
    {INFO_PAGES.map(p => <a key={p.id} href={p.path} onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); go(p.id) }}>{p.label}</a>)}
  </nav>
}
