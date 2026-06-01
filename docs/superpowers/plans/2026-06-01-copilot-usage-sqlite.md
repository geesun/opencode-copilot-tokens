# Copilot Usage SQLite Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-session JSON storage with a single `bun:sqlite` database of integer token events, and add a `/copilot-usage` command showing per-model token usage and cost across today / this week / last week / this month / last month.

**Architecture:** SQLite is the sole source of truth (append-only event log of integer token counts). The sidebar still renders from the in-memory `sessions` store (never queries the DB on render). Cost is never stored — it is derived after aggregation by pricing summed integer token totals once per model, eliminating per-step rounding-to-zero.

**Tech Stack:** Bun (`bun:sqlite`, `bun:test`), TypeScript, SolidJS + `@opentui/solid` (TUI).

**Reference spec:** `docs/superpowers/specs/2026-06-01-copilot-usage-sqlite-design.md`

**Note on bun:** the runtime binary is `bun` (at `~/.bun/bin/bun`, v1.3.14). All test commands below assume `bun` is on `PATH`; if not, prefix with `~/.bun/bin/`.

---

## File Structure

- `src/ranges.ts` (new) — pure date helpers: `localDate(ts)` and `ranges(now)` producing the five labeled `{start,end}` date ranges (local time, week starts Monday).
- `src/db.ts` (new) — `bun:sqlite` wrapper: schema, `insertEvent`, `loadSession`, `usage`, `pruneOlderThan`, plus `defaultDir()` / `dbPath()`. Returns integer token totals only.
- `src/usage.ts` (new) — combines `db.usage()` + `ranges()` + `compute.ts` cost math into a renderable `RangeUsage[]`.
- `src/tui.tsx` (modify) — swap storage for `Db`; rewrite write path and `hydrate`; add retention pruning; register `/copilot-usage`; render a `UsagePanel`.
- `src/storage.ts` (delete) — replaced by `db.ts`.
- `test/ranges.test.ts`, `test/db.test.ts`, `test/usage.test.ts` (new).
- `test/storage.test.ts` (delete).

---

## Task 1: Date-range helpers (`src/ranges.ts`)

**Files:**
- Create: `src/ranges.ts`
- Test: `test/ranges.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/ranges.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { localDate, ranges } from "../src/ranges"

describe("localDate", () => {
  test("formats a timestamp as YYYY-MM-DD in local time", () => {
    // Construct a local date explicitly so the test is timezone-independent.
    const d = new Date(2026, 5, 1, 13, 30) // 2026-06-01 local
    expect(localDate(d.getTime())).toBe("2026-06-01")
  })

  test("pads single-digit month and day", () => {
    const d = new Date(2026, 0, 9, 0, 0) // 2026-01-09 local
    expect(localDate(d.getTime())).toBe("2026-01-09")
  })
})

describe("ranges", () => {
  // Monday 2026-06-01 13:00 local. Week (Mon-start) = 06-01..06-07.
  const now = new Date(2026, 5, 1, 13, 0)
  const byKey = Object.fromEntries(ranges(now).map((r) => [r.key, r]))

  test("today is a single-day range", () => {
    expect(byKey.today.start).toBe("2026-06-01")
    expect(byKey.today.end).toBe("2026-06-01")
    expect(byKey.today.label).toBe("Today (2026-06-01)")
  })

  test("this week starts Monday and ends today", () => {
    expect(byKey.thisWeek.start).toBe("2026-06-01")
    expect(byKey.thisWeek.end).toBe("2026-06-01")
    expect(byKey.thisWeek.label).toBe("This week (06-01 ~ 06-01)")
  })

  test("last week is the previous Monday..Sunday", () => {
    expect(byKey.lastWeek.start).toBe("2026-05-25")
    expect(byKey.lastWeek.end).toBe("2026-05-31")
    expect(byKey.lastWeek.label).toBe("Last week (05-25 ~ 05-31)")
  })

  test("this month is first-of-month..today", () => {
    expect(byKey.thisMonth.start).toBe("2026-06-01")
    expect(byKey.thisMonth.end).toBe("2026-06-01")
    expect(byKey.thisMonth.label).toBe("This month (2026-06)")
  })

  test("last month is the full previous calendar month", () => {
    expect(byKey.lastMonth.start).toBe("2026-05-01")
    expect(byKey.lastMonth.end).toBe("2026-05-31")
    expect(byKey.lastMonth.label).toBe("Last month (2026-05)")
  })

  test("handles year boundary: now = Jan 1 2026 (a Thursday)", () => {
    const jan1 = new Date(2026, 0, 1, 9, 0)
    const k = Object.fromEntries(ranges(jan1).map((r) => [r.key, r]))
    // Week containing Thu Jan 1 2026 starts Mon Dec 29 2025.
    expect(k.thisWeek.start).toBe("2025-12-29")
    expect(k.lastWeek.start).toBe("2025-12-22")
    expect(k.lastWeek.end).toBe("2025-12-28")
    expect(k.lastMonth.start).toBe("2025-12-01")
    expect(k.lastMonth.end).toBe("2025-12-31")
  })

  test("returns the five ranges in display order", () => {
    expect(ranges(now).map((r) => r.key)).toEqual([
      "today", "thisWeek", "lastWeek", "thisMonth", "lastMonth",
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/ranges.test.ts`
Expected: FAIL — `Cannot find module '../src/ranges'`.

- [ ] **Step 3: Write the implementation**

Create `src/ranges.ts`:

```ts
export type Range = { key: string; label: string; start: string; end: string }

const pad = (n: number): string => String(n).padStart(2, "0")

// 'YYYY-MM-DD' for a Date's LOCAL calendar day.
const ymd = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// 'MM-DD' for compact range labels.
const md = (d: Date): string => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// 'YYYY-MM' for month labels.
const ym = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`

// 'YYYY-MM-DD' for an epoch-ms timestamp, in the system local timezone.
export const localDate = (ts: number): string => ymd(new Date(ts))

// The five comparison ranges, computed from `now` in local time.
// Week starts Monday. Returned in display order.
export const ranges = (now: Date): Range[] => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const dow = today.getDay() // 0=Sun .. 6=Sat
  const mondayOffset = (dow + 6) % 7
  const thisMon = new Date(today)
  thisMon.setDate(today.getDate() - mondayOffset)
  const lastMon = new Date(thisMon)
  lastMon.setDate(thisMon.getDate() - 7)
  const lastSun = new Date(thisMon)
  lastSun.setDate(thisMon.getDate() - 1)

  const thisMonth1 = new Date(today.getFullYear(), today.getMonth(), 1)
  const lastMonth1 = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0) // day 0 = last day of prev month

  return [
    { key: "today", label: `Today (${ymd(today)})`, start: ymd(today), end: ymd(today) },
    {
      key: "thisWeek",
      label: `This week (${md(thisMon)} ~ ${md(today)})`,
      start: ymd(thisMon),
      end: ymd(today),
    },
    {
      key: "lastWeek",
      label: `Last week (${md(lastMon)} ~ ${md(lastSun)})`,
      start: ymd(lastMon),
      end: ymd(lastSun),
    },
    {
      key: "thisMonth",
      label: `This month (${ym(today)})`,
      start: ymd(thisMonth1),
      end: ymd(today),
    },
    {
      key: "lastMonth",
      label: `Last month (${ym(lastMonth1)})`,
      start: ymd(lastMonth1),
      end: ymd(lastMonthEnd),
    },
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/ranges.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/ranges.ts test/ranges.test.ts
git commit -m "feat(ranges): local date + five comparison range helpers"
```

---

## Task 2: SQLite wrapper (`src/db.ts`)

**Files:**
- Create: `src/db.ts`
- Test: `test/db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/db.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db.test.ts`
Expected: FAIL — `Cannot find module '../src/db'`.

- [ ] **Step 3: Write the implementation**

Create `src/db.ts`:

```ts
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { homedir } from "node:os"
import { localDate } from "./ranges"
import type { StepDelta } from "./compute"

export const defaultDir = (): string =>
  join(homedir(), ".local", "state", "opencode", "copilot-tokens")

export const dbPath = (): string => join(defaultDir(), "usage.db")

// One step-finish worth of integer token counts plus its origin.
export type EventRow = {
  ts: number
  sessionID: string
  parentID: string | null
  modelID: string
  tokens: StepDelta
}

// Raw SUM(...) row shape returned by SQLite (snake_case columns).
type SumRow = {
  model_id: string
  input: number
  output: number
  cache_read: number
  cache_write: number
  reasoning: number
}

const toTotals = (rows: SumRow[]): Record<string, StepDelta> => {
  const out: Record<string, StepDelta> = {}
  for (const r of rows) {
    out[r.model_id] = {
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      reasoning: r.reasoning,
    }
  }
  return out
}

const SUM_COLS =
  "SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, " +
  "SUM(cache_write) AS cache_write, SUM(reasoning) AS reasoning"

export class Db {
  private db: Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        date        TEXT    NOT NULL,
        session_id  TEXT    NOT NULL,
        parent_id   TEXT,
        model_id    TEXT    NOT NULL,
        input       INTEGER NOT NULL,
        output      INTEGER NOT NULL,
        cache_read  INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        reasoning   INTEGER NOT NULL
      )
    `)
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_date ON events(date)")
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)")
  }

  insertEvent(row: EventRow): void {
    this.db
      .query(
        `INSERT INTO events
          (ts, date, session_id, parent_id, model_id, input, output, cache_read, cache_write, reasoning)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.ts,
        localDate(row.ts),
        row.sessionID,
        row.parentID,
        row.modelID,
        row.tokens.input,
        row.tokens.output,
        row.tokens.cacheRead,
        row.tokens.cacheWrite,
        row.tokens.reasoning,
      )
  }

  // Per-model integer token totals for one session, across all dates.
  loadSession(sessionID: string): Record<string, StepDelta> {
    const rows = this.db
      .query(`SELECT model_id, ${SUM_COLS} FROM events WHERE session_id = ? GROUP BY model_id`)
      .all(sessionID) as SumRow[]
    return toTotals(rows)
  }

  // Per-model integer token totals within an inclusive [start, end] date range.
  usage(range: { start: string; end: string }): Record<string, StepDelta> {
    const rows = this.db
      .query(`SELECT model_id, ${SUM_COLS} FROM events WHERE date BETWEEN ? AND ? GROUP BY model_id`)
      .all(range.start, range.end) as SumRow[]
    return toTotals(rows)
  }

  // Delete rows whose local date is older than (now - days).
  pruneOlderThan(days: number, now: Date = new Date()): void {
    const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000
    const cutoff = localDate(cutoffMs)
    this.db.query("DELETE FROM events WHERE date < ?").run(cutoff)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts test/db.test.ts
git commit -m "feat(db): bun:sqlite event log with usage/loadSession/prune"
```

---

## Task 3: Usage view model (`src/usage.ts`)

**Files:**
- Create: `src/usage.ts`
- Test: `test/usage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/usage.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/usage.test.ts`
Expected: FAIL — `Cannot find module '../src/usage'`.

- [ ] **Step 3: Write the implementation**

Create `src/usage.ts`:

```ts
import { costFor, emptyTotals } from "./compute"
import { priceFor } from "./pricing"
import { ranges } from "./ranges"
import type { Db } from "./db"
import type { ModelTotals, PriceTable } from "./types"

export type ModelUsage = { model: string; totals: ModelTotals }
export type RangeUsage = {
  key: string
  label: string
  models: ModelUsage[]
  totalCost: number
}

// For each of the five ranges, sum integer tokens per model (from the DB) and
// price the summed totals ONCE — never per step — so tiny amounts cannot round
// to zero. Models are sorted by cost descending.
export const computeUsage = (db: Db, pricing: PriceTable, now: Date): RangeUsage[] =>
  ranges(now).map((r) => {
    const byTokens = db.usage({ start: r.start, end: r.end })
    const models: ModelUsage[] = Object.entries(byTokens).map(([model, t]) => {
      const totals: ModelTotals = {
        ...emptyTotals(),
        ...t,
        estimatedCostUsd: costFor({ ...emptyTotals(), ...t }, priceFor(model, pricing)),
      }
      return { model, totals }
    })
    models.sort((a, b) => b.totals.estimatedCostUsd - a.totals.estimatedCostUsd)
    const totalCost = models.reduce((sum, m) => sum + m.totals.estimatedCostUsd, 0)
    return { key: r.key, label: r.label, models, totalCost }
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/usage.test.ts`
Expected: PASS — note the first test proves summed-then-priced ≠ 0.

- [ ] **Step 5: Commit**

```bash
git add src/usage.ts test/usage.test.ts
git commit -m "feat(usage): per-range per-model usage with cost derived after aggregation"
```

---

## Task 4: Swap storage for Db in the TUI write + hydrate paths

**Files:**
- Modify: `src/tui.tsx`

This task rewires persistence. The sidebar render path and in-memory store are unchanged.

- [ ] **Step 1: Replace the storage import and instantiation**

In `src/tui.tsx`, change the imports near the top. Replace:

```ts
import { defaultDir, Storage } from "./storage"
```

with:

```ts
import { costFor, emptyTotals } from "./compute"
import { Db, dbPath } from "./db"
```

(There is already `import { costBreakdown, type StepDelta } from "./compute"` — keep it; the new line adds `costFor`/`emptyTotals`. If your linter forbids duplicate imports from the same module, instead merge into a single line: `import { costBreakdown, costFor, emptyTotals, type StepDelta } from "./compute"` and do NOT add a second compute import.)

Then replace:

```ts
  const storage = new Storage(defaultDir())
```

with:

```ts
  const db = new Db(dbPath())
  db.pruneOlderThan(120)
  // Tracks the local date of the last retention prune so we prune at most once
  // per local day (on the first write of a new day).
  let lastPrunedDate = new Date().toLocaleDateString("en-CA") // YYYY-MM-DD
```

- [ ] **Step 2: Rewrite `hydrate` to read from the DB (synchronous)**

Replace the entire `hydrate` function:

```ts
  const hydrate = async (sessionID: string) => {
    if (hydrated.has(sessionID)) return
    hydrated.add(sessionID)
    const loaded = await storage.read(sessionID)
    if (!loaded) return
    // Do not clobber state that was already accumulated this run (a step-finish
    // event may have arrived between our hydrate() call and the disk read).
    if (sessions[sessionID]) return
    setSessions(sessionID, loaded)
  }
```

with:

```ts
  const hydrate = (sessionID: string) => {
    if (hydrated.has(sessionID)) return
    hydrated.add(sessionID)
    const byTokens = db.loadSession(sessionID)
    if (Object.keys(byTokens).length === 0) return
    // Do not clobber state already accumulated this run.
    if (sessions[sessionID]) return
    const byModel: Record<string, ModelTotals> = {}
    for (const [model, t] of Object.entries(byTokens)) {
      byModel[model] = {
        ...emptyTotals(),
        ...t,
        estimatedCostUsd: costFor({ ...emptyTotals(), ...t }, priceFor(model, pricing())),
      }
    }
    setSessions(sessionID, {
      sessionID,
      lastUpdated: Date.now(),
      currentModel: null,
      byModel,
      lastTurn: null,
    })
  }
```

Note: `hydrate` is now synchronous. All existing `void hydrate(...)` call sites still compile (`void` on a non-promise is valid). Add the `ModelTotals` type import if not already present — `src/tui.tsx` already imports `type { ModelTotals, ... } from "./types"`, so no change needed.

- [ ] **Step 3: Rewrite the step-finish write path to insert an event**

In the `api.event.on("message.part.updated", ...)` handler, replace:

```ts
    setSessions(part.sessionID, (prev) => updateSession(prev, part.sessionID, m.modelID, delta, pricing()))
    // Persist after every accumulation. Fire-and-forget: opencode emits
    // step-finish serially per session so writes do not race for the same
    // sessionID, and a brief disk lag does not affect rendering.
    void storage.write(sessions[part.sessionID])
```

with:

```ts
    setSessions(part.sessionID, (prev) => updateSession(prev, part.sessionID, m.modelID, delta, pricing()))
    // Append one integer-token event. cost is never stored; it is derived after
    // aggregation. Writes are a single atomic INSERT, safe across sessions/processes.
    db.insertEvent({
      ts: Date.now(),
      sessionID: part.sessionID,
      parentID: parentOf[part.sessionID] ?? null,
      modelID: m.modelID,
      tokens: delta,
    })
    // Retention: prune once per local day, on the first write of a new day.
    const todayLocal = new Date().toLocaleDateString("en-CA")
    if (todayLocal !== lastPrunedDate) {
      lastPrunedDate = todayLocal
      db.pruneOlderThan(120)
    }
```

- [ ] **Step 4: Verify the project type-checks and existing tests still pass**

Run: `bun test`
Expected: PASS for `compute`, `session`, `rollup`, `pricing`, `pricing-parse`, `quota`, `ranges`, `db`, `usage`. (`storage.test.ts` still references `../src/storage`, which still exists at this point, so it also passes. It is removed in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add src/tui.tsx
git commit -m "refactor(tui): persist token events to SQLite, hydrate from DB"
```

---

## Task 5: `/copilot-usage` command + UsagePanel

**Files:**
- Modify: `src/tui.tsx`

- [ ] **Step 1: Add usage imports and signals**

At the top of `src/tui.tsx`, add to the existing imports:

```ts
import { computeUsage, type RangeUsage } from "./usage"
```

Inside the `tui` function, near the other `createSignal` declarations (after the `quota` signal), add:

```ts
  // Computed on demand by /copilot-usage. Null = panel hidden.
  const [usage, setUsage] = createSignal<RangeUsage[] | null>(null)
```

- [ ] **Step 2: Register the `/copilot-usage` command**

In `api.keymap.registerLayer({ ... commands: [ ... ] })`, add a third command after the existing `copilot-tokens.refresh` entry:

```ts
      {
        name: "copilot-tokens.usage",
        title: "Show Copilot usage (today / week / month)",
        category: "Copilot",
        namespace: "palette",
        slashName: "copilot-usage",
        run() {
          // Toggle: hide if already shown, else compute fresh and show.
          setUsage((cur) => (cur ? null : computeUsage(db, pricing(), new Date())))
        },
      },
```

- [ ] **Step 3: Render the UsagePanel in the sidebar**

In the `sidebar_content` slot's returned JSX, add a `<Show>` for the usage panel. Change:

```tsx
          <box>
            <QuotaSection api={api} quota={quota()} />
            <Show when={visible()}>
```

to:

```tsx
          <box>
            <QuotaSection api={api} quota={quota()} />
            <Show when={usage()}>
              {(u: () => RangeUsage[]) => <UsagePanel api={api} ranges={u()} />}
            </Show>
            <Show when={visible()}>
```

- [ ] **Step 4: Add the UsagePanel component**

At the bottom of `src/tui.tsx`, before `const plugin: TuiPluginModule ...`, add:

```tsx
const UsagePanel = (props: { api: TuiPluginApi; ranges: RangeUsage[] }) => {
  const theme = () => props.api.theme.current
  return (
    <box>
      <For each={props.ranges}>
        {(r: RangeUsage) => (
          <box>
            <text fg={theme().textMuted}>{section(r.label)}</text>
            <Show
              when={r.models.length > 0}
              fallback={<text fg={theme().textMuted}>{row("(none)", usd(0))}</text>}
            >
              <For each={r.models}>
                {(mu) => (
                  <text fg={theme().textMuted}>
                    {row3(mu.model, fmt(mu.totals.input + mu.totals.output), usd(mu.totals.estimatedCostUsd))}
                  </text>
                )}
              </For>
              <text fg={theme().text}>
                <b>{row("TOTAL", usd(r.totalCost))}</b>
              </text>
            </Show>
          </box>
        )}
      </For>
    </box>
  )
}
```

This reuses the existing `section`, `row`, `row3`, `fmt`, `usd` helpers already defined in the file. The token column shows `input + output` for a compact per-model line; the per-range `TOTAL` is the derived cost.

- [ ] **Step 5: Sanity-check the full test suite still passes**

Run: `bun test`
Expected: PASS (no test imports the TUI; this confirms nothing else broke).

- [ ] **Step 6: Commit**

```bash
git add src/tui.tsx
git commit -m "feat(tui): /copilot-usage command and usage panel"
```

---

## Task 6: Remove the obsolete JSON storage module

**Files:**
- Delete: `src/storage.ts`
- Delete: `test/storage.test.ts`

- [ ] **Step 1: Confirm nothing imports storage anymore**

Run: `grep -rn "storage" src test --include="*.ts" --include="*.tsx"`
Expected: no references to `./storage`, `../src/storage`, or the `Storage` class (only unrelated word matches, if any). If any remain, fix them before deleting.

- [ ] **Step 2: Delete the files**

```bash
git rm src/storage.ts test/storage.test.ts
```

- [ ] **Step 3: Run the full test suite**

Run: `bun test`
Expected: PASS — `ranges`, `db`, `usage`, `compute`, `session`, `rollup`, `pricing`, `pricing-parse`, `quota`. No `storage` test remains.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove JSON storage, superseded by SQLite"
```

---

## Task 7: Manual verification + docs note

**Files:**
- Modify: `README.md` (document the new command)

- [ ] **Step 1: Add a README line for the command**

In `README.md`, find where the existing `/copilot-tokens` and `/copilot-refresh` commands are documented and add:

```markdown
- `/copilot-usage` — toggle a panel showing token usage and estimated cost per model for today, this/last week, and this/last month (data stored locally in `~/.local/state/opencode/copilot-tokens/usage.db`).
```

If the README has no command list, add a short "Commands" section containing all three.

- [ ] **Step 2: Full test suite green**

Run: `bun test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document /copilot-usage command"
```

---

## Self-Review notes (already applied)

- **Spec coverage:** SQLite single source (Task 2), integer-token schema/no cost column (Task 2), cost-after-aggregation (Task 3), in-memory render preserved (Tasks 4–5), concurrency PRAGMAs (Task 2), five ranges Monday-start with per-model breakdown (Tasks 1, 3, 5), 120-day retention on start + daily (Tasks 4, 2), no migration / fresh start (storage removed in Task 6, no import step), tests incl. tiny-token non-zero (Task 3), date-range boundaries (Task 1).
- **Type consistency:** `Db` methods return `Record<string, StepDelta>`; `computeUsage` consumes them via `compute.ts` (`costFor`, `emptyTotals`) and `pricing.ts` (`priceFor`); `RangeUsage`/`ModelUsage` used consistently in `usage.ts` and the `UsagePanel`. `hydrate` made synchronous; all call sites use `void` which remains valid.
