# Design: SQLite-backed token storage + daily/weekly/monthly usage view

Date: 2026-06-01
Status: Approved (pending spec review)

## Goal

Replace the current per-session JSON storage with a single `bun:sqlite`
database as the sole source of truth for GitHub Copilot token data, and add a
`/copilot-usage` slash command that reports token usage grouped by model across
several time ranges (today, this/last week, this/last month) so the user can
compare periods.

The existing per-session sidebar (real-time totals for the viewed session and
its subagents) must keep working exactly as today.

## Non-goals

- No migration of the existing 45 per-session JSON files. Start fresh.
- No server-side / GitHub API usage (Copilot does not expose per-user IDE token
  consumption; this plugin's local accounting remains the only source).
- No retention/pruning beyond a fixed 120-day window.

## Architecture (B1: SQLite single source of truth, render stays in-memory)

```
step-finish event
   ├─→ updateSession()   in-memory store  (sidebar render source, unchanged)
   └─→ db.insertEvent()  append one detail row to SQLite

hydrate / restart recovery
   └─← db.loadSession()  SUM byModel WHERE session_id  → rebuild in-memory store

/copilot-usage command
   └─← db.usage(range) for each of the 5 ranges  (aggregation runs only here)
```

**Key performance decision:** the sidebar never queries the database on render.
The in-memory `sessions` store remains the render source. The database is touched
only on:

1. step-finish — one `INSERT` (append-only, ~tens of microseconds in WAL mode),
2. hydrate / restart — one read per session to rebuild in-memory totals,
3. `/copilot-usage` — five aggregation queries, one per range.

step-finish fires at human pace (a handful per minute), so write volume is
negligible for SQLite.

## Database

Path: `~/.local/state/opencode/copilot-tokens/usage.db`

Connection pragmas (set once on open):

```sql
PRAGMA journal_mode = WAL;     -- concurrent readers + single writer
PRAGMA busy_timeout = 5000;    -- wait up to 5s for a write lock instead of erroring
PRAGMA synchronous = NORMAL;   -- safe and fast under WAL
```

### Concurrency

- **Same opencode process, multiple sessions (incl. subagent/Task child
  sessions):** all run in one plugin instance; step-finish events are dispatched
  serially, so writes are effectively single-threaded.
- **Multiple opencode processes (several TUIs):** WAL + `busy_timeout`
  serializes cross-process writes via SQLite file locking; a blocked writer waits
  rather than failing with `SQLITE_BUSY`.
- Each write is a single atomic `INSERT` (append-only event log), so there is no
  read-modify-write race and no lost updates.

### Schema

```sql
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,   -- epoch ms
  date        TEXT    NOT NULL,   -- 'YYYY-MM-DD' derived from ts using the system local timezone
  session_id  TEXT    NOT NULL,
  parent_id   TEXT,               -- spawning session for subagents, NULL otherwise
  model_id    TEXT    NOT NULL,
  input       INTEGER NOT NULL,
  output      INTEGER NOT NULL,
  cache_read  INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  reasoning   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_date    ON events(date);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
```

`date` is denormalized from `ts` using the **system local** timezone so
day/week/month grouping is a plain string/range comparison.

**No cost column.** Token counts are stored as exact integers; cost is *never*
stored and *never* summed. Every cost figure (sidebar, today, week, month) is
derived at query/render time from the **summed integer token totals** per model.

### Why store tokens, not cost (premature-rounding hazard)

Cost is linear in tokens, but per-step costs are tiny (a 10-token step might be
$0.00003). If a per-step cost were rounded to display precision (4 decimals)
before being stored or summed, it would round to $0.0000 and the money would be
lost; thousands of such steps would still sum to $0.00 even though the true
aggregate is significant.

The fix is to defer pricing until after aggregation: keep raw integer tokens,
sum them exactly (`SUM` over integers cannot lose precision), and apply the
per-model rate **once** to the summed totals:

```
cost(range, model) = SUM(input)·rate_in + SUM(output)·rate_out
                   + SUM(cache_read)·rate_cr + SUM(cache_write)·rate_cw
                   + SUM(reasoning)·rate_out      (all ÷ 1,000,000)
```

Small amounts accumulate as integers before the single multiply, so nothing
rounds to zero. This is exactly what the sidebar's `updateSession` already does
(`accumulate` tokens, then `costFor`), so behavior stays consistent. Pricing
uses the current `pricing.ts` table (prices are treated as stable; no per-step
price snapshot is stored).

## Module structure

- **New `src/db.ts`** — wraps `bun:sqlite` `Database`. Public API:
  - `insertEvent(row)` — append one step-finish row of integer token counts.
  - `loadSession(sessionID)` — `SUM(...) GROUP BY model_id` for one session,
    returns per-model integer token totals used to rebuild `SessionState`.
  - `usage(range: { start: string; end: string })` — `SUM(...) GROUP BY model_id`
    within an inclusive date range; returns per-model integer token totals.
  - `pruneOlderThan(days)` — `DELETE FROM events WHERE date < cutoff`.
  - `db.ts` returns only token totals; cost is computed by callers via
    `compute.ts` (`costFor` / `costBreakdown`) from those totals.
- **Replace `src/storage.ts`** — removed; `db.ts` takes over persistence.
- **`src/tui.tsx`** — write path calls `db.insertEvent`; hydrate calls
  `db.loadSession`; register `/copilot-usage`; add a `UsagePanel` (or command
  output) rendering the five ranges, costing each range's summed tokens per model
  via `costFor`.
- **`src/session.ts` / `src/compute.ts`** — unchanged; in-memory accumulation and
  cost math are reused. `loadSession` rebuilds `SessionState` with `byModel` set
  (cost recomputed from the summed tokens) and `lastTurn = null` (last turn is
  transient and resets on restart, as today).

## Date range helpers (local time, week starts Monday)

A small pure module computes `{ start, end }` `YYYY-MM-DD` strings for each range
from a given "now", so it is unit-testable:

- **Today**: `[today, today]`
- **This week**: `[Monday of current week, today]`
- **Last week**: `[Monday of previous week, Sunday of previous week]`
- **This month**: `[first day of current month, today]`
- **Last month**: `[first day of previous month, last day of previous month]`

## Aggregation queries

- Per session (sidebar hydrate):
  `SELECT model_id, SUM(input)... FROM events WHERE session_id = ? GROUP BY model_id`
- Usage range:
  `SELECT model_id, SUM(input)... FROM events WHERE date BETWEEN ? AND ? GROUP BY model_id`

Both return per-model **integer token totals**; the caller prices each model's
totals once via `costFor` and sums for the grand total.

Daily/weekly/monthly totals **sum all events in the range regardless of
session**. Each step-finish is recorded once under the session it occurred in
(child session for subagent work), so there is no double counting. Parent
roll-up is purely a sidebar display concern and does not apply to range totals.

## `/copilot-usage` output

All five ranges render identically: a per-model breakdown followed by a range
total, so the same model can be compared across periods.

```
Today (2026-06-01)
  claude-opus-4.8      in 70,935   out 1,114   $0.4798
  claude-sonnet-4.6    in 44,748   out 4,330   $0.4719
  TOTAL                                         $0.9517

This week (05-26 ~ 06-01)
  <per-model rows>
  TOTAL                                         $X.XXXX

Last week (05-19 ~ 05-25)
  <per-model rows>
  TOTAL                                         $X.XXXX

This month (2026-06)
  <per-model rows>
  TOTAL                                         $X.XXXX

Last month (2026-05)
  <per-model rows>
  TOTAL                                         $X.XXXX
```

## Retention

120-day window. Run `pruneOlderThan(120)` on plugin start and once per day on the
first write of a new local date (tracked by an in-memory "last pruned date").

## Testing

- `db.ts` against an in-memory database (`:memory:`):
  - insert several events across sessions/models/dates → assert `usage(range)`
    returns the correct per-model **integer token totals**,
  - assert `loadSession` reconstructs per-model token totals,
  - assert `pruneOlderThan` deletes only rows older than the cutoff.
- Cost derivation (`compute.ts`, already covered): assert that pricing the summed
  token totals once matches the expected aggregate, and that many tiny-token
  steps summed-then-priced do **not** round to zero.
- Date-range helpers: pin "now" and assert each of the five `{start,end}` pairs,
  including Monday week start and month/year boundary cases (e.g. now = Jan 1).

## Open questions

None. (Week start = Monday, all five ranges show a per-model breakdown, no
migration — all confirmed.)
