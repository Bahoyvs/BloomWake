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
  EMULATED_AD_MS,
  classifyAdError,
  getAdSdk,
  isAdAvailable,
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
