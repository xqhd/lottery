import crypto from "node:crypto";

const MASK_64 = (1n << 64n) - 1n;
const TWO_POW_53 = 2 ** 53;

export type Rng = () => number;

function readSeedState(seed: string): [bigint, bigint] {
  const digest = crypto.createHash("sha256").update(seed).digest();
  const s0 = digest.readBigUInt64LE(0);
  let s1 = digest.readBigUInt64LE(8);
  if (s0 === 0n && s1 === 0n) s1 = 1n;
  return [s0, s1];
}

export function createPrng(seed: string): Rng {
  let [state0, state1] = readSeedState(seed);

  return () => {
    let s1 = state0;
    const s0 = state1;
    state0 = s0;

    s1 ^= (s1 << 23n) & MASK_64;
    state1 = (s1 ^ s0 ^ (s1 >> 17n) ^ (s0 >> 26n)) & MASK_64;

    const result = (state1 + s0) & MASK_64;
    const top53 = Number(result >> 11n); // 53 bits

    return (top53 + 1) / TWO_POW_53; // (0, 1]
  };
}
