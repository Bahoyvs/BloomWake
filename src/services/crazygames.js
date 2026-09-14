/**
 * CrazyGames SDK adapter.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * The one module that knows the shape of `window.CrazyGames`. Everything else
 * asks for a rewarded ad and gets back a plain `{ok, reason}`, so the portal's
 * API — which is not ours, is versioned by someone else, and is simply absent
 * on localhost and on itch — cannot leak into the reward flow.
 *
 * ---------------------------------------------------------------------------
 * FAILURE IS THE NORMAL CASE, NOT THE EXCEPTION
 * ---------------------------------------------------------------------------
 * An ad request fails constantly in the real world: no SDK outside the portal,
 * no fill, an ad blocker, a player who closes it two seconds in. So this never
 * rejects. Every path — including one that throws inside the SDK's own callback
 * — resolves to `{ok: false, reason}`, because the only correct response to a
 * failed ad is to carry on with the base reward, and a caller that has to wrap
 * `await` in a try/catch to get that right will eventually get it wrong.
 *
 * The one thing it must never do is resolve `{ok: true}` when no ad played. The
 * reward is real currency; an optimistic guess here is a dupe bug.
 *
 * ---------------------------------------------------------------------------
 * DEV EMULATION
 * ---------------------------------------------------------------------------
 * With no SDK present, `requestRewardedAd` waits `EMULATED_AD_MS` and reports
 * success, so the whole 2x flow — spinner, doubled numbers, disabled button —
 * is exercisable on localhost. That is a development convenience and nothing
 * more: it is gated on there being no SDK at all, so it can never pay out a
 * player on the portal, where the SDK is always present.
 */

/** How long the emulated ad "plays" for. Long enough to see the pending state. */
export const EMULATED_AD_MS = 1500;

/** Why an ad did not pay out. The caller branches on these, not on strings. */
export const AD_RESULTS = {
  /** The ad played to the end and the reward is earned. */
  OK: 'OK',
  /** The player dismissed it early. Not an error — the commonest outcome. */
  DISMISSED: 'DISMISSED',
  /** No inventory, a blocker, or the SDK refused for its own reasons. */
  UNAVAILABLE: 'UNAVAILABLE',
  /** The SDK threw, or broke its own contract. */
  ERROR: 'ERROR',
  /** No SDK and emulation switched off — a real build off-portal. */
  NO_SDK: 'NO_SDK',
};

/**
 * The portal SDK, if this page is running inside it.
 *
 * Wrapped because reaching for `window` throws under SSR and inside a worker,
 * and because a partially-initialised SDK (the object exists, `ad` does not) is
 * a real state on slow connections — treating that as "no SDK" is what keeps a
 * cold start from throwing at the player instead of showing them a button.
 *
 * @returns {Object|null} The `ad` namespace, or null
 */
export function getAdSdk() {
  try {
    return globalThis.window?.CrazyGames?.SDK?.ad ?? null;
  } catch {
    return null;
  }
}

/** @returns {boolean} Whether a real rewarded ad can be requested right now. */
export function isAdAvailable() {
  return typeof getAdSdk()?.requestAd === 'function';
}

/**
 * Request a rewarded ad.
 *
 * SUPERSEDED by `CrazyGamesService.requestAd`, which is what the game calls.
 * Kept because it is a stable, tested export with a narrower contract — one
 * ad type, one phase callback, a dev emulation of its own — and because it is
 * the shape the crate modal's handler was written against. New callers want
 * the service: it splits "requested" from "started" the way the platform asks,
 * guards against two ads at once, and shares the one SDK instance.
 *
 * Resolves once — the SDK fires its callbacks through an options object and a
 * badly-behaved integration can fire more than one (an `adError` after an
 * `adFinished` on a late network failure, most often). A settle latch is what
 * stops the second callback from paying the reward out twice.
 *
 * @param {Object} [options]
 * @param {Object|null} [options.sdk] - Ad namespace; defaults to the live SDK.
 *   Injected by tests, which have no portal to talk to.
 * @param {boolean} [options.emulate] - Fake a successful ad when no SDK exists.
 *   Defaults to on in dev and off in a production build.
 * @param {number} [options.emulatedMs] - How long the fake ad takes
 * @param {(phase: string) => void} [options.onPhase] - 'started' | 'finished',
 *   for muting audio and pausing the loop while the ad is on screen
 * @returns {Promise<{ok: boolean, reason: string, emulated?: boolean}>}
 */
export function requestRewardedAd({
  sdk = getAdSdk(),
  emulate = isDevBuild(),
  emulatedMs = EMULATED_AD_MS,
  onPhase,
} = {}) {
  const phase = (name) => {
    // A listener that throws is the caller's bug, not a reason to fail the ad
    // the player already watched.
    try {
      onPhase?.(name);
    } catch (error) {
      console.warn('[BloomWake] Ad phase listener threw.', error);
    }
  };

  if (typeof sdk?.requestAd !== 'function') {
    if (!emulate) return Promise.resolve({ ok: false, reason: AD_RESULTS.NO_SDK });

    phase('started');
    return new Promise((resolve) => {
      setTimeout(() => {
        phase('finished');
        resolve({ ok: true, reason: AD_RESULTS.OK, emulated: true });
      }, emulatedMs);
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      phase('finished');
      resolve(outcome);
    };

    phase('started');

    try {
      sdk.requestAd('rewarded', {
        adStarted: () => {},
        adFinished: () => settle({ ok: true, reason: AD_RESULTS.OK }),
        // The SDK reports a player-dismissed ad and a no-fill through the same
        // callback, distinguished only by an error shape that is not contractual.
        // Both mean "no reward", so both resolve the same way and the reason is
        // only ever used for telemetry and copy.
        adError: (error) => settle({ ok: false, reason: classifyAdError(error) }),
      });
    } catch (error) {
      console.warn('[BloomWake] Rewarded ad request threw.', error);
      settle({ ok: false, reason: AD_RESULTS.ERROR });
    }
  });
}

/**
 * Best-effort read of an SDK error into one of AD_RESULTS.
 *
 * Deliberately forgiving: the payload is documented loosely and has changed
 * shape between SDK versions, so anything unrecognised becomes UNAVAILABLE
 * rather than throwing. Nothing downstream branches on the difference — the
 * player keeps their base reward either way.
 *
 * @param {*} error
 * @returns {string}
 */
export function classifyAdError(error) {
  let code = '';
  try {
    // String() on a null-prototype object throws rather than returning
    // "[object Object]" — it has no toString to call. An SDK that hands one
    // back must not take the reward flow down with it.
    code = String(error?.code ?? error?.name ?? error ?? '').toLowerCase();
  } catch {
    return AD_RESULTS.UNAVAILABLE;
  }

  if (code.includes('dismiss') || code.includes('cancel') || code.includes('skip')) {
    return AD_RESULTS.DISMISSED;
  }
  return AD_RESULTS.UNAVAILABLE;
}

/**
 * Is this a dev build? Guarded because `import.meta.env` is a Vite construct
 * and is simply absent under plain Node, where the tests run.
 * @returns {boolean}
 */
function isDevBuild() {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
}

/* ========================================================================== */
/* CrazyGames SDK v3 — the full portal surface                                */
/* ========================================================================== */

/**
 * Everything above this line is the rewarded-ad path, which predates the rest
 * and is still the contract the crate modal is written against. Everything
 * below is the wider SDK v3 integration the portal requires before a game is
 * allowed out of Basic Launch: init, the loading and gameplay telemetry that
 * measures our initial download, the platform mute setting, and the midgame
 * interstitial.
 *
 * ---------------------------------------------------------------------------
 * ONE OBJECT KNOWS THE PORTAL, AND IT IS NOT THE GAME
 * ---------------------------------------------------------------------------
 * `CrazyGamesService` is the only thing that touches `window.CrazyGames`. Every
 * method on it is safe to call before init(), after a failed init(), and on a
 * page that has never heard of the portal — off-portal it silently drives a
 * mock with the same shape. That is not a convenience: the game runs on
 * localhost, in vitest, and on the portal, and a lifecycle hook that throws in
 * two of those three is a hook nobody will be willing to call from the frame
 * loop.
 *
 * ---------------------------------------------------------------------------
 * TELEMETRY IS LATCHED, NOT FIRE-AND-FORGET
 * ---------------------------------------------------------------------------
 * `gameplayStart`/`gameplayStop` are a state machine with exactly two states,
 * and the service refuses a transition to the state it is already in. The
 * portal measures our initial download from the FIRST gameplayStart, and pairs
 * starts with stops to compute playtime — so a stray second start (unpausing a
 * run that was never paused, say) is not a harmless duplicate, it is a wrong
 * number on the dashboard that decides whether the game reaches Full Launch.
 */

/** Where the portal's SDK is loaded from. Mirrored in index.html. */
export const SDK_SCRIPT_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';

/** The two video-ad formats the portal serves. */
export const AD_TYPES = {
  /** Between levels, after a death — a break the player was already having. */
  MIDGAME: 'midgame',
  /** Opt-in, in exchange for something. Never required to progress. */
  REWARDED: 'rewarded',
};

/**
 * Ad errors that are the system working, not a fault.
 *
 * The portal paces midgame ads itself (one per three minutes) and disables them
 * outright during Basic Launch, and both of those arrive as an `adError`. A game
 * that showed the player a dialog for these would be showing them a dialog
 * every time the SDK does its job, so they are logged at debug level and
 * nothing else.
 */
export const QUIET_AD_CODES = new Set([
  'adCooldown',
  'adsDisabledBasicLaunch',
  'unfilled',
  'adblock',
]);

/** How long a mocked ad "plays" off-portal, so the pause path is exercisable. */
export const MOCK_AD_MS = 800;

/**
 * A stand-in for the portal SDK, with the same call shape.
 *
 * Off-portal there is no `window.CrazyGames` at all, and the alternative to a
 * mock is an optional-chain at all thirty call sites — which reads as "this
 * might not be wired up" everywhere rather than "we are not on the portal" in
 * one place. The mock also makes the integration exercisable: a midgame ad on
 * localhost really does pause the simulation for MOCK_AD_MS and really does
 * mute the score, so the thing QA will look at is the thing that was tested.
 *
 * @param {Object} [options]
 * @param {number} [options.adMs] - How long a mocked ad runs for
 * @param {Object} [options.settings] - Initial platform settings
 * @returns {Object} An object shaped like `window.CrazyGames.SDK`
 */
export function createMockSdk({ adMs = MOCK_AD_MS, settings = {} } = {}) {
  const listeners = new Set();
  const authListeners = new Set();
  const state = { muteAudio: false, disableChat: false, ...settings };
  /** Every call the game made, in order — the seam the tests assert on. */
  const calls = [];
  const record = (name, ...args) => calls.push({ name, args });
  /**
   * The mock's cloud, which is a Map.
   *
   * Values are stored as strings the way the real module stores them, so a
   * caller that round-trips a number through the mock gets a string back
   * exactly as it would on the portal. Getting that wrong locally is how a
   * `=== 0` check ships broken.
   */
  const cloud = new Map();

  return {
    environment: 'local',
    calls,
    init: async () => record('init'),
    game: {
      settings: state,
      loadingStart: () => record('loadingStart'),
      loadingStop: () => record('loadingStop'),
      gameplayStart: () => record('gameplayStart'),
      gameplayStop: () => record('gameplayStop'),
      happytime: () => record('happytime'),
      addSettingsChangeListener: (fn) => listeners.add(fn),
      removeSettingsChangeListener: (fn) => listeners.delete(fn),
    },
    ad: {
      requestAd: (type, callbacks) => {
        record('requestAd', type);
        callbacks?.adStarted?.();
        setTimeout(() => callbacks?.adFinished?.(), adMs);
      },
    },
    /**
     * The Data module, mirroring `localStorage` exactly as the portal's does —
     * including returning `null`, not `undefined`, for an absent key.
     */
    data: {
      getItem: (key) => (cloud.has(key) ? cloud.get(key) : null),
      setItem: (key, value) => {
        cloud.set(key, String(value));
      },
      removeItem: (key) => {
        cloud.delete(key);
      },
      clear: () => cloud.clear(),
    },
    user: {
      isUserAccountAvailable: true,
      getUser: async () => null,
      addAuthListener: (fn) => authListeners.add(fn),
      removeAuthListener: (fn) => authListeners.delete(fn),
    },
    /** Test/dev hook: push a settings change the way the portal would. */
    emitSettingsChange(patch) {
      Object.assign(state, patch);
      for (const fn of [...listeners]) fn({ ...state });
    },
    /** Test/dev hook: pretend a guest just signed in. */
    emitAuthChange(user = { username: 'MockPilot' }) {
      for (const fn of [...authListeners]) fn(user);
    },
  };
}

/**
 * Read the live SDK off the window, if this page is inside the portal.
 *
 * `environment === 'disabled'` is the portal's way of saying "you are on
 * somebody else's domain and every call from here will throw". Treating that as
 * no SDK at all is what stops a sitelock-adjacent embed from taking the game
 * down with it.
 *
 * @returns {Object|null}
 */
export function getPortalSdk() {
  try {
    return asPortalSdk(globalThis.window?.CrazyGames?.SDK);
  } catch {
    return null;
  }
}

/**
 * Is this object a portal SDK we may actually call?
 *
 * The `disabled` environment is the check that matters. The portal reports it
 * on any domain that is not one of its own, where every SDK call throws — so an
 * SDK object is present, looks complete, and is a trap. Screened here rather
 * than at each call site so an injected SDK gets the same treatment as one
 * found on the window.
 *
 * @param {*} sdk
 * @returns {Object|null}
 */
function asPortalSdk(sdk) {
  if (!sdk || sdk.environment === 'disabled') return null;
  return sdk;
}

export class CrazyGamesService {
  /**
   * @param {Object} [options]
   * @param {Object|null} [options.sdk] - The SDK to drive. Defaults to the live
   *   one, falling back to a mock. Injected by tests.
   * @param {boolean} [options.useMock] - Force the mock even on the portal.
   *   Only ever true in a test.
   */
  constructor({ sdk, useMock = false } = {}) {
    /** @type {Object|null} A usable SDK object, or null when there is none. */
    this.portal = sdk !== undefined ? asPortalSdk(sdk) : getPortalSdk();
    /**
     * Whether what we are driving is the live portal.
     *
     * Separate from whether `this.sdk` exists, because `useMock` makes the two
     * diverge: an injected mock is a perfectly good thing to call, and is still
     * not the portal. Nothing branches on this except the environment getter —
     * it is there so the service cannot quietly report itself as live.
     */
    this.real = Boolean(this.portal) && !useMock;
    /**
     * @type {Object} Always present. An injected SDK is used as given — the
     * mock is synthesised only when there is nothing at all to talk to.
     */
    this.sdk = this.portal ?? createMockSdk();

    /** @type {boolean} Whether init() has completed. */
    this.ready = false;
    /**
     * @type {Promise<boolean>|null} The in-flight (or settled) init() call.
     * `whenReady()` awaits this rather than polling `this.ready`, and `init()`
     * itself is built on it too, so two overlapping `init()` calls share one
     * SDK handshake instead of racing it twice.
     */
    this.initPromise = null;
    /**
     * Calls to `SDK.game` methods made before init() has resolved.
     *
     * The real portal SDK does not buffer these itself — a `game.*` call made
     * before its own init promise settles throws `sdkNotInitialized`, and it
     * throws it from inside a method we do not control the internals of, which
     * is why a naive try/catch around the call site is not enough on its own:
     * the safest fix is to never make the call at all until init() is known to
     * have finished. `call()` queues here instead when `this.ready` is false,
     * and `init()` flushes the queue once it is safe to.
     * @type {string[]}
     */
    this.pendingCalls = [];
    /** @type {boolean} The gameplayStart/Stop latch. */
    this.inGameplay = false;
    /**
     * Whether the portal has forced audio off.
     *
     * Left at its safe default here rather than read from `this.sdk.game`
     * synchronously in the constructor: on the real SDK, `game` (or its
     * `settings` property) can itself throw `sdkNotInitialized` before init()
     * has resolved, and the constructor runs at MODULE IMPORT time — long
     * before anything has had a chance to await anything. The real value is
     * read safely in `init()`, once the SDK has actually said it is ready.
     * @type {boolean}
     */
    this.platformMuted = false;
    /** @type {Set<(muted: boolean) => void>} */
    this.muteListeners = new Set();
    /** @type {boolean} Guards against two ads being in flight at once. */
    this.adInFlight = false;

    this.onPlatformSettings = (next) => this.applyPlatformSettings(next);
  }

  /** @returns {string} 'crazygames' | 'local' | 'mock' */
  get environment() {
    if (!this.real) return 'mock';
    return this.sdk?.environment ?? 'crazygames';
  }

  /* ------------------------------------------------------------------ */
  /* Setup                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Initialise the SDK and subscribe to the platform settings.
   *
   * v3 requires an explicit, awaited `init()` before anything else works, and
   * the portal wants it done on the loading screen rather than at the first ad.
   * A failed init is NOT fatal: the service drops to the mock and the game
   * boots, because a portal outage must cost us the ads and not the game.
   *
   * @returns {Promise<boolean>} Whether the real SDK came up
   */
  /**
   * @returns {Promise<boolean>} Whether the real SDK is up. Safe to call any
   *   number of times, including concurrently — every caller shares the same
   *   underlying handshake rather than starting a second one.
   */
  init() {
    if (this.ready) return Promise.resolve(this.real);
    if (!this.initPromise) this.initPromise = this.#doInit();
    return this.initPromise;
  }

  /** The actual handshake. Only ever run once; `init()` is the public gate. */
  async #doInit() {
    try {
      await this.sdk?.init?.();
    } catch (error) {
      console.warn('[BloomWake] CrazyGames SDK init failed; running detached.', error);
      // Everything from here runs against the mock, so no later call can throw
      // on a half-initialised SDK.
      this.sdk = createMockSdk();
      this.real = false;
    }

    // ONLY NOW is `this.sdk.game`/`this.sdk.ad` safe to touch on the real
    // portal SDK. Ready flips before anything below reads it, and the queued
    // calls are flushed before subscribeToSettings — the very method that
    // asks the SDK to reach back into this class — is asked to do anything.
    this.ready = true;

    try {
      this.subscribeToSettings();
      // Read once after init as well as subscribing: a player who muted the
      // game from the portal chrome BEFORE we finished loading gets silence,
      // rather than one burst of music followed by the listener catching up.
      this.applyPlatformSettings(this.sdk?.game?.settings);
    } catch (error) {
      console.warn('[BloomWake] Reading initial CrazyGames settings failed.', error);
    }

    this.flushPendingCalls();
    return this.real;
  }

  /**
   * @returns {Promise<void>} Resolves once init() has settled — immediately if
   *   it already has. Used by anything that touches `SDK.ad` directly, which
   *   `call()`'s queue does not cover.
   */
  async whenReady() {
    if (this.ready) return;
    await this.init();
  }

  /** Run every `game.*` call that arrived before init() resolved, in order. */
  flushPendingCalls() {
    const queued = this.pendingCalls.splice(0);
    for (const method of queued) this.invoke(method);
  }

  /** Attach the platform settings listener. */
  subscribeToSettings() {
    try {
      this.sdk?.game?.addSettingsChangeListener?.(this.onPlatformSettings);
    } catch (error) {
      console.warn('[BloomWake] Could not subscribe to portal settings.', error);
    }
  }

  /**
   * Fold a settings payload in and tell the audio layer if mute moved.
   *
   * Only `muteAudio` is acted on. `disableChat` is read and ignored on purpose:
   * the game has no chat, and a listener that pretended to handle a setting it
   * does not implement is worse than one that visibly does not.
   *
   * @param {Object} [next]
   */
  applyPlatformSettings(next) {
    const muted = Boolean(next?.muteAudio);
    if (muted === this.platformMuted) return;
    this.platformMuted = muted;
    for (const listener of [...this.muteListeners]) {
      try {
        listener(muted);
      } catch (error) {
        console.error('[BloomWake] Platform mute listener threw.', error);
      }
    }
  }

  /**
   * Listen for the portal forcing audio on or off.
   *
   * @param {(muted: boolean) => void} listener
   * @returns {() => void} Unsubscribe
   */
  onMuteChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('Mute listener must be a function');
    this.muteListeners.add(listener);
    return () => this.muteListeners.delete(listener);
  }

  /** @returns {boolean} Whether the PORTAL — not the player — wants silence. */
  isPlatformMuted() {
    return this.platformMuted;
  }

  /* ------------------------------------------------------------------ */
  /* Data module and account                                             */
  /* ------------------------------------------------------------------ */

  /**
   * @returns {boolean} Whether `init()` has settled.
   *
   * The storage service gates its cloud driver on this. It is the difference
   * between `SDK.data` existing (it does, from the moment the script tag
   * evaluates) and `SDK.data` being SAFE TO CALL (only after the handshake),
   * and confusing the two is exactly the `sdkNotInitialized` class of bug.
   */
  isInitialized() {
    return this.ready;
  }

  /**
   * The Data module, or null when there is not one to use.
   *
   * Null before init for the reason above, and null when the module is absent
   * — which is a real state even on the portal: the Data module is switched on
   * per-game by a toggle in the submission flow, and a game whose toggle is off
   * gets a `dataModuleDisabled` error from every call. Returning null lets the
   * storage service pick its next driver instead of discovering that one write
   * at a time.
   *
   * @returns {Object|null}
   */
  getDataModule() {
    if (!this.ready) return null;
    /*
     * The mock's Data module is NOT a cloud, and must never be mistaken for
     * one. It is a Map that dies with the page, so a storage layer that
     * adopted it would report itself as cloud-backed while quietly losing
     * everything on reload — and would mask the fact that localStorage is the
     * real save off-portal.
     *
     * `real` is the right test rather than `environment === 'crazygames'`:
     * with the SDK script loaded on localhost the portal hands back a genuine
     * module that writes to localStorage itself, which is exactly the
     * behaviour we want to be exercising there.
     */
    if (!this.real) return null;
    try {
      const data = this.sdk?.data;
      // Shape-checked rather than truth-checked: a partially-shipped module
      // with a getItem and no setItem would be worse than no module at all,
      // because progress would read back fine until the tab closed.
      if (typeof data?.getItem !== 'function' || typeof data?.setItem !== 'function') {
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  /** @returns {boolean} Whether cloud saves are available right now. */
  hasDataModule() {
    return this.getDataModule() !== null;
  }

  /**
   * Listen for a guest signing in part-way through a session.
   *
   * The portal fires this on LOGIN only; a logout reloads the whole page, so
   * there is no matching teardown to handle. What matters to us is that the
   * Data module silently swaps which account's saves it is reading at that
   * moment — so anything already hydrated into memory is now stale, and the
   * listener is the only warning we get.
   *
   * @param {(user: Object|null) => void} listener
   * @returns {() => void} Unsubscribe. A no-op when there is no user module.
   */
  onAuthChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('Auth listener must be a function');
    try {
      const user = this.sdk?.user;
      if (typeof user?.addAuthListener !== 'function') return () => {};
      user.addAuthListener(listener);
      return () => {
        try {
          user.removeAuthListener?.(listener);
        } catch {
          // A torn-down SDK; nothing left to detach from.
        }
      };
    } catch (error) {
      console.warn('[BloomWake] Could not subscribe to CrazyGames auth.', error);
      return () => {};
    }
  }

  /* ------------------------------------------------------------------ */
  /* Telemetry                                                           */
  /* ------------------------------------------------------------------ */

  /** Loading has begun. Called before anything is awaited. */
  loadingStart() {
    this.call('loadingStart');
  }

  /** Everything needed to play is resident. */
  loadingStop() {
    this.call('loadingStop');
  }

  /**
   * The player is now playing.
   *
   * Latched: a second start with no stop between is dropped. The first call the
   * portal ever sees is what it measures our initial download against, and
   * every call after that is half of a playtime interval — neither of which
   * survives being fired twice by an unpause of a run that was not paused.
   *
   * @returns {boolean} Whether this actually transitioned
   */
  gameplayStart() {
    if (this.inGameplay) return false;
    this.inGameplay = true;
    this.call('gameplayStart');
    return true;
  }

  /**
   * Gameplay has broken off: a pause, a death, a forfeit.
   *
   * Deliberately NOT called on window blur. The portal detects a game losing
   * focus inside its own iframe and handles it, and a second stop from us would
   * be an unmatched one.
   *
   * @returns {boolean} Whether this actually transitioned
   */
  gameplayStop() {
    if (!this.inGameplay) return false;
    this.inGameplay = false;
    this.call('gameplayStop');
    return true;
  }

  /**
   * Ask the portal for a site-wide celebration.
   *
   * Rationed hard by policy — the portal asks for milestones, not events, so
   * this is wired to exactly two things (a first Hive Cruiser kill in a run, a
   * legendary chip out of a crate) and nothing that happens every wave.
   */
  happyTime() {
    this.call('happytime');
  }

  /**
   * Call a `game` module method, swallowing anything it throws.
   *
   * Telemetry is the lowest-value thing in the frame and lives on the far side
   * of an iframe boundary we do not own. Nothing here is ever worth an
   * exception reaching the caller.
   *
   * @param {string} method
   */
  call(method) {
    // Deferred, not dropped: a `loadingStart` that fired a tick too early must
    // still reach the SDK once it is safe to, or the portal's load-time
    // measurement starts from whenever init() happened to finish instead of
    // from the real beginning of the load.
    if (!this.ready) {
      this.pendingCalls.push(method);
      return;
    }
    this.invoke(method);
  }

  /** The actual SDK call, only ever reached once `this.ready` is true. */
  invoke(method) {
    try {
      this.sdk?.game?.[method]?.();
    } catch (error) {
      console.warn('[BloomWake] CrazyGames ' + method + '() failed.', error);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Ads                                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Request a video ad.
   *
   * THE CALLBACK ORDER IS THE CONTRACT, and it is not the same as the SDK's:
   *
   *   `adRequested` fires synchronously, before the network is touched. This is
   *     where the simulation is frozen and the UI blocked, because an ad
   *     request runs several auctions and can take seconds — a player who can
   *     still steer and still take damage during that is being hit by something
   *     they cannot see.
   *   `adStarted` fires when the ad's own audio does. Muting HERE rather than
   *     at request time is what the portal asks for, and it means a request
   *     that never fills never silences the game.
   *   `adFinished` / `adError` — exactly one of them, exactly once. Both must
   *     unmute and unfreeze; only `adFinished` may pay out.
   *
   * Never rejects, and never resolves ok for an ad that did not play.
   *
   * @param {string} type - One of AD_TYPES
   * @param {Object} [callbacks]
   * @param {() => void} [callbacks.adRequested]
   * @param {() => void} [callbacks.adStarted]
   * @param {() => void} [callbacks.adFinished]
   * @param {(code: string) => void} [callbacks.adError]
   * @returns {Promise<{ok: boolean, reason: string, code?: string}>}
   */
  requestAd(type, callbacks = {}) {
    // `SDK.ad.requestAd` is exactly as intolerant of a pre-init call as
    // `SDK.game.*` is. In practice nothing calls this before init() has long
    // since resolved — an ad needs a run to have happened first — but the
    // deferral costs nothing and closes the same class of race `call()`
    // guards against for the game module.
    if (!this.ready) {
      return this.whenReady().then(() => this.requestAd(type, callbacks));
    }

    const fire = (name, arg) => {
      try {
        callbacks[name]?.(arg);
      } catch (error) {
        // A listener bug must not fail an ad the player actually watched, nor
        // strand the game paused behind one that failed.
        console.warn('[BloomWake] Ad callback ' + name + ' threw.', error);
      }
    };

    // One ad at a time. Two in flight would double-pause and, worse, leave the
    // second one's adFinished unmuting a game the first has not finished with.
    if (this.adInFlight) {
      return Promise.resolve({ ok: false, reason: AD_RESULTS.UNAVAILABLE, code: 'adInFlight' });
    }

    const adModule = this.sdk?.ad;
    if (typeof adModule?.requestAd !== 'function') {
      return Promise.resolve({ ok: false, reason: AD_RESULTS.NO_SDK });
    }

    this.adInFlight = true;
    fire('adRequested');

    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        this.adInFlight = false;
        resolve(outcome);
      };

      try {
        adModule.requestAd(type, {
          adStarted: () => {
            if (!settled) fire('adStarted');
          },
          adFinished: () => {
            if (settled) return;
            fire('adFinished');
            settle({ ok: true, reason: AD_RESULTS.OK });
          },
          adError: (error) => {
            if (settled) return;
            const code = readAdCode(error);
            if (!QUIET_AD_CODES.has(code)) {
              console.info('[BloomWake] ' + type + ' ad not shown: ' + (code || 'unknown'));
            }
            // The player is never rewarded here, and the caller is never handed
            // a shape it could mistake for a payout.
            fire('adError', code);
            settle({ ok: false, reason: classifyAdError(error), code });
          },
        });
      } catch (error) {
        console.warn('[BloomWake] Ad request threw.', error);
        fire('adError', 'threw');
        settle({ ok: false, reason: AD_RESULTS.ERROR, code: 'threw' });
      }
    });
  }

  /**
   * A midgame interstitial at a break the player was already taking.
   *
   * No cooldown of our own. The portal enforces one ad every three minutes and
   * silently ignores anything asked for sooner, so inventing a second timer
   * here could only ever make us ask LESS often than the platform allows — and
   * would be a second set of rules to keep in step with theirs.
   *
   * @param {Object} [callbacks] - As requestAd
   * @returns {Promise<{ok: boolean, reason: string, code?: string}>}
   */
  requestMidgameAd(callbacks) {
    return this.requestAd(AD_TYPES.MIDGAME, callbacks);
  }

  /** Tear down listeners. Used by tests and hot reload, not by the game. */
  dispose() {
    try {
      this.sdk?.game?.removeSettingsChangeListener?.(this.onPlatformSettings);
    } catch {
      // A mock that was already discarded; nothing to detach from.
    }
    this.muteListeners.clear();
  }
}

/**
 * Best-effort read of an SDK error's `code`.
 *
 * Separate from classifyAdError because the two answer different questions:
 * that one asks "does the player get paid" (no), this one asks "what do we log
 * and is it worth logging", and the portal's documented codes — `adCooldown`,
 * `unfilled` — are meaningful to us verbatim.
 *
 * @param {*} error
 * @returns {string} The raw code, or '' when there is nothing readable
 */
export function readAdCode(error) {
  try {
    const code = error?.code ?? error;
    return typeof code === 'string' ? code : '';
  } catch {
    return '';
  }
}

/**
 * The game's one service instance.
 *
 * Constructed at import time, which is safe because the constructor only reads
 * `window` behind a try and never calls the SDK. Nothing works until `init()`
 * has been awaited in the bootloader.
 */
export const crazyGames = new CrazyGamesService();
