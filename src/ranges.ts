export type Range = { key: string; label: string; start: string; end: string }

const pad = (n: number): string => String(n).padStart(2, "0")

// 'YYYY-MM-DD' for a Date's LOCAL calendar day.
const ymd = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// 'MM-DD' for compact range labels.
const md = (d: Date): string => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// 'YYYY-MM' for month labels.
const ym = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`

// 'YYYY-MM-DD' for an epoch-ms timestamp, in the system local timezone.
export const localDate = (ts: number): string => ymd(new Date(ts))

// The five comparison ranges, computed from `now` in local time.
// Week starts Monday. Returned in display order.
export const ranges = (now: Date): Range[] => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const dow = today.getDay() // 0=Sun .. 6=Sat
  const mondayOffset = (dow + 6) % 7
  const thisMon = new Date(today)
  thisMon.setDate(today.getDate() - mondayOffset)
  const lastMon = new Date(thisMon)
  lastMon.setDate(thisMon.getDate() - 7)
  const lastSun = new Date(thisMon)
  lastSun.setDate(thisMon.getDate() - 1)

  const thisMonth1 = new Date(today.getFullYear(), today.getMonth(), 1)
  const lastMonth1 = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0) // day 0 = last day of prev month

  return [
    { key: "today", label: `Today (${ymd(today)})`, start: ymd(today), end: ymd(today) },
    {
      key: "thisWeek",
      label: `This week (${md(thisMon)} ~ ${md(today)})`,
      start: ymd(thisMon),
      end: ymd(today),
    },
    {
      key: "lastWeek",
      label: `Last week (${md(lastMon)} ~ ${md(lastSun)})`,
      start: ymd(lastMon),
      end: ymd(lastSun),
    },
    {
      key: "thisMonth",
      label: `This month (${ym(today)})`,
      start: ymd(thisMonth1),
      end: ymd(today),
    },
    {
      key: "lastMonth",
      label: `Last month (${ym(lastMonth1)})`,
      start: ymd(lastMonth1),
      end: ymd(lastMonthEnd),
    },
  ]
}
