import type { ModelPricing, PriceTable } from "./types"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const SOURCE_URL =
  "https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml"
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

const bundledPath = (): string => join(import.meta.dir, "..", "pricing.json")
const cachePath = (): string => join(homedir(), ".cache", "opencode", "copilot-pricing.json")

export const loadBundledPricing = async (): Promise<PriceTable> => {
  return await Bun.file(bundledPath()).json()
}

// Cache-aware loader: returns the freshest source we have without ever blocking
// on the network. The actual refresh is fired off by the TUI plugin.
export const loadPricing = async (): Promise<PriceTable> => {
  const cached = Bun.file(cachePath())
  if (await cached.exists()) {
    const t: PriceTable = await cached.json()
    const ageMs = Date.now() - new Date(`${t.fetchedAt}T00:00:00Z`).getTime()
    if (ageMs < CACHE_TTL_MS) return t
  }
  return await loadBundledPricing()
}

export const refreshPricing = async (): Promise<PriceTable | null> => {
  const res = await fetch(SOURCE_URL).catch(() => null)
  if (!res || !res.ok) return null
  const yaml = await res.text().catch(() => null)
  if (!yaml) return null
  const table = parsePricingYaml(yaml)
  if (Object.keys(table.models).length === 0) return null
  await mkdir(join(homedir(), ".cache", "opencode"), { recursive: true })
  await Bun.write(cachePath(), JSON.stringify(table, null, 2))
  return table
}

export const priceFor = (modelID: string, table: PriceTable): ModelPricing | null => {
  return table.models[modelID] ?? null
}

// --- YAML parser ---
//
// We only parse the very narrow YAML shape of github/docs's
// data/tables/copilot/models-and-pricing.yml: a top-level list of objects with
// scalar string/dollar-amount values. No nested mappings, no anchors, no
// multi-line scalars, no flow style. Keeping the parser inline avoids pulling
// in a YAML dependency for a 200-line file.

// Strip surrounding quotes from a YAML scalar value, plus footnote markers
// like [^1] that the docs site uses to attach footnotes to model names.
const unquote = (raw: string): string => {
  const trimmed = raw.trim()
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1)
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1)
  return trimmed
}

const stripFootnotes = (name: string): string => name.replace(/\[\^\d+\]/g, "").trim()

// "Claude Sonnet 4.5" → "claude-sonnet-4.5"
// "GPT-5 mini"       → "gpt-5-mini"
// "GPT-5.2-Codex"    → "gpt-5.2-codex"
const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9.\-]/g, "")

// "$3.00" → 3.0, "$0.025" → 0.025, missing/non-dollar → null
const dollars = (raw: string | undefined): number | null => {
  if (raw === undefined) return null
  const m = raw.replace(/\s/g, "").match(/^\$?(\d+(?:\.\d+)?)$/)
  return m ? parseFloat(m[1]) : null
}

export const parsePricingYaml = (yaml: string): PriceTable => {
  const models: Record<string, ModelPricing> = {}
  let current: Record<string, string> | null = null

  const flush = () => {
    if (!current) return
    const name = stripFootnotes(current["model"] ?? "")
    const input = dollars(current["input"])
    const cachedInput = dollars(current["cached_input"])
    const output = dollars(current["output"])
    const cacheWrite = "cache_write" in current ? dollars(current["cache_write"]) : null
    if (name && input !== null && cachedInput !== null && output !== null) {
      models[slugify(name)] = { input, cachedInput, output, cacheWrite }
    }
    current = null
  }

  for (const raw of yaml.split("\n")) {
    // Comments and blank lines split records.
    const trimmed = raw.trim()
    if (trimmed === "" || trimmed.startsWith("#")) {
      flush()
      continue
    }
    // "- model: ..." starts a new record. Treat it as both a flush boundary
    // and the first key/value pair of the new record.
    if (trimmed.startsWith("- ")) {
      flush()
      current = {}
      const kv = trimmed.slice(2).match(/^([a-z_]+):\s*(.*)$/)
      if (kv) current[kv[1]] = unquote(kv[2])
      continue
    }
    if (!current) continue
    const kv = trimmed.match(/^([a-z_]+):\s*(.*)$/)
    if (kv) current[kv[1]] = unquote(kv[2])
  }
  flush()

  return {
    fetchedAt: new Date().toISOString().slice(0, 10),
    source: SOURCE_URL,
    models,
  }
}
