import { describe, expect, test } from "bun:test"
import { rollupByModel } from "../src/session"
import type { ModelTotals, SessionState } from "../src/types"

const totals = (over: Partial<ModelTotals> = {}): ModelTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  estimatedCostUsd: 0,
  ...over,
})

const sessionWith = (id: string, byModel: Record<string, ModelTotals>): SessionState => ({
  sessionID: id,
  lastUpdated: 0,
  currentModel: null,
  byModel,
  lastTurn: null,
})

describe("rollupByModel", () => {
  test("returns the root session's own totals when it has no descendants", () => {
    const sessions = {
      root: sessionWith("root", { "gpt-5": totals({ input: 100, estimatedCostUsd: 0.001 }) }),
    }
    const out = rollupByModel(sessions, "root", {})

    expect(out["gpt-5"].input).toBe(100)
    expect(out["gpt-5"].estimatedCostUsd).toBeCloseTo(0.001, 10)
  })

  test("merges a child session's totals into the root, same model summed", () => {
    const sessions = {
      root: sessionWith("root", { "gpt-5": totals({ input: 100, estimatedCostUsd: 0.001 }) }),
      child: sessionWith("child", { "gpt-5": totals({ input: 40, estimatedCostUsd: 0.0004 }) }),
    }
    const out = rollupByModel(sessions, "root", { child: "root" })

    expect(out["gpt-5"].input).toBe(140)
    expect(out["gpt-5"].estimatedCostUsd).toBeCloseTo(0.0014, 10)
  })

  test("a child running a different model gets its own bucket", () => {
    const sessions = {
      root: sessionWith("root", { "gpt-5": totals({ input: 100 }) }),
      child: sessionWith("child", { "claude-opus": totals({ input: 50, estimatedCostUsd: 0.01 }) }),
    }
    const out = rollupByModel(sessions, "root", { child: "root" })

    expect(out["gpt-5"].input).toBe(100)
    expect(out["claude-opus"].input).toBe(50)
    expect(out["claude-opus"].estimatedCostUsd).toBeCloseTo(0.01, 10)
  })

  test("rolls up grandchildren (nested subagents)", () => {
    const sessions = {
      root: sessionWith("root", { m: totals({ input: 1 }) }),
      child: sessionWith("child", { m: totals({ input: 10 }) }),
      grandchild: sessionWith("grandchild", { m: totals({ input: 100 }) }),
    }
    const out = rollupByModel(sessions, "root", { child: "root", grandchild: "child" })

    expect(out["m"].input).toBe(111)
  })

  test("excludes sibling sessions that are not descendants of root", () => {
    const sessions = {
      root: sessionWith("root", { m: totals({ input: 1 }) }),
      other: sessionWith("other", { m: totals({ input: 999 }) }),
    }
    const out = rollupByModel(sessions, "root", {})

    expect(out["m"].input).toBe(1)
  })

  test("merges every numeric field, not just input", () => {
    const sessions = {
      root: sessionWith("root", {
        m: totals({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5, estimatedCostUsd: 0.6 }),
      }),
      child: sessionWith("child", {
        m: totals({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 50, estimatedCostUsd: 6 }),
      }),
    }
    const out = rollupByModel(sessions, "root", { child: "root" })

    expect(out["m"]).toEqual({
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheWrite: 44,
      reasoning: 55,
      estimatedCostUsd: 6.6,
    })
  })

  test("survives a parent-chain cycle without infinite looping", () => {
    const sessions = {
      a: sessionWith("a", { m: totals({ input: 1 }) }),
      b: sessionWith("b", { m: totals({ input: 2 }) }),
    }
    // a -> b -> a is a malformed cycle; rollup must terminate.
    const out = rollupByModel(sessions, "a", { a: "b", b: "a" })

    expect(out["m"].input).toBe(3)
  })
})
