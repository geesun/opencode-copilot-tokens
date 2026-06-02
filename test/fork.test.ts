import { describe, expect, test } from "bun:test"
import { ForkTracker } from "../src/fork"

describe("ForkTracker", () => {
  test("counts every step-finish for a normal (non-fork) session", () => {
    const ft = new ForkTracker()
    ft.noteSession("ses1", "My normal session")
    expect(ft.shouldCount("ses1", 1000)).toBe(true)
    expect(ft.shouldCount("ses1", 2000)).toBe(true)
  })

  test("counts a session we never heard a title for", () => {
    expect(new ForkTracker().shouldCount("unknown", 1000)).toBe(true)
  })

  test("suppresses the copy burst of a fork, then resumes counting", () => {
    // opencode's /fork deep-copies the whole history: a rapid burst of
    // step-finish parts arrives right after creation, then genuine new turns
    // come much later. Suppress the burst, count the rest.
    const ft = new ForkTracker(3000)
    ft.noteSession("fork1", "Some task (fork #1)")

    // Burst: parts a few ms apart — all suppressed.
    let t = 100_000
    for (let i = 0; i < 5; i++) {
      expect(ft.shouldCount("fork1", t)).toBe(false)
      t += 2 // ~2ms apart, like the real copy burst
    }

    // A genuine new turn arrives long after the burst settles → counted.
    expect(ft.shouldCount("fork1", t + 20_000)).toBe(true)
    // Everything after the burst is normal activity → counted.
    expect(ft.shouldCount("fork1", t + 25_000)).toBe(true)
  })

  test("does not re-arm suppression after the import has settled", () => {
    // session.updated keeps firing with the same "(fork #N)" title forever;
    // re-arming would wrongly swallow real post-fork activity.
    const ft = new ForkTracker(3000)
    ft.noteSession("fork1", "T (fork #2)")
    expect(ft.shouldCount("fork1", 1_000)).toBe(false) // first copied part
    expect(ft.shouldCount("fork1", 50_000)).toBe(true) // settled → counted

    ft.noteSession("fork1", "T (fork #2)") // late session.updated, same title
    expect(ft.shouldCount("fork1", 60_000)).toBe(true) // must stay counted
  })

  test("recognises the fork suffix only at the end of the title", () => {
    const ft = new ForkTracker(3000)
    ft.noteSession("a", "real (fork #10)")
    ft.noteSession("b", "talking about (fork #1) in the middle")
    expect(ft.shouldCount("a", 1)).toBe(false) // treated as fork
    expect(ft.shouldCount("b", 1)).toBe(true) // not a fork
  })
})
