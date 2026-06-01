export type ModelMeta = { providerID: string; modelID: string }

// Tracks the (provider, model) that produced each assistant message so a
// step-finish part can be attributed to the model that actually generated it —
// not merely the session's most-recently-seen model.
//
// A single session can use multiple models (the user switches models mid-
// session, or a router setup hands different turns to different models). The
// step-finish part carries only `messageID`, so keying this lookup by
// sessionID mis-attributes tokens in those sessions (~5% of sessions in
// practice). Keying by messageID is exact: every part maps back to the one
// message — and therefore the one model — that emitted it.
export class ModelRegistry {
  private byMessage = new Map<string, ModelMeta>()

  remember(messageID: string, meta: ModelMeta): void {
    this.byMessage.set(messageID, meta)
  }

  // The model that produced `messageID`, or null if we never saw it.
  resolve(messageID: string): ModelMeta | null {
    return this.byMessage.get(messageID) ?? null
  }
}
