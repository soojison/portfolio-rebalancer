export type Bucket = 'us' | 'intl' | 'bond'

export type Allocation = Record<Bucket, number>

export const ZERO_ALLOC: Allocation = { us: 0, intl: 0, bond: 0 }

export type Holding = {
  ticker: string
  shares: number
}

export type EnrichedHolding = Holding & {
  price: number | null
  value: number | null
  alloc: Allocation
  allocSource: 'static' | 'api' | 'fallback-unknown'
  name?: string
}
