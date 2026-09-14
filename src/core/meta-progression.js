/**
 * Bridge between a finished wave/run and persistent meta-state (Phase 5).
 *
 * Capsule resolution lives in rewards.js and state mutation rules live in
 * state.js; this module composes the two so the browser layer never has to
 * know that a Legendary capsule touches three different branches of the save.
 *
 * THE SCRAP IS NOT BANKED HERE. Each function returns the new meta-state
 * (cosmetics, stats, pity) alongside a `reward` carrying the Scrap it rolled,
 * and the caller credits that to the one wallet in the crate economy save. The
 * split exists because there is exactly one balance in the game and this module
 * cannot see it — which is also what stops a second one growing back.
 *
 * Pure: every function returns a new state.
 */

import { resolveSmallCapsule, resolveLargeCapsule, getOddsForWave } from './rewards.js';
import { grantCosmetics } from './cosmetics.js';
import { recordRun } from './state.js';
import { WAVE_CONSTANTS } from './wave.js';

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
    state: granted.state,
    reward,
    newCosmetics: granted.added,
  };
}

/**
 * Open the large capsule awarded at the end of a run, and fold the run into
 * lifetime stats.
 *
 * Order matters: pity comes from the state as it was when the run started, and
 * the updated counter is written back with it.
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

/* ------------------------------------------------------------------------ */
/* Abandoned runs                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Minimum wave an ABANDONED run must reach before it earns anything.
 *
 * Pinned to the first boss encounter rather than an arbitrary number: it is
 * the point in a run where a player has actually put themselves at risk. A
 * run abandoned any earlier cost nothing but pressing Launch Mission and then
 * Abandon Run — completeRun's large capsule always pays out at least Common
 * Scrap and can hand out a livery, so without this line that sequence is a
 * five-second, zero-risk way to mint currency.
 *
 * This does NOT touch a run that ends in death. Dying before this wave is
 * losing, not walking away, and the wave-scaled odds in rewards.js already
 * pay a run that short almost nothing — the exploit is specifically in the
 * certainty of quitting on purpose, not in reaching wave 1.
 */
export const ABANDON_REWARD_THRESHOLD_WAVE = WAVE_CONSTANTS.BOSS_WAVE_INTERVAL;

/**
 * Whether a finished run forfeits its end-of-run salvage.
 *
 * @param {{abandoned?: boolean, wave?: number}} runResult - The game:over
 *   payload; a run that was never abandoned (a death, or a victory) never
 *   forfeits regardless of wave.
 * @returns {boolean}
 */
export function forfeitsRunRewards({ abandoned, wave } = {}) {
  if (!abandoned) return false;
  return Math.max(1, Math.floor(wave ?? 1)) < ABANDON_REWARD_THRESHOLD_WAVE;
}

/**
 * Close out a run that forfeited its rewards.
 *
 * The sibling to completeRun for exactly the case forfeitsRunRewards flags,
 * and it deliberately does NOT call resolveLargeCapsule, touch pity or grant
 * cosmetics — running that pipeline for a run that took no risk is the very
 * exploit this pair of functions exists to close. `reward.scrap` is 0, there
 * are no cosmetics, and `odds` is null rather than the odds for the wave the
 * player never actually earned a roll against.
 *
 * Lifetime stats still update: a run that happened did happen, and neither
 * `bestWaveReached` nor `totalRuns` is spendable currency, so recording it
 * costs the player nothing and keeps the debrief's own summary honest.
 *
 * The return shape mirrors completeRun's — `state`, `reward`, `newCosmetics`,
 * `pityApplied`, `odds` — plus `forfeited: true`, so a caller can hand either
 * result to the same debrief code and branch on that one flag.
 *
 * @param {Object} state
 * @param {{wave: number}} runResult
 * @returns {{state: Object, reward: {tier: null, scrap: number, cosmetics: Array},
 *   newCosmetics: Array, pityApplied: boolean, odds: null, forfeited: true}}
 */
export function forfeitRunRewards(state, runResult) {
  const waveReached = Math.max(1, Math.floor(runResult?.wave ?? 1));
  return {
    state: recordRun(state, { wave: waveReached }),
    reward: { tier: null, scrap: 0, cosmetics: [] },
    newCosmetics: [],
    pityApplied: false,
    odds: null,
    forfeited: true,
  };
}
