/**
 * Bridge between a finished wave/run and persistent meta-state (Phase 5).
 *
 * Capsule resolution lives in rewards.js and state mutation rules live in
 * state.js; this module composes the two so the browser layer never has to
 * know that a Legendary capsule touches three different branches of the save.
 *
 * Pure: every function returns a new state.
 */

import { resolveSmallCapsule, resolveLargeCapsule, getOddsForWave } from './rewards.js';
import { grantCosmetics } from './cosmetics.js';
import { recordRun } from './state.js';

/**
 * Open the small capsule awarded for clearing a wave.
 *
 * No pity and no performance band — this one is a steady trickle, which is why
 * it can be shown as a non-blocking toast instead of a full screen.
 *
 * @param {Object} state
 * @param {() => number} rng
 * @returns {{state: Object, reward: Object, newCosmetics: Array<string>}}
 */
export function openSmallCapsule(state, rng) {
  const reward = resolveSmallCapsule(rng);
  const granted = grantCosmetics(state, reward.cosmetics);

  return {
    state: { ...granted.state, petals: granted.state.petals + reward.petals },
    reward,
    newCosmetics: granted.added,
  };
}

/**
 * Open the large capsule awarded at the end of a run, and fold the run into
 * lifetime stats.
 *
 * Order matters: pity comes from the state as it was when the run started, and
 * the updated counter is written back alongside the Petals.
 *
 * @param {Object} state
 * @param {{wave: number, score?: number, kills?: number}} runResult
 * @param {() => number} rng
 * @returns {{state: Object, reward: Object, newCosmetics: Array<string>, pityApplied: boolean, odds: Object}}
 */
export function completeRun(state, runResult, rng) {
  const waveReached = Math.max(1, Math.floor(runResult?.wave ?? 1));
  const { reward, updatedPity, pityApplied } = resolveLargeCapsule(waveReached, state.pity, rng);

  const withStats = recordRun(state, { wave: waveReached });
  const granted = grantCosmetics(withStats, reward.cosmetics);

  return {
    state: {
      ...granted.state,
      petals: granted.state.petals + reward.petals,
      pity: updatedPity,
    },
    reward,
    newCosmetics: granted.added,
    pityApplied,
    odds: getOddsForWave(waveReached),
  };
}

/**
 * Runs remaining before pity guarantees a Rare-or-better large capsule.
 * Surfaced on the results screen so the guarantee is visible, not hidden.
 *
 * @param {Object} state
 * @param {number} [threshold]
 * @returns {number}
 */
export function runsUntilPity(state, threshold = 8) {
  return Math.max(0, threshold - state.pity.runsSinceRareOrBetter);
}
