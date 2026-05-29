export type ModelTotals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  estimatedCostUsd: number
}

export type TurnSummary = {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  estimatedCostUsd: number
}

export type SessionState = {
  sessionID: string
  lastUpdated: number
  currentModel: string | null
  byModel: Record<string, ModelTotals>
  lastTurn: TurnSummary | null
}

export type ModelPricing = {
  input: number          // USD per 1M tokens
  cachedInput: number
  output: number
  cacheWrite: number | null
}

export type PriceTable = {
  fetchedAt: string      // ISO date, e.g. "2026-05-28"
  source: string
  models: Record<string, ModelPricing>
}
