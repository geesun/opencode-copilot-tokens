import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { parsePricingYaml } from "../src/pricing"

const sample = await Bun.file(join(import.meta.dir, "fixtures", "sample-pricing.yml")).text()

describe("parsePricingYaml", () => {
  test("parses an OpenAI model without cache_write", () => {
    const t = parsePricingYaml(sample)
    expect(t.models["gpt-5-mini"]).toEqual({
      input: 0.25,
      cachedInput: 0.025,
      output: 2.0,
      cacheWrite: null,
    })
  })

  test("strips footnote markers like [^1] from model name before slugifying", () => {
    const t = parsePricingYaml(sample)
    // GPT-4.1[^1] -> gpt-4.1
    expect(t.models["gpt-4.1"]).toEqual({
      input: 2.0,
      cachedInput: 0.5,
      output: 8.0,
      cacheWrite: null,
    })
  })

  test("parses Anthropic model with cache_write", () => {
    const t = parsePricingYaml(sample)
    expect(t.models["claude-sonnet-4.5"]).toEqual({
      input: 3.0,
      cachedInput: 0.3,
      output: 15.0,
      cacheWrite: 3.75,
    })
    expect(t.models["claude-opus-4.6"]).toEqual({
      input: 5.0,
      cachedInput: 0.5,
      output: 25.0,
      cacheWrite: 6.25,
    })
  })

  test("handles Gemini model name with footnote + double-quoted notes", () => {
    const t = parsePricingYaml(sample)
    expect(t.models["gemini-2.5-pro"]).toEqual({
      input: 1.25,
      cachedInput: 0.125,
      output: 10.0,
      cacheWrite: null,
    })
  })

  test("sets fetchedAt to today's date in YYYY-MM-DD and a source url", () => {
    const t = parsePricingYaml(sample)
    expect(t.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(t.source).toContain("github/docs")
  })

  test("returns at least all the models in the sample", () => {
    const t = parsePricingYaml(sample)
    expect(Object.keys(t.models).length).toBeGreaterThanOrEqual(5)
  })
})
