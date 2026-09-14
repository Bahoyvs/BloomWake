/**
 * CrazyGames adapter tests.
 *
 * The SDK is injected rather than stubbed onto a global, so these run in plain
 * Node with no portal, no window and no timers faked. The whole point of the
 * module is that it never rejects and never lies about a reward, so most of
 * what follows is failure paths.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AD_RESULTS,
  AD_TYPES,
  CrazyGamesService,
  EMULATED_AD_MS,
  QUIET_AD_CODES,
  classifyAdError,
  createMockSdk,
  getAdSdk,
  getPortalSdk,
  isAdAvailable,
  readAdCode,
  requestRewardedAd,
} from '../src/services/crazygames.js';

/** An SDK that drives the callback the portal would fire. */
function fakeSdk(behaviour) {
  return {
    requestAd: vi.fn((type, callbacks) => behaviour(type, callbacks)),
  };
}

describe('SDK detection', () => {
  it('reports no SDK when the page is not on the portal', () => {
    // Node has no window; the accessor must answer null rather than throw.
    expect(getAdSdk()).toBeNull();
    expect(isAdAvailable()).toBe(false);
  });
});

describe('Requesting a rewarded ad', () => {
  it('resolves ok when the ad plays to the end', async () => {
    const sdk = fakeSdk((type, cb) => cb.adFinished());
    const outcome = await requestRewardedAd({ sdk });

    expect(outcome).toEqual({ ok: true, reason: AD_RESULTS.OK });
    expect(sdk.requestAd).toHaveBeenCalledWith('rewarded', expect.any(Object));
  });

  it('resolves not-ok when the player dismisses it', async () => {
    const sdk = fakeSdk((type, cb) => cb.adError({ code: 'userDismissed' }));
    const outcome = await requestRewardedAd({ sdk });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(AD_RESULTS.DISMISSED);
  });

  it('resolves not-ok when there is no fill', async () => {
    const sdk = fakeSdk((type, cb) => cb.adError({ code: 'unfilled' }));
    expect((await requestRewardedAd({ sdk })).reason).toBe(AD_RESULTS.UNAVAILABLE);
  });

  it('never rejects when the SDK throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sdk = fakeSdk(() => {
      throw new Error('SDK exploded');
    });

    const outcome = await requestRewardedAd({ sdk });
    expect(outcome).toEqual({ ok: false, reason: AD_RESULTS.ERROR });
    warn.mockRestore();
  });

  it('pays out only once when the SDK fires two callbacks', async () => {
    // A late network failure after a completed view is a real integration bug;
    // paying the reward twice for it would be a dupe.
    const sdk = fakeSdk((type, cb) => {
      cb.adFinished();
      cb.adError({ code: 'network' });
    });

    expect(await requestRewardedAd({ sdk })).toEqual({ ok: true, reason: AD_RESULTS.OK });
  });

  it('does not pay out when an error arrives before a late finish', async () => {
    const sdk = fakeSdk((type, cb) => {
      cb.adError({ code: 'userDismissed' });
      cb.adFinished();
    });

    expect((await requestRewardedAd({ sdk })).ok).toBe(false);
  });

  it('reports NO_SDK off-portal when emulation is off', async () => {
    const outcome = await requestRewardedAd({ sdk: null, emulate: false });
    expect(outcome).toEqual({ ok: false, reason: AD_RESULTS.NO_SDK });
  });

  it('emulates a successful ad in development', async () => {
    const started = Date.now();
    const outcome = await requestRewardedAd({ sdk: null, emulate: true, emulatedMs: 20 });

    expect(outcome).toMatchObject({ ok: true, reason: AD_RESULTS.OK, emulated: true });
    // The wait is real, so the pending state is actually exercisable by hand.
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('flags an emulated payout so it can never be mistaken for a real one', async () => {
    const real = await requestRewardedAd({ sdk: fakeSdk((t, cb) => cb.adFinished()) });
    expect(real.emulated).toBeUndefined();
  });

  it('waits a beat by default, rather than resolving instantly', () => {
    expect(EMULATED_AD_MS).toBeGreaterThanOrEqual(1000);
  });

  it('treats a half-initialised SDK as no SDK', async () => {
    // The object exists but `requestAd` has not been attached yet — a real
    // state on a slow connection, and one that would throw if called.
    const outcome = await requestRewardedAd({ sdk: {}, emulate: false });
    expect(outcome.reason).toBe(AD_RESULTS.NO_SDK);
  });
});

describe('Ad phase reporting', () => {
  it('brackets a real ad with started and finished', async () => {
    const phases = [];
    await requestRewardedAd({
      sdk: fakeSdk((type, cb) => cb.adFinished()),
      onPhase: (phase) => phases.push(phase),
    });

    expect(phases).toEqual(['started', 'finished']);
  });

  it('still reports finished when the ad fails', async () => {
    const phases = [];
    await requestRewardedAd({
      sdk: fakeSdk((type, cb) => cb.adError({ code: 'unfilled' })),
      onPhase: (phase) => phases.push(phase),
    });

    // A caller that paused the game on 'started' must be resumed on every
    // path, or a failed ad leaves the game frozen behind the debrief.
    expect(phases).toEqual(['started', 'finished']);
  });

  it('does not fail an ad the player watched because a listener threw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outcome = await requestRewardedAd({
      sdk: fakeSdk((type, cb) => cb.adFinished()),
      onPhase: () => {
        throw new Error('listener bug');
      },
    });

    expect(outcome.ok).toBe(true);
    warn.mockRestore();
  });
});

describe('Error classification', () => {
  it('recognises the ways a player backs out', () => {
    expect(classifyAdError({ code: 'userDismissed' })).toBe(AD_RESULTS.DISMISSED);
    expect(classifyAdError({ code: 'CANCELLED' })).toBe(AD_RESULTS.DISMISSED);
    expect(classifyAdError('skipped')).toBe(AD_RESULTS.DISMISSED);
  });

  it('falls back to unavailable for anything it cannot read', () => {
    expect(classifyAdError(undefined)).toBe(AD_RESULTS.UNAVAILABLE);
    expect(classifyAdError({})).toBe(AD_RESULTS.UNAVAILABLE);
    expect(classifyAdError({ weird: true })).toBe(AD_RESULTS.UNAVAILABLE);
  });

  it('never throws on a hostile payload', () => {
    expect(() => classifyAdError(Object.create(null))).not.toThrow();
    expect(() => classifyAdError(null)).not.toThrow();
  });
});

/* ========================================================================== */
/* SDK v3 — init, telemetry, platform settings, midgame ads                   */
/* ========================================================================== */

/**
 * A recording SDK with the v3 shape.
 *
 * Built here rather than reusing `createMockSdk` for the cases where the point
 * of the test is a BADLY behaved SDK — one that throws from init, fires two
 * callbacks, or never answers at all. The production mock is well-behaved by
 * construction, which is exactly what makes it useless for those.
 *
 * @param {Object} [options]
 * @param {(type: string, callbacks: Object) => void} [options.onRequestAd]
 */
function recordingSdk({ onRequestAd, initThrows = false, settings = {} } = {}) {
  const calls = [];
  const listeners = new Set();
  const state = { muteAudio: false, disableChat: false, ...settings };

  return {
    environment: 'crazygames',
    calls,
    listeners,
    init: async () => {
      calls.push('init');
      if (initThrows) throw new Error('SDK refused to initialise');
    },
    game: {
      settings: state,
      loadingStart: () => calls.push('loadingStart'),
      loadingStop: () => calls.push('loadingStop'),
      gameplayStart: () => calls.push('gameplayStart'),
      gameplayStop: () => calls.push('gameplayStop'),
      happytime: () => calls.push('happytime'),
      addSettingsChangeListener: (fn) => listeners.add(fn),
      removeSettingsChangeListener: (fn) => listeners.delete(fn),
    },
    ad: {
      requestAd: (type, callbacks) => {
        calls.push('requestAd:' + type);
        onRequestAd?.(type, callbacks);
      },
    },
    /** Push a settings change the way the portal would. */
    push(patch) {
      Object.assign(state, patch);
      for (const fn of [...listeners]) fn({ ...state });
    },
  };
}

/** A service wired to a recording SDK, already initialised. */
async function service(options) {
  const sdk = recordingSdk(options);
  const cg = new CrazyGamesService({ sdk });
  await cg.init();
  return { sdk, cg };
}

describe('SDK initialisation', () => {
  it('awaits the portal init before anything else is usable', async () => {
    const { sdk, cg } = await service();

    expect(sdk.calls[0]).toBe('init');
    expect(cg.ready).toBe(true);
    expect(cg.environment).toBe('crazygames');
  });

  it('falls back to a mock when the portal init throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cg } = await service({ initThrows: true });

    // The whole point: a portal outage costs the ads, not the game. Every
    // lifecycle call still has somewhere to go.
    expect(cg.ready).toBe(true);
    expect(cg.environment).toBe('mock');
    expect(() => cg.gameplayStart()).not.toThrow();
    warn.mockRestore();
  });

  it('runs on a mock off-portal, with no window at all', async () => {
    // Plain Node: getPortalSdk() finds nothing and must not throw reaching for
    // it. This is the environment the tests and every local dev run live in.
    expect(getPortalSdk()).toBeNull();

    const cg = new CrazyGamesService();
    await cg.init();

    expect(cg.environment).toBe('mock');
    expect(cg.gameplayStart()).toBe(true);
    expect(cg.sdk.calls.map((c) => c.name)).toContain('gameplayStart');
  });

  it('treats a disabled environment as no portal', () => {
    // The portal reports `disabled` on domains that are not its own, where
    // every SDK call throws. Using it would take the game down with it.
    const cg = new CrazyGamesService({ sdk: { environment: 'disabled' } });
    expect(cg.environment).toBe('mock');
  });

  it('is safe to init twice', async () => {
    const { sdk, cg } = await service();
    await cg.init();

    expect(sdk.calls.filter((c) => c === 'init')).toHaveLength(1);
  });

  it('shares one handshake across overlapping init() calls', async () => {
    // Two callers awaiting init() concurrently (boot() and, say, a stray
    // early SDK-dependent read) must not start the portal handshake twice.
    const sdk = recordingSdk();
    const cg = new CrazyGamesService({ sdk });

    const [a, b] = await Promise.all([cg.init(), cg.init()]);

    expect(a).toBe(b);
    expect(sdk.calls.filter((c) => c === 'init')).toHaveLength(1);
  });

  it('never touches SDK.game before init() has resolved', () => {
    // The real bug this whole gate exists for: `t.GeneralError:
    // sdkNotInitialized`. Reproduced here with an SDK whose `game` getter
    // throws exactly the way the portal's does before its own init promise
    // settles — the CONSTRUCTOR must not trip it, because it runs at module
    // import time, long before anything has awaited anything.
    let initialised = false;
    const sdk = {
      environment: 'crazygames',
      init: async () => {
        initialised = true;
      },
      get game() {
        if (!initialised) {
          throw new Error('sdkNotInitialized: CrazySDK is not initialized yet.');
        }
        return { settings: {}, addSettingsChangeListener: () => {} };
      },
    };

    expect(() => new CrazyGamesService({ sdk })).not.toThrow();
  });

  it('defers every game-module call made before init() resolves', async () => {
    // A call site that fires too early (the historical bug: `loadingStart()`
    // at module top level, before `await init()`) must reach the SDK once it
    // is safe to, rather than throwing or being silently dropped.
    let initialised = false;
    const calls = [];
    const sdk = {
      environment: 'crazygames',
      init: async () => {
        initialised = true;
      },
      get game() {
        if (!initialised) {
          throw new Error('sdkNotInitialized: CrazySDK is not initialized yet.');
        }
        return {
          settings: {},
          addSettingsChangeListener: () => {},
          loadingStart: () => calls.push('loadingStart'),
          gameplayStart: () => calls.push('gameplayStart'),
        };
      },
    };
    const cg = new CrazyGamesService({ sdk });

    // Called before init() — must not throw, and must not reach the SDK yet.
    expect(() => cg.loadingStart()).not.toThrow();
    expect(() => cg.gameplayStart()).not.toThrow();
    expect(calls).toEqual([]);

    await cg.init();

    // Flushed in the order they were made, once it is actually safe to.
    expect(calls).toEqual(['loadingStart', 'gameplayStart']);
  });

  it('offers no Data module before init(), whatever the SDK looks like', async () => {
    const sdk = recordingSdk();
    sdk.data = { getItem: () => null, setItem: () => {} };
    const cg = new CrazyGamesService({ sdk });

    // Same trap as `SDK.game`: the object exists from the moment the script
    // tag evaluates and is not callable until the handshake lands.
    expect(cg.getDataModule()).toBeNull();
    expect(cg.hasDataModule()).toBe(false);

    await cg.init();
    expect(cg.hasDataModule()).toBe(true);
  });

  it('never presents the mock Data module as a real one', async () => {
    // Off-portal the fallback mock has a `data` module so the SDK surface is
    // complete — but it is a Map that dies with the page. A storage layer that
    // adopted it would report itself as cloud-backed and lose everything on
    // reload, while masking the fact that localStorage is the real save here.
    const cg = new CrazyGamesService({ sdk: null });
    await cg.init();

    expect(cg.environment).toBe('mock');
    expect(cg.getDataModule()).toBeNull();
  });

  it('defers a pre-init ad request until the SDK is ready', async () => {
    let initialised = false;
    const sdk = {
      environment: 'crazygames',
      init: async () => {
        initialised = true;
      },
      get game() {
        return { settings: {}, addSettingsChangeListener: () => {} };
      },
      get ad() {
        if (!initialised) {
          throw new Error('sdkNotInitialized: CrazySDK is not initialized yet.');
        }
        return {
          requestAd: (type, cb) => cb.adFinished(),
        };
      },
    };
    const cg = new CrazyGamesService({ sdk });

    const pending = cg.requestAd(AD_TYPES.MIDGAME, {});
    await cg.init();

    expect(await pending).toEqual({ ok: true, reason: AD_RESULTS.OK });
  });
});

describe('Loading telemetry', () => {
  it('reports the load window to the portal', async () => {
    const { sdk, cg } = await service();
    cg.loadingStart();
    cg.loadingStop();

    expect(sdk.calls).toContain('loadingStart');
    expect(sdk.calls).toContain('loadingStop');
  });

  it('never lets a broken SDK method reach the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sdk = recordingSdk();
    sdk.game.loadingStop = () => {
      throw new Error('SDK exploded');
    };
    const cg = new CrazyGamesService({ sdk });
    await cg.init();

    expect(() => cg.loadingStop()).not.toThrow();
    warn.mockRestore();
  });
});

describe('Gameplay lifecycle', () => {
  it('reports a start when a run begins', async () => {
    const { sdk, cg } = await service();

    expect(cg.gameplayStart()).toBe(true);
    expect(cg.inGameplay).toBe(true);
    expect(sdk.calls).toContain('gameplayStart');
  });

  it('reports a stop when gameplay breaks off', async () => {
    const { sdk, cg } = await service();
    cg.gameplayStart();

    expect(cg.gameplayStop()).toBe(true);
    expect(cg.inGameplay).toBe(false);
    expect(sdk.calls.filter((c) => c === 'gameplayStop')).toHaveLength(1);
  });

  it('refuses a second start with no stop between', async () => {
    // The portal measures our initial download from the FIRST start and pairs
    // starts with stops for playtime. A duplicate is a wrong number on the
    // dashboard, not a harmless no-op.
    const { sdk, cg } = await service();

    expect(cg.gameplayStart()).toBe(true);
    expect(cg.gameplayStart()).toBe(false);
    expect(sdk.calls.filter((c) => c === 'gameplayStart')).toHaveLength(1);
  });

  it('refuses a stop when gameplay was never running', async () => {
    const { sdk, cg } = await service();

    expect(cg.gameplayStop()).toBe(false);
    expect(sdk.calls).not.toContain('gameplayStop');
  });

  it('cycles start and stop across a pause and a resume', async () => {
    const { sdk, cg } = await service();

    cg.gameplayStart(); // launch
    cg.gameplayStop(); // pause
    cg.gameplayStart(); // resume
    cg.gameplayStop(); // death

    expect(sdk.calls.filter((c) => c.startsWith('gameplay'))).toEqual([
      'gameplayStart',
      'gameplayStop',
      'gameplayStart',
      'gameplayStop',
    ]);
  });

  it('asks for a celebration only when told to', async () => {
    const { sdk, cg } = await service();
    expect(sdk.calls).not.toContain('happytime');

    cg.happyTime();
    expect(sdk.calls.filter((c) => c === 'happytime')).toHaveLength(1);
  });
});

describe('Platform settings', () => {
  it('reads muteAudio that was already set before we loaded', async () => {
    const { cg } = await service({ settings: { muteAudio: true } });
    expect(cg.isPlatformMuted()).toBe(true);
  });

  it('tells listeners when the portal mutes the game', async () => {
    const seen = [];
    const { sdk, cg } = await service();
    cg.onMuteChange((muted) => seen.push(muted));

    sdk.push({ muteAudio: true });
    expect(seen).toEqual([true]);
    expect(cg.isPlatformMuted()).toBe(true);
  });

  it('tells listeners when the portal un-mutes again', async () => {
    const seen = [];
    const { sdk, cg } = await service({ settings: { muteAudio: true } });
    cg.onMuteChange((muted) => seen.push(muted));

    sdk.push({ muteAudio: false });
    expect(seen).toEqual([false]);
    expect(cg.isPlatformMuted()).toBe(false);
  });

  it('does not re-announce a setting that did not move', async () => {
    // The portal pushes the WHOLE settings object on any change, including
    // changes to settings this game does not implement. Re-applying mute on
    // each of those would fight the audio manager for no reason.
    const seen = [];
    const { sdk, cg } = await service();
    cg.onMuteChange((muted) => seen.push(muted));

    sdk.push({ disableChat: true });
    sdk.push({ muteAudio: false });
    expect(seen).toEqual([]);
  });

  it('unsubscribes cleanly', async () => {
    const seen = [];
    const { sdk, cg } = await service();
    const off = cg.onMuteChange((muted) => seen.push(muted));
    off();

    sdk.push({ muteAudio: true });
    expect(seen).toEqual([]);
  });

  it('keeps notifying the other listeners when one throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen = [];
    const { sdk, cg } = await service();
    cg.onMuteChange(() => {
      throw new Error('listener bug');
    });
    cg.onMuteChange((muted) => seen.push(muted));

    sdk.push({ muteAudio: true });
    expect(seen).toEqual([true]);
    error.mockRestore();
  });
});

describe('Video ads through the service', () => {
  it('runs a midgame ad through the full callback sequence', async () => {
    const phases = [];
    const { sdk, cg } = await service({
      onRequestAd: (type, cb) => {
        cb.adStarted();
        cb.adFinished();
      },
    });

    const outcome = await cg.requestMidgameAd({
      adRequested: () => phases.push('requested'),
      adStarted: () => phases.push('started'),
      adFinished: () => phases.push('finished'),
      adError: () => phases.push('error'),
    });

    expect(outcome).toEqual({ ok: true, reason: AD_RESULTS.OK });
    expect(sdk.calls).toContain('requestAd:midgame');
    expect(phases).toEqual(['requested', 'started', 'finished']);
  });

  it('asks for the rewarded format when that is what was requested', async () => {
    const { sdk, cg } = await service({ onRequestAd: (type, cb) => cb.adFinished() });
    await cg.requestAd(AD_TYPES.REWARDED, {});

    expect(sdk.calls).toContain('requestAd:rewarded');
  });

  it('blocks the UI before the network is touched, not after', async () => {
    // The request runs several auctions and can take seconds. A player who can
    // still act during that is being hit by something they cannot see.
    const order = [];
    const { cg } = await service({
      onRequestAd: (type, cb) => {
        order.push('sdk-called');
        cb.adFinished();
      },
    });

    await cg.requestAd(AD_TYPES.MIDGAME, {
      adRequested: () => order.push('requested'),
    });
    expect(order).toEqual(['requested', 'sdk-called']);
  });

  it('does not mute the game for a request that never fills', async () => {
    // adStarted is the portal's "the ad's own audio is playing now" signal.
    // Muting at request time would silence a game for an ad that never came.
    const phases = [];
    const { cg } = await service({
      onRequestAd: (type, cb) => cb.adError({ code: 'unfilled' }),
    });

    await cg.requestAd(AD_TYPES.MIDGAME, {
      adRequested: () => phases.push('requested'),
      adStarted: () => phases.push('started'),
      adError: () => phases.push('error'),
    });

    expect(phases).toEqual(['requested', 'error']);
  });

  it('never rewards the player when a rewarded ad errors', async () => {
    let rewarded = false;
    const { cg } = await service({
      onRequestAd: (type, cb) => cb.adError({ code: 'unfilled' }),
    });

    const outcome = await cg.requestAd(AD_TYPES.REWARDED, {
      adFinished: () => {
        rewarded = true;
      },
    });

    // Both halves matter: the payout callback must not run, AND the resolved
    // value must not be something a caller could mistake for a payout.
    expect(rewarded).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(AD_RESULTS.UNAVAILABLE);
  });

  it('does not reward when the player dismisses a rewarded ad', async () => {
    const { cg } = await service({
      onRequestAd: (type, cb) => cb.adError({ code: 'userDismissed' }),
    });

    const outcome = await cg.requestAd(AD_TYPES.REWARDED, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(AD_RESULTS.DISMISSED);
  });

  it('reports the portal error code alongside the verdict', async () => {
    const { cg } = await service({
      onRequestAd: (type, cb) => cb.adError({ code: 'adCooldown' }),
    });

    const outcome = await cg.requestAd(AD_TYPES.MIDGAME, {});
    expect(outcome.code).toBe('adCooldown');
  });

  it('stays quiet about the errors that are the SDK doing its job', async () => {
    // adCooldown and adsDisabledBasicLaunch happen constantly and by design.
    // Logging them would bury the errors that mean something.
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { cg } = await service({
      onRequestAd: (type, cb) => cb.adError({ code: 'adCooldown' }),
    });

    await cg.requestAd(AD_TYPES.MIDGAME, {});
    expect(info).not.toHaveBeenCalled();
    expect([...QUIET_AD_CODES]).toContain('adsDisabledBasicLaunch');
    info.mockRestore();
  });

  it('resolves exactly once when the SDK fires two callbacks', async () => {
    const phases = [];
    const { cg } = await service({
      onRequestAd: (type, cb) => {
        cb.adStarted();
        cb.adFinished();
        cb.adError({ code: 'network' });
      },
    });

    const outcome = await cg.requestAd(AD_TYPES.MIDGAME, {
      adFinished: () => phases.push('finished'),
      adError: () => phases.push('error'),
    });

    expect(outcome.ok).toBe(true);
    expect(phases).toEqual(['finished']);
  });

  it('unblocks the game when the SDK throws on request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const phases = [];
    const { cg } = await service({
      onRequestAd: () => {
        throw new Error('SDK exploded');
      },
    });

    const outcome = await cg.requestAd(AD_TYPES.MIDGAME, {
      adRequested: () => phases.push('requested'),
      adError: () => phases.push('error'),
    });

    // The error callback is where the caller unmutes and un-pauses. Skipping it
    // here would leave the game frozen behind an ad that never appeared.
    expect(phases).toEqual(['requested', 'error']);
    expect(outcome).toMatchObject({ ok: false, reason: AD_RESULTS.ERROR });
    warn.mockRestore();
  });

  it('does not strand the game when a callback throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cg } = await service({
      onRequestAd: (type, cb) => {
        cb.adStarted();
        cb.adFinished();
      },
    });

    const outcome = await cg.requestAd(AD_TYPES.MIDGAME, {
      adStarted: () => {
        throw new Error('listener bug');
      },
    });

    expect(outcome.ok).toBe(true);
    expect(cg.adInFlight).toBe(false);
    warn.mockRestore();
  });

  it('refuses a second ad while one is still on screen', async () => {
    let release;
    const { cg } = await service({
      onRequestAd: (type, cb) => {
        release = () => cb.adFinished();
      },
    });

    const first = cg.requestAd(AD_TYPES.MIDGAME, {});
    const second = await cg.requestAd(AD_TYPES.MIDGAME, {});

    // The second one's adFinished would otherwise unmute a game the first has
    // not finished with.
    expect(second).toMatchObject({ ok: false, code: 'adInFlight' });

    release();
    expect((await first).ok).toBe(true);
    // And the guard clears, so the next break can carry an ad.
    expect(cg.adInFlight).toBe(false);
  });

  it('reports NO_SDK rather than throwing when the ad module is missing', async () => {
    // A half-initialised SDK on a slow connection: the object is there, the ad
    // namespace is not.
    const sdk = recordingSdk();
    delete sdk.ad.requestAd;
    const cg = new CrazyGamesService({ sdk });
    await cg.init();

    expect(await cg.requestAd(AD_TYPES.MIDGAME, {})).toEqual({
      ok: false,
      reason: AD_RESULTS.NO_SDK,
    });
  });
});

describe('The development mock', () => {
  it('plays an ad through to the end so the pause path is exercisable', async () => {
    const sdk = createMockSdk({ adMs: 5 });
    const cg = new CrazyGamesService({ sdk, useMock: true });
    await cg.init();

    const phases = [];
    const outcome = await cg.requestMidgameAd({
      adRequested: () => phases.push('requested'),
      adStarted: () => phases.push('started'),
      adFinished: () => phases.push('finished'),
    });

    expect(outcome.ok).toBe(true);
    expect(phases).toEqual(['requested', 'started', 'finished']);
  });

  it('can push a settings change the way the portal does', async () => {
    const sdk = createMockSdk();
    const cg = new CrazyGamesService({ sdk, useMock: true });
    await cg.init();

    const seen = [];
    cg.onMuteChange((muted) => seen.push(muted));
    sdk.emitSettingsChange({ muteAudio: true });

    expect(seen).toEqual([true]);
  });

  it('records every lifecycle call, so a dev can see the integration work', async () => {
    const cg = new CrazyGamesService({ sdk: null });
    await cg.init();
    cg.loadingStart();
    cg.gameplayStart();

    expect(cg.sdk.calls.map((c) => c.name)).toEqual([
      'init',
      'loadingStart',
      'gameplayStart',
    ]);
  });
});

describe('Ad error codes', () => {
  it('reads a documented portal code verbatim', () => {
    expect(readAdCode({ code: 'adCooldown' })).toBe('adCooldown');
    expect(readAdCode('unfilled')).toBe('unfilled');
  });

  it('answers empty rather than throwing on anything else', () => {
    expect(readAdCode(undefined)).toBe('');
    expect(readAdCode({})).toBe('');
    expect(readAdCode({ code: 42 })).toBe('');
    expect(() => readAdCode(Object.create(null))).not.toThrow();
  });
});
