import { costFor, emptyTotals } from "./compute"
import { priceFor } from "./pricing"
import { ranges } from "./ranges"
import type { Db } from "./db"
import type { ModelTotals, PriceTable } from "./types"

export type ModelUsage = { model: string; totals: ModelTotals }
export type RangeUsage = {
  key: string
  label: string
  models: ModelUsage[]
  totalCost: number
}

// For each of the five ranges, sum integer tokens per model (from the DB) and
// price the summed totals ONCE — never per step — so tiny amounts cannot round
// to zero. Models are sorted by cost descending.
export const computeUsage = (db: Db, pricing: PriceTable, now: Date): RangeUsage[] =>
  ranges(now).map((r) => {
    const byTokens = db.usage({ start: r.start, end: r.end })
    const models: ModelUsage[] = Object.entries(byTokens).map(([model, t]) => {
      const totals: ModelTotals = {
        ...emptyTotals(),
        ...t,
        estimatedCostUsd: costFor({ ...emptyTotals(), ...t }, priceFor(model, pricing)),
      }
      return { model, totals }
    })
    models.sort((a, b) => b.totals.estimatedCostUsd - a.totals.estimatedCostUsd)
    const totalCost = models.reduce((sum, m) => sum + m.totals.estimatedCostUsd, 0)
    return { key: r.key, label: r.label, models, totalCost }
  })
