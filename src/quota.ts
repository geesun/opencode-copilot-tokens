import { githubCopilotToken } from "./auth"

const QUOTA_URL = "https://api.github.com/copilot_internal/user"

// Per VS Code's `chatQuotaServiceImpl.ts`, the same endpoint returns
// quota_snapshots keyed by one of (in priority order): `premium_models`
// (the new June 2026 key), `premium_interactions` (the legacy PRU key),
// `chat` (used for Free users). We mirror the same fallback chain so the
// plugin keeps working through the transition.
//
// Reference: microsoft/vscode-copilot-chat
//   src/platform/chat/common/chatQuotaServiceImpl.ts (lines 41 & 86)
type QuotaSnapshot = {
  quota_id?: string
  entitlement?: number
  remaining?: number
  unlimited?: boolean
  overage_count?: number
  overage_permitted?: boolean
  percent_remaining?: number
}

type UserInfo = {
  copilot_plan?: string
  quota_reset_date?: string
  quota_snapshots?: Record<string, QuotaSnapshot>
}

export type Quota = {
  plan: string
  unlimited: boolean
  entitlement: number
  remaining: number
  used: number
  percentRemaining: number
  resetDate: string | null
  source: "premium_models" | "premium_interactions" | "chat"
}

// Visible for testing: keep the snapshot-selection logic pure so the unit
// tests can exercise it without touching the network.
export const pickSnapshot = (
  snapshots: Record<string, QuotaSnapshot> | undefined,
): { snapshot: QuotaSnapshot; source: Quota["source"] } | null => {
  if (!snapshots) return null
  const premiumModels = snapshots["premium_models"]
  if (premiumModels) return { snapshot: premiumModels, source: "premium_models" }
  const premiumInteractions = snapshots["premium_interactions"]
  if (premiumInteractions) return { snapshot: premiumInteractions, source: "premium_interactions" }
  const chat = snapshots["chat"]
  if (chat) return { snapshot: chat, source: "chat" }
  return null
}

export const buildQuota = (info: UserInfo): Quota | null => {
  const picked = pickSnapshot(info.quota_snapshots)
  if (!picked) return null
  const { snapshot, source } = picked
  const entitlement = snapshot.entitlement ?? 0
  const remaining = snapshot.remaining ?? 0
  const unlimited = snapshot.unlimited ?? false
  const used = Math.max(0, entitlement - remaining)
  const percentRemaining =
    snapshot.percent_remaining ?? (entitlement > 0 ? (remaining / entitlement) * 100 : 0)
  return {
    plan: info.copilot_plan ?? "unknown",
    unlimited,
    entitlement,
    remaining,
    used,
    percentRemaining,
    resetDate: info.quota_reset_date ?? null,
    source,
  }
}

export const loadQuota = async (): Promise<Quota | null> => {
  const tok = await githubCopilotToken()
  if (!tok) return null
  const res = await fetch(QUOTA_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tok}`,
      "X-GitHub-Api-Version": "2026-03-10",
    },
  }).catch(() => null)
  if (!res || !res.ok) return null
  const info = (await res.json().catch(() => null)) as UserInfo | null
  if (!info) return null
  return buildQuota(info)
}
