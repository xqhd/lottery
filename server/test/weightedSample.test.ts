import { describe, expect, it } from "vitest";
import { createPrng } from "../src/draw/prng.js";
import { weightedSampleWithoutReplacement } from "../src/draw/weightedSample.js";

describe("weightedSampleWithoutReplacement", () => {
  it("is deterministic for the same seed", () => {
    const items = [
      { id: "a", weight: 1 },
      { id: "b", weight: 2 },
      { id: "c", weight: 3 },
      { id: "d", weight: 4 }
    ];

    const run = (seed: string) => weightedSampleWithoutReplacement(items, 2, createPrng(seed)).map((x) => x.id);

    expect(run("seed-1")).toEqual(["a", "c"]);
    expect(run("seed-2")).toEqual(["d", "c"]);
  });

  it("skips non-positive weights", () => {
    const items = [
      { id: "a", weight: 0 },
      { id: "b", weight: -1 },
      { id: "c", weight: 1 }
    ];

    const winners = weightedSampleWithoutReplacement(items, 2, createPrng("seed")).map((x) => x.id);
    expect(winners).toEqual(["c"]);
  });
});
