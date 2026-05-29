import { mkdir, rename } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import type { SessionState } from "./types"

export const defaultDir = (): string =>
  join(homedir(), ".local", "state", "opencode", "copilot-tokens")

export class Storage {
  constructor(private readonly dir: string) {}

  path(sessionID: string): string {
    return join(this.dir, `${sessionID}.json`)
  }

  async read(sessionID: string): Promise<SessionState | null> {
    const file = Bun.file(this.path(sessionID))
    if (!(await file.exists())) return null
    return await file.json()
  }

  async write(state: SessionState): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const target = this.path(state.sessionID)
    // Caller must serialize writes per sessionID; tmp filename is not unique
    // per call. opencode emits step-finish serially per session, so this is safe.
    const tmp = `${target}.tmp`
    await Bun.write(tmp, JSON.stringify(state, null, 2))
    await rename(tmp, target)
  }
}
