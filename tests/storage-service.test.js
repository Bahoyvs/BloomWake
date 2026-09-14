/**
 * Storage service tests.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ARE ACTUALLY PROTECTING
 * ---------------------------------------------------------------------------
 * A player's save. Every other bug in this codebase is recoverable by
 * reloading; this is the one system where being wrong means somebody's forty
 * hours are gone. So the bias throughout is paranoid: most of what follows is
 * about the cases where a backing is missing, refuses, throws on being LOOKED
 * at, or already holds something better than what we were about to write.
 *
 * Everything is injected — an SDK stand-in, a local stand-in — so none of this
 * needs a browser, and the service under test is a fresh instance per case
 * rather than the module singleton. A shared singleton would let one test's
 * writes decide another test's outcome, which in a suite about persistence is
 * an especially bad way to be wrong.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CrazyGamesDataDriver,
  DRIVERS,
  GAME_STORAGE_KEYS,
  LocalStorageDriver,
  MAX_STORAGE_BYTES,
  MemoryDriver,
  StorageQuotaError,
  StorageService,
  WARN_STORAGE_BYTES,
  byteLength,
  storageService,
} from '../src/services/storage-service.js';

const ECONOMY_KEY = 'bloomwake.economy.v1';
const SETTINGS_KEY = 'bloomwake.settings.v1';
const SAVE_KEY = 'bloomwake.save.v1';

/** A localStorage-shaped fake, inspectable through `.map`. */
function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

/** A local driver over a fake store, skipping the `window` lookup. */
function fakeLocal(initial = {}) {
  return new LocalStorageDriver(fakeStore(initial));
}

/**
 * A stand-in for the CrazyGames service.
 *
 * Only the three things the storage service actually asks it, so a change to
 * either side's contract shows up here as a broken test rather than as a
 * silently skipped cloud driver.
 *
 * @param {Object} [options]
 * @param {boolean} [options.initialized]
 * @param {Object|null} [options.data] - The Data module, or null for "absent"
 */
function fakeSdkService({ initialized = true, data = {}, cloud } = {}) {
  const store = cloud ?? new Map();
  const authListeners = new Set();
  const dataModule =
    data === null
      ? null
      : {
          getItem: (k) => (store.has(k) ? store.get(k) : null),
          setItem: (k, v) => store.set(k, String(v)),
          removeItem: (k) => store.delete(k),
          clear: () => store.clear(),
          ...data,
        };

  return {
    store,
    authListeners,
    isInitialized: () => initialized,
    getDataModule: () => (initialized ? dataModule : null),
    onAuthChange: (fn) => {
      authListeners.add(fn);
      return () => authListeners.delete(fn);
    },
    /** Pretend a guest just signed in. */
    signIn() {
      for (const fn of [...authListeners]) fn({ username: 'Pilot' });
    },
  };
}

/** A service wired to a cloud, already initialised. */
async function cloudService(options = {}) {
  const sdkService = fakeSdkService(options.sdk);
  const localDriver = options.localDriver === undefined ? fakeLocal(options.local) : options.localDriver;
  const service = new StorageService({ sdkService, localDriver });
  await service.init();
  return { service, sdkService, localDriver };
}

/* ========================================================================= */
/* Driver selection                                                          */
/* ========================================================================= */

describe('Driver selection', () => {
  it('falls all the way back to memory under Node', async () => {
    // No SDK, and `LocalStorageDriver.create()` finds no window. This is the
    // environment the whole test suite runs in, so it had better be playable.
    const service = new StorageService({ sdkService: { isInitialized: () => false } });
    await service.init();

    expect(service.driverName).toBe(DRIVERS.MEMORY);
    expect(service.isCloud).toBe(false);
  });

  it('uses localStorage when there is no SDK', async () => {
    const service = new StorageService({
      sdkService: { isInitialized: () => false },
      localDriver: fakeLocal(),
    });
    await service.init();

    expect(service.driverName).toBe(DRIVERS.LOCAL);
  });

  it('prefers the CrazyGames cloud when the SDK is up', async () => {
    const { service } = await cloudService();
    expect(service.driverName).toBe(DRIVERS.CLOUD);
    expect(service.isCloud).toBe(true);
  });

  it('refuses the cloud while the SDK is still initialising', async () => {
    // The `sdkNotInitialized` trap: `SDK.data` exists from the moment the
    // script tag evaluates, and is not callable until the handshake lands.
    // Existing is not the same as being safe to use.
    const { service } = await cloudService({ sdk: { initialized: false } });
    expect(service.driverName).toBe(DRIVERS.LOCAL);
  });

  it('skips the cloud when the Data module is switched off for this game', async () => {
    // A real portal state: the Data module is enabled by a per-game toggle in
    // the submission flow, and a game whose toggle is off gets an error from
    // every call rather than an absent object.
    const { service } = await cloudService({ sdk: { data: null } });
    expect(service.driverName).toBe(DRIVERS.LOCAL);
  });

  it('skips a half-shipped Data module rather than trusting it', async () => {
    // A module that reads and cannot write is worse than no module: progress
    // would look fine all session and be gone on reload.
    const sdkService = {
      isInitialized: () => true,
      getDataModule: () => ({ getItem: () => null }),
    };
    const service = new StorageService({ sdkService, localDriver: fakeLocal() });
    await service.init();

    expect(service.driverName).toBe(DRIVERS.LOCAL);
  });

  it('is inert until init(), so importing it can never throw', () => {
    // The singleton is constructed at module scope. If the constructor went
    // looking for `window` or the SDK, importing this file would be the thing
    // that broke the game.
    expect(storageService.ready).toBe(false);
    expect(storageService.driverName).toBe(DRIVERS.MEMORY);
  });

  it('shares one init across concurrent callers', async () => {
    const sdkService = fakeSdkService();
    const service = new StorageService({ sdkService, localDriver: fakeLocal() });

    const [a, b] = await Promise.all([service.init(), service.init()]);
    expect(a).toBe(b);
    expect(service.ready).toBe(true);
  });
});

/* ========================================================================= */
/* Migration                                                                 */
/* ========================================================================= */

describe('Local to cloud migration', () => {
  it('promotes an existing local save into an empty cloud', async () => {
    const { service, sdkService } = await cloudService({
      local: { [ECONOMY_KEY]: '{"scrap":420}' },
    });

    expect(sdkService.store.get(ECONOMY_KEY)).toBe('{"scrap":420}');
    expect(service.getItem(ECONOMY_KEY)).toBe('{"scrap":420}');
  });

  it('migrates every game key it finds', async () => {
    const { sdkService } = await cloudService({
      local: {
        [ECONOMY_KEY]: 'economy',
        [SETTINGS_KEY]: 'settings',
        [SAVE_KEY]: 'save',
      },
    });

    for (const key of GAME_STORAGE_KEYS) expect(sdkService.store.has(key)).toBe(true);
  });

  it('leaves cloud data alone when the cloud already has the key', async () => {
    // The player has been playing on their phone. This desktop still has an
    // old local save. The phone's progress is the real one — it is the copy
    // that has seen every device — and must not be overwritten.
    const cloud = new Map([[ECONOMY_KEY, '{"scrap":9000}']]);
    const { service, sdkService } = await cloudService({
      sdk: { cloud },
      local: { [ECONOMY_KEY]: '{"scrap":10}' },
    });

    expect(sdkService.store.get(ECONOMY_KEY)).toBe('{"scrap":9000}');
    expect(service.getItem(ECONOMY_KEY)).toBe('{"scrap":9000}');
  });

  it('never deletes the local copy', async () => {
    // It is the offline backup. A player who later opens the game somewhere
    // the SDK will not load still needs to find their progress.
    const localDriver = fakeLocal({ [ECONOMY_KEY]: '{"scrap":420}' });
    const service = new StorageService({ sdkService: fakeSdkService(), localDriver });
    await service.init();

    expect(localDriver.store.map.get(ECONOMY_KEY)).toBe('{"scrap":420}');
  });

  it('reports what it did', async () => {
    const cloud = new Map([[SETTINGS_KEY, 'already-here']]);
    const service = new StorageService({
      sdkService: fakeSdkService({ cloud }),
      localDriver: fakeLocal({ [ECONOMY_KEY]: 'moved', [SETTINGS_KEY]: 'stale' }),
    });
    await service.init();

    // init() has already run it; a second call is a no-op on a cloud that now
    // holds both keys, which is itself the property worth pinning: migration
    // is not destructive and not order-dependent.
    const report = await service.migrateLocalStorageToCloud();
    expect(report.migrated).toEqual([]);
    expect(report.skipped).toEqual([ECONOMY_KEY, SETTINGS_KEY]);
  });

  it('survives a cloud that refuses one key mid-migration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service } = await cloudService({
      sdk: {
        data: {
          setItem: (k) => {
            throw new Error('dataLimitExcedeed');
          },
        },
      },
      local: { [ECONOMY_KEY]: '{"scrap":420}' },
    });

    // The write up failed, the local copy is untouched, and the read-through
    // fallback still finds it. A half-failed migration costs the player
    // nothing at all.
    expect(service.getItem(ECONOMY_KEY)).toBe('{"scrap":420}');
    warn.mockRestore();
  });

  it('does nothing at all without a cloud driver', async () => {
    const service = new StorageService({
      sdkService: { isInitialized: () => false },
      localDriver: fakeLocal({ [ECONOMY_KEY]: 'x' }),
    });
    await service.init();

    const report = await service.migrateLocalStorageToCloud();
    expect(report).toEqual({ migrated: [], skipped: [], failed: [] });
  });
});

/* ========================================================================= */
/* The key-value interface                                                   */
/* ========================================================================= */

describe('Reading and writing', () => {
  it('round-trips a value', async () => {
    const { service } = await cloudService();
    expect(service.setItem(ECONOMY_KEY, '{"scrap":1}')).toBe(true);
    expect(service.getItem(ECONOMY_KEY)).toBe('{"scrap":1}');
  });

  it('answers null for a key that was never written', async () => {
    const { service } = await cloudService();
    expect(service.getItem('bloomwake.nothing')).toBeNull();
  });

  it('stringifies the way localStorage does', async () => {
    // Callers have always been able to hand this a number and read a string
    // back. A driver that preserved the type would be the odd one out, and a
    // `=== 0` somewhere would start failing only on the portal.
    const { service } = await cloudService();
    service.setItem(ECONOMY_KEY, 0);
    expect(service.getItem(ECONOMY_KEY)).toBe('0');
  });

  it('mirrors cloud writes down to the offline backup', async () => {
    const { service, localDriver } = await cloudService();
    service.setItem(ECONOMY_KEY, 'fresh');

    // This is what makes the local copy a BACKUP rather than a fossil: a
    // player who loses the SDK tomorrow gets today's progress, not the
    // progress they had when they first migrated.
    expect(localDriver.store.map.get(ECONOMY_KEY)).toBe('fresh');
  });

  it('reads through to the backup when the cloud comes up empty', async () => {
    // A key written before the SDK was ever integrated, or one a migration
    // never got to.
    const localDriver = fakeLocal();
    const service = new StorageService({ sdkService: fakeSdkService(), localDriver });
    await service.init();
    localDriver.store.map.set(SAVE_KEY, 'orphaned');

    expect(service.getItem(SAVE_KEY)).toBe('orphaned');
  });

  it('deletes from the backup as well as the cloud', async () => {
    // The invariant the read-through fallback depends on. Without it, a reset
    // would restore itself from the backup on the very next read and appear
    // to do nothing.
    const { service, localDriver, sdkService } = await cloudService({
      local: { [ECONOMY_KEY]: 'doomed' },
    });

    service.removeItem(ECONOMY_KEY);
    expect(sdkService.store.has(ECONOMY_KEY)).toBe(false);
    expect(localDriver.store.map.has(ECONOMY_KEY)).toBe(false);
    expect(service.getItem(ECONOMY_KEY)).toBeNull();
  });

  it('clears only the keys the game owns', async () => {
    // The portal shares an origin with the site around it. Nothing gives this
    // game the right to call localStorage.clear().
    const localDriver = fakeLocal({ 'someone.elses.key': 'keep me' });
    const service = new StorageService({
      sdkService: { isInitialized: () => false },
      localDriver,
    });
    await service.init();
    service.setItem(ECONOMY_KEY, 'mine');

    service.clear();
    expect(service.getItem(ECONOMY_KEY)).toBeNull();
    expect(localDriver.store.map.get('someone.elses.key')).toBe('keep me');
  });

  it('reports a failed write as false rather than throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service } = await cloudService({
      sdk: {
        data: {
          setItem: () => {
            throw new Error('quota');
          },
        },
      },
    });

    expect(service.setItem(ECONOMY_KEY, 'x')).toBe(false);
    warn.mockRestore();
  });

  it('answers null rather than throwing when a read blows up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service } = await cloudService({
      sdk: {
        data: {
          getItem: () => {
            throw new Error('cloud is down');
          },
        },
      },
    });

    expect(service.getItem(ECONOMY_KEY)).toBeNull();
    warn.mockRestore();
  });
});

/* ========================================================================= */
/* Quota                                                                     */
/* ========================================================================= */

describe('Quota guardrails', () => {
  it('measures in UTF-8 bytes, not UTF-16 units', () => {
    // The platform's limit is in bytes. `String.length` would under-count
    // every non-ASCII character in a save, which is the direction that loses
    // data rather than the direction that complains early.
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('日本語')).toBe(9);
    expect(byteLength('')).toBe(0);
  });

  it('stores an ordinary payload without complaint', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service } = await cloudService();

    expect(service.setItem(ECONOMY_KEY, JSON.stringify({ scrap: 1200 }))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses a write that would breach the 1MB ceiling', async () => {
    const { service } = await cloudService();
    const huge = 'x'.repeat(MAX_STORAGE_BYTES + 1);

    // Loud, not silent. Past this line the portal stops persisting ANYTHING,
    // so a quiet `false` here would read as an ordinary bad day and the player
    // would lose every reward they earned from then on.
    expect(() => service.setItem(ECONOMY_KEY, huge)).toThrow(StorageQuotaError);
  });

  it('says what was refused and why', async () => {
    const { service } = await cloudService();
    try {
      service.setItem(ECONOMY_KEY, 'x'.repeat(MAX_STORAGE_BYTES + 1));
      throw new Error('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(StorageQuotaError);
      expect(error.key).toBe(ECONOMY_KEY);
      expect(error.limit).toBe(MAX_STORAGE_BYTES);
      expect(error.message).toContain(ECONOMY_KEY);
    }
  });

  it('does not write anything when it refuses', async () => {
    const { service, sdkService } = await cloudService();
    expect(() => service.setItem(ECONOMY_KEY, 'x'.repeat(MAX_STORAGE_BYTES + 1))).toThrow();
    expect(sdkService.store.has(ECONOMY_KEY)).toBe(false);
  });

  it('warns once when the total approaches the ceiling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service } = await cloudService();

    service.setItem(ECONOMY_KEY, 'x'.repeat(WARN_STORAGE_BYTES + 1024));
    expect(warn).toHaveBeenCalledTimes(1);

    // Once per session, not once per autosave. The thing being warned about
    // does not change between two of them, and the noise would bury the
    // warnings that do mean something.
    service.setItem(ECONOMY_KEY, 'x'.repeat(WARN_STORAGE_BYTES + 2048));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('counts the total across keys, not each key alone', async () => {
    const { service } = await cloudService();
    const half = 'x'.repeat(Math.floor(MAX_STORAGE_BYTES * 0.6));

    expect(service.setItem(ECONOMY_KEY, half)).toBe(true);
    // Each write fits on its own; together they do not, and the platform's
    // limit is on the total.
    expect(() => service.setItem(SAVE_KEY, half)).toThrow(StorageQuotaError);
  });

  it('lets a save be rewritten at the same size forever', async () => {
    // The projection replaces this key's current size rather than adding to
    // it. Getting that wrong would fire the guard on the first autosave after
    // a large save, which is to say immediately and permanently.
    const { service } = await cloudService();
    const big = 'x'.repeat(Math.floor(MAX_STORAGE_BYTES * 0.8));

    for (let i = 0; i < 5; i++) expect(service.setItem(ECONOMY_KEY, big)).toBe(true);
    expect(service.totalBytes()).toBeLessThanOrEqual(MAX_STORAGE_BYTES);
  });

  it('frees the quota a deleted key was using', async () => {
    const { service } = await cloudService();
    service.setItem(ECONOMY_KEY, 'x'.repeat(Math.floor(MAX_STORAGE_BYTES * 0.9)));
    service.removeItem(ECONOMY_KEY);

    expect(service.totalBytes()).toBe(0);
    expect(service.setItem(SAVE_KEY, 'x'.repeat(1000))).toBe(true);
  });
});

/* ========================================================================= */
/* Resilience                                                                */
/* ========================================================================= */

describe('Hostile environments', () => {
  it('treats a localStorage that throws on access as absent', () => {
    // A sandboxed iframe throws a SecurityError on the PROPERTY READ, before
    // any method is called. This is the case that used to take the whole game
    // down at import time.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });

    try {
      expect(LocalStorageDriver.create()).toBeNull();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete globalThis.localStorage;
    }
  });

  it('boots to memory when localStorage is poisoned', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });

    try {
      const service = new StorageService({ sdkService: { isInitialized: () => false } });
      await expect(service.init()).resolves.toBe(service);
      expect(service.driverName).toBe(DRIVERS.MEMORY);
      // And it is a working store, not a stub: the session survives, it just
      // does not survive a reload.
      service.setItem(ECONOMY_KEY, 'in-memory');
      expect(service.getItem(ECONOMY_KEY)).toBe('in-memory');
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete globalThis.localStorage;
    }
  });

  it('treats a present-but-unwritable localStorage as absent', () => {
    // Private browsing in older Safari: the object is there, reads work, and
    // every write throws. Only a probe write can tell the difference.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('QuotaExceededError');
        },
        removeItem: () => {},
      },
    });

    try {
      expect(LocalStorageDriver.create()).toBeNull();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete globalThis.localStorage;
    }
  });

  it('survives an SDK service that throws when asked about the cloud', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new StorageService({
      sdkService: {
        isInitialized: () => true,
        getDataModule: () => {
          throw new Error('SDK exploded');
        },
      },
      localDriver: fakeLocal(),
    });

    await expect(service.init()).resolves.toBe(service);
    expect(service.driverName).toBe(DRIVERS.LOCAL);
    warn.mockRestore();
  });

  it('works with no SDK service at all', async () => {
    const service = new StorageService({ sdkService: null, localDriver: fakeLocal() });
    await service.init();
    expect(service.driverName).toBe(DRIVERS.LOCAL);
  });
});

/* ========================================================================= */
/* Signing in mid-session                                                    */
/* ========================================================================= */

describe('Re-hydration on sign-in', () => {
  it('announces when a guest signs in', async () => {
    const { service, sdkService } = await cloudService();
    const seen = [];
    service.onRehydrate(() => seen.push('rehydrate'));

    sdkService.signIn();
    expect(seen).toEqual(['rehydrate']);
  });

  it('re-measures the new account before anyone reads it', async () => {
    // Order matters: a manager that saves immediately on reload must be sized
    // against the account it has just landed in, not against the guest
    // session that was replaced.
    //
    // No local backup here, deliberately. With one, the read-through fallback
    // would answer from it and this would be measuring the wrong thing — see
    // the next case, which is about exactly that.
    const { service, sdkService } = await cloudService({ localDriver: null });
    service.setItem(ECONOMY_KEY, 'x'.repeat(2048));
    expect(service.totalBytes()).toBe(2048);

    sdkService.store.clear();
    sdkService.store.set(SAVE_KEY, 'x'.repeat(16));

    let measuredDuringCallback = null;
    service.onRehydrate(() => {
      measuredDuringCallback = service.totalBytes();
    });
    sdkService.signIn();

    // The new account's contents, not the guest's, and already correct by the
    // time the first listener runs.
    expect(measuredDuringCallback).toBe(16);
  });

  it('carries guest progress into an account that has none', async () => {
    // Not an accident of the fallback — it is what the platform itself does:
    // a guest's saves live locally and are promoted on login IF the account is
    // empty. A player who plays as a guest and then signs in keeps what they
    // earned.
    const { service, sdkService } = await cloudService();
    service.setItem(ECONOMY_KEY, '{"scrap":500}');

    sdkService.store.clear(); // the account they signed into is brand new
    sdkService.signIn();

    expect(service.getItem(ECONOMY_KEY)).toBe('{"scrap":500}');
  });

  it('prefers the account over the guest when both have progress', async () => {
    // The other half of the same rule. An account with its own history wins:
    // it is the copy that has seen the player's other devices.
    const { service, sdkService } = await cloudService();
    service.setItem(ECONOMY_KEY, '{"scrap":5}');

    sdkService.store.set(ECONOMY_KEY, '{"scrap":9000}');
    sdkService.signIn();

    expect(service.getItem(ECONOMY_KEY)).toBe('{"scrap":9000}');
  });

  it('keeps notifying the rest when one listener throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { service, sdkService } = await cloudService();
    const seen = [];

    service.onRehydrate(() => {
      throw new Error('manager bug');
    });
    service.onRehydrate(() => seen.push('still ran'));
    sdkService.signIn();

    expect(seen).toEqual(['still ran']);
    error.mockRestore();
  });

  it('unsubscribes cleanly', async () => {
    const { service, sdkService } = await cloudService();
    const seen = [];
    const off = service.onRehydrate(() => seen.push('x'));
    off();

    sdkService.signIn();
    expect(seen).toEqual([]);
  });

  it('does not need a user module to be present', async () => {
    // Off-portal there is no auth to listen to, and asking for one must not be
    // the thing that stops the game booting.
    const service = new StorageService({
      sdkService: { isInitialized: () => false },
      localDriver: fakeLocal(),
    });
    await expect(service.init()).resolves.toBe(service);
  });
});

/* ========================================================================= */
/* The drivers on their own                                                  */
/* ========================================================================= */

describe('MemoryDriver', () => {
  it('round-trips, deletes and clears', () => {
    const driver = new MemoryDriver();
    expect(driver.getItem('a')).toBeNull();

    driver.setItem('a', 1);
    expect(driver.getItem('a')).toBe('1');

    driver.removeItem('a');
    expect(driver.getItem('a')).toBeNull();

    driver.setItem('b', 'x');
    driver.clear();
    expect(driver.getItem('b')).toBeNull();
  });
});

describe('CrazyGamesDataDriver', () => {
  it('normalises undefined to null', () => {
    // Some SDK builds answer `undefined` for a missing key and others `null`.
    // Normalising here is what stops every caller having to know which build
    // it is talking to.
    const driver = new CrazyGamesDataDriver({ getItem: () => undefined, setItem: () => {} });
    expect(driver.getItem('anything')).toBeNull();
  });

  it('lets a write error through for the service to handle', () => {
    // Reads degrade to null; writes do not degrade silently, because a write
    // that vanishes is a save that vanishes.
    const driver = new CrazyGamesDataDriver({
      getItem: () => null,
      setItem: () => {
        throw new Error('dataModuleDisabled');
      },
    });
    expect(() => driver.setItem('k', 'v')).toThrow('dataModuleDisabled');
  });
});
