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
import {
  fetchFundAllocation,
  fetchQuotes,
  type PriceSource,
} from './lib/yahoo'

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
    Record<
      string,
      { price: number | null; name?: string; source?: PriceSource }
    >
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

      // Manual price wins over everything else.
      const price =
        typeof h.manualPrice === 'number' && h.manualPrice > 0
          ? h.manualPrice
          : (q?.price ?? null)
      const priceSource: EnrichedHolding['priceSource'] =
        typeof h.manualPrice === 'number' && h.manualPrice > 0
          ? 'manual'
          : q?.source && q.source !== 'none'
            ? q.source
            : undefined

      const value = price != null ? price * h.shares : null

      const staticAlloc = STATIC_ALLOCATIONS[sym]
      let alloc: Allocation
      let allocSource: EnrichedHolding['allocSource']
      if (h.manualAlloc) {
        alloc = h.manualAlloc
        allocSource = 'manual'
      } else if (staticAlloc) {
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
        priceSource,
        name: h.name ?? q?.name,
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
      // Merge: keep last-known prices for any ticker the new fetch didn't return.
      // We compute the merged map synchronously so the `missing` check below
      // sees the up-to-date prices (state updates are async).
      const merged: typeof quotes = { ...quotes }
      for (const t of tickers) {
        if (q[t]?.price != null) merged[t] = q[t]
        else if (!merged[t]) merged[t] = q[t] ?? { price: null }
      }
      setQuotes(merged)

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

      const missing = tickers.filter((t) => merged[t]?.price == null)
      if (missing.length > 0) {
        setError(
          `couldn't get prices for: ${missing.join(', ')} (enter manually below)`,
        )
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
    if (!ticker) return
    const parsed = parseFloat(sharesInput.replace(/[^0-9.\-]/g, ''))
    const shares = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    setHoldings((prev) => {
      const existing = prev.find((h) => h.ticker.toUpperCase() === ticker)
      if (existing) {
        return prev.map((h) =>
          h.ticker.toUpperCase() === ticker
            ? { ...h, shares: shares || h.shares }
            : h,
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

  function exportJson() {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      holdings,
      targets,
      newMoney,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `portfolio-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function importJson(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result))
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('not a json object')
        }
        const importedHoldings: Holding[] = Array.isArray(parsed.holdings)
          ? parsed.holdings.filter(
              (h: any) =>
                h && typeof h.ticker === 'string' && typeof h.shares === 'number',
            )
          : []
        const importedTargets: Allocation =
          parsed.targets &&
          typeof parsed.targets.us === 'number' &&
          typeof parsed.targets.intl === 'number' &&
          typeof parsed.targets.bond === 'number'
            ? parsed.targets
            : targets
        const importedNewMoney =
          typeof parsed.newMoney === 'number' ? parsed.newMoney : newMoney

        setHoldings(importedHoldings)
        setTargets(importedTargets)
        setNewMoney(importedNewMoney)
        setError(null)
      } catch (err) {
        setError(`import failed: ${err instanceof Error ? err.message : err}`)
      }
    }
    reader.readAsText(file)
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

  function updateHolding(ticker: string, patch: Partial<Holding>) {
    setHoldings((prev) =>
      prev.map((h) =>
        h.ticker.toUpperCase() === ticker.toUpperCase() ? { ...h, ...patch } : h,
      ),
    )
  }

  const [editingTicker, setEditingTicker] = useState<string | null>(null)

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
          <div className="card__actions">
            <label className="link link--neutral small">
              import
              <input
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) importJson(f)
                  e.target.value = ''
                }}
              />
            </label>
            <button
              className="link link--neutral small"
              onClick={exportJson}
              disabled={holdings.length === 0}
            >
              export
            </button>
            <button onClick={refresh} disabled={loading || holdings.length === 0}>
              {loading ? 'fetching…' : 'fetch prices'}
            </button>
          </div>
        </div>

        <form className="add-holding" onSubmit={addHolding}>
          <input
            placeholder="ticker (e.g. VTI)"
            value={tickerInput}
            onChange={(e) => setTickerInput(e.target.value)}
          />
          <input
            placeholder="# of shares (optional)"
            type="text"
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
                    {h.allocSource === 'static' && (
                      <span className="pill pill--static" title="allocation from built-in table">
                        built-in
                      </span>
                    )}
                    {h.allocSource === 'api' && (
                      <span className="pill pill--yahoo" title="allocation from yahoo fund profile">
                        yahoo
                      </span>
                    )}
                  </td>
                  <td>
                    <input
                      className="shares-edit"
                      type="text"
                      inputMode="decimal"
                      value={h.shares === 0 ? '' : String(h.shares)}
                      placeholder="0"
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^0-9.\-]/g, '')
                        const n = parseFloat(v)
                        updateShares(h.ticker, Number.isFinite(n) ? n : 0)
                      }}
                    />
                  </td>
                  <td>
                    {fmtMoney(h.price)}
                    {h.priceSource && (
                      <span
                        className={`pill pill--${h.priceSource}`}
                        title={`price from ${h.priceSource}`}
                      >
                        {h.priceSource}
                      </span>
                    )}
                  </td>
                  <td>{fmtMoney(h.value)}</td>
                  <td className="small">
                    {fmtPct(h.alloc.us)} / {fmtPct(h.alloc.intl)} /{' '}
                    {fmtPct(h.alloc.bond)}
                  </td>
                  <td>
                    <button
                      className="link link--neutral"
                      onClick={() =>
                        setEditingTicker(
                          editingTicker === h.ticker ? null : h.ticker,
                        )
                      }
                    >
                      {editingTicker === h.ticker ? 'done' : 'edit'}
                    </button>
                    <button
                      className="link"
                      onClick={() => removeHolding(h.ticker)}
                    >
                      remove
                    </button>
                  </td>
                </tr>
              ))}
              {editingTicker && (() => {
                const h = enriched.find((x) => x.ticker === editingTicker)
                if (!h) return null
                const a = h.manualAlloc ?? h.alloc
                return (
                  <tr key={`${h.ticker}-editor`} className="editor-row">
                    <td colSpan={6}>
                      <div className="editor">
                        <div className="editor__field">
                          <label>nickname / name</label>
                          <input
                            type="text"
                            placeholder="e.g. Vanguard Target 2060 Trust II"
                            value={h.name ?? ''}
                            onChange={(e) =>
                              updateHolding(h.ticker, { name: e.target.value })
                            }
                          />
                        </div>
                        <div className="editor__field">
                          <label>manual price ($)</label>
                          <input
                            type="text"
                            inputMode="decimal"
                            placeholder="leave blank to use API"
                            value={h.manualPrice ?? ''}
                            onChange={(e) => {
                              const v = e.target.value.replace(/[^0-9.\-]/g, '')
                              const n = parseFloat(v)
                              updateHolding(h.ticker, {
                                manualPrice:
                                  Number.isFinite(n) && n > 0 ? n : undefined,
                              })
                            }}
                          />
                        </div>
                        <div className="editor__field editor__field--wide">
                          <label>custom allocation (%)</label>
                          <div className="alloc-inputs">
                            {BUCKETS.map((b) => (
                              <AllocInput
                                key={b}
                                bucket={b}
                                value={h.manualAlloc ? a[b] : null}
                                placeholder={a[b]}
                                onChange={(frac) => {
                                  const next: Allocation = {
                                    ...(h.manualAlloc ?? h.alloc),
                                    [b]: frac,
                                  }
                                  updateHolding(h.ticker, { manualAlloc: next })
                                }}
                              />
                            ))}
                            {h.manualAlloc && (
                              <button
                                className="link link--neutral small"
                                onClick={() =>
                                  updateHolding(h.ticker, {
                                    manualAlloc: undefined,
                                  })
                                }
                              >
                                reset
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )
              })()}
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
                  <Tooltip
                    formatter={(v) =>
                      fmtMoney(typeof v === 'number' ? v : Number(v))
                    }
                  />
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

function AllocInput({
  bucket,
  value,
  placeholder,
  onChange,
}: {
  bucket: Bucket
  value: number | null
  placeholder: number
  onChange: (frac: number) => void
}) {
  // Keep the displayed string in local state so the user can type things like
  // "10.99" without the parent re-formatting and rounding mid-keystroke.
  const [draft, setDraft] = useState<string>(() =>
    value == null ? '' : String(Math.round(value * 10000) / 100),
  )

  useEffect(() => {
    if (value == null) {
      setDraft('')
      return
    }
    const formatted = String(Math.round(value * 10000) / 100)
    // Only sync from props when the parsed numeric value differs from the
    // current draft. Otherwise typing "10." would get clobbered back to "10".
    const parsedDraft = parseFloat(draft)
    if (!Number.isFinite(parsedDraft) || Math.abs(parsedDraft / 100 - value) > 1e-6) {
      setDraft(formatted)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return (
    <label className="alloc-input">
      <span
        className="swatch"
        style={{ background: BUCKET_COLOR[bucket] }}
      />
      {BUCKET_LABEL[bucket]}
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        placeholder={String(Math.round(placeholder * 10000) / 100)}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9.]/g, '')
          setDraft(raw)
          const n = parseFloat(raw)
          if (Number.isFinite(n)) onChange(n / 100)
        }}
      />
      %
    </label>
  )
}
