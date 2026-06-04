import { useEffect, useMemo, useState } from 'react'
import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import './App.css'
import {
  BUCKET_COLOR,
  BUCKET_LABEL,
  STATIC_ALLOCATIONS,
  combineAllocs,
  normalizeAlloc,
} from './lib/allocations'
import { computeRebalance } from './lib/rebalance'
import type {
  Allocation,
  Bucket,
  EnrichedHolding,
  Holding,
} from './lib/types'
import { ZERO_ALLOC } from './lib/types'
import { fetchFundAllocation, fetchQuotes } from './lib/yahoo'

const STORAGE_KEY = 'portfolio-rebalancer:v1'
const BUCKETS: Bucket[] = ['us', 'intl', 'bond']

type Persisted = {
  holdings: Holding[]
  targets: Allocation
  newMoney: number
}

const DEFAULT_TARGETS: Allocation = { us: 0.6, intl: 0.3, bond: 0.1 }

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) throw new Error('empty')
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      holdings: Array.isArray(parsed.holdings) ? parsed.holdings : [],
      targets: parsed.targets ?? DEFAULT_TARGETS,
      newMoney: typeof parsed.newMoney === 'number' ? parsed.newMoney : 0,
    }
  } catch {
    return { holdings: [], targets: DEFAULT_TARGETS, newMoney: 0 }
  }
}

function fmtMoney(n: number | null): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  })
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

export default function App() {
  const initial = loadPersisted()
  const [holdings, setHoldings] = useState<Holding[]>(initial.holdings)
  const [targets, setTargets] = useState<Allocation>(initial.targets)
  const [newMoney, setNewMoney] = useState<number>(initial.newMoney)
  const [tickerInput, setTickerInput] = useState('')
  const [sharesInput, setSharesInput] = useState('')

  const [quotes, setQuotes] = useState<
    Record<string, { price: number | null; name?: string }>
  >({})
  const [allocOverrides, setAllocOverrides] = useState<
    Record<string, { alloc: Allocation; source: 'api' | 'fallback-unknown' }>
  >({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ holdings, targets, newMoney }),
    )
  }, [holdings, targets, newMoney])

  const enriched: EnrichedHolding[] = useMemo(() => {
    return holdings.map((h) => {
      const sym = h.ticker.toUpperCase()
      const q = quotes[sym]
      const price = q?.price ?? null
      const value = price != null ? price * h.shares : null
      const staticAlloc = STATIC_ALLOCATIONS[sym]
      let alloc: Allocation
      let allocSource: EnrichedHolding['allocSource']
      if (staticAlloc) {
        alloc = staticAlloc
        allocSource = 'static'
      } else if (allocOverrides[sym]) {
        alloc = allocOverrides[sym].alloc
        allocSource = allocOverrides[sym].source
      } else {
        alloc = { us: 1, intl: 0, bond: 0 }
        allocSource = 'fallback-unknown'
      }
      return {
        ...h,
        ticker: sym,
        price,
        value,
        alloc,
        allocSource,
        name: q?.name,
      }
    })
  }, [holdings, quotes, allocOverrides])

  const totalValue = useMemo(
    () => enriched.reduce((acc, h) => acc + (h.value ?? 0), 0),
    [enriched],
  )

  const currentAlloc: Allocation = useMemo(() => {
    if (totalValue <= 0) return ZERO_ALLOC
    const weighted = enriched
      .filter((h) => h.value != null)
      .map((h) => ({ alloc: h.alloc, weight: (h.value ?? 0) / totalValue }))
    return combineAllocs(weighted)
  }, [enriched, totalValue])

  const normalizedTargets = useMemo(() => normalizeAlloc(targets), [targets])

  const rebalance = useMemo(
    () => computeRebalance(enriched, normalizedTargets, newMoney || 0),
    [enriched, normalizedTargets, newMoney],
  )

  async function refresh() {
    if (holdings.length === 0) return
    setLoading(true)
    setError(null)
    try {
      const tickers = holdings.map((h) => h.ticker.toUpperCase())
      const q = await fetchQuotes(tickers)
      setQuotes(q)

      const unknown = tickers.filter((t) => !STATIC_ALLOCATIONS[t])
      const overrides: typeof allocOverrides = {}
      await Promise.all(
        unknown.map(async (t) => {
          const a = await fetchFundAllocation(t)
          if (a) {
            overrides[t] = { alloc: a, source: 'api' }
          } else {
            overrides[t] = {
              alloc: { us: 1, intl: 0, bond: 0 },
              source: 'fallback-unknown',
            }
          }
        }),
      )
      setAllocOverrides((prev) => ({ ...prev, ...overrides }))

      const missing = tickers.filter((t) => q[t]?.price == null)
      if (missing.length > 0) {
        setError(`couldn't get prices for: ${missing.join(', ')}`)
      }
    } catch (err) {
      console.error(err)
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  function addHolding(e: React.FormEvent) {
    e.preventDefault()
    const ticker = tickerInput.trim().toUpperCase()
    const shares = Number(sharesInput)
    if (!ticker || !Number.isFinite(shares) || shares <= 0) return
    setHoldings((prev) => {
      const existing = prev.find((h) => h.ticker.toUpperCase() === ticker)
      if (existing) {
        return prev.map((h) =>
          h.ticker.toUpperCase() === ticker ? { ...h, shares } : h,
        )
      }
      return [...prev, { ticker, shares }]
    })
    setTickerInput('')
    setSharesInput('')
  }

  function removeHolding(ticker: string) {
    setHoldings((prev) =>
      prev.filter((h) => h.ticker.toUpperCase() !== ticker.toUpperCase()),
    )
  }

  function updateShares(ticker: string, shares: number) {
    setHoldings((prev) =>
      prev.map((h) =>
        h.ticker.toUpperCase() === ticker.toUpperCase()
          ? { ...h, shares }
          : h,
      ),
    )
  }

  function updateTarget(bucket: Bucket, pct: number) {
    setTargets((prev) => ({ ...prev, [bucket]: Math.max(0, pct / 100) }))
  }

  const pieData = BUCKETS.map((b) => ({
    name: BUCKET_LABEL[b],
    value: currentAlloc[b] * totalValue,
    color: BUCKET_COLOR[b],
  })).filter((d) => d.value > 0)

  const targetSum = targets.us + targets.intl + targets.bond
  const targetSumOk = Math.abs(targetSum - 1) < 0.001

  return (
    <div className="app">
      <header className="app__header">
        <h1>portfolio rebalancer</h1>
        <p className="app__subtitle">
          see your true asset split (TDFs looked through) and figure out where
          to put new money.
        </p>
      </header>

      <section className="card">
        <div className="card__header">
          <h2>holdings</h2>
          <button onClick={refresh} disabled={loading || holdings.length === 0}>
            {loading ? 'fetching…' : 'fetch prices'}
          </button>
        </div>

        <form className="add-holding" onSubmit={addHolding}>
          <input
            placeholder="ticker (e.g. VTI)"
            value={tickerInput}
            onChange={(e) => setTickerInput(e.target.value)}
          />
          <input
            placeholder="# of shares"
            inputMode="decimal"
            value={sharesInput}
            onChange={(e) => setSharesInput(e.target.value)}
          />
          <button type="submit">add</button>
        </form>

        {holdings.length === 0 ? (
          <p className="muted">
            no holdings yet — add a few tickers above. try VTI, VXUS, BND,
            VTTSX to see the TDF look-through.
          </p>
        ) : (
          <table className="holdings">
            <thead>
              <tr>
                <th>ticker</th>
                <th>shares</th>
                <th>price</th>
                <th>value</th>
                <th>US / intl / bond</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {enriched.map((h) => (
                <tr key={h.ticker}>
                  <td>
                    <strong>{h.ticker}</strong>
                    {h.name && <div className="muted small">{h.name}</div>}
                    {h.allocSource === 'fallback-unknown' && (
                      <div className="warn small">
                        unknown — assumed 100% US
                      </div>
                    )}
                    {h.allocSource === 'api' && (
                      <div className="muted small">via yahoo profile</div>
                    )}
                  </td>
                  <td>
                    <input
                      className="shares-edit"
                      type="number"
                      step="0.001"
                      value={h.shares}
                      onChange={(e) =>
                        updateShares(h.ticker, Number(e.target.value))
                      }
                    />
                  </td>
                  <td>{fmtMoney(h.price)}</td>
                  <td>{fmtMoney(h.value)}</td>
                  <td className="small">
                    {fmtPct(h.alloc.us)} / {fmtPct(h.alloc.intl)} /{' '}
                    {fmtPct(h.alloc.bond)}
                  </td>
                  <td>
                    <button
                      className="link"
                      onClick={() => removeHolding(h.ticker)}
                    >
                      remove
                    </button>
                  </td>
                </tr>
              ))}
              <tr className="totals">
                <td colSpan={3}>
                  <strong>total</strong>
                </td>
                <td>
                  <strong>{fmtMoney(totalValue)}</strong>
                </td>
                <td className="small">
                  {fmtPct(currentAlloc.us)} / {fmtPct(currentAlloc.intl)} /{' '}
                  {fmtPct(currentAlloc.bond)}
                </td>
                <td></td>
              </tr>
            </tbody>
          </table>
        )}

        {error && <p className="error">{error}</p>}
      </section>

      {totalValue > 0 && (
        <section className="card">
          <h2>current distribution</h2>
          <div className="dist">
            <div className="dist__chart">
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                  >
                    {pieData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmtMoney(v)} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="dist__table">
              <table>
                <thead>
                  <tr>
                    <th>bucket</th>
                    <th>current</th>
                    <th>target</th>
                    <th>gap</th>
                  </tr>
                </thead>
                <tbody>
                  {BUCKETS.map((b) => {
                    const cur = currentAlloc[b]
                    const tgt = normalizedTargets[b]
                    const gap = tgt - cur
                    return (
                      <tr key={b}>
                        <td>
                          <span
                            className="swatch"
                            style={{ background: BUCKET_COLOR[b] }}
                          />
                          {BUCKET_LABEL[b]}
                        </td>
                        <td>{fmtPct(cur)}</td>
                        <td>{fmtPct(tgt)}</td>
                        <td
                          className={
                            gap > 0.005
                              ? 'gap-pos'
                              : gap < -0.005
                                ? 'gap-neg'
                                : ''
                          }
                        >
                          {gap > 0 ? '+' : ''}
                          {fmtPct(gap)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      <section className="card">
        <h2>target allocation</h2>
        <div className="targets">
          {BUCKETS.map((b) => (
            <label key={b} className="target-row">
              <span
                className="swatch"
                style={{ background: BUCKET_COLOR[b] }}
              />
              <span className="target-row__label">{BUCKET_LABEL[b]}</span>
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                value={Math.round(targets[b] * 100)}
                onChange={(e) => updateTarget(b, Number(e.target.value))}
              />
              <span>%</span>
            </label>
          ))}
        </div>
        {!targetSumOk && (
          <p className="warn small">
            targets sum to {(targetSum * 100).toFixed(0)}% — they'll be
            normalized for the calculation.
          </p>
        )}
      </section>

      <section className="card">
        <h2>rebalance with new $$</h2>
        <label className="newmoney">
          <span>i'm adding</span>
          <input
            type="number"
            min="0"
            step="100"
            value={newMoney}
            onChange={(e) => setNewMoney(Number(e.target.value))}
          />
          <span>$ to my portfolio</span>
        </label>

        {newMoney > 0 && totalValue > 0 ? (
          <div className="rebalance">
            <p className="muted small">
              suggested buys to drift toward target without selling:
            </p>
            <table>
              <thead>
                <tr>
                  <th>bucket</th>
                  <th>add $</th>
                  <th>suggested buy</th>
                  <th>~ shares</th>
                </tr>
              </thead>
              <tbody>
                {rebalance.suggestions.map((s) => (
                  <tr key={s.bucket}>
                    <td>
                      <span
                        className="swatch"
                        style={{ background: BUCKET_COLOR[s.bucket] }}
                      />
                      {BUCKET_LABEL[s.bucket]}
                    </td>
                    <td>{fmtMoney(s.dollars)}</td>
                    <td>
                      <strong>{s.ticker}</strong>{' '}
                      <span className="muted small">
                        @ {fmtMoney(s.price)}
                      </span>
                    </td>
                    <td>{s.shares != null ? s.shares.toFixed(3) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {Math.abs(rebalance.unallocated) > 0.5 && (
              <p className="muted small">
                unallocated: {fmtMoney(rebalance.unallocated)}
              </p>
            )}
          </div>
        ) : (
          <p className="muted">
            enter an amount above and fetch prices to see suggestions.
          </p>
        )}
      </section>

      <footer className="app__footer muted small">
        prices via yahoo finance (best-effort). TDF breakdowns from a static
        table + yahoo fund profile fallback — review periodically as fund
        allocations drift.
      </footer>
    </div>
  )
}
