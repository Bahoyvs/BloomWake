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
