/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { costBreakdown, type StepDelta } from "./compute"
import { loadPricing, priceFor, refreshPricing } from "./pricing"
import { loadQuota, type Quota } from "./quota"
import { rollupByModel, updateSession } from "./session"
import { defaultDir, Storage } from "./storage"
import type { ModelTotals, PriceTable, SessionState, TurnSummary } from "./types"

const id = "opencode-copilot-tokens"
const COPILOT = "github-copilot"
const KV_VISIBLE = "copilot-tokens.visible"

type SessionMeta = { providerID: string; modelID: string }

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
  const meta = new Map<string, SessionMeta>()
  const storage = new Storage(defaultDir())
  // Per-session hydrate guard: read disk at most once per session per process.
  const hydrated = new Set<string>()

  const hydrate = async (sessionID: string) => {
    if (hydrated.has(sessionID)) return
    hydrated.add(sessionID)
    const loaded = await storage.read(sessionID)
    if (!loaded) return
    // Do not clobber state that was already accumulated this run (a step-finish
    // event may have arrived between our hydrate() call and the disk read).
    if (sessions[sessionID]) return
    setSessions(sessionID, loaded)
  }

  // Disposers returned by api.event.on are auto-tracked by the plugin scope.
  api.event.on("message.updated", (event) => {
    const info = event.properties.info
    if (info.role !== "assistant") return
    if (!info.providerID || !info.modelID) return
    meta.set(info.sessionID, { providerID: info.providerID, modelID: info.modelID })
    // Hydrate as soon as we see any assistant message for this session, so
    // cumulative totals survive opencode restarts even before the user opens
    // the sidebar.
    void hydrate(info.sessionID)
  })

  api.event.on("message.part.updated", (event) => {
    const part = event.properties.part
    if (part.type !== "step-finish") return
    const m = meta.get(part.sessionID)
    if (!m || m.providerID !== COPILOT) return

    const delta: StepDelta = {
      input: part.tokens.input,
      output: part.tokens.output,
      cacheRead: part.tokens.cache.read,
      cacheWrite: part.tokens.cache.write,
      reasoning: part.tokens.reasoning,
    }

    setSessions(part.sessionID, (prev) => updateSession(prev, part.sessionID, m.modelID, delta, pricing()))
    // Persist after every accumulation. Fire-and-forget: opencode emits
    // step-finish serially per session so writes do not race for the same
    // sessionID, and a brief disk lag does not affect rendering.
    void storage.write(sessions[part.sessionID])
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

// "Copilot 10.0% (100/1000)"  — single-line header that doubles as the
// sidebar title and the live quota display. Highlighted in `warning` so it
// stands out from the muted section headers below.
const quotaLine = (q: Quota): string => {
  if (q.unlimited) return "Copilot ∞"
  return `Copilot ${(100 - q.percentRemaining).toFixed(1)}% (${fmt(q.used)}/${fmt(q.entitlement)})`
}

const QuotaSection = (props: { api: TuiPluginApi; quota: Quota | null }) => {
  const theme = () => props.api.theme.current
  return (
    <Show
      when={props.quota}
      fallback={
        <text fg={theme().text}>
          <b>Copilot Tokens</b>
        </text>
      }
    >
      {(quota: () => Quota) => (
        <text fg={theme().warning}>
          <b>{quotaLine(quota())}</b>
        </text>
      )}
    </Show>
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

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
