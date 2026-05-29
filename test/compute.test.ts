import { describe, expect, test } from "bun:test"
import { accumulate, costFor, emptyTotals } from "../src/compute"
import type { ModelTotals, PriceTable } from "../src/types"

const pricing: PriceTable = {
  fetchedAt: "2026-05-28",
  source: "test",
  models: {
    "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14.0, cacheWrite: null },
    "claude-sonnet-4.5": { input: 3.0, cachedInput: 0.3, output: 15.0, cacheWrite: 3.75 },
  },
}

describe("emptyTotals", () => {
  test("returns all zeros", () => {
    expect(emptyTotals()).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      estimatedCostUsd: 0,
    })
  })
})

describe("accumulate", () => {
  test("adds a step's tokens to an empty totals", () => {
    const result = accumulate(emptyTotals(), {
      input: 1000,
      output: 200,
      cacheRead: 500,
      cacheWrite: 0,
      reasoning: 50,
    })
    expect(result.input).toBe(1000)
    expect(result.output).toBe(200)
    expect(result.cacheRead).toBe(500)
    expect(result.cacheWrite).toBe(0)
    expect(result.reasoning).toBe(50)
  })

  test("adds to existing totals", () => {
    const prev: ModelTotals = {
      input: 100, output: 20, cacheRead: 10, cacheWrite: 0, reasoning: 5, estimatedCostUsd: 0,
    }
    const result = accumulate(prev, {
      input: 50, output: 10, cacheRead: 5, cacheWrite: 1, reasoning: 2,
    })
    expect(result).toMatchObject({
      input: 150, output: 30, cacheRead: 15, cacheWrite: 1, reasoning: 7,
    })
  })
})

describe("costFor", () => {
  test("computes cost for known OpenAI model (no cache write)", () => {
    // 1M input @ $1.75 + 500k cached @ $0.175 + 100k output @ $14
    // = 1.75 + 0.0875 + 1.40 = 3.2375
    const totals: ModelTotals = {
      input: 1_000_000,
      output: 100_000,
      cacheRead: 500_000,
      cacheWrite: 0,
      reasoning: 0,
      estimatedCostUsd: 0,
    }
    const cost = costFor(totals, pricing.models["gpt-5.2"])
    expect(cost).toBeCloseTo(3.2375, 6)
  })

  test("computes cost for Anthropic model (with cache write)", () => {
    // 1M input @ $3 + 100k cached @ $0.30 + 50k cache_write @ $3.75 + 200k output @ $15
    // = 3 + 0.03 + 0.1875 + 3 = 6.2175
    const totals: ModelTotals = {
      input: 1_000_000,
      output: 200_000,
      cacheRead: 100_000,
      cacheWrite: 50_000,
      reasoning: 0,
      estimatedCostUsd: 0,
    }
    const cost = costFor(totals, pricing.models["claude-sonnet-4.5"])
    expect(cost).toBeCloseTo(6.2175, 6)
  })

  test("returns 0 when pricing is null", () => {
    const totals: ModelTotals = {
      input: 999, output: 999, cacheRead: 999, cacheWrite: 999, reasoning: 0, estimatedCostUsd: 0,
    }
    expect(costFor(totals, null)).toBe(0)
  })

  test("ignores cache write cost when pricing has cacheWrite: null", () => {
    const totals: ModelTotals = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 99999, reasoning: 0, estimatedCostUsd: 0,
    }
    expect(costFor(totals, pricing.models["gpt-5.2"])).toBe(0)
  })
})
