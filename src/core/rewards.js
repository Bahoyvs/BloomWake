/**
 * Bloom Capsule resolution (GDD Section 8, Phase 5 Step A).
 *
 * Pure functions over the reward tables. Every function takes an RNG as a
 * parameter — the seeded mulberry32 from math.js — so a capsule roll is
 * reproducible and the distribution is testable without stubbing globals.
 *
 * Nothing here mutates caller state: pity is passed in and a NEW pity value is
 * returned alongside the reward.
 */

import { PITY_THRESHOLD } from './state.js';
import {
  REWARD_TIERS,
  REWARD_POOL,
  SMALL_CAPSULE_WEIGHTS,
  getLargeCapsuleBand,
} from '../data/rewards.js';

/** Tiers at or above Rare — what pity guarantees and what resets the counter. */
export const RARE_OR_BETTER = ['rare', 'legendary'];

/**
 * @param {string} tier
 * @returns {boolean}
 */
export function isRareOrBetter(tier) {
  return RARE_OR_BETTER.includes(tier);
}

/**
 * Weighted pick over a tier->weight map.
 *
 * Zero-weight tiers can never be selected. Weights need not sum to 1; they are
 * normalised by their own total, so a filtered subset (as pity uses) still
 * rolls with the right relative odds.
 *
 * @param {Object<string, number>} weights
 * @param {() => number} rng - Returns floats in [0, 1)
 * @returns {string|null} Tier id, or null when every weight is zero
 */
export function rollRewardTier(weights, rng) {
  let total = 0;
  for (const tier of REWARD_TIERS) total += Math.max(0, weights[tier] || 0);
  if (total <= 0) return null;

  let roll = rng() * total;
  let last = null;
  for (const tier of REWARD_TIERS) {
    const weight = Math.max(0, weights[tier] || 0);
    if (weight <= 0) continue;
    last = tier;
    roll -= weight;
    if (roll < 0) return tier;
  }
  // Floating-point roll-off at the very top of the range lands on the last
  // non-zero tier, which is the correct bucket.
  return last;
}

/**
 * Integer in [min, max], inclusive on both ends.
 * @param {[number, number]} range
 * @param {() => number} rng
 * @returns {number}
 */
export function rollAmount(range, rng) {
  const [min, max] = range;
  if (max <= min) return Math.round(min);
  return Math.floor(min + rng() * (max - min + 1));
}

/**
 * Turn a tier into concrete payouts.
 *
 * Every entry in the tier's pool is granted, not one sampled entry — which is
 * why a Legendary capsule yields the prestige skin AND its Petal roll, making
 * the skin's drop rate equal to the Legendary tier rate rather than half of it.
 *
 * @param {string} tier
 * @param {() => number} rng
 * @param {Object} [pool] - Payout table; overridable so the economy calibration
 *   script can trial scaled Petal ranges against this exact logic instead of
 *   reimplementing it.
 * @returns {{tier: string, petals: number, cosmetics: Array<string>}}
 */
export function resolveTierReward(tier, rng, pool = REWARD_POOL) {
  const entries = pool[tier] ?? [];
  let petals = 0;
  const cosmetics = [];

  for (const entry of entries) {
    if (entry.type === 'petal') {
      petals += rollAmount(entry.amount, rng);
    } else if (entry.type === 'cosmetic') {
      cosmetics.push(entry.id);
    }
  }

  return { tier, petals, cosmetics };
}

/**
 * End-of-wave capsule: flat odds, no pity, no performance band.
 *
 * @param {() => number} rng
 * @param {Object} [pool] - Payout table override (see resolveTierReward)
 * @returns {{tier: string, petals: number, cosmetics: Array<string>}}
 */
export function resolveSmallCapsule(rng, pool = REWARD_POOL) {
  const tier = rollRewardTier(SMALL_CAPSULE_WEIGHTS, rng);
  return resolveTierReward(tier, rng, pool);
}

/**
 * End-of-run capsule: odds scale with the wave reached, with a pity floor.
 *
 * Pity: once `runsSinceRareOrBetter` reaches PITY_THRESHOLD (8), the roll is
 * restricted to Rare and Legendary using their relative band weights, so the
 * 9th capsule after a dry streak is guaranteed Rare-or-better. In the 1-4 band
 * Legendary has zero weight, so pity resolves to Rare there.
 *
 * @param {number} waveReached
 * @param {{runsSinceRareOrBetter: number}} pityState
 * @param {() => number} rng
 * @param {Object} [pool] - Payout table override (see resolveTierReward)
 * @returns {{reward: Object, updatedPity: {runsSinceRareOrBetter: number}, pityApplied: boolean}}
 */
export function resolveLargeCapsule(waveReached, pityState, rng, pool = REWARD_POOL) {
  const band = getLargeCapsuleBand(waveReached);
  const streak = Math.max(0, pityState?.runsSinceRareOrBetter ?? 0);
  const pityApplied = streak >= PITY_THRESHOLD;

  let tier;
  if (pityApplied) {
    const forced = {};
    for (const rare of RARE_OR_BETTER) forced[rare] = band.weights[rare] || 0;
    // Guard the degenerate case of a band with no rare weight at all, so pity
    // can never silently fall through to a Common.
    tier = rollRewardTier(forced, rng) ?? 'rare';
  } else {
    tier = rollRewardTier(band.weights, rng);
  }

  const reward = resolveTierReward(tier, rng, pool);
  const hitRare = isRareOrBetter(tier);

  return {
    reward: { ...reward, band: { minWave: band.minWave, maxWave: band.maxWave } },
    updatedPity: { runsSinceRareOrBetter: hitRare ? 0 : streak + 1 },
    pityApplied,
  };
}

/**
 * The odds table the player just qualified for, for the "?" transparency icon.
 * @param {number} waveReached
 * @returns {{minWave: number, maxWave: number, weights: Object}}
 */
export function getOddsForWave(waveReached) {
  return getLargeCapsuleBand(waveReached);
}
