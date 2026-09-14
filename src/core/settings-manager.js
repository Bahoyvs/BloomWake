/**
 * System settings — the one owner of the player's preferences.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SEPARATE FROM THE SAVE
 * ---------------------------------------------------------------------------
 * The meta-save records what the player has EARNED; this records how they want
 * the game to behave. They change for entirely unrelated reasons, and a
 * breaking change to one must never risk the other — a migration that resets
 * somebody's upgrades because the volume schema moved is indefensible. So they
 * live under different keys and validate independently.
 *
 * ---------------------------------------------------------------------------
 * THIS LIVES IN core/ BUT TOUCHES NO BROWSER API OF ITS OWN
 * ---------------------------------------------------------------------------
 * Everything here is pure — defaults, validation, clamping, change dispatch —
 * against a storage adapter. The adapter is a three-method interface
 * (`getItem`/`setItem`/`removeItem`), which is small enough that a Map stands
 * in for it in a test and that localStorage satisfies without a wrapper.
 *
 * It no longer goes looking for `localStorage` itself. Where a save actually
 * lives — the player's CrazyGames account, this browser, or nowhere — is one
 * decision for the whole game, and it is made in src/services/storage-service.js.
 * This module defaults to that service and otherwise cannot tell the difference,
 * which is what let the settings become a cloud save without a line of the
 * validation below changing.
 *
 * ---------------------------------------------------------------------------
 * EVERY STORED VALUE IS TREATED AS HOSTILE
 * ---------------------------------------------------------------------------
 * localStorage is user-writable, survives across versions, and is shared with
 * whatever the previous build of this game wrote. `normalizeSettings` therefore
 * never trusts it: unknown keys are dropped, wrong types are replaced by the
 * default rather than coerced, and every number is clamped into range. The
 * function always returns a COMPLETE settings object, so nothing downstream has
 * to check whether a field is present.
 */

/*
 * Imported for its default only. Nothing here calls into it at module scope,
 * and a test that injects its own adapter never touches it at all.
 */
import { storageService } from '../services/storage-service.js';

/** Where the settings live. Versioned separately from the meta-save. */
export const SETTINGS_STORAGE_KEY = 'bloomwake.settings.v1';

/**
 * Screen-shake intensities.
 *
 * Three named steps rather than a free slider, because the choice being made
 * is not "how much shake" — it is "do I get motion sick". A player who needs
 * this turned down needs it predictable, and a continuous control invites
 * hunting for a value instead of picking the one that works.
 */
export const SCREEN_SHAKE = {
  FULL: 1.0,
  LIGHT: 0.5,
  OFF: 0.0,
};

/** The allowed shake values, for snapping and for the UI to enumerate. */
export const SCREEN_SHAKE_LEVELS = [SCREEN_SHAKE.FULL, SCREEN_SHAKE.LIGHT, SCREEN_SHAKE.OFF];

/**
 * @typedef {Object} Settings
 * @property {number} masterVolume - 0..1
 * @property {number} sfxVolume - 0..1
 * @property {number} musicVolume - 0..1
 * @property {boolean} muted
 * @property {number} screenShake - One of SCREEN_SHAKE_LEVELS
 * @property {boolean} damageFlash - false disables white hit flashes
 * @property {boolean} showDamageNumbers
 */

/**
 * Factory defaults.
 *
 * Music sits below the effects because it is a bed: a player who notices the
 * soundtrack during a wave is a player who did not hear the lock-on warning.
 * Everything accessibility-related defaults ON, so the settings screen is where
 * effects are removed rather than where they are discovered.
 *
 * @type {Settings}
 */
export const DEFAULT_SETTINGS = Object.freeze({
  masterVolume: 0.8,
  sfxVolume: 0.8,
  musicVolume: 0.7,
  muted: false,
  screenShake: SCREEN_SHAKE.FULL,
  damageFlash: true,
  showDamageNumbers: true,
});

/** @param {*} v @param {number} fallback @returns {number} */
function clampUnit(v, fallback) {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/**
 * Snap to the nearest allowed shake level.
 *
 * Forgiving rather than strict: an off-grid value — from a build that had a
 * slider, or from a player who edited their own storage — lands on whichever
 * step is closest instead of resetting the choice to the default. A player who
 * had asked for less shake keeps less shake.
 *
 * @param {*} v
 * @returns {number}
 */
function snapShake(v) {
  const n = clampUnit(v, DEFAULT_SETTINGS.screenShake);
  let best = SCREEN_SHAKE_LEVELS[0];
  for (const level of SCREEN_SHAKE_LEVELS) {
    if (Math.abs(level - n) < Math.abs(best - n)) best = level;
  }
  return best;
}

/** @param {*} v @param {boolean} fallback @returns {boolean} */
function asBool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * How each field is validated. Data rather than a switch so that adding a
 * setting is one entry here and one control in the modal, with no third place
 * to forget.
 */
const VALIDATORS = {
  masterVolume: (v) => clampUnit(v, DEFAULT_SETTINGS.masterVolume),
  sfxVolume: (v) => clampUnit(v, DEFAULT_SETTINGS.sfxVolume),
  musicVolume: (v) => clampUnit(v, DEFAULT_SETTINGS.musicVolume),
  muted: (v) => asBool(v, DEFAULT_SETTINGS.muted),
  screenShake: snapShake,
  damageFlash: (v) => asBool(v, DEFAULT_SETTINGS.damageFlash),
  showDamageNumbers: (v) => asBool(v, DEFAULT_SETTINGS.showDamageNumbers),
};

/** @type {string[]} Every valid settings key. */
export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

/**
 * Build a complete, valid settings object from anything at all.
 *
 * @param {*} raw - Parsed JSON, a partial object, null, or garbage
 * @returns {Settings} Always complete, always in range
 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const key of SETTING_KEYS) {
    // A key absent from storage takes the default; a key present takes the
    // validator's verdict on it. Keys in storage that are not in the schema
    // are simply never read, which is how a removed setting disappears.
    out[key] = key in source ? VALIDATORS[key](source[key]) : DEFAULT_SETTINGS[key];
  }
  return out;
}

export class SettingsManager {
  /**
   * @param {Object} [options]
   * @param {Object|null} [options.storage] - Storage adapter. Defaults to the
   *   game's storage service; pass `null` for a manager that deliberately
   *   persists nothing, which is distinct from omitting it.
   * @param {string} [options.key] - Storage key
   */
  constructor({ storage, key = SETTINGS_STORAGE_KEY } = {}) {
    this.key = key;
    // `undefined` means "whatever the game uses"; an explicit `null` means
    // "none". Collapsing the two would make a memory-only manager impossible
    // to ask for.
    this.storage = storage === undefined ? storageService : storage;
    /** @type {Settings} */
    this.settings = this.read();
    /** @type {Set<Function>} */
    this.listeners = new Set();
  }

  /** @returns {boolean} Whether preferences will survive a reload. */
  get persists() {
    return Boolean(this.storage);
  }

  /**
   * Load and validate. A corrupt payload silently becomes the defaults — a
   * player with a bad settings blob should reach the game, not a dead screen.
   * @returns {Settings}
   */
  read() {
    if (!this.storage) return normalizeSettings(null);
    try {
      const raw = this.storage.getItem(this.key);
      return normalizeSettings(raw ? JSON.parse(raw) : null);
    } catch (error) {
      console.warn('[BloomWake] Settings could not be read, using defaults.', error);
      return normalizeSettings(null);
    }
  }

  /**
   * Persist the current settings.
   * @returns {boolean} Whether the write landed
   */
  write() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(this.key, JSON.stringify(this.settings));
      return true;
    } catch (error) {
      // A full quota or a storage permission revoked mid-session. The player
      // keeps their choice for this session; it just will not survive a reload.
      console.warn('[BloomWake] Settings could not be written.', error);
      return false;
    }
  }

  /**
   * Re-read the store and adopt what is there, notifying subscribers.
   *
   * The boot path calls this once the storage driver is resolved, and the
   * re-hydration path calls it again if the player signs in mid-session and a
   * different account's preferences become the live ones. It notifies rather
   * than assigning quietly, because the audio manager and the renderer only
   * ever learn about a preference by being told.
   *
   * @returns {Settings} The freshly loaded settings
   */
  load() {
    const previous = this.settings;
    this.settings = this.read();

    const changed = SETTING_KEYS.filter((key) => previous[key] !== this.settings[key]);
    // A reload that changes nothing is the common case — the boot call, most
    // often, where the constructor already read the same bytes. Staying silent
    // keeps it from being a settings-changed event for every listener.
    if (changed.length > 0) this.notify(changed);
    return this.getAll();
  }

  /** @returns {Settings} A copy — callers must not mutate the live object. */
  getAll() {
    return { ...this.settings };
  }

  /**
   * @param {string} key
   * @returns {*}
   */
  get(key) {
    return this.settings[key];
  }

  /**
   * Change one setting.
   *
   * @param {string} key
   * @param {*} value - Validated before it is stored
   * @returns {boolean} Whether anything actually changed
   */
  set(key, value) {
    return this.patch({ [key]: value });
  }

  /**
   * Change several settings as one transaction.
   *
   * One write and one notification for the whole patch, rather than one per
   * field: a reset touches seven settings, and seven separate change events
   * would have the audio manager and the renderer reconfiguring six times for
   * nothing.
   *
   * @param {Object} partial
   * @returns {boolean} Whether anything actually changed
   */
  patch(partial) {
    if (!partial || typeof partial !== 'object') return false;

    const changed = [];
    const next = { ...this.settings };

    for (const [key, value] of Object.entries(partial)) {
      // An unknown key is a typo at the call site, not a new setting. Silently
      // storing it would make the typo look like it worked.
      if (!VALIDATORS[key]) {
        console.warn(`[BloomWake] Unknown setting "${key}" ignored.`);
        continue;
      }
      const clean = VALIDATORS[key](value);
      if (clean !== next[key]) {
        next[key] = clean;
        changed.push(key);
      }
    }

    // Nothing moved — commonly a slider being dragged within one step. No
    // write, no notification.
    if (changed.length === 0) return false;

    this.settings = next;
    this.write();
    this.notify(changed);
    return true;
  }

  /**
   * Restore the factory defaults.
   * @returns {boolean} Whether anything changed
   */
  reset() {
    return this.patch({ ...DEFAULT_SETTINGS });
  }

  /**
   * Listen for changes.
   *
   * @param {(settings: Settings, changed: string[]) => void} listener
   * @returns {() => void} Unsubscribe
   */
  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Settings listener must be a function');
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * @param {string[]} changed
   */
  notify(changed) {
    const snapshot = this.getAll();
    // Iterate a copy: a listener that unsubscribes itself — which the pause
    // modal does on teardown — would otherwise mutate the set mid-walk.
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot, changed);
      } catch (error) {
        // One broken listener must not stop the audio manager from hearing
        // that the player just muted the game.
        console.error('[BloomWake] Settings listener threw.', error);
      }
    }
  }
}
