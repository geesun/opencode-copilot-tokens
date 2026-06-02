// Deterministic fork-copy detection.
//
// opencode's `/fork` (Session.fork in packages/opencode/src/session/session.ts)
// creates a NEW session via createNext — which stamps `time.created = Date.now()`
// and emits `session.created` — and THEN clones the source session's messages
// with `updateMessage({ ...msg.info, id: newID, sessionID })`. The spread keeps
// each cloned message's ORIGINAL `time.created`, so every copy predates the
// session it was copied into. Any genuinely new turn (including revert+
// regenerate) is created at/after the session.
//
// Hence the exact, heuristic-free rule below: a step-finish belongs to a fork's
// copied history iff its message was created before its session. Forking
// performs no model calls, so those copies must not be counted as spend. In a
// normal session every message is created at/after the session, so this never
// suppresses real activity.
export function isForkCopy(messageCreated: number, sessionCreated: number): boolean {
  return messageCreated < sessionCreated
}
