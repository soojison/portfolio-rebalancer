import type { Allocation } from './types'
import { normalizeAlloc } from './allocations'

export type QuoteInfo = {
  price: number | null
  name?: string
  quoteType?: string
}

export async function fetchQuotes(
  tickers: string[],
): Promise<Record<string, QuoteInfo>> {
  if (tickers.length === 0) return {}
  const symbols = tickers.map((t) => t.toUpperCase()).join(',')
  const url = `/yf/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`
  const result: Record<string, QuoteInfo> = {}
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`quote http ${res.status}`)
    const json = await res.json()
    const rows: any[] = json?.quoteResponse?.result ?? []
    for (const row of rows) {
      const sym = String(row.symbol || '').toUpperCase()
      result[sym] = {
        price:
          typeof row.regularMarketPrice === 'number'
            ? row.regularMarketPrice
            : null,
        name: row.shortName || row.longName,
        quoteType: row.quoteType,
      }
    }
  } catch (err) {
    console.warn('fetchQuotes failed', err)
  }
  for (const t of tickers) {
    const key = t.toUpperCase()
    if (!result[key]) result[key] = { price: null }
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
