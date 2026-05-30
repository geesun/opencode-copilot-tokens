import { homedir } from "node:os"
import { join } from "node:path"

// opencode stores OAuth credentials per provider under this path. The
// GitHub Copilot entry has a `refresh` token that can be sent as a Bearer
// against api.github.com to call the internal user/quota endpoints.
const authPath = (): string => join(homedir(), ".local", "share", "opencode", "auth.json")

export const githubCopilotToken = async (): Promise<string | null> => {
  const file = Bun.file(authPath())
  if (!(await file.exists())) return null
  const auth = (await file.json().catch(() => null)) as Record<string, { refresh?: string }> | null
  return auth?.["github-copilot"]?.refresh ?? null
}
