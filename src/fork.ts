// opencode's `/fork` creates a NEW session that is a deep COPY of an existing
// session's entire message/part history. Every copied step-finish part is
// recreated with a fresh id and re-emitted through `message.part.updated`, so
// to our event handler a fork looks like thousands of brand-new turns. But no
// model was ever called — forking copies bytes, it does not spend tokens — so
// counting those parts inflates both the forked session's totals and the
// today/week/month usage log (a single fork added ~110M phantom tokens in
// practice, and forks-of-forks multiply it).
//
// There is no structured "this is a fork" flag on the Session object; the only
// marker is the auto-generated " (fork #N)" title suffix. The copied history
// arrives as a dense burst right after creation (measured: ~1270 parts in
// ~2.2s), while genuine new turns in the fork come many seconds later. So we:
//   1. flag a session as a fork from its title, and
//   2. swallow its step-finish parts while they keep arriving back-to-back,
//      resuming normal counting once activity settles (a gap > settleMs).
const FORK_TITLE = /\(fork #\d+\)$/

export class ForkTracker {
  // sessionID -> ts of the last suppressed (imported) step-finish. Presence
  // means we are still swallowing this fork's copied history. 0 = flagged but
  // no parts seen yet.
  private importing = new Map<string, number>()
  // Every fork session we have already flagged, so a later session.updated
  // carrying the same "(fork #N)" title never re-arms suppression after the
  // import has settled.
  private seen = new Set<string>()

  constructor(private settleMs = 3000) {}

  // Call on session.created / session.updated. Arms suppression the first time
  // we see a fork-titled session.
  noteSession(id: string, title: string | undefined): void {
    if (!title || !FORK_TITLE.test(title)) return
    if (this.seen.has(id)) return
    this.seen.add(id)
    this.importing.set(id, 0)
  }

  // Whether a step-finish in `sessionID` at `now` is real spend to be counted.
  // Returns false only for parts that belong to a fork's initial copy burst.
  shouldCount(sessionID: string, now: number): boolean {
    const last = this.importing.get(sessionID)
    if (last === undefined) return true // not a fork import → normal spend
    if (last !== 0 && now - last >= this.settleMs) {
      // Burst has settled; this is genuine new activity in the fork.
      this.importing.delete(sessionID)
      return true
    }
    // First copied part (last === 0) or still inside the burst → swallow.
    this.importing.set(sessionID, now)
    return false
  }
}
