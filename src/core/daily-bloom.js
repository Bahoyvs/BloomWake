/**
 * Daily Bloom login bonus (GDD Section 9, Phase 5 Step B).
 *
 * Resets on the PLAYER'S LOCAL calendar day, not UTC — a player in UTC+13
 * should get a new bonus when their own date rolls over, not at some hour that
 * only makes sense in Greenwich.
 *
 * The comparison is done on getFullYear/getMonth/getDate components rather than
 * on toLocaleDateString() strings. Both answer "did the local day change", but
 * locale strings vary by browser and locale, which would make the result
 * environment-dependent and the tests non-deterministic.
 *
 * Every function takes timestamps as parameters and never calls Date.now()
 * internally, so tests can pin any instant they like without touching the
 * machine clock — same rule as the rest of src/core/.
 */

import { resolveTierReward, rollRewardTier } from './rewards.js';
import { SMALL_CAPSULE_WEIGHTS } from '../data/rewards.js';

/**
 * Do two Date objects fall on the same local calendar day?
 * @param {Date} dateA
 * @param {Date} dateB
 * @returns {boolean}
 */
export function isSameLocalDay(dateA, dateB) {
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
}

/**
 * Is the Daily Bloom claimable?
 *
 * @param {number} lastClaimedAtMs - Wall-clock ms of the last claim; 0 = never
 * @param {number} nowMs - Wall-clock ms of "now"
 * @returns {boolean}
 */
export function isDailyBloomAvailable(lastClaimedAtMs, nowMs) {
  // Never claimed: available immediately on first launch.
  if (!lastClaimedAtMs) return true;

  // A clock set backwards (timezone change, manual adjustment) would otherwise
  // leave the bonus unclaimable until real time caught up. Treat any earlier
  // "now" than the last claim as a new day rather than punishing the player.
  if (nowMs < lastClaimedAtMs) return true;

  return !isSameLocalDay(new Date(lastClaimedAtMs), new Date(nowMs));
}

/**
 * Ms until the next local midnight — for the menu countdown.
 * @param {number} nowMs
 * @returns {number}
 */
export function msUntilNextLocalDay(nowMs) {
  const now = new Date(nowMs);
  const nextMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    0
  );
  return Math.max(0, nextMidnight.getTime() - nowMs);
}

/**
 * Claim the Daily Bloom.
 *
 * Rolls on the small-capsule table, which keeps the login bonus a pleasant top
 * up rather than a reason to skip playing.
 *
 * @param {Object} state - Persistent meta-state
 * @param {number} nowMs
 * @param {() => number} rng
 * @returns {{ok: boolean, reason?: string, reward?: Object, state: Object}}
 */
export function claimDailyBloom(state, nowMs, rng) {
  if (!isDailyBloomAvailable(state.dailyBloom.lastClaimedAt, nowMs)) {
    return { ok: false, reason: 'ALREADY_CLAIMED_TODAY', state };
  }

  const tier = rollRewardTier(SMALL_CAPSULE_WEIGHTS, rng);
  const reward = resolveTierReward(tier, rng);

  const nextState = {
    ...state,
    petals: state.petals + reward.petals,
    cosmetics: {
      ...state.cosmetics,
      owned: [...new Set([...state.cosmetics.owned, ...reward.cosmetics])],
    },
    dailyBloom: { lastClaimedAt: nowMs },
  };

  return { ok: true, reward, state: nextState };
}
