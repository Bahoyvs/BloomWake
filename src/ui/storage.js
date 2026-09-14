/**
 * Browser persistence for the meta-state (Phase 5).
 *
 * The meta-save's half of the storage layer: it moves JSON in and out and hands
 * it to loadState for validation. src/core/state.js stays pure and knows nothing
 * about where a save lives.
 *
 * WHERE it lives is no longer this module's business either. It used to reach
 * for `localStorage` directly, with its own availability probe; it now goes
 * through the game's storage service, which decides between the player's
 * CrazyGames cloud save, this browser, and nothing at all. That matters beyond
 * tidiness: `bloomwake.save.v1` is one of the keys the service migrates to the
 * cloud, and a module still reading it straight out of localStorage would have
 * been reading a copy the cloud had already moved past.
 *
 * Every failure path is non-fatal: a player with a corrupt save, a full disk or
 * storage disabled entirely should still reach the menu and play.
 */

import { loadState, serializeState } from '../core/state.js';
import { storageService } from '../services/storage-service.js';

export const STORAGE_KEY = 'bloomwake.save.v1';

/**
 * Read and validate the save, falling back to a fresh state.
 *
 * @param {Object} [storage] - Adapter to read from. Defaults to the game's
 *   storage service; injected by tests.
 * @returns {Object} A complete meta-state
 */
export function loadSave(storage = storageService) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
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
 *
 * @param {Object} state
 * @param {Object} [storage] - Defaults to the game's storage service
 * @returns {boolean} Whether the write succeeded
 */
export function saveState(state, storage = storageService) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(serializeState(state)));
    return true;
  } catch (error) {
    // Includes a StorageQuotaError from the service: a save too large to ever
    // land is still not a reason to take the game down mid-run.
    console.warn('[BloomWake] Save could not be written.', error);
    return false;
  }
}

/**
 * Wipe the save.
 *
 * @param {Object} [storage] - Defaults to the game's storage service
 */
export function clearSave(storage = storageService) {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing useful to do */
  }
}
