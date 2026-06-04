export type Bucket = 'us' | 'intl' | 'bond'

export type Allocation = Record<Bucket, number>

export const ZERO_ALLOC: Allocation = { us: 0, intl: 0, bond: 0 }

export type Holding = {
  ticker: string
  shares: number
  // Optional manual overrides. If set, the app skips API lookups and uses
  // these instead. Useful for 401k trust-class funds that don't trade
  // publicly (e.g. "Vanguard Target 2060 Trust II").
  manualPrice?: number
  manualAlloc?: Allocation
  name?: string
}

export type EnrichedHolding = Holding & {
  price: number | null
  value: number | null
  alloc: Allocation
  allocSource: 'static' | 'api' | 'fallback-unknown' | 'manual'
  priceSource?: 'stooq' | 'vanguard' | 'yahoo' | 'manual'
}
