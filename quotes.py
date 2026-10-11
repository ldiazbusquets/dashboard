#!/usr/bin/env python3
"""Fetches market quotes with yfinance and writes them to quotes.json.

Run by the workflow before fetch-canvas.mjs, which picks the file up and encrypts
it with everything else. Needs no account or key. Symbols come from the TICKERS
secret (comma-separated); unset means a few index ETFs, "none" turns it off.

Yahoo symbols all work here: stocks and ETFs (AAPL, SPY), indexes (^VIX, ^TNX),
crypto (BTC-USD). Only counts are printed, never the symbols.
"""
import json
import os
import re
import sys


def build(symbol, closes):
    """Turn a list of daily closes (oldest first) into one quote record."""
    closes = [float(c) for c in closes if c == c and c is not None]  # drop NaN / None
    if not closes:
        return None
    price = closes[-1]
    prev = closes[-2] if len(closes) > 1 else None
    return {
        "symbol": symbol,
        "price": round(price, 4),
        "changePct": ((price - prev) / prev * 100) if prev else None,
        "spark": [round(c, 2) for c in closes[-22:]],
    }


def main():
    raw = (os.environ.get("TICKERS") or "").strip()
    if re.fullmatch(r"(?i)none|off", raw):
        symbols = []
    else:
        symbols = [s.upper() for s in re.split(r"[\s,]+", raw or "SPY, QQQ, DIA, IWM") if re.fullmatch(r"[A-Za-z0-9.^=-]{1,12}", s)][:12]

    quotes = []
    if symbols:
        import yfinance as yf
        for sym in symbols:
            try:
                hist = yf.Ticker(sym).history(period="1mo", interval="1d", auto_adjust=True)
                q = build(sym, list(hist["Close"]))
                if q:
                    quotes.append(q)
            except Exception as e:  # one bad symbol must not stop the rest
                print(f"warn: one quote failed ({type(e).__name__})", file=sys.stderr)

    with open(os.environ.get("QUOTES_FILE", "quotes.json"), "w") as f:
        json.dump(quotes, f)
    print(f"Wrote {len(quotes)} of {len(symbols)} quotes.")


if __name__ == "__main__":
    main()
