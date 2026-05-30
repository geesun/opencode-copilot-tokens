import { describe, expect, test } from "bun:test"
import { buildQuota, pickSnapshot } from "../src/quota"

describe("pickSnapshot", () => {
  test("prefers premium_models over premium_interactions", () => {
    const got = pickSnapshot({
      premium_models: { entitlement: 1500, remaining: 500 },
      premium_interactions: { entitlement: 300, remaining: 100 },
    })
    expect(got?.source).toBe("premium_models")
    expect(got?.snapshot.entitlement).toBe(1500)
  })

  test("falls back to premium_interactions (legacy PRU)", () => {
    const got = pickSnapshot({
      premium_interactions: { entitlement: 300, remaining: 50 },
    })
    expect(got?.source).toBe("premium_interactions")
    expect(got?.snapshot.remaining).toBe(50)
  })

  test("falls back to chat for free users", () => {
    const got = pickSnapshot({
      chat: { entitlement: 50, remaining: 12 },
    })
    expect(got?.source).toBe("chat")
  })

  test("returns null when no known key is present", () => {
    expect(pickSnapshot({})).toBeNull()
    expect(pickSnapshot(undefined)).toBeNull()
    expect(pickSnapshot({ completions: { entitlement: 10, remaining: 1 } })).toBeNull()
  })
})

describe("buildQuota", () => {
  test("computes used and percent for legacy premium_interactions", () => {
    const q = buildQuota({
      copilot_plan: "individual",
      quota_reset_date: "2026-06-30",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 300,
          remaining: 75,
          unlimited: false,
          percent_remaining: 25,
        },
      },
    })
    expect(q).not.toBeNull()
    expect(q!.plan).toBe("individual")
    expect(q!.used).toBe(225)
    expect(q!.percentRemaining).toBe(25)
    expect(q!.resetDate).toBe("2026-06-30")
    expect(q!.source).toBe("premium_interactions")
  })

  test("honours unlimited flag", () => {
    const q = buildQuota({
      quota_snapshots: {
        premium_models: { entitlement: 0, remaining: 0, unlimited: true },
      },
    })
    expect(q!.unlimited).toBe(true)
    expect(q!.source).toBe("premium_models")
  })

  test("derives percentRemaining when server omits it", () => {
    const q = buildQuota({
      quota_snapshots: {
        premium_models: { entitlement: 1000, remaining: 250 },
      },
    })
    expect(q!.percentRemaining).toBe(25)
    expect(q!.used).toBe(750)
  })

  test("returns null when snapshots are missing", () => {
    expect(buildQuota({})).toBeNull()
    expect(buildQuota({ copilot_plan: "free" })).toBeNull()
  })

  test("defaults plan to 'unknown' when missing", () => {
    const q = buildQuota({
      quota_snapshots: { premium_models: { entitlement: 100, remaining: 100 } },
    })
    expect(q!.plan).toBe("unknown")
  })
})
