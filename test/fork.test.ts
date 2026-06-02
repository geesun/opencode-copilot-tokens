import { describe, expect, test } from "bun:test"
import { isForkCopy } from "../src/fork"

describe("isForkCopy", () => {
  // opencode's Session.fork creates the new session first (stamping
  // session.time.created = now), then clones the source's messages while
  // PRESERVING each message's original time.created. So a cloned message always
  // predates its session; a genuinely new turn is created at/after it.
  test("a message created before its session is a fork copy", () => {
    expect(isForkCopy(1000, 2000)).toBe(true)
  })

  test("a message created at the same instant as its session is NOT a copy", () => {
    // createNext stamps the session, then the first real message is created
    // at/after it. Strict inequality keeps that first message counted.
    expect(isForkCopy(2000, 2000)).toBe(false)
  })

  test("a message created after its session is real activity, not a copy", () => {
    // Covers genuine new turns made inside a fork, and revert+regenerate
    // (regenerated messages get a fresh, later time.created).
    expect(isForkCopy(3000, 2000)).toBe(false)
  })
})
