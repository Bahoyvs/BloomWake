/**
 * Browser persistence for the meta-state (Phase 5).
 *
 * The only module that touches localStorage. src/core/state.js stays pure and
 * knows nothing about where a save lives; this layer just moves JSON in and out
 * and hands it to loadState for validation.
 *
 * Every failure path is non-fatal: a player with a corrupt save, a full disk or
 * storage disabled entirely should still reach the menu and play.
 */

import { loadState, serializeState } from '../core/state.js';

const STORAGE_KEY = 'bloomwake.save.v1';

/**
 * Is localStorage usable? Private browsing and hardened settings can make it
 * throw on access rather than simply be absent.
 * @returns {boolean}
 */
function isStorageAvailable() {
  try {
    const probe = '__bloomwake_probe__';
    window.localStorage.setItem(probe, probe);
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and validate the save, falling back to a fresh state.
 * @returns {Object} A complete meta-state
 */
export function loadSave() {
  if (!isStorageAvailable()) return loadState(null);

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return loadState(null);
    return loadState(JSON.parse(raw));
  } catch (error) {
    // Corrupt JSON: start clean rather than trapping the player on a dead save.
    console.warn('[BloomWake] Save could not be read, starting fresh.', error);
    return loadState(null);
  }
}

/**
 * Persist the meta-state.
 * @param {Object} state
 * @returns {boolean} Whether the write succeeded
 */
export function saveState(state) {
  if (!isStorageAvailable()) return false;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState(state)));
    return true;
  } catch (error) {
    console.warn('[BloomWake] Save could not be written.', error);
    return false;
  }
}

/** Wipe the save. Exposed for debugging, not wired to any in-game button. */
export function clearSave() {
  if (!isStorageAvailable()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing useful to do */
  }
}
