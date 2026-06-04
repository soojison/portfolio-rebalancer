import type { Allocation, Bucket } from './types'

// Static classifications for common ETFs and mutual funds.
// Numbers are approximate fund-level allocations to (US stock / intl stock / bond).
// For broad single-bucket funds we use 100/0/0 style entries. For multi-asset
// funds (target-date, balanced) we use Vanguard / iShares / Schwab disclosed weights
// rounded for clarity. These should be reviewed periodically.
export const STATIC_ALLOCATIONS: Record<string, Allocation> = {
  // --- US total / large / broad ---
  VTI: { us: 1, intl: 0, bond: 0 },
  VOO: { us: 1, intl: 0, bond: 0 },
  IVV: { us: 1, intl: 0, bond: 0 },
  SPY: { us: 1, intl: 0, bond: 0 },
  VTSAX: { us: 1, intl: 0, bond: 0 },
  FXAIX: { us: 1, intl: 0, bond: 0 },
  FSKAX: { us: 1, intl: 0, bond: 0 },
  SCHB: { us: 1, intl: 0, bond: 0 },
  ITOT: { us: 1, intl: 0, bond: 0 },
  QQQ: { us: 1, intl: 0, bond: 0 },
  VUG: { us: 1, intl: 0, bond: 0 },
  VTV: { us: 1, intl: 0, bond: 0 },
  VB: { us: 1, intl: 0, bond: 0 },
  VO: { us: 1, intl: 0, bond: 0 },

  // --- International ---
  VXUS: { us: 0, intl: 1, bond: 0 },
  VEA: { us: 0, intl: 1, bond: 0 },
  VWO: { us: 0, intl: 1, bond: 0 },
  IXUS: { us: 0, intl: 1, bond: 0 },
  VTIAX: { us: 0, intl: 1, bond: 0 },
  FTIHX: { us: 0, intl: 1, bond: 0 },
  SCHF: { us: 0, intl: 1, bond: 0 },
  EFA: { us: 0, intl: 1, bond: 0 },
  IEFA: { us: 0, intl: 1, bond: 0 },
  IEMG: { us: 0, intl: 1, bond: 0 },

  // --- Bonds ---
  BND: { us: 0, intl: 0, bond: 1 },
  AGG: { us: 0, intl: 0, bond: 1 },
  BNDX: { us: 0, intl: 0, bond: 1 },
  VTEB: { us: 0, intl: 0, bond: 1 },
  VBTLX: { us: 0, intl: 0, bond: 1 },
  FXNAX: { us: 0, intl: 0, bond: 1 },
  TLT: { us: 0, intl: 0, bond: 1 },
  SHY: { us: 0, intl: 0, bond: 1 },
  SCHZ: { us: 0, intl: 0, bond: 1 },

  // --- Vanguard target-date (Investor) — approximate weights ---
  // These slide more toward bonds as target year approaches; values are
  // representative for 2026 and will need updating over time.
  VFFVX: { us: 0.54, intl: 0.36, bond: 0.1 }, // 2055
  VTTSX: { us: 0.54, intl: 0.36, bond: 0.1 }, // 2060
  VLXVX: { us: 0.54, intl: 0.36, bond: 0.1 }, // 2065
  VSVNX: { us: 0.54, intl: 0.36, bond: 0.1 }, // 2070
  VFIFX: { us: 0.53, intl: 0.35, bond: 0.12 }, // 2050
  VFORX: { us: 0.5, intl: 0.33, bond: 0.17 }, // 2045
  VTIVX: { us: 0.46, intl: 0.31, bond: 0.23 }, // 2040
  VTHRX: { us: 0.42, intl: 0.28, bond: 0.3 }, // 2035
  VTTHX: { us: 0.37, intl: 0.25, bond: 0.38 }, // 2030
  VTWNX: { us: 0.3, intl: 0.2, bond: 0.5 }, // 2025
  VTINX: { us: 0.18, intl: 0.12, bond: 0.7 }, // Retirement Income

  // --- Vanguard LifeStrategy (static balanced funds) ---
  VASGX: { us: 0.48, intl: 0.32, bond: 0.2 }, // Growth (80/20)
  VSMGX: { us: 0.36, intl: 0.24, bond: 0.4 }, // Moderate Growth (60/40)
  VSCGX: { us: 0.24, intl: 0.16, bond: 0.6 }, // Conservative Growth (40/60)
  VASIX: { us: 0.12, intl: 0.08, bond: 0.8 }, // Income (20/80)

  // --- Fidelity Freedom Index target-date (representative) ---
  FDKLX: { us: 0.54, intl: 0.36, bond: 0.1 }, // 2060
  FDEWX: { us: 0.54, intl: 0.36, bond: 0.1 }, // 2055
  FDKVX: { us: 0.5, intl: 0.33, bond: 0.17 }, // 2050
  FBIFX: { us: 0.42, intl: 0.28, bond: 0.3 }, // 2035

  // --- Schwab target-date index ---
  SWYNX: { us: 0.54, intl: 0.36, bond: 0.1 }, // 2060
  SWYMX: { us: 0.5, intl: 0.33, bond: 0.17 }, // 2050

  // --- Cash-ish / money market often appears, treat as bond bucket ---
  VMFXX: { us: 0, intl: 0, bond: 1 },
  SPAXX: { us: 0, intl: 0, bond: 1 },
}

export function normalizeAlloc(a: Allocation): Allocation {
  const sum = a.us + a.intl + a.bond
  if (sum <= 0) return { us: 0, intl: 0, bond: 0 }
  return { us: a.us / sum, intl: a.intl / sum, bond: a.bond / sum }
}

export function combineAllocs(
  weighted: Array<{ alloc: Allocation; weight: number }>,
): Allocation {
  const total: Allocation = { us: 0, intl: 0, bond: 0 }
  for (const { alloc, weight } of weighted) {
    total.us += alloc.us * weight
    total.intl += alloc.intl * weight
    total.bond += alloc.bond * weight
  }
  return total
}

export const BUCKET_LABEL: Record<Bucket, string> = {
  us: 'US stocks',
  intl: 'Intl stocks',
  bond: 'Bonds',
}

export const BUCKET_COLOR: Record<Bucket, string> = {
  us: '#3b82f6',
  intl: '#10b981',
  bond: '#f59e0b',
}
