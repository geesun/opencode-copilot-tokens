import { accumulate, costFor, emptyTotals, type StepDelta } from "./compute"
import { priceFor } from "./pricing"
import type { PriceTable, SessionState, TurnSummary } from "./types"

// Pure update: given a session's previous state (or undefined for first-ever
// step in this session) plus a new step-finish delta for a specific model,
// produce the next SessionState. Extracted from tui.tsx for unit-testability.
//
// `now` is injected so tests can pin `lastUpdated` deterministically.
export const updateSession = (
  prev: SessionState | undefined,
  sessionID: string,
  modelID: string,
  delta: StepDelta,
  pricing: PriceTable,
  now: number = Date.now(),
): SessionState => {
  const existing = prev ?? {
    sessionID,
    lastUpdated: now,
    currentModel: modelID,
    byModel: {},
    lastTurn: null,
  }
  const prevTotals = existing.byModel[modelID] ?? emptyTotals()
  const accumulated = accumulate(prevTotals, delta)
  const p = priceFor(modelID, pricing)
  const newTotals = { ...accumulated, estimatedCostUsd: costFor(accumulated, p) }

  // For "Last turn" we cost just this delta, not the cumulative totals.
  const deltaTotals = { ...emptyTotals(), ...delta }
  const lastTurn: TurnSummary = {
    model: modelID,
    input: delta.input,
    output: delta.output,
    cacheRead: delta.cacheRead,
    cacheWrite: delta.cacheWrite,
    reasoning: delta.reasoning,
    estimatedCostUsd: costFor(deltaTotals, p),
  }

  return {
    sessionID,
    lastUpdated: now,
    currentModel: modelID,
    byModel: { ...existing.byModel, [modelID]: newTotals },
    lastTurn,
  }
}
