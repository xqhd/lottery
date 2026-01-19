import type { Rng } from "./prng.js";

export const ALGORITHM_VERSION = "weighted_reservoir_v1";

export type WeightedItem = {
  id: string;
  weight: number;
};

type ScoredItem = {
  item: WeightedItem;
  key: number;
};

export function weightedSampleWithoutReplacement(
  items: WeightedItem[],
  count: number,
  rng: Rng
): WeightedItem[] {
  if (count <= 0) return [];

  const scored: ScoredItem[] = [];
  for (const item of items) {
    if (!Number.isFinite(item.weight) || item.weight <= 0) continue;

    const u = rng(); // (0, 1]
    scored.push({ item, key: -Math.log(u) / item.weight });
  }

  scored.sort((a, b) => a.key - b.key);
  return scored.slice(0, count).map((x) => x.item);
}

