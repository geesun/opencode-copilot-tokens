import type { ModelPricing, PriceTable } from "./types"
import { join } from "node:path"

export const loadBundledPricing = async (): Promise<PriceTable> => {
  return await Bun.file(join(import.meta.dir, "..", "pricing.json")).json()
}

export const priceFor = (modelID: string, table: PriceTable): ModelPricing | null => {
  return table.models[modelID] ?? null
}
