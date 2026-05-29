import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Storage } from "../src/storage"
import type { SessionState } from "../src/types"

let dir: string
let storage: Storage

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "copilot-tokens-test-"))
  storage = new Storage(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const sample = (id: string): SessionState => ({
  sessionID: id,
  lastUpdated: 123,
  currentModel: "gpt-5.2",
  byModel: {
    "gpt-5.2": {
      input: 1, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 0, estimatedCostUsd: 0.001,
    },
  },
  lastTurn: null,
})

describe("Storage", () => {
  test("read returns null when file does not exist", async () => {
    expect(await storage.read("ses_missing")).toBeNull()
  })

  test("write then read round-trips", async () => {
    const state = sample("ses_1")
    await storage.write(state)
    expect(await storage.read("ses_1")).toEqual(state)
  })

  test("write is atomic — partial files are not left behind", async () => {
    await storage.write(sample("ses_2"))
    const tmpFile = Bun.file(storage.path("ses_2") + ".tmp")
    expect(await tmpFile.exists()).toBe(false)
  })

  test("path is deterministic and sessionID-keyed", () => {
    expect(storage.path("ses_abc")).toBe(join(dir, "ses_abc.json"))
  })
})
