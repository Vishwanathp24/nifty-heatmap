"""Search/AI-crawler friendly HTML: every page URL gets its own title, description, canonical,
social tags, JSON-LD and a plain-text summary in the first HTML response (the app itself is
client-rendered, so without this crawlers see an empty page)."""
import html
import json

SITE = "https://moneymaau.com"
NAME = "NSE Sector Heatmap"

# path -> (title, description, h1, intro, indexable)
PAGES = {
    "/": (
        "NSE Sector Heatmap: Nifty PCR, FII/DII Flows & F&O Breadth",
        "Live NSE market overview: Nifty put-call ratio, market bias, FII/DII activity, Nifty 50 and F&O breadth, global cues and top movers in one screen.",
        "NSE market overview: Nifty PCR, market bias and F&O breadth",
        "Nifty put-call ratio (PCR) from open interest, a market bias reading, FII and DII cash-market activity, Nifty 50 and F&O universe breadth, global cues and the day's top movers. "
        "Data comes from NSE and other public sources and is for information only, not investment advice.",
        True,
    ),
    "/heatmap": (
        "NSE Sector Heatmap: Sector-wise Moves in Nifty & F&O Stocks",
        "Heatmap of NSE sectors and F&O stocks colored by percentage change, with the day's top gainers and losers per sector.",
        "NSE sector heatmap",
        "See which NSE sectors are leading or lagging today, drill into the F&O stocks inside each sector, and send a selection of sectors to the ORB Scanner.",
        True,
    ),
    "/orb-scanner": (
        "NSE ORB Scanner: Opening Range Breakout Stocks (5/15/30/60 min)",
        "Opening range breakout scanner for NSE F&O stocks with 5, 15, 30 and 60 minute opening ranges, breakout and breakdown signals and filters.",
        "NSE opening range breakout (ORB) scanner",
        "An opening range breakout (ORB) scanner for NSE F&O stocks. Choose a 5, 15, 30 or 60 minute opening range and see which stocks have broken above the range high or below the range low.",
        True,
    ),
    "/intraday-scanner": (
        "NSE Intraday Scanner: VWAP, EMA, Supertrend, RSI & ADX",
        "Intraday trend scanner for NSE F&O stocks using VWAP, EMA 5/9, Supertrend, RSI and ADX on 15-minute and 1-hour candles, with live charts.",
        "NSE intraday trend scanner",
        "Scans NSE F&O stocks on 15-minute and 1-hour candles for VWAP, EMA 5/9, Supertrend, RSI and ADX/DI conditions, with live charts and option chain tools.",
        True,
    ),
    "/crypto": (
        "Crypto Market Overview: Prices, Trending Coins & Options",
        "Crypto prices with 24-hour change, distance from all-time high, category heatmap, trending coins and options data.",
        "Crypto market overview",
        "Top crypto prices with today's and 24-hour change, distance from all-time high and one-year low, a category heatmap, trending coins and options data. Crypto trades around the clock.",
        True,
    ),
    "/ipo": (
        "IPO Tracker India: Open IPOs, GMP, Subscription & Lot Size",
        "Mainboard and SME IPO tracker for India with price band, lot size, minimum application amount, subscription status and dates.",
        "India IPO tracker",
        "Upcoming, open and recently listed IPOs in India with price band, lot size, the minimum amount for a retail and HNI application, subscription status and key dates.",
        True,
    ),
    "/learning": (
        "Learn Options & Technical Analysis: PCR, ORB, VWAP, Supertrend",
        "Plain-language lessons on put-call ratio, opening range breakout, VWAP, EMA, Supertrend, RSI and ADX as used on this dashboard.",
        "Learn the indicators used on this dashboard",
        "Short explanations of put-call ratio (PCR), opening range breakout (ORB), VWAP, EMA, Supertrend, RSI and ADX, and how each one is read on the scanners.",
        True,
    ),
    "/journal": (
        "Trading Journal | NSE Sector Heatmap",
        "Personal trading journal for logging and reviewing trades.",
        "Trading journal",
        "Log and review your own trades. This page shows personal data after sign-in.",
        False,
    ),
}


def indexable_paths():
    return [p for p, v in PAGES.items() if v[4]]


def render(index_html: str, path: str) -> str:
    title, desc, h1, intro, indexable = PAGES[path]
    url = SITE + ("" if path == "/" else path)
    canonical = url if path != "/" else SITE + "/"
    e = html.escape
    graph = {"@context": "https://schema.org", "@graph": [
        {"@type": "WebSite", "@id": SITE + "/#website", "name": NAME, "url": SITE + "/", "inLanguage": "en-IN"},
        {"@type": "WebPage", "@id": canonical + "#webpage", "url": canonical, "name": title, "description": desc,
         "isPartOf": {"@id": SITE + "/#website"}, "inLanguage": "en-IN"},
    ]}
    head = (
        f"<title>{e(title)}</title>\n"
        f'    <meta name="description" content="{e(desc, quote=True)}" />\n'
        f'    <meta name="robots" content="{"index,follow" if indexable else "noindex,follow"}" />\n'
        f'    <link rel="canonical" href="{canonical}" />\n'
        f'    <meta property="og:type" content="website" />\n'
        f'    <meta property="og:site_name" content="{NAME}" />\n'
        f'    <meta property="og:title" content="{e(title, quote=True)}" />\n'
        f'    <meta property="og:description" content="{e(desc, quote=True)}" />\n'
        f'    <meta property="og:url" content="{canonical}" />\n'
        f'    <meta name="twitter:card" content="summary" />\n'
        f'    <meta name="twitter:title" content="{e(title, quote=True)}" />\n'
        f'    <meta name="twitter:description" content="{e(desc, quote=True)}" />\n'
        f'    <script type="application/ld+json">{json.dumps(graph, separators=(",", ":")).replace("</", "<\\/")}</script>'
    )
    nav = "".join(f'<a href="{p}">{e(PAGES[p][2])}</a> ' for p in PAGES if p != path and PAGES[p][4])
    body = f'<div id="root"><main><h1>{e(h1)}</h1><p>{e(intro)}</p><nav>{nav}</nav></main></div>'
    out = index_html.replace("<title>NSE Sector Heatmap</title>", head, 1)
    return out.replace('<div id="root"></div>', body, 1)


def robots() -> str:
    return f"User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: {SITE}/sitemap.xml\n"


def sitemap(lastmod: str) -> str:
    urls = "".join(
        f"<url><loc>{SITE}{'/' if p == '/' else p}</loc><lastmod>{lastmod}</lastmod></url>" for p in indexable_paths())
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>\n'


NOT_FOUND = (
    '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    '<meta name="robots" content="noindex"><title>Page not found | NSE Sector Heatmap</title></head>'
    '<body style="font-family:system-ui;background:#0F1218;color:#e6e9ef;padding:48px"><h1>Page not found</h1>'
    '<p><a style="color:#6ea8ff" href="/">Go to the NSE market overview</a></p></body></html>'
)
