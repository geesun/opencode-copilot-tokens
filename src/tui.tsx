import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { StepDelta } from "./compute"
import { loadPricing, refreshPricing } from "./pricing"
import { updateSession } from "./session"
import { defaultDir, Storage } from "./storage"
import type { PriceTable, SessionState, TurnSummary } from "./types"

const id = "opencode-copilot-tokens"
const COPILOT = "github-copilot"
const KV_VISIBLE = "copilot-tokens.visible"

type SessionMeta = { providerID: string; modelID: string }

const tui: TuiPlugin = async (api) => {
  // Restore the user's last preference. api.kv.get is synchronous; the second
  // arg is the first-run default.
  const [visible, setVisible] = createSignal(api.kv.get<boolean>(KV_VISIBLE, true))
  const [pricing, setPricing] = createSignal<PriceTable>(await loadPricing())
  const [justRefreshed, setJustRefreshed] = createSignal(false)
  // Fire-and-forget background refresh. Failures are silent (network down,
  // 404 from upstream URL move, etc.) — we just keep using the bundled or
  // previously-cached pricing.
  void (async () => {
    const next = await refreshPricing()
    if (!next) return
    setPricing(next)
    setJustRefreshed(true)
    setTimeout(() => setJustRefreshed(false), 3000)
  })()
  // Single source of truth for the sidebar render path. Mutating a plain
  // Map/object would NOT trigger re-render — see plan note above Task 7.
  const [sessions, setSessions] = createStore<Record<string, SessionState>>({})
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

  api.slots.register({
    order: 350,
    slots: {
      sidebar_content(_ctx, props) {
        // Trigger hydration the first time the sidebar is asked about this
        // session — covers the "user opens a session without sending a
        // message" case where message.updated has not fired.
        void hydrate(props.session_id)
        const state = () => sessions[props.session_id] ?? null
        return (
          <Show when={visible()}>
            <Show
              when={state()}
              fallback={
                <box>
                  <text fg={api.theme.current.text}>
                    <b>Copilot Tokens</b>
                  </text>
                  <text fg={api.theme.current.textMuted}>(no Copilot turns yet)</text>
                </box>
              }
            >
              {(s) => (
                <Panel
                  api={api}
                  state={s()}
                  pricingFetchedAt={pricing().fetchedAt}
                  refreshed={justRefreshed()}
                />
              )}
            </Show>
          </Show>
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
        slashName: "tokens",
        run() {
          setVisible((x) => {
            const next = !x
            api.kv.set(KV_VISIBLE, next)
            return next
          })
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

// "in" / "6"  ->  "in              6"
const row = (label: string, value: string): string =>
  label.padEnd(LABEL_W) + " " + value.padStart(VALUE_W)

// Single horizontal rule character repeated. Light glyph keeps it subtle.
const rule = (): string => "─".repeat(PANEL_W)

// Section header with a trailing rule:  "Last turn ────────────"
const section = (title: string): string => {
  const pad = PANEL_W - title.length - 1
  return title + " " + "─".repeat(Math.max(pad, 0))
}

const Panel = (props: {
  api: TuiPluginApi
  state: SessionState
  pricingFetchedAt: string
  refreshed: boolean
}) => {
  const theme = () => props.api.theme.current
  const models = () => Object.entries(props.state.byModel)
  const total = () => models().reduce((sum, [, t]) => sum + t.estimatedCostUsd, 0)

  return (
    <box>
      <text fg={theme().text}>
        <b>Copilot Tokens</b>
      </text>
      <text fg={theme().textMuted}>
        {row("pricing", props.pricingFetchedAt + (props.refreshed ? " ⟳" : ""))}
      </text>

      <Show when={props.state.lastTurn}>
        {(turn: () => TurnSummary) => (
          <box>
            <text fg={theme().textMuted}>{section("Last turn")}</text>
            <text fg={theme().text}>{row("in", fmt(turn().input))}</text>
            <text fg={theme().text}>{row("out", fmt(turn().output))}</text>
            <Show when={turn().cacheRead > 0}>
              <text fg={theme().textMuted}>{row("cache(i)", fmt(turn().cacheRead))}</text>
            </Show>
            <Show when={turn().cacheWrite > 0}>
              <text fg={theme().textMuted}>{row("cache(w)", fmt(turn().cacheWrite))}</text>
            </Show>
            <text fg={theme().text}>
              <b>{row("cost", usd(turn().estimatedCostUsd))}</b>
            </text>
          </box>
        )}
      </Show>

      <box>
        <text fg={theme().textMuted}>{section("Session by model")}</text>
        <For each={models()}>
          {([modelID, t]) => (
            <box>
              <text fg={theme().text}>
                <b>{modelID}</b>
              </text>
              <text fg={theme().textMuted}>{row("in", fmt(t.input))}</text>
              <text fg={theme().textMuted}>{row("out", fmt(t.output))}</text>
              <Show when={t.cacheRead > 0}>
                <text fg={theme().textMuted}>{row("cache(i)", fmt(t.cacheRead))}</text>
              </Show>
              <Show when={t.cacheWrite > 0}>
                <text fg={theme().textMuted}>{row("cache(w)", fmt(t.cacheWrite))}</text>
              </Show>
              <text fg={theme().textMuted}>{row("cost", usd(t.estimatedCostUsd))}</text>
            </box>
          )}
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
