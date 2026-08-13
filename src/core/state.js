/**
 * Persistent meta-state for BloomWake (Phase 5).
 *
 * This is the across-runs save: Petals, meta-upgrades, cosmetics, pity and the
 * Daily Bloom clock. Per-run state (HP, wave, active cards) stays in
 * game-state.js and is deliberately NOT persisted.
 *
 * Pure JS: no DOM, no localStorage. Persistence I/O belongs to the browser
 * layer; this module only turns an untrusted plain object into a valid state
 * and back, so every migration rule is Node-testable.
 *
 * BACKWARD COMPATIBILITY
 * Loading deep-merges the stored object over DEFAULT_META_STATE. Any field a
 * older save is missing takes the default, and fields the save does carry are
 * preserved untouched. Because Phase 5 only ADDS fields, SAVE_VERSION stays at
 * 1 — a Phase-4-shaped save (or no save at all) loads cleanly with Phase 5
 * defaults filled in and needs no migration step.
 */

import { COSMETIC_IDS } from '../data/cosmetics.js';

/**
 * Bump only on a BREAKING change — a field whose type or meaning changes, or
 * one that is removed. Additive fields must never bump it, or every existing
 * player would be pushed through a migration that has nothing to do.
 */
export const SAVE_VERSION = 1;

/** Runs without a Rare-or-better large capsule before pity forces one. */
export const PITY_THRESHOLD = 8;

/**
 * The canonical shape. Every key here is a key `loadState` guarantees exists.
 * @returns {Object} A fresh deep copy, so callers can never mutate the default.
 */
export function createDefaultState() {
  return {
    version: SAVE_VERSION,
    petals: 0,
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
  return sanitizeState(merged);
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
  clean.petals = Math.max(0, Math.floor(Number(clean.petals) || 0));

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

/**
 * Credit Petals, guarding against negative or fractional grants.
 * @param {Object} state
 * @param {number} amount
 * @returns {Object}
 */
export function addPetals(state, amount) {
  const gain = Math.max(0, Math.floor(Number(amount) || 0));
  return { ...state, petals: state.petals + gain };
}
