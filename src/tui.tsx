import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, Show } from "solid-js"

const id = "opencode-copilot-tokens"

type SessionMeta = { providerID: string; modelID: string }

const tui: TuiPlugin = async (api) => {
  const [visible, setVisible] = createSignal(true)
  // Reactive per-session provider/model cache. We wrap the Map in a signal so
  // SolidJS re-renders the sidebar slot whenever a new message.updated event
  // adds an entry. Mutating the Map in-place would not trigger updates.
  const [meta, setMeta] = createSignal<Map<string, SessionMeta>>(new Map())

  // The disposer returned by api.event.on is auto-tracked by the plugin scope.
  api.event.on("message.updated", (event) => {
    const info = event.properties.info
    if (info.role !== "assistant") return
    if (!info.providerID || !info.modelID) return
    setMeta((prev) => {
      const next = new Map(prev)
      next.set(info.sessionID, { providerID: info.providerID, modelID: info.modelID })
      return next
    })
  })

  api.slots.register({
    order: 350,
    slots: {
      sidebar_content(_ctx, props) {
        return (
          <Show when={visible()}>
            <box>
              <text fg={api.theme.current.text}>
                <b>Copilot Tokens</b>
              </text>
              <text fg={api.theme.current.textMuted}>provider: {meta().get(props.session_id)?.providerID ?? "—"}</text>
              <text fg={api.theme.current.textMuted}>model: {meta().get(props.session_id)?.modelID ?? "—"}</text>
            </box>
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
          setVisible((x) => !x)
        },
      },
    ],
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
