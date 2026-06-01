/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ModelRegistry } from "./attribution"
import { costBreakdown, costFor, emptyTotals, type StepDelta } from "./compute"
import { Db, dbPath } from "./db"
import { loadPricing, priceFor, refreshPricing } from "./pricing"
import { loadQuota, type Quota } from "./quota"
import { rollupByModel, updateSession } from "./session"
import { computeUsage, type RangeUsage } from "./usage"
import type { ModelTotals, PriceTable, SessionState, TurnSummary } from "./types"

const id = "opencode-copilot-tokens"
const COPILOT = "github-copilot"
const KV_VISIBLE = "copilot-tokens.visible"

const tui: TuiPlugin = async (api) => {
  // Restore the user's last preference. api.kv.get is synchronous; the second
  // arg is the first-run default.
  const [visible, setVisible] = createSignal(api.kv.get<boolean>(KV_VISIBLE, true))
  const [pricing, setPricing] = createSignal<PriceTable>(await loadPricing())
  // Plan-level quota (premium requests / AI credits) from
  // /copilot_internal/user. Null = not yet loaded, no Copilot auth, or the
  // request failed. Refreshed on plugin start, on every idle, and via the
  // /copilot-refresh slash command.
  const [quota, setQuota] = createSignal<Quota | null>(null)
  // Computed on demand by /copilot-usage. Null = panel hidden.
  const [usage, setUsage] = createSignal<RangeUsage[] | null>(null)
  const refreshQuota = () => {
    void loadQuota().then(setQuota)
  }
  refreshQuota()
  // Fire-and-forget background refresh. Failures are silent (network down,
  // 404 from upstream URL move, etc.) — we just keep using the bundled or
  // previously-cached pricing.
  void (async () => {
    const next = await refreshPricing()
    if (!next) return
    setPricing(next)
  })()
  // Single source of truth for the sidebar render path. Mutating a plain
  // Map/object would NOT trigger re-render — see plan note above Task 7.
  const [sessions, setSessions] = createStore<Record<string, SessionState>>({})
  // childSessionID -> parentSessionID. opencode runs each subagent (Task tool)
  // in its own child session whose totals must roll up into the parent the user
  // is viewing — see rollupByModel in session.ts. A store so the sidebar
  // re-renders when a subagent session is first learned about.
  const [parentOf, setParentOf] = createStore<Record<string, string>>({})
  // Internal-only lookup, never read in the render path, so a plain Map is fine.
  // Keyed by messageID (not sessionID): a session can use multiple models, and a
  // step-finish part must be attributed to the model that produced ITS message.
  const registry = new ModelRegistry()
  const db = new Db(dbPath())
  db.pruneOlderThan(120)
  // Tracks the local date of the last retention prune so we prune at most once
  // per local day (on the first write of a new day).
  let lastPrunedDate = new Date().toLocaleDateString("en-CA") // YYYY-MM-DD
  // Per-session hydrate guard: read disk at most once per session per process.
  const hydrated = new Set<string>()

  const hydrate = (sessionID: string) => {
    if (hydrated.has(sessionID)) return
    hydrated.add(sessionID)
    const byTokens = db.loadSession(sessionID)
    if (Object.keys(byTokens).length === 0) return
    // Do not clobber state already accumulated this run.
    if (sessions[sessionID]) return
    const byModel: Record<string, ModelTotals> = {}
    for (const [model, t] of Object.entries(byTokens)) {
      byModel[model] = {
        ...emptyTotals(),
        ...t,
        estimatedCostUsd: costFor({ ...emptyTotals(), ...t }, priceFor(model, pricing())),
      }
    }
    setSessions(sessionID, {
      sessionID,
      lastUpdated: Date.now(),
      currentModel: null,
      byModel,
      lastTurn: null,
    })
  }

  // Disposers returned by api.event.on are auto-tracked by the plugin scope.
  api.event.on("message.updated", (event) => {
    const info = event.properties.info
    if (info.role !== "assistant") return
    if (!info.providerID || !info.modelID) return
    registry.remember(info.id, { providerID: info.providerID, modelID: info.modelID })
    // Hydrate as soon as we see any assistant message for this session, so
    // cumulative totals survive opencode restarts even before the user opens
    // the sidebar.
    void hydrate(info.sessionID)
  })

  api.event.on("message.part.updated", (event) => {
    const part = event.properties.part
    if (part.type !== "step-finish") return
    // Attribute by the part's OWN message, not the session's last-seen model:
    // a session may use several models. messageIDs are globally unique (never
    // reused, even across revert), so this maps each step to its true model.
    const m = registry.resolve(part.messageID)
    if (!m || m.providerID !== COPILOT) return

    const delta: StepDelta = {
      input: part.tokens.input,
      output: part.tokens.output,
      cacheRead: part.tokens.cache.read,
      cacheWrite: part.tokens.cache.write,
      reasoning: part.tokens.reasoning,
    }

    setSessions(part.sessionID, (prev) => updateSession(prev, part.sessionID, m.modelID, delta, pricing()))
    // Append one integer-token event. cost is never stored; it is derived after
    // aggregation. Writes are a single atomic INSERT, safe across sessions/processes.
    db.insertEvent({
      ts: Date.now(),
      sessionID: part.sessionID,
      parentID: parentOf[part.sessionID] ?? null,
      modelID: m.modelID,
      tokens: delta,
    })
    // Retention: prune once per local day, on the first write of a new day.
    const todayLocal = new Date().toLocaleDateString("en-CA")
    if (todayLocal !== lastPrunedDate) {
      lastPrunedDate = todayLocal
      db.pruneOlderThan(120)
    }
  })

  // Refresh plan quota whenever a turn finishes — that's when the server-side
  // counter has just been decremented, so the user gets fresh numbers
  // without an explicit /copilot-refresh.
  api.event.on("session.status", (event) => {
    if (event.properties.status?.type !== "idle") return
    refreshQuota()
  })

  // Learn the parent of each subagent session so its cost rolls up into the
  // viewed parent. session.updated/created carry the full Session, which has
  // `parentID` set for subagent sessions. Hydrate the child too so its
  // persisted totals survive an opencode restart.
  const learnParent = (info: { id: string; parentID?: string }) => {
    if (!info.parentID) return
    setParentOf(info.id, info.parentID)
    void hydrate(info.id)
  }
  api.event.on("session.updated", (event) => learnParent(event.properties.info))
  api.event.on("session.created", (event) => learnParent(event.properties.info))

  api.slots.register({
    order: 350,
    slots: {
      sidebar_content(_ctx, props) {
        // Trigger hydration the first time the sidebar is asked about this
        // session — covers the "user opens a session without sending a
        // message" case where message.updated has not fired.
        void hydrate(props.session_id)
        const state = () => sessions[props.session_id] ?? null
        // Cumulative totals include this session plus every subagent
        // descendant; lastTurn stays the viewed session's own last turn.
        const byModel = () => rollupByModel(sessions, props.session_id, parentOf)
        return (
          <box>
            <QuotaSection api={api} quota={quota()} />
            <Show when={visible()}>
              <Show
                when={state()}
                fallback={
                  <text fg={api.theme.current.textMuted}>(no Copilot turns yet)</text>
                }
              >
                {(s) => <Panel api={api} byModel={byModel()} lastTurn={s().lastTurn} pricing={pricing()} />}
              </Show>
            </Show>
            <Show when={usage()}>
              {(u: () => RangeUsage[]) => <UsagePanel api={api} ranges={u()} />}
            </Show>
          </box>
        )
      },
    },
  })

  api.keymap.registerLayer({
    priority: 1000,
    commands: [
      {
        name: "copilot-tokens.toggle",
        title: "Toggle Copilot tokens panel",
        category: "Copilot",
        namespace: "palette",
        slashName: "copilot-tokens",
        run() {
          setVisible((x) => {
            const next = !x
            api.kv.set(KV_VISIBLE, next)
            return next
          })
        },
      },
      {
        name: "copilot-tokens.refresh",
        title: "Refresh Copilot plan quota",
        category: "Copilot",
        namespace: "palette",
        slashName: "copilot-refresh",
        run() {
          refreshQuota()
        },
      },
      {
        name: "copilot-tokens.usage",
        title: "Show Copilot usage (today / week / month)",
        category: "Copilot",
        namespace: "palette",
        slashName: "copilot-usage",
        run() {
          // Toggle: hide if already shown, else compute fresh and show.
          setUsage((cur) => (cur ? null : computeUsage(db, pricing(), new Date())))
        },
      },
    ],
  })
}

const fmt = (n: number): string => n.toLocaleString("en-US")
const usd = (n: number): string => `$${n.toFixed(4)}`

// Host sidebar is 42 cols with paddingLeft/Right 2 (→ 38 inside) and the
// scrollbox child adds paddingRight 1, leaving 37 usable cols for our box.
// Use 36 for a 1-col safety margin against future host changes.
const PANEL_W = 36
const LABEL_W = 10
const VALUE_W = PANEL_W - LABEL_W - 1

// 3-column row: label | right-aligned tokens | right-aligned cost.
//   9 + 1 + 11 + 1 + 14 = 36
const COL_LABEL = 9
const COL_TOK = 11
const COL_COST = PANEL_W - COL_LABEL - COL_TOK - 2

// "in" / "147" / "$0.0004"  ->  "in              147   $0.0004"
const row3 = (label: string, tokens: string, cost: string): string =>
  label.padEnd(COL_LABEL) + " " + tokens.padStart(COL_TOK) + " " + cost.padStart(COL_COST)

// 2-column row, used by quota / total rows where there is no token count.
const row = (label: string, value: string): string =>
  label.padEnd(LABEL_W) + " " + value.padStart(VALUE_W)

// Single horizontal rule character repeated. Light glyph keeps it subtle.
const rule = (): string => "─".repeat(PANEL_W)

// Section header with a trailing rule:  "Last turn ────────────"
const section = (title: string): string => {
  const pad = PANEL_W - title.length - 1
  return title + " " + "─".repeat(Math.max(pad, 0))
}

// "claude-opus-4.8              $6.5743" — model name on the left, cost right-
// aligned to the panel edge regardless of the name's length. Used by the
// /copilot-usage ranges, where the token count is omitted as not useful.
const modelCost = (model: string, value: string): string => {
  const pad = PANEL_W - model.length - value.length
  return model + " ".repeat(Math.max(pad, 1)) + value
}

// "Copilot 10.0% (100/1000)"  — single-line header that doubles as the
// sidebar title and the live quota display. Highlighted in `warning` so it
// stands out from the muted section headers below.
const quotaLine = (q: Quota): string => {
  if (q.unlimited) return "Copilot unlimited"
  return `Copilot ${(100 - q.percentRemaining).toFixed(1)}% (${fmt(q.used)}/${fmt(q.entitlement)})`
}

const QuotaSection = (props: { api: TuiPluginApi; quota: Quota | null }) => {
  const theme = () => props.api.theme.current
  // Quota is unlimited for current accounts, so the live quota line is hidden.
  // The `quota` prop and `quotaLine` helper are kept so it can be restored by
  // rendering `quotaLine(props.quota)` here again if metered plans return.
  return (
    <text fg={theme().warning}>
      <b>Copilot Tokens</b>
    </text>
  )
}

const Panel = (props: {
  api: TuiPluginApi
  byModel: Record<string, ModelTotals>
  lastTurn: TurnSummary | null
  pricing: PriceTable
}) => {
  const theme = () => props.api.theme.current
  const models = () => Object.entries(props.byModel)
  const total = () => models().reduce((sum, [, t]) => sum + t.estimatedCostUsd, 0)
  const breakdown = (modelID: string, totals: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }) =>
    costBreakdown(
      { ...totals, estimatedCostUsd: 0 },
      priceFor(modelID, props.pricing),
    )

  return (
    <box>
      <Show when={props.lastTurn}>
        {(turn: () => TurnSummary) => {
          const b = () => breakdown(turn().model, turn())
          return (
            <box>
              <text fg={theme().textMuted}>{section("Last turn")}</text>
              <text fg={theme().text}>
                <b>{turn().model}</b>
              </text>
              <text fg={theme().textMuted}>{row3("in", fmt(turn().input), usd(b().input))}</text>
              <text fg={theme().textMuted}>{row3("out", fmt(turn().output), usd(b().output))}</text>
              <Show when={turn().cacheRead > 0}>
                <text fg={theme().textMuted}>{row3("cache(r)", fmt(turn().cacheRead), usd(b().cacheRead))}</text>
              </Show>
              <Show when={turn().cacheWrite > 0}>
                <text fg={theme().textMuted}>{row3("cache(w)", fmt(turn().cacheWrite), usd(b().cacheWrite))}</text>
              </Show>
              <Show when={turn().reasoning > 0}>
                <text fg={theme().textMuted}>{row3("think", fmt(turn().reasoning), usd(b().reasoning))}</text>
              </Show>
              <text fg={theme().text}>
                <b>{row3("cost", "", usd(turn().estimatedCostUsd))}</b>
              </text>
            </box>
          )
        }}
      </Show>

      <box>
        <text fg={theme().textMuted}>{section("Session by model")}</text>
        <For each={models()}>
          {([modelID, t]) => {
            const b = () => breakdown(modelID, t)
            return (
              <box>
                <text fg={theme().text}>
                  <b>{modelID}</b>
                </text>
                <text fg={theme().textMuted}>{row3("in", fmt(t.input), usd(b().input))}</text>
                <text fg={theme().textMuted}>{row3("out", fmt(t.output), usd(b().output))}</text>
                <Show when={t.cacheRead > 0}>
                  <text fg={theme().textMuted}>{row3("cache(r)", fmt(t.cacheRead), usd(b().cacheRead))}</text>
                </Show>
                <Show when={t.cacheWrite > 0}>
                  <text fg={theme().textMuted}>{row3("cache(w)", fmt(t.cacheWrite), usd(b().cacheWrite))}</text>
                </Show>
                <Show when={t.reasoning > 0}>
                  <text fg={theme().textMuted}>{row3("think", fmt(t.reasoning), usd(b().reasoning))}</text>
                </Show>
                <text fg={theme().text}>
                  <b>{row3("cost", "", usd(t.estimatedCostUsd))}</b>
                </text>
              </box>
            )
          }}
        </For>
      </box>

      <text fg={theme().textMuted}>{rule()}</text>
      <text fg={theme().text}>
        <b>{row("TOTAL", usd(total()))}</b>
      </text>
    </box>
  )
}

const UsagePanel = (props: { api: TuiPluginApi; ranges: RangeUsage[] }) => {
  const theme = () => props.api.theme.current
  return (
    <box>
      {/* On-demand block: a blank line above and a bold "Usage" heading fence
          it off from the always-on quota/session panel above. */}
      <text> </text>
      <text fg={theme().warning}>
        <b>Usage</b>
      </text>
      <For each={props.ranges}>
        {(r: RangeUsage) => (
          // Ranges with no usage (e.g. an empty last week/month) are hidden
          // entirely rather than shown as "(none)".
          <Show when={r.models.length > 0}>
            <box>
              <text fg={theme().textMuted}>{section(r.label)}</text>
              <For each={r.models}>
                {(mu) => (
                  <text fg={theme().text}>
                    {modelCost(mu.model, usd(mu.totals.estimatedCostUsd))}
                  </text>
                )}
              </For>
              <text fg={theme().text}>
                <b>{row("TOTAL", usd(r.totalCost))}</b>
              </text>
            </box>
          </Show>
        )}
      </For>
    </box>
  )
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
