import { describe, expect, test } from "bun:test"
import { loadBundledPricing, priceFor } from "../src/pricing"

describe("loadBundledPricing", () => {
  test("returns the bundled table with expected shape", async () => {
    const table = await loadBundledPricing()
    expect(table.source).toContain("docs.github.com")
    expect(typeof table.fetchedAt).toBe("string")
    expect(table.models["gpt-5.2"].input).toBe(1.75)
    expect(table.models["claude-sonnet-4.5"].cacheWrite).toBe(3.75)
    expect(table.models["gpt-5.2"].cacheWrite).toBeNull()
  })
})

describe("priceFor", () => {
  test("returns pricing for known model id", async () => {
    const table = await loadBundledPricing()
    const p = priceFor("gpt-5.2", table)
    expect(p?.input).toBe(1.75)
  })

  test("returns null for unknown model id", async () => {
    const table = await loadBundledPricing()
    expect(priceFor("never-heard-of-it", table)).toBeNull()
  })
})
