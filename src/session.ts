import { accumulate, costFor, emptyTotals, type StepDelta } from "./compute"
import { priceFor } from "./pricing"
import type { ModelTotals, PriceTable, SessionState, TurnSummary } from "./types"

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

// Roll up `byModel` totals for `rootID` plus every descendant session. opencode
// runs each subagent (Task tool) in its own child session whose `parentID`
// points at the spawning session (see opencode tool/task.ts). Those child
// sessions accumulate token/cost under their own sessionID, so the parent's
// sidebar would miss them. This merges the parent and all descendants so the
// cumulative cost matches the server-side quota, which always counts subagents.
//
// `parentOf` maps childSessionID -> parentSessionID. The cycle guard makes the
// walk safe against malformed chains.
export const rollupByModel = (
  sessions: Record<string, SessionState>,
  rootID: string,
  parentOf: Record<string, string>,
): Record<string, ModelTotals> => {
  const out: Record<string, ModelTotals> = {}
  for (const session of Object.values(sessions)) {
    if (!inScope(session.sessionID, rootID, parentOf)) continue
    for (const [model, t] of Object.entries(session.byModel)) {
      const prev = out[model] ?? emptyTotals()
      out[model] = {
        input: prev.input + t.input,
        output: prev.output + t.output,
        cacheRead: prev.cacheRead + t.cacheRead,
        cacheWrite: prev.cacheWrite + t.cacheWrite,
        reasoning: prev.reasoning + t.reasoning,
        estimatedCostUsd: prev.estimatedCostUsd + t.estimatedCostUsd,
      }
    }
  }
  return out
}

// True when `id` is `rootID` or any ancestor in its parent chain is `rootID`.
const inScope = (id: string, rootID: string, parentOf: Record<string, string>): boolean => {
  const seen = new Set<string>()
  let cur: string | undefined = id
  while (cur && !seen.has(cur)) {
    if (cur === rootID) return true
    seen.add(cur)
    cur = parentOf[cur]
  }
  return false
}
