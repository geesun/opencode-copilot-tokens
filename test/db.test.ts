import { describe, expect, test } from "bun:test"
import { Db } from "../src/db"
import type { StepDelta } from "../src/compute"

const tok = (over: Partial<StepDelta> = {}): StepDelta => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...over,
})

// In-memory DB so tests never touch disk.
const mem = () => new Db(":memory:")

// Fixed local-day timestamps for deterministic `date` columns.
const at = (y: number, m: number, d: number): number =>
  new Date(y, m - 1, d, 12, 0).getTime()

describe("Db.insertEvent + usage", () => {
  test("sums integer tokens per model within an inclusive date range", () => {
    const db = mem()
    db.insertEvent({ ts: at(2026, 6, 1), sessionID: "s1", parentID: null, modelID: "gpt", tokens: tok({ input: 100, output: 50 }) })
    db.insertEvent({ ts: at(2026, 6, 1), sessionID: "s2", parentID: null, modelID: "gpt", tokens: tok({ input: 10, output: 5 }) })
    db.insertEvent({ ts: at(2026, 6, 1), sessionID: "s1", parentID: null, modelID: "claude", tokens: tok({ input: 7 }) })
    db.insertEvent({ ts: at(2026, 5, 31), sessionID: "s1", parentID: null, modelID: "gpt", tokens: tok({ input: 999 }) })

    const u = db.usage({ start: "2026-06-01", end: "2026-06-01" })
    expect(u["gpt"]).toEqual(tok({ input: 110, output: 55 }))
    expect(u["claude"]).toEqual(tok({ input: 7 }))
  })

  test("usage excludes rows outside the range", () => {
    const db = mem()
    db.insertEvent({ ts: at(2026, 5, 20), sessionID: "s1", parentID: null, modelID: "gpt", tokens: tok({ input: 1 }) })
    expect(db.usage({ start: "2026-06-01", end: "2026-06-07" })).toEqual({})
  })
})

describe("Db.loadSession", () => {
  test("sums tokens per model for one session across dates", () => {
    const db = mem()
    db.insertEvent({ ts: at(2026, 6, 1), sessionID: "s1", parentID: null, modelID: "gpt", tokens: tok({ input: 100 }) })
    db.insertEvent({ ts: at(2026, 6, 2), sessionID: "s1", parentID: null, modelID: "gpt", tokens: tok({ input: 5, output: 2 }) })
    db.insertEvent({ ts: at(2026, 6, 1), sessionID: "other", parentID: null, modelID: "gpt", tokens: tok({ input: 999 }) })

    expect(db.loadSession("s1")).toEqual({ gpt: tok({ input: 105, output: 2 }) })
  })

  test("returns an empty object for an unknown session", () => {
    expect(mem().loadSession("nope")).toEqual({})
  })
})

describe("Db.pruneOlderThan", () => {
  test("deletes rows older than (now - days) and keeps the rest", () => {
    const db = mem()
    db.insertEvent({ ts: at(2026, 1, 1), sessionID: "s", parentID: null, modelID: "gpt", tokens: tok({ input: 1 }) })
    db.insertEvent({ ts: at(2026, 6, 1), sessionID: "s", parentID: null, modelID: "gpt", tokens: tok({ input: 2 }) })

    db.pruneOlderThan(120, new Date(2026, 5, 1, 12, 0)) // cutoff = 2026-02-01

    // Jan 1 is older than the cutoff -> gone; Jun 1 kept.
    expect(db.usage({ start: "2026-01-01", end: "2026-01-31" })).toEqual({})
    expect(db.usage({ start: "2026-06-01", end: "2026-06-01" })["gpt"].input).toBe(2)
  })
})
