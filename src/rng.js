// Tiny seeded RNG (mulberry32). Used everywhere we need determinism — track
// generation, procedural car liveries, pickup placement, etc.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Range helpers
export function rfloat(rng, min, max) { return min + (max - min) * rng(); }
export function rint(rng, min, max) { return Math.floor(rfloat(rng, min, max + 1)); }
export function rchoice(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
