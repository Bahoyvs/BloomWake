/**
 * The game's one storage engine.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * Three places used to reach for `localStorage` on their own — the meta-save,
 * the crate economy and the settings — each with its own availability probe and
 * its own try/catch. That was survivable while there was one place a save could
 * live. It stopped being survivable the moment there were three: the portal's
 * Data module (a real cloud save, synced across a player's devices), the
 * browser's localStorage, and nothing at all.
 *
 * So this is the seam. It presents exactly the interface those three callers
 * were already written against — `getItem`, `setItem`, `removeItem`, `clear`,
 * synchronous, strings in and strings out — and decides underneath which of the
 * three real backings that maps onto. Nothing above this line knows a cloud
 * exists.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE: A SAVE IS NEVER LOST TO A REFACTOR
 * ---------------------------------------------------------------------------
 * Players have progress in `localStorage` today. Moving the game to a cloud
 * driver must not so much as flicker it. Three things enforce that:
 *
 *   1. MIGRATION IS ADDITIVE. On the first boot with a cloud driver, local keys
 *      are copied UP into the cloud — and only into keys the cloud does not
 *      already have. Cloud data always wins, because the cloud is the thing
 *      that knows about the player's other devices and this browser is not.
 *   2. THE LOCAL COPY IS NEVER DELETED. It stays as an offline backup, and it
 *      is kept CURRENT: every cloud write is mirrored down to it. A player who
 *      later opens the game somewhere the SDK cannot load still finds their
 *      progress where it has always been.
 *   3. READS FALL BACK. A cloud miss consults the local backup before giving up,
 *      so a migration that half-failed — the network died between two keys —
 *      costs the player nothing.
 *
 * The invariant that makes (3) safe is that deletes propagate DOWN as well as
 * up. If `removeItem` only cleared the cloud, the next read would resurrect the
 * save from the backup and "reset progress" would silently do nothing.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER THROWS ON A READ, AND THROWS ON EXACTLY ONE KIND OF WRITE
 * ---------------------------------------------------------------------------
 * Every read path degrades to `null`. Every write path degrades to `false`,
 * with one deliberate exception: a payload past the portal's hard 1MB ceiling
 * throws `StorageQuotaError`. That is not a failure to be swallowed — it means
 * a save has grown past what the platform will ever accept, and the alternative
 * to a loud error is the portal quietly dropping the write and the player
 * losing everything they earn from then on. All three callers already wrap
 * `setItem` in a try/catch, so the throw is caught and reported, not fatal.
 */

import { crazyGames } from './crazygames.js';

/**
 * The keys the game owns.
 *
 * Enumerated rather than discovered because two of the three backings cannot be
 * enumerated: `SDK.data` exposes no `key(n)`, and neither does a Map-backed
 * fake. Migration and the size accounting both need to know what to look at, so
 * the list is the schema. A new save key gets added here or it does not get
 * migrated — which is a deliberate trade for having the list be readable.
 */
export const GAME_STORAGE_KEYS = Object.freeze([
  'bloomwake.economy.v1',
  'bloomwake.settings.v1',
  'bloomwake.save.v1',
]);

/**
 * The portal's hard ceiling on stored data, in bytes.
 *
 * 1MB, JSON-stringified, across everything the game saves. Past it the platform
 * stops backing data up — not with an exception, just silently — which is the
 * worst possible failure for a save system, so this side refuses first.
 */
export const MAX_STORAGE_BYTES = 1024 * 1024;

/** Where we start saying something, well short of the cliff. */
export const WARN_STORAGE_BYTES = 900 * 1024;

/** Driver names, for logging and for tests that assert which one is live. */
export const DRIVERS = Object.freeze({
  CLOUD: 'crazygames-data',
  LOCAL: 'local-storage',
  MEMORY: 'memory',
});

/**
 * A write refused for being too large to ever land.
 *
 * Its own class so a caller can tell "this save is too big" apart from "the
 * disk is full this second" — the first is a bug in what we are storing and
 * needs fixing, the second is weather.
 */
export class StorageQuotaError extends Error {
  /**
   * @param {string} message
   * @param {Object} [detail]
   */
  constructor(message, detail = {}) {
    super(message);
    this.name = 'StorageQuotaError';
    Object.assign(this, detail);
  }
}

/**
 * Byte length of a string as UTF-8.
 *
 * `String.length` counts UTF-16 code units and would under-count every
 * non-ASCII character in a save — and the platform's limit is in bytes. The
 * ladder exists because `TextEncoder` is not guaranteed in every environment
 * this module is imported into; the final fallback is a deliberate
 * over-estimate, since guessing high only makes the guard fire early.
 *
 * @param {string} text
 * @returns {number}
 */
export function byteLength(text) {
  const str = String(text ?? '');
  try {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(str).length;
  } catch {
    // Fall through to the next strategy.
  }
  try {
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(str, 'utf8');
  } catch {
    // Fall through.
  }
  // Worst case for UTF-8 within the BMP. High, and high is the safe direction.
  return str.length * 3;
}

/* ========================================================================== */
/* Drivers                                                                    */
/* ========================================================================== */

/**
 * In-memory storage.
 *
 * The floor of the ladder, and never a failure state on its own terms: it is
 * what vitest runs on, what a locked-down iframe falls back to, and what a
 * private window with storage disabled gets. The game is fully playable on it.
 * The only thing the player loses is the session surviving a reload, and that
 * beats every alternative, all of which are "the game does not start".
 */
export class MemoryDriver {
  constructor() {
    this.name = DRIVERS.MEMORY;
    /** @type {Map<string, string>} */
    this.map = new Map();
  }

  /** @param {string} key @returns {string|null} */
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  /** @param {string} key @param {*} value */
  setItem(key, value) {
    this.map.set(key, String(value));
  }

  /** @param {string} key */
  removeItem(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

/**
 * `localStorage`, behind the try/catch it has always needed.
 *
 * Merely READING `window.localStorage` throws in a sandboxed iframe (a
 * `SecurityError`) and in some hardened privacy configurations — it is not
 * cleanly absent, it is a landmine. So the constructor takes the store as an
 * argument and `create()` is the only thing that goes looking for it, with the
 * probe write that is the only way to tell a usable store from one that will
 * fail on first use.
 */
export class LocalStorageDriver {
  /** @param {Storage} store */
  constructor(store) {
    this.name = DRIVERS.LOCAL;
    this.store = store;
  }

  /**
   * @returns {LocalStorageDriver|null} A driver, or null when localStorage is
   *   absent, blocked, or present-but-unwritable.
   */
  static create() {
    try {
      const store = globalThis.window?.localStorage ?? globalThis.localStorage;
      if (!store) return null;
      // Quota and permission failures only surface on a real write, so probe
      // with one. A store that reads fine and refuses to write is the exact
      // case that would otherwise be discovered when a run's rewards vanish.
      const probe = '__bloomwake_storage_probe__';
      store.setItem(probe, probe);
      store.removeItem(probe);
      return new LocalStorageDriver(store);
    } catch {
      return null;
    }
  }

  /** @param {string} key @returns {string|null} */
  getItem(key) {
    try {
      return this.store.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} key @param {*} value
   * @throws Whatever the store throws — a full quota is real information and
   *   the service above turns it into a `false`, not a silent success.
   */
  setItem(key, value) {
    this.store.setItem(key, String(value));
  }

  /** @param {string} key */
  removeItem(key) {
    try {
      this.store.removeItem(key);
    } catch {
      // A store that will not delete is one we cannot do anything about.
    }
  }

  /**
   * Clears only the game's own keys.
   *
   * `localStorage.clear()` would take out everything on the origin, which on
   * the portal is shared with the site itself. Nothing gives this game the
   * right to do that.
   */
  clear() {
    for (const key of GAME_STORAGE_KEYS) this.removeItem(key);
  }
}

/**
 * The portal's Data module: a real cross-device cloud save.
 *
 * Its API is deliberately `localStorage`-shaped — the portal documents it that
 * way — which is what lets it sit behind the same interface as the other two.
 * What it adds is a player's account: a guest's writes go to local storage and
 * are promoted to the cloud when they sign in, and a signed-in player's writes
 * follow them to their phone.
 *
 * It is NEVER constructed before `SDK.init()` has resolved; see
 * `crazyGames.getDataModule()`, which is the only thing that decides that.
 */
export class CrazyGamesDataDriver {
  /** @param {Object} data - `window.CrazyGames.SDK.data` */
  constructor(data) {
    this.name = DRIVERS.CLOUD;
    this.data = data;
  }

  /** @param {string} key @returns {string|null} */
  getItem(key) {
    try {
      const value = this.data.getItem(key);
      // The module answers `undefined` for a missing key in some SDK builds
      // and `null` in others. One of them is normalised away here so no caller
      // has to know which build it is talking to.
      return value === undefined || value === null ? null : String(value);
    } catch (error) {
      console.warn('[BloomWake] Cloud read failed for "' + key + '".', error);
      return null;
    }
  }

  /** @param {string} key @param {*} value */
  setItem(key, value) {
    this.data.setItem(key, String(value));
  }

  /** @param {string} key */
  removeItem(key) {
    try {
      this.data.removeItem(key);
    } catch (error) {
      console.warn('[BloomWake] Cloud delete failed for "' + key + '".', error);
    }
  }

  /** Clears the game's keys. See LocalStorageDriver.clear for why not clear(). */
  clear() {
    for (const key of GAME_STORAGE_KEYS) this.removeItem(key);
  }
}

/* ========================================================================== */
/* The service                                                                */
/* ========================================================================== */

export class StorageService {
  /**
   * @param {Object} [options]
   * @param {Object} [options.sdkService] - The CrazyGames service to ask about
   *   the Data module. Injected by tests; defaults to the live singleton.
   * @param {Object|null} [options.localDriver] - Override the local backing.
   *   `null` means "there is no localStorage here", which is a state tests need
   *   to be able to assert on and cannot otherwise reach.
   * @param {boolean} [options.mirrorToLocal] - Keep the offline backup current.
   */
  constructor({ sdkService, localDriver, mirrorToLocal = true } = {}) {
    this.sdkService = sdkService ?? crazyGames;
    this.mirrorToLocal = mirrorToLocal;

    /**
     * The local backing, resolved once.
     *
     * Held separately from `this.driver` because it has a second job: when the
     * cloud is live, this is the offline backup that writes are mirrored to and
     * that reads fall back on. `undefined` means "not looked for yet"; `null`
     * means "looked, and there is none".
     * @type {Object|null|undefined}
     */
    this.localDriver = localDriver;

    /** @type {Object} The driver every operation actually goes through. */
    this.driver = new MemoryDriver();
    /** @type {boolean} */
    this.ready = false;
    /** @type {Promise<StorageService>|null} */
    this.initPromise = null;

    /**
     * Bytes currently held, per key. The portal's limit is on the total, and
     * neither the cloud module nor a Map can be asked how big it is, so the
     * service keeps its own ledger and updates it on every write.
     * @type {Map<string, number>}
     */
    this.sizes = new Map();

    /** @type {Set<() => void>} Called when the account underneath changes. */
    this.rehydrateListeners = new Set();
    /** @type {(() => void)|null} */
    this.authTeardown = null;
    /** @type {boolean} Whether a warning has already been logged this session. */
    this.warnedNearQuota = false;
  }

  /** @returns {string} Which backing is live: see DRIVERS. */
  get driverName() {
    return this.driver.name;
  }

  /** @returns {boolean} Whether saves reach the player's account. */
  get isCloud() {
    return this.driver.name === DRIVERS.CLOUD;
  }

  /* ------------------------------------------------------------------ */
  /* Setup                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve a driver, migrate anything owed to the cloud, and start listening
   * for the player signing in.
   *
   * MUST be awaited after `crazyGames.init()` and before anything hydrates
   * state, because the driver it picks depends on whether the SDK handshake
   * finished — and a manager that read its save a tick early would have read it
   * from the wrong backing and then written that back over the right one.
   *
   * Safe to call twice; the second caller gets the first one's promise.
   *
   * @returns {Promise<StorageService>}
   */
  init() {
    if (this.ready) return Promise.resolve(this);
    if (!this.initPromise) this.initPromise = this.#doInit();
    return this.initPromise;
  }

  /** @returns {Promise<StorageService>} */
  async #doInit() {
    if (this.localDriver === undefined) this.localDriver = LocalStorageDriver.create();

    const cloud = this.#resolveCloudDriver();
    if (cloud) {
      this.driver = cloud;
      await this.migrateLocalStorageToCloud();
    } else {
      // No cloud: the local store IS the save, not a backup of one.
      this.driver = this.localDriver ?? new MemoryDriver();
    }

    this.measureExistingKeys();
    this.subscribeToAuthChanges();
    this.ready = true;

    console.info('[BloomWake] Storage driver: ' + this.driverName + '.');
    return this;
  }

  /**
   * @returns {CrazyGamesDataDriver|null} The cloud driver, when the SDK is both
   *   initialised and actually offering a Data module.
   */
  #resolveCloudDriver() {
    try {
      if (!this.sdkService?.isInitialized?.()) return null;
      const data = this.sdkService.getDataModule?.();
      // Shape-checked here as well as in the SDK service. Not redundancy for
      // its own sake: this is the object that decides where a save goes, and a
      // module that can read and cannot write is strictly worse than no module
      // at all — progress would read back correctly all session and be gone on
      // reload. Whatever it is handed, it checks.
      if (typeof data?.getItem !== 'function' || typeof data?.setItem !== 'function') {
        return null;
      }
      return new CrazyGamesDataDriver(data);
    } catch (error) {
      console.warn('[BloomWake] Could not resolve the cloud storage driver.', error);
      return null;
    }
  }

  /**
   * Copy any local save the cloud does not already have.
   *
   * Runs once, on the first boot where a cloud driver is live. The direction is
   * only ever local -> cloud and only ever into an EMPTY cloud key: a player
   * who has been playing on their phone and opens the game on a desktop that
   * still has an old local save must get their phone's progress, not have it
   * overwritten by whatever this machine happens to remember.
   *
   * Nothing is deleted afterwards. The local copy stays as the offline backup
   * this service reads through to and mirrors writes into.
   *
   * @returns {Promise<{migrated: string[], skipped: string[], failed: string[]}>}
   */
  async migrateLocalStorageToCloud() {
    const report = { migrated: [], skipped: [], failed: [] };
    const local = this.localDriver;
    if (!local || !this.isCloud) return report;

    for (const key of GAME_STORAGE_KEYS) {
      let localValue = null;
      try {
        localValue = local.getItem(key);
      } catch {
        localValue = null;
      }
      // Nothing here to promote. Not a skip — there was never a decision.
      if (localValue === null || localValue === undefined || localValue === '') continue;

      const cloudValue = this.driver.getItem(key);
      if (cloudValue !== null && cloudValue !== undefined) {
        // The cloud already knows about this key, and the cloud is the one that
        // has seen the player's other devices. It wins, always.
        report.skipped.push(key);
        continue;
      }

      try {
        this.driver.setItem(key, localValue);
        report.migrated.push(key);
      } catch (error) {
        // A failed key is not a failed migration: the local copy is untouched
        // and the read-through fallback will still find it.
        console.warn('[BloomWake] Could not migrate "' + key + '" to the cloud.', error);
        report.failed.push(key);
      }
    }

    if (report.migrated.length > 0) {
      console.info(
        '[BloomWake] Migrated ' + report.migrated.length + ' save(s) to the CrazyGames cloud: ' +
          report.migrated.join(', ') + '.'
      );
    }
    return report;
  }

  /** Seed the size ledger from whatever is already stored. */
  measureExistingKeys() {
    this.sizes.clear();
    for (const key of GAME_STORAGE_KEYS) {
      const value = this.read(key);
      if (value !== null) this.sizes.set(key, byteLength(value));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Account changes                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Re-read state when the player signs in mid-session.
   *
   * The Data module swaps accounts underneath us the instant a guest logs in —
   * same object, different saves. Everything already hydrated into memory is
   * stale at that point, and worse, the next autosave would write this
   * session's guest progress over the account's real one.
   *
   * The listeners are a notification, not a callback into the managers. This
   * module cannot import the economy or the settings: they import IT, and a
   * cycle between a save file and the thing being saved is how a bundler ends
   * up handing one of them an empty object at start-up. `main.js` owns the
   * wiring, because `main.js` is where every other system is already wired.
   *
   * @param {() => void} listener
   * @returns {() => void} Unsubscribe
   */
  onRehydrate(listener) {
    if (typeof listener !== 'function') throw new TypeError('Rehydrate listener must be a function');
    this.rehydrateListeners.add(listener);
    return () => this.rehydrateListeners.delete(listener);
  }

  /** Ask the SDK to tell us when a guest becomes a player. */
  subscribeToAuthChanges() {
    if (this.authTeardown) return;
    this.authTeardown = this.sdkService?.onAuthChange?.(() => this.handleAuthChange()) ?? null;
  }

  /**
   * A sign-in happened. Re-measure, then tell everyone to re-read.
   *
   * The order matters: the ledger is rebuilt from the NEW account's data before
   * any listener runs, so a manager that saves immediately on reload is sized
   * against what is actually stored rather than against the guest session that
   * has just been replaced.
   */
  handleAuthChange() {
    this.measureExistingKeys();
    for (const listener of [...this.rehydrateListeners]) {
      try {
        listener();
      } catch (error) {
        // One manager failing to re-hydrate must not stop the others.
        console.error('[BloomWake] Re-hydration listener threw.', error);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* The key-value interface                                             */
  /* ------------------------------------------------------------------ */

  /**
   * @param {string} key
   * @returns {string|null} The stored string, or null when there is none.
   */
  getItem(key) {
    return this.read(key);
  }

  /**
   * Read, with the offline backup as a second chance.
   *
   * Split out from `getItem` so `measureExistingKeys` can use it during init,
   * before `ready` is set.
   *
   * @param {string} key
   * @returns {string|null}
   */
  read(key) {
    let value = null;
    try {
      value = this.driver.getItem(key) ?? null;
    } catch (error) {
      console.warn('[BloomWake] Storage read failed for "' + key + '".', error);
      value = null;
    }
    if (value !== null) return value;

    // A cloud miss is worth a second look: a migration that failed part-way, or
    // a key written before the SDK was ever integrated, is still down there.
    // Safe only because deletes propagate to the backup too — see removeItem.
    if (this.isCloud && this.localDriver) {
      try {
        return this.localDriver.getItem(key) ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Store a value.
   *
   * @param {string} key
   * @param {*} value - Stringified, the way localStorage would
   * @returns {boolean} Whether the write landed
   * @throws {StorageQuotaError} When the write would breach the platform's 1MB
   *   ceiling. Deliberately loud: past that line the portal stops persisting
   *   anything at all, and a `false` here would read as an ordinary bad day.
   */
  setItem(key, value) {
    const payload = String(value);
    this.guardQuota(key, payload);

    try {
      this.driver.setItem(key, payload);
    } catch (error) {
      console.warn('[BloomWake] Storage write failed for "' + key + '".', error);
      return false;
    }

    this.sizes.set(key, byteLength(payload));
    this.mirrorDown(key, payload);
    return true;
  }

  /**
   * @param {string} key
   * @returns {boolean} Whether anything was removed without error
   */
  removeItem(key) {
    let ok = true;
    try {
      this.driver.removeItem(key);
    } catch (error) {
      console.warn('[BloomWake] Storage delete failed for "' + key + '".', error);
      ok = false;
    }
    this.sizes.delete(key);

    // Down as well as up. Without this the read-through fallback in `read`
    // would restore the key on the very next get, and a reset would appear to
    // do nothing at all.
    if (this.isCloud && this.localDriver) {
      try {
        this.localDriver.removeItem(key);
      } catch {
        // Backup that will not delete; the cloud is authoritative anyway.
      }
    }
    return ok;
  }

  /** Remove every key the game owns, from the driver and the backup alike. */
  clear() {
    for (const key of GAME_STORAGE_KEYS) this.removeItem(key);
    this.sizes.clear();
    this.warnedNearQuota = false;
  }

  /* ------------------------------------------------------------------ */
  /* Quota                                                               */
  /* ------------------------------------------------------------------ */

  /** @returns {number} Bytes currently held across every game key. */
  totalBytes() {
    let total = 0;
    for (const bytes of this.sizes.values()) total += bytes;
    return total;
  }

  /**
   * Refuse a write that cannot ever land, and complain about one getting close.
   *
   * The projection replaces this key's current size rather than adding to it —
   * a save being rewritten at the same size does not consume more quota, and
   * treating it as though it did would fire the guard on the first autosave.
   *
   * @param {string} key
   * @param {string} payload
   * @throws {StorageQuotaError}
   */
  guardQuota(key, payload) {
    const incoming = byteLength(payload);
    const projected = this.totalBytes() - (this.sizes.get(key) ?? 0) + incoming;

    if (projected > MAX_STORAGE_BYTES) {
      throw new StorageQuotaError(
        'Refusing to write "' + key + '": ' + Math.round(projected / 1024) + 'KB would exceed the ' +
          Math.round(MAX_STORAGE_BYTES / 1024) + 'KB CrazyGames storage limit.',
        { key, bytes: incoming, projected, limit: MAX_STORAGE_BYTES }
      );
    }

    if (projected > WARN_STORAGE_BYTES) {
      // Once per session. A warning on every autosave would be noise, and the
      // thing it is warning about does not change between two of them.
      if (!this.warnedNearQuota) {
        this.warnedNearQuota = true;
        console.warn(
          '[BloomWake] Stored data is ' + Math.round(projected / 1024) + 'KB, approaching the ' +
            Math.round(MAX_STORAGE_BYTES / 1024) + 'KB CrazyGames limit.'
        );
      }
    } else {
      this.warnedNearQuota = false;
    }
  }

  /**
   * Keep the offline backup in step with a cloud write.
   *
   * Best-effort and never fatal: the cloud write has already succeeded by the
   * time this runs, so a full local disk costs the player their offline copy
   * and nothing else.
   *
   * @param {string} key
   * @param {string} payload
   */
  mirrorDown(key, payload) {
    if (!this.mirrorToLocal || !this.isCloud || !this.localDriver) return;
    try {
      this.localDriver.setItem(key, payload);
    } catch {
      // The backup is a courtesy. The save itself is already safe.
    }
  }

  /** Detach listeners. Used by tests and hot reload, not by the game. */
  dispose() {
    try {
      this.authTeardown?.();
    } catch {
      // Already gone.
    }
    this.authTeardown = null;
    this.rehydrateListeners.clear();
  }
}

/**
 * The game's one storage service.
 *
 * Constructed at import time and deliberately inert until `init()` — the
 * constructor resolves no drivers and touches neither `window` nor the SDK, so
 * importing this module can never be the thing that throws.
 */
export const storageService = new StorageService();
