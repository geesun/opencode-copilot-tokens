import { describe, expect, test } from "bun:test"
import { Db } from "../src/db"
import { computeUsage } from "../src/usage"
import type { PriceTable } from "../src/types"
import type { StepDelta } from "../src/compute"

const pricing: PriceTable = {
  fetchedAt: "2026-06-01",
  source: "test",
  models: {
    gpt: { input: 3.0, cachedInput: 0.3, output: 15.0, cacheWrite: null },
  },
}

const tok = (over: Partial<StepDelta> = {}): StepDelta => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...over,
})

const at = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12, 0).getTime()

describe("computeUsage", () => {
  test("derives cost from summed tokens per model for each range", () => {
    const db = new Db(":memory:")
    // 10 tiny steps of 10 input tokens each on 'today' (2026-06-01).
    for (let i = 0; i < 10; i++) {
      db.insertEvent({ ts: at(2026, 6, 1), sessionID: "s", parentID: null, modelID: "gpt", tokens: tok({ input: 10 }) })
    }

    const now = new Date(2026, 5, 1, 12, 0)
    const result = computeUsage(db, pricing, now)
    const today = result.find((r) => r.key === "today")!

    // 100 input tokens * 3.0/1M = 0.0003 — NOT zero, despite each step being 0.00003.
    expect(today.models).toHaveLength(1)
    expect(today.models[0].model).toBe("gpt")
    expect(today.models[0].totals.input).toBe(100)
    expect(today.models[0].totals.estimatedCostUsd).toBeCloseTo(0.0003, 10)
    expect(today.totalCost).toBeCloseTo(0.0003, 10)
  })

  test("returns all five ranges with empty models when no data", () => {
    const db = new Db(":memory:")
    const result = computeUsage(db, pricing, new Date(2026, 5, 1, 12, 0))
    expect(result.map((r) => r.key)).toEqual(["today", "thisWeek", "lastWeek", "thisMonth", "lastMonth"])
    expect(result.every((r) => r.models.length === 0 && r.totalCost === 0)).toBe(true)
  })

  test("sorts models within a range by cost descending", () => {
    const db = new Db(":memory:")
    const priced: PriceTable = {
      ...pricing,
      models: {
        cheap: { input: 1.0, cachedInput: 0.1, output: 2.0, cacheWrite: null },
        pricey: { input: 50.0, cachedInput: 5.0, output: 100.0, cacheWrite: null },
      },
    }
    db.insertEvent({ ts: at(2026, 6, 1), sessionID: "s", parentID: null, modelID: "cheap", tokens: tok({ input: 1000 }) })
    db.insertEvent({ ts: at(2026, 6, 1), sessionID: "s", parentID: null, modelID: "pricey", tokens: tok({ input: 1000 }) })

    const today = computeUsage(db, priced, new Date(2026, 5, 1, 12, 0)).find((r) => r.key === "today")!
    expect(today.models.map((m) => m.model)).toEqual(["pricey", "cheap"])
  })
})
