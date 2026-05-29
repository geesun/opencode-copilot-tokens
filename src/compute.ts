import type { ModelPricing, ModelTotals } from "./types"

export const emptyTotals = (): ModelTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  estimatedCostUsd: 0,
})

export type StepDelta = Pick<ModelTotals, "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning">

export const accumulate = (prev: ModelTotals, delta: StepDelta): ModelTotals => ({
  input: prev.input + delta.input,
  output: prev.output + delta.output,
  cacheRead: prev.cacheRead + delta.cacheRead,
  cacheWrite: prev.cacheWrite + delta.cacheWrite,
  reasoning: prev.reasoning + delta.reasoning,
  estimatedCostUsd: prev.estimatedCostUsd,
})

// Pricing values are USD per 1,000,000 tokens.
const PER_MILLION = 1_000_000

export const costFor = (totals: ModelTotals, pricing: ModelPricing | null): number => {
  if (!pricing) return 0
  const input = (totals.input * pricing.input) / PER_MILLION
  const cached = (totals.cacheRead * pricing.cachedInput) / PER_MILLION
  const output = (totals.output * pricing.output) / PER_MILLION
  const cacheWrite = pricing.cacheWrite ? (totals.cacheWrite * pricing.cacheWrite) / PER_MILLION : 0
  return input + cached + output + cacheWrite
}
