import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { StepDelta } from "./compute"
import { loadBundledPricing } from "./pricing"
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
  const [pricing] = createSignal<PriceTable>(await loadBundledPricing())
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
              {(s) => <Panel api={api} state={s()} />}
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

const Panel = (props: { api: TuiPluginApi; state: SessionState }) => {
  const theme = () => props.api.theme.current
  const models = () => Object.entries(props.state.byModel)
  const total = () => models().reduce((sum, [, t]) => sum + t.estimatedCostUsd, 0)

  return (
    <box>
      <text fg={theme().text}>
        <b>Copilot Tokens</b>
      </text>
      <Show when={props.state.currentModel}>
        <text fg={theme().textMuted}>Model: {props.state.currentModel} (current)</text>
      </Show>

      <Show when={props.state.lastTurn}>
        {(turn: () => TurnSummary) => (
          <box marginTop={1}>
            <text fg={theme().text}>Last turn</text>
            <text fg={theme().textMuted}>
              in {fmt(turn().input)} out {fmt(turn().output)}
            </text>
            <Show when={turn().cacheRead > 0}>
              <text fg={theme().textMuted}>cache read {fmt(turn().cacheRead)}</text>
            </Show>
            <Show when={turn().cacheWrite > 0}>
              <text fg={theme().textMuted}>cache write {fmt(turn().cacheWrite)}</text>
            </Show>
            <text fg={theme().textMuted}>≈ {usd(turn().estimatedCostUsd)}</text>
          </box>
        )}
      </Show>

      <box marginTop={1}>
        <text fg={theme().text}>Session by model</text>
        <For each={models()}>
          {([modelID, t]) => (
            <box marginTop={1}>
              <text fg={theme().textMuted}>{modelID}</text>
              <text fg={theme().textMuted}>
                in {fmt(t.input)} out {fmt(t.output)}
              </text>
              <Show when={t.cacheRead > 0}>
                <text fg={theme().textMuted}>cache read {fmt(t.cacheRead)}</text>
              </Show>
              <Show when={t.cacheWrite > 0}>
                <text fg={theme().textMuted}>cache write {fmt(t.cacheWrite)}</text>
              </Show>
              <text fg={theme().textMuted}>≈ {usd(t.estimatedCostUsd)}</text>
            </box>
          )}
        </For>
      </box>

      <box marginTop={1}>
        <text fg={theme().text}>Total ≈ {usd(total())}</text>
      </box>
    </box>
  )
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
