import type { Allocation, Bucket, EnrichedHolding } from './types'

export type RebalancePlan = {
  newTotal: number
  perBucket: Array<{
    bucket: Bucket
    currentValue: number
    targetValue: number
    add: number // dollars to add to this bucket (>= 0)
  }>
  suggestions: Array<{
    ticker: string
    bucket: Bucket
    dollars: number
    shares: number | null
    price: number | null
  }>
  unallocated: number
}

// Given current portfolio (already valued in $), a target % allocation per
// bucket, and a new $ amount to add, compute how to deposit the new $$ across
// buckets so the resulting portfolio drifts toward the target — without
// requiring any sells. Each bucket gets at least 0 (we can't withdraw).
// We then pick a representative ticker per bucket from the user's existing
// holdings to suggest as the actual purchase.
export function computeRebalance(
  holdings: EnrichedHolding[],
  targets: Allocation,
  newMoney: number,
): RebalancePlan {
  const buckets: Bucket[] = ['us', 'intl', 'bond']
  const currentValueByBucket: Record<Bucket, number> = {
    us: 0,
    intl: 0,
    bond: 0,
  }
  for (const h of holdings) {
    if (h.value == null) continue
    currentValueByBucket.us += h.value * h.alloc.us
    currentValueByBucket.intl += h.value * h.alloc.intl
    currentValueByBucket.bond += h.value * h.alloc.bond
  }
  const currentTotal =
    currentValueByBucket.us +
    currentValueByBucket.intl +
    currentValueByBucket.bond
  const newTotal = currentTotal + newMoney

  // Ideal target $ per bucket given the new total.
  const ideal: Record<Bucket, number> = {
    us: newTotal * targets.us,
    intl: newTotal * targets.intl,
    bond: newTotal * targets.bond,
  }

  // First pass: gap = max(0, ideal - current). Sum may exceed newMoney if
  // multiple buckets are under target. Scale proportionally to fit newMoney.
  const gaps: Record<Bucket, number> = {
    us: Math.max(0, ideal.us - currentValueByBucket.us),
    intl: Math.max(0, ideal.intl - currentValueByBucket.intl),
    bond: Math.max(0, ideal.bond - currentValueByBucket.bond),
  }
  const gapSum = gaps.us + gaps.intl + gaps.bond

  const add: Record<Bucket, number> = { us: 0, intl: 0, bond: 0 }
  if (gapSum <= 0) {
    // Every bucket already at/above target — split new money in target ratio.
    add.us = newMoney * targets.us
    add.intl = newMoney * targets.intl
    add.bond = newMoney * targets.bond
  } else if (gapSum <= newMoney) {
    // Fill all under-target buckets exactly, distribute remainder in target ratio.
    const leftover = newMoney - gapSum
    add.us = gaps.us + leftover * targets.us
    add.intl = gaps.intl + leftover * targets.intl
    add.bond = gaps.bond + leftover * targets.bond
  } else {
    // Not enough new money to fill every gap — scale gaps to newMoney.
    const scale = newMoney / gapSum
    add.us = gaps.us * scale
    add.intl = gaps.intl * scale
    add.bond = gaps.bond * scale
  }

  // Pick a ticker per bucket from existing holdings: prefer the holding whose
  // own allocation is most concentrated in that bucket. Falls back to defaults.
  const fallbackTickerByBucket: Record<Bucket, string> = {
    us: 'VTI',
    intl: 'VXUS',
    bond: 'BND',
  }
  const tickerByBucket: Record<Bucket, { ticker: string; price: number | null }> = {
    us: { ticker: fallbackTickerByBucket.us, price: null },
    intl: { ticker: fallbackTickerByBucket.intl, price: null },
    bond: { ticker: fallbackTickerByBucket.bond, price: null },
  }
  for (const b of buckets) {
    let best: { ticker: string; score: number; price: number | null } | null = null
    for (const h of holdings) {
      const score = h.alloc[b]
      if (score <= 0) continue
      if (!best || score > best.score) {
        best = { ticker: h.ticker, score, price: h.price }
      }
    }
    if (best) tickerByBucket[b] = { ticker: best.ticker, price: best.price }
  }

  const suggestions = buckets.map((b) => {
    const dollars = add[b]
    const { ticker, price } = tickerByBucket[b]
    const shares = price && price > 0 ? dollars / price : null
    return { ticker, bucket: b, dollars, shares, price }
  })

  const perBucket = buckets.map((b) => ({
    bucket: b,
    currentValue: currentValueByBucket[b],
    targetValue: ideal[b],
    add: add[b],
  }))

  const unallocated = newMoney - (add.us + add.intl + add.bond)

  return { newTotal, perBucket, suggestions, unallocated }
}
