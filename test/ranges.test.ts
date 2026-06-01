import { describe, expect, test } from "bun:test"
import { localDate, ranges } from "../src/ranges"

describe("localDate", () => {
  test("formats a timestamp as YYYY-MM-DD in local time", () => {
    const d = new Date(2026, 5, 1, 13, 30) // 2026-06-01 local
    expect(localDate(d.getTime())).toBe("2026-06-01")
  })

  test("pads single-digit month and day", () => {
    const d = new Date(2026, 0, 9, 0, 0) // 2026-01-09 local
    expect(localDate(d.getTime())).toBe("2026-01-09")
  })
})

describe("ranges", () => {
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
