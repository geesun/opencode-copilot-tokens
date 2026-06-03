import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { localDate } from "./ranges"
import type { StepDelta } from "./compute"

export const defaultDir = (): string =>
  join(homedir(), ".local", "state", "opencode", "copilot-tokens")

export const dbPath = (): string => join(defaultDir(), "usage.db")

// One step-finish worth of integer token counts plus its origin.
export type EventRow = {
  ts: number
  sessionID: string
  parentID: string | null
  modelID: string
  tokens: StepDelta
}

// Raw SUM(...) row shape returned by SQLite (snake_case columns).
type SumRow = {
  model_id: string
  input: number
  output: number
  cache_read: number
  cache_write: number
  reasoning: number
}

const toTotals = (rows: SumRow[]): Record<string, StepDelta> => {
  const out: Record<string, StepDelta> = {}
  for (const r of rows) {
    out[r.model_id] = {
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      reasoning: r.reasoning,
    }
  }
  return out
}

const SUM_COLS =
  "SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, " +
  "SUM(cache_write) AS cache_write, SUM(reasoning) AS reasoning"

export class Db {
  private db: Database

  constructor(path: string) {
    // bun:sqlite does not create missing parent directories — on first run the
    // ~/.local/state/opencode/copilot-tokens dir does not exist yet and opening
    // the database would throw "unable to open database file". Special SQLite
    // paths (":memory:", "") used by tests have no directory to create.
    if (path && !path.startsWith(":")) {
      mkdirSync(dirname(path), { recursive: true })
    }
    this.db = new Database(path)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        date        TEXT    NOT NULL,
        session_id  TEXT    NOT NULL,
        parent_id   TEXT,
        model_id    TEXT    NOT NULL,
        input       INTEGER NOT NULL,
        output      INTEGER NOT NULL,
        cache_read  INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        reasoning   INTEGER NOT NULL
      )
    `)
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_date ON events(date)")
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)")
  }

  insertEvent(row: EventRow): void {
    this.db
      .query(
        `INSERT INTO events
          (ts, date, session_id, parent_id, model_id, input, output, cache_read, cache_write, reasoning)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.ts,
        localDate(row.ts),
        row.sessionID,
        row.parentID,
        row.modelID,
        row.tokens.input,
        row.tokens.output,
        row.tokens.cacheRead,
        row.tokens.cacheWrite,
        row.tokens.reasoning,
      )
  }

  // Per-model integer token totals for one session, across all dates.
  loadSession(sessionID: string): Record<string, StepDelta> {
    const rows = this.db
      .query(`SELECT model_id, ${SUM_COLS} FROM events WHERE session_id = ? GROUP BY model_id`)
      .all(sessionID) as SumRow[]
    return toTotals(rows)
  }

  // Per-model integer token totals within an inclusive [start, end] date range.
  usage(range: { start: string; end: string }): Record<string, StepDelta> {
    const rows = this.db
      .query(`SELECT model_id, ${SUM_COLS} FROM events WHERE date BETWEEN ? AND ? GROUP BY model_id`)
      .all(range.start, range.end) as SumRow[]
    return toTotals(rows)
  }

  // Delete rows whose local date is older than (now - days).
  pruneOlderThan(days: number, now: Date = new Date()): void {
    const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000
    const cutoff = localDate(cutoffMs)
    this.db.query("DELETE FROM events WHERE date < ?").run(cutoff)
  }
}
