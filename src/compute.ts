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

// opencode reports `tokens.output` with `reasoning` already subtracted
// (see opencode session/session.ts:413). Both fields are disjoint and
// both are billed at the model's per-million `output` rate, matching
// opencode's own cost formula (session/session.ts:438).
export const costFor = (totals: ModelTotals, pricing: ModelPricing | null): number => {
  const b = costBreakdown(totals, pricing)
  return b.input + b.output + b.cacheRead + b.cacheWrite + b.reasoning
}

export type CostBreakdown = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

// Per-component cost in USD. Reasoning is billed at the output rate (same
// as opencode and the model providers). `cacheWrite` is 0 when the provider
// (e.g. GitHub Copilot) does not report cache_creation_input_tokens.
export const costBreakdown = (
  totals: ModelTotals,
  pricing: ModelPricing | null,
): CostBreakdown => {
  if (!pricing) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  return {
    input: (totals.input * pricing.input) / PER_MILLION,
    output: (totals.output * pricing.output) / PER_MILLION,
    cacheRead: (totals.cacheRead * pricing.cachedInput) / PER_MILLION,
    cacheWrite: pricing.cacheWrite ? (totals.cacheWrite * pricing.cacheWrite) / PER_MILLION : 0,
    reasoning: (totals.reasoning * pricing.output) / PER_MILLION,
  }
}
