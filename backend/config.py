"""Static configuration: sector indices, key indices, session times."""

# NSE short index symbol (as used by allIndices.indexSymbol and the
# getIndicesData constituents API) -> display label. Ordered most-specific
# first: a stock's display sector is the first index here that contains it.
SECTORS = [
    ("NIFTY IT", "IT"),
    ("NIFTY AUTO", "Auto"),
    ("NIFTY PHARMA", "Pharma"),
    ("NIFTY METAL", "Metal"),
    ("NIFTY REALTY", "Realty"),
    ("NIFTY FMCG", "FMCG"),
    ("NIFTY MEDIA", "Media"),
    ("NIFTY CEMENT", "Cement"),
    ("NIFTY PSU BANK", "PSU Bank"),
    ("NIFTY PVT BANK", "Pvt Bank"),
    ("NIFTY BANK", "Bank"),
    ("NIFTY CAPITAL MKT", "Capital Mkt"),
    ("NIFTY FIN SERVICE", "Fin Service"),
    ("NIFTY CONSR DURBL", "Consumer Durables"),
    ("NIFTY CHEMICALS", "Chemicals"),
    ("NIFTY OIL AND GAS", "Oil & Gas"),
    ("NIFTY HEALTHCARE", "Healthcare"),
    ("NIFTY IND DEFENCE", "Defence"),
    ("NIFTY ENERGY", "Energy"),
    ("NIFTY IND DIGITAL", "Digital"),
    ("NIFTY INFRA", "Infra"),
    ("NIFTY CONSUMPTION", "Consumption"),
    ("NIFTY COMMODITIES", "Commodities"),
    ("NIFTY PSE", "PSE"),
    ("NIFTY CPSE", "CPSE"),
    ("NIFTY MNC", "MNC"),
    ("NIFTY SERV SECTOR", "Services"),
]
SECTOR_LABELS = dict(SECTORS)

FO_INDEX = "SECURITIES IN F&O"
BROAD = {"n50": "NIFTY 50", "n100": "NIFTY 100", "n200": "NIFTY 200", "mid150": "NIFTY MIDCAP 150"}
KEY_INDICES = {"nifty50": "NIFTY 50", "niftybank": "NIFTY BANK", "indiavix": "INDIA VIX"}

OPEN_MIN = 9 * 60 + 15      # 09:15
OR_END_MIN = 10 * 60 + 15   # 10:15
CLOSE_MIN = 15 * 60 + 30    # 15:30
POLL_SECONDS = 10
BASELINE_SESSIONS = 5
