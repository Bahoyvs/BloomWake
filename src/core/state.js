/**
 * Persistent meta-state for BloomWake (Phase 5).
 *
 * This is the across-runs save: meta-upgrades, cosmetics, the equipped skill,
 * pity and the Daily Bloom clock. Per-run state (HP, wave, active cards) stays
 * in game-state.js and is deliberately NOT persisted.
 *
 * ---------------------------------------------------------------------------
 * THIS SAVE HOLDS NO WALLET
 * ---------------------------------------------------------------------------
 * It records WHAT THE PLAYER OWNS. What they can SPEND is a single Scrap
 * balance in the crate economy save (src/core/meta-economy.js), and it is the
 * only balance in the game.
 *
 * It used to hold `petals`, which meant the shop spent one currency and chip
 * upgrades spent another — two numbers, both labelled Scrap on screen, that
 * could not be spent on each other. Removing the field rather than renaming it
 * is what makes that mistake unrepeatable: there is no second wallet left to
 * accidentally read.
 *
 * Pure JS: no DOM, no localStorage. Persistence I/O belongs to the browser
 * layer; this module only turns an untrusted plain object into a valid state
 * and back, so every migration rule is Node-testable.
 *
 * BACKWARD COMPATIBILITY
 * Loading deep-merges the stored object over DEFAULT_META_STATE, so a field an
 * older save is missing takes the default and fields it does carry survive
 * untouched. Purely additive changes therefore need no migration and must not
 * bump SAVE_VERSION. The v1 -> v2 Petal handover is the one real migration in
 * here; see loadState.
 */

import { COSMETIC_IDS } from '../data/cosmetics.js';
import { DEFAULT_ACTIVE_SKILL_ID, getActiveSkillById } from '../data/active-skills.js';

/**
 * Bump only on a BREAKING change — a field whose type or meaning changes, or
 * one that is removed. Additive fields must never bump it, or every existing
 * player would be pushed through a migration that has nothing to do.
 *
 * 2: `petals` removed. The game now has ONE wallet, and it lives in the crate
 * economy save (src/core/meta-economy.js) as `scrap`. See loadState.
 */
export const SAVE_VERSION = 2;

/** Runs without a Rare-or-better large capsule before pity forces one. */
export const PITY_THRESHOLD = 8;

/**
 * The canonical shape. Every key here is a key `loadState` guarantees exists.
 * @returns {Object} A fresh deep copy, so callers can never mutate the default.
 */
export function createDefaultState() {
  return {
    version: SAVE_VERSION,
    /**
     * Scrap harvested from a pre-v2 save, waiting to be moved into the crate
     * economy's wallet. Zero on every save that has already been migrated.
     *
     * THIS IS NOT A BALANCE. It is a one-shot hand-off, and the only reason it
     * exists is that this module cannot see the economy save — the transfer is
     * performed by the boot sequence and immediately cleared with
     * `clearPendingScrap`. Nothing may spend from it.
     */
    pendingScrapTransfer: 0,
    metaUpgrades: {
      startHp: 0,
      pickupRadius: 0,
      startSpeed: 0,
      fourthCardSlot: false,
    },
    cosmetics: {
      owned: [COSMETIC_IDS.DEFAULT],
      equipped: COSMETIC_IDS.DEFAULT,
    },
    /**
     * The active skill carried into the next run. A loadout choice, so it
     * persists like the equipped cosmetic rather than resetting each run.
     */
    activeSkillId: DEFAULT_ACTIVE_SKILL_ID,
    pity: {
      runsSinceRareOrBetter: 0,
    },
    dailyBloom: {
      /** Wall-clock ms of the last claim; 0 means never claimed. */
      lastClaimedAt: 0,
    },
    stats: {
      bestWaveReached: 0,
      totalRuns: 0,
    },
  };
}

export const DEFAULT_META_STATE = createDefaultState();

/**
 * True for plain objects only — arrays and null must be replaced wholesale
 * rather than merged key-by-key.
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively overlay `source` onto `target`, returning a new object.
 *
 * Rules:
 *  - Nested plain objects merge key-by-key, so a save missing `stats.totalRuns`
 *    keeps the default for that one field instead of losing the whole branch.
 *  - Arrays are replaced, never concatenated — an owned-cosmetics list of
 *    ['default'] merged with ['default','dew-tint'] must be the latter, not a
 *    duplicate-laden union.
 *  - Keys absent from `source` keep the target's value.
 *  - `undefined` in source is treated as absent; `null` is an explicit value.
 *
 * @param {Object} target - Defaults
 * @param {Object} source - Stored save
 * @returns {Object}
 */
export function deepMerge(target, source) {
  const result = Array.isArray(target) ? [...target] : { ...target };
  if (!isPlainObject(source)) return result;

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;

    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else if (Array.isArray(value)) {
      result[key] = [...value];
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Turn an untrusted stored object into a valid meta-state.
 *
 * Never throws: a corrupt or absent save yields clean defaults rather than
 * blocking the player from reaching the menu.
 *
 * @param {Object|null} [stored] - Parsed save data, or null/undefined
 * @returns {Object} A complete meta-state
 */
export function loadState(stored) {
  const defaults = createDefaultState();
  if (!isPlainObject(stored)) return defaults;

  const merged = deepMerge(defaults, stored);

  /*
   * v1 -> v2: the Petal wallet becomes Scrap, in the crate economy's save.
   *
   * Harvested unconditionally rather than behind `if (stored.version < 2)`. A
   * save that has already migrated simply has no `petals` key and harvests 0,
   * so the rule is idempotent — and that matters more than tidiness here,
   * because a version-gated migration that is skipped by a save written with a
   * wrong version number silently deletes a player's whole balance. There is
   * no recovering from that, and no way for them to tell us it happened.
   */
  merged.pendingScrapTransfer += Math.max(0, Math.floor(Number(merged.petals) || 0));
  delete merged.petals;

  return sanitizeState(merged);
}

/**
 * Mark the legacy balance as handed over. Called by the boot sequence once the
 * amount is safely inside the economy save, and never before — losing the tab
 * mid-transfer must re-run the migration, not skip it.
 *
 * @param {Object} state
 * @returns {Object}
 */
export function clearPendingScrap(state) {
  return { ...state, pendingScrapTransfer: 0 };
}

/**
 * Repair values that are structurally present but not usable — a save edited by
 * hand, or written by a build that allowed something this one does not.
 * @param {Object} state
 * @returns {Object}
 */
export function sanitizeState(state) {
  const clean = state;

  clean.version = SAVE_VERSION;
  clean.pendingScrapTransfer = Math.max(0, Math.floor(Number(clean.pendingScrapTransfer) || 0));
  // A hand-edited save can reintroduce the dead field; it must never come back
  // as something the shop might read.
  delete clean.petals;

  for (const key of ['startHp', 'pickupRadius', 'startSpeed']) {
    clean.metaUpgrades[key] = Math.max(0, Math.floor(Number(clean.metaUpgrades[key]) || 0));
  }
  clean.metaUpgrades.fourthCardSlot = Boolean(clean.metaUpgrades.fourthCardSlot);

  // The default skin can never be missing, or the player has nothing to equip.
  const owned = Array.isArray(clean.cosmetics.owned) ? clean.cosmetics.owned : [];
  const uniqueOwned = [...new Set([COSMETIC_IDS.DEFAULT, ...owned])];
  clean.cosmetics.owned = uniqueOwned;
  if (!uniqueOwned.includes(clean.cosmetics.equipped)) {
    clean.cosmetics.equipped = COSMETIC_IDS.DEFAULT;
  }

  // An id from a newer build, or a hand-edited save, costs the player their
  // choice of skill rather than leaving the system pointing at a missing row.
  if (!getActiveSkillById(clean.activeSkillId)) {
    clean.activeSkillId = DEFAULT_ACTIVE_SKILL_ID;
  }

  clean.pity.runsSinceRareOrBetter = Math.max(
    0,
    Math.floor(Number(clean.pity.runsSinceRareOrBetter) || 0)
  );
  clean.dailyBloom.lastClaimedAt = Math.max(0, Number(clean.dailyBloom.lastClaimedAt) || 0);
  clean.stats.bestWaveReached = Math.max(0, Math.floor(Number(clean.stats.bestWaveReached) || 0));
  clean.stats.totalRuns = Math.max(0, Math.floor(Number(clean.stats.totalRuns) || 0));

  return clean;
}

/**
 * Plain serialisable snapshot for the storage layer.
 * @param {Object} state
 * @returns {Object}
 */
export function serializeState(state) {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Fold a finished run into persistent stats.
 * Pure: returns a new state rather than mutating the caller's.
 *
 * @param {Object} state
 * @param {{wave: number}} runResult
 * @returns {Object}
 */
export function recordRun(state, runResult) {
  const wave = Math.max(0, Math.floor(runResult?.wave ?? 0));
  return {
    ...state,
    stats: {
      bestWaveReached: Math.max(state.stats.bestWaveReached, wave),
      totalRuns: state.stats.totalRuns + 1,
    },
  };
}
