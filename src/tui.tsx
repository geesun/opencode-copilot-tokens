import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createSignal, Show } from "solid-js"

export const id = "opencode-copilot-tokens"

export const tui: TuiPlugin = async (api) => {
  const [visible, setVisible] = createSignal(true)

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
              <text fg={api.theme.current.textMuted}>session: {props.session_id}</text>
              <text fg={api.theme.current.textMuted}>(skeleton — wired in next tasks)</text>
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
