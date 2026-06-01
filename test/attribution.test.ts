import { describe, expect, test } from "bun:test"
import { ModelRegistry } from "../src/attribution"

describe("ModelRegistry", () => {
  test("resolves each message to the model that produced it", () => {
    // One session can use multiple models (model switching, router setups).
    // Keying by messageID attributes each step-finish to its own message's
    // model; keying by sessionID (the old bug) would collapse both to the
    // last-seen model.
    const reg = new ModelRegistry()
    reg.remember("msg-a", { providerID: "github-copilot", modelID: "claude-sonnet-4.6" })
    reg.remember("msg-b", { providerID: "github-copilot", modelID: "gpt-4.1" })
    expect(reg.resolve("msg-a")).toEqual({ providerID: "github-copilot", modelID: "claude-sonnet-4.6" })
    expect(reg.resolve("msg-b")).toEqual({ providerID: "github-copilot", modelID: "gpt-4.1" })
  })

  test("returns null for an unknown message", () => {
    expect(new ModelRegistry().resolve("nope")).toBeNull()
  })

  test("a later remember for the same message overrides earlier streaming updates", () => {
    const reg = new ModelRegistry()
    reg.remember("m", { providerID: "github-copilot", modelID: "x" })
    reg.remember("m", { providerID: "github-copilot", modelID: "y" })
    expect(reg.resolve("m")?.modelID).toBe("y")
  })
})
