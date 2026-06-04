import type { Allocation } from './types'
import { normalizeAlloc } from './allocations'

export type PriceSource = 'stooq' | 'vanguard' | 'yahoo' | 'none'

export type QuoteInfo = {
  price: number | null
  name?: string
  quoteType?: string
  source?: PriceSource
}

// Stooq's CSV endpoint. Batch mode (comma-separated symbols) is buggy and
// returns mangled output, so we fetch one ticker at a time in parallel.
// With f=sd2t2ohlcvn and no headers, columns are:
//   symbol, date, time, open, high, low, close, volume, name
// For unknown symbols stooq fills numeric fields with "N/D".
async function fetchStooqOne(ticker: string): Promise<QuoteInfo | null> {
  const sym = ticker.toLowerCase()
  const url = `/stooq/q/l/?s=${encodeURIComponent(sym)}.us&i=d&f=sd2t2ohlcvn&h=0`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const text = (await res.text()).trim()
    if (!text) return null
    const cols = text.split(',')
    if (cols.length < 7) return null
    const closeStr = cols[6]?.trim()
    const close = parseFloat(closeStr)
    if (!Number.isFinite(close) || close <= 0) return null
    const name = cols.slice(8).join(',').trim() || undefined
    return { price: close, name, source: 'stooq' }
  } catch (err) {
    console.warn('fetchStooqOne failed for', ticker, err)
    return null
  }
}

async function fetchStooq(
  tickers: string[],
): Promise<Record<string, QuoteInfo>> {
  const entries = await Promise.all(
    tickers.map(async (t) => [t.toUpperCase(), await fetchStooqOne(t)] as const),
  )
  const out: Record<string, QuoteInfo> = {}
  for (const [t, info] of entries) {
    if (info) out[t] = info
  }
  return out
}

// Vanguard's investor site exposes a public JSON price endpoint for every
// vanguard fund — both ETFs and mutual funds. No auth required. Each ticker
// lives under one of two paths depending on whether it's an ETF or mutual fund;
// we try both since we don't know up-front.
async function fetchVanguardOne(ticker: string): Promise<QuoteInfo | null> {
  const sym = ticker.toLowerCase()
  const paths = [
    `/vg/investment-products/mutual-funds/profile/api/${sym}/price`,
    `/vg/investment-products/etfs/profile/api/${sym}/price`,
  ]
  for (const path of paths) {
    try {
      const res = await fetch(path)
      if (!res.ok) continue
      const json = await res.json()
      const priceStr =
        json?.currentPrice?.dailyPrice?.regular?.price ??
        json?.currentPrice?.dailyPrice?.premarket?.price
      const price = parseFloat(priceStr)
      if (!Number.isFinite(price) || price <= 0) continue
      return { price, name: undefined, source: 'vanguard' }
    } catch {
      continue
    }
  }
  return null
}

// Yahoo's chart endpoint sometimes works when /v7/quote returns 429.
// Returns recent OHLC for one ticker; we just take the last close.
async function fetchYahooChart(ticker: string): Promise<QuoteInfo | null> {
  try {
    const url = `/yf/v8/finance/chart/${encodeURIComponent(
      ticker.toUpperCase(),
    )}?interval=1d&range=5d`
    const res = await fetch(url)
    if (!res.ok) return null
    const json = await res.json()
    const r = json?.chart?.result?.[0]
    if (!r) return null
    const meta = r.meta || {}
    const price =
      typeof meta.regularMarketPrice === 'number'
        ? meta.regularMarketPrice
        : null
    if (price == null) return null
    return {
      price,
      name: meta.shortName || meta.longName,
      quoteType: meta.instrumentType,
      source: 'yahoo',
    }
  } catch (err) {
    console.warn('fetchYahooChart failed for', ticker, err)
    return null
  }
}

export async function fetchQuotes(
  tickers: string[],
): Promise<Record<string, QuoteInfo>> {
  if (tickers.length === 0) return {}
  const upper = tickers.map((t) => t.toUpperCase())
  const result: Record<string, QuoteInfo> = {}

  const stooqResult = await fetchStooq(upper)
  for (const t of upper) {
    if (stooqResult[t]?.price != null) {
      result[t] = stooqResult[t]
    }
  }

  let missing = upper.filter((t) => !result[t])
  if (missing.length > 0) {
    const vgFallbacks = await Promise.all(
      missing.map(async (t) => [t, await fetchVanguardOne(t)] as const),
    )
    for (const [t, info] of vgFallbacks) {
      if (info) result[t] = info
    }
  }

  missing = upper.filter((t) => !result[t])
  if (missing.length > 0) {
    const yahooFallbacks = await Promise.all(
      missing.map(async (t) => [t, await fetchYahooChart(t)] as const),
    )
    for (const [t, info] of yahooFallbacks) {
      if (info) result[t] = info
    }
  }

  for (const t of upper) {
    if (!result[t]) result[t] = { price: null }
  }
  return result
}

// Attempt to read a fund's top-level US/intl/bond split from Yahoo's
// fundProfile + topHoldings modules. This is best-effort: Yahoo doesn't expose
// it cleanly for every fund, so callers must fall back to a static table.
export async function fetchFundAllocation(
  ticker: string,
): Promise<Allocation | null> {
  const url = `/yfq/v10/finance/quoteSummary/${encodeURIComponent(
    ticker.toUpperCase(),
  )}?modules=topHoldings,fundProfile`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const json = await res.json()
    const r = json?.quoteSummary?.result?.[0]
    if (!r) return null

    const sectorWeightings: Array<Record<string, { raw?: number }>> =
      r?.topHoldings?.sectorWeightings ?? []
    const bondHoldings = r?.topHoldings?.bondHoldings
    const stockHoldings = r?.topHoldings?.stockHoldings

    // Yahoo gives us assetClassification in fundProfile sometimes; more
    // reliable: use sectorWeightings (stock-only by sector) plus
    // bondPosition / stockPosition / cashPosition in topHoldings.
    const bondPct = r?.topHoldings?.bondPosition?.raw
    const stockPct = r?.topHoldings?.stockPosition?.raw
    const cashPct = r?.topHoldings?.cashPosition?.raw

    if (typeof stockPct !== 'number' || typeof bondPct !== 'number') {
      return null
    }

    // For US vs intl split inside the equity sleeve, Yahoo doesn't reliably
    // give a region breakdown for every fund. As a heuristic: if the
    // fundProfile says it's a US-only equity fund, push all stocks to US;
    // if international, push all to intl. Otherwise assume the typical
    // ~60/40 US/intl global split that Vanguard uses for TDFs.
    const category: string = r?.fundProfile?.categoryName?.toLowerCase?.() ?? ''
    let usFrac = 0.6
    let intlFrac = 0.4
    if (category.includes('foreign') || category.includes('international')) {
      usFrac = 0
      intlFrac = 1
    } else if (
      category.includes('large') ||
      category.includes('mid') ||
      category.includes('small') ||
      category.includes('us ')
    ) {
      usFrac = 1
      intlFrac = 0
    }

    const equity = stockPct
    const bond = bondPct + (cashPct ?? 0) // bundle cash with bonds bucket
    void stockHoldings
    void bondHoldings
    void sectorWeightings

    return normalizeAlloc({
      us: equity * usFrac,
      intl: equity * intlFrac,
      bond,
    })
  } catch (err) {
    console.warn('fetchFundAllocation failed for', ticker, err)
    return null
  }
}
