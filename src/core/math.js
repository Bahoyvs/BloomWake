/**
 * Pure math helpers for BloomWake simulation.
 * Zero DOM / window dependencies — fully testable in Node.
 */

/**
 * Clamp a value between min and max
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Vector length
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function length(x, y) {
  return Math.hypot(x, y);
}

/**
 * Normalize a vector. Zero-length vectors return {x: 0, y: 0}.
 * @param {number} x
 * @param {number} y
 * @returns {{x: number, y: number}}
 */
export function normalize(x, y) {
  const len = Math.hypot(x, y);
  if (len === 0) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
}

/**
 * Squared distance between two points (avoids sqrt in hot loops)
 * @returns {number}
 */
export function distanceSq(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/**
 * Deterministic seeded PRNG (mulberry32).
 * Determinism keeps simulation tests reproducible.
 * @param {number} seed
 * @returns {() => number} Function returning floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random float in [min, max) using the supplied RNG
 * @param {() => number} rng
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randomRange(rng, min, max) {
  return min + rng() * (max - min);
}

/**
 * Removes entities flagged `alive === false` in place using swap-remove.
 * Allocation-free — full object pooling arrives in Phase 2.
 * @param {Array<{alive: boolean}>} list
 */
export function removeDead(list) {
  let write = 0;
  for (let read = 0; read < list.length; read++) {
    const item = list[read];
    if (item.alive) {
      list[write] = item;
      write++;
    }
  }
  list.length = write;
}
