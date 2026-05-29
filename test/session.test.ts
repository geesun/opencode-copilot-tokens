import { describe, expect, test } from "bun:test"
import type { StepDelta } from "../src/compute"
import { updateSession } from "../src/session"
import type { PriceTable } from "../src/types"

const pricing: PriceTable = {
  fetchedAt: "2026-05-29",
  source: "test",
  models: {
    "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2.0, cacheWrite: null },
    "claude-sonnet-4.5": { input: 3.0, cachedInput: 0.3, output: 15.0, cacheWrite: 3.75 },
  },
}

const delta = (over: Partial<StepDelta> = {}): StepDelta => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  ...over,
})

describe("updateSession", () => {
  test("creates a session from undefined and populates byModel + lastTurn", () => {
    const next = updateSession(undefined, "ses_1", "gpt-5-mini", delta({ input: 1000, output: 500 }), pricing, 42)

    expect(next.sessionID).toBe("ses_1")
    expect(next.lastUpdated).toBe(42)
    expect(next.currentModel).toBe("gpt-5-mini")
    // 1000 * 0.25/1M = 0.00025;  500 * 2.0/1M = 0.001;  total = 0.00125
    expect(next.byModel["gpt-5-mini"].input).toBe(1000)
    expect(next.byModel["gpt-5-mini"].output).toBe(500)
    expect(next.byModel["gpt-5-mini"].estimatedCostUsd).toBeCloseTo(0.00125, 10)
    // Last turn equals this single delta (since it's the first one).
    expect(next.lastTurn?.input).toBe(1000)
    expect(next.lastTurn?.estimatedCostUsd).toBeCloseTo(0.00125, 10)
  })

  test("accumulates a second delta for the same model", () => {
    const first = updateSession(undefined, "ses_1", "gpt-5-mini", delta({ input: 1000, output: 500 }), pricing, 1)
    const second = updateSession(first, "ses_1", "gpt-5-mini", delta({ input: 200, output: 100 }), pricing, 2)

    expect(second.byModel["gpt-5-mini"].input).toBe(1200)
    expect(second.byModel["gpt-5-mini"].output).toBe(600)
    // cumulative cost = 1200 * 0.25/1M + 600 * 2.0/1M = 0.0003 + 0.0012 = 0.0015
    expect(second.byModel["gpt-5-mini"].estimatedCostUsd).toBeCloseTo(0.0015, 10)
    // Last turn reflects ONLY the second delta, not cumulative.
    expect(second.lastTurn?.input).toBe(200)
    expect(second.lastTurn?.estimatedCostUsd).toBeCloseTo(0.00005 + 0.0002, 10)
  })

  test("keeps prior model totals when switching to a new model", () => {
    const a = updateSession(undefined, "ses_1", "gpt-5-mini", delta({ input: 1000, output: 500 }), pricing, 1)
    const b = updateSession(a, "ses_1", "claude-sonnet-4.5", delta({ input: 2000, output: 1000 }), pricing, 2)

    expect(b.currentModel).toBe("claude-sonnet-4.5")
    expect(b.byModel["gpt-5-mini"].input).toBe(1000) // preserved
    expect(b.byModel["claude-sonnet-4.5"].input).toBe(2000)
    expect(b.lastTurn?.model).toBe("claude-sonnet-4.5")
  })

  test("unknown model has zero cost but still accumulates tokens", () => {
    const next = updateSession(undefined, "ses_1", "unknown-model", delta({ input: 1000, output: 500 }), pricing, 1)

    expect(next.byModel["unknown-model"].input).toBe(1000)
    expect(next.byModel["unknown-model"].estimatedCostUsd).toBe(0)
    expect(next.lastTurn?.estimatedCostUsd).toBe(0)
  })

  test("cache write is billed when the model has a cacheWrite price", () => {
    const next = updateSession(
      undefined,
      "ses_1",
      "claude-sonnet-4.5",
      delta({ input: 1000, cacheWrite: 1000 }),
      pricing,
      1,
    )
    // input 1000 * 3.0/1M = 0.003; cacheWrite 1000 * 3.75/1M = 0.00375; total = 0.00675
    expect(next.byModel["claude-sonnet-4.5"].estimatedCostUsd).toBeCloseTo(0.00675, 10)
  })
})
