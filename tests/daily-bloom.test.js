import { describe, it, expect } from 'vitest';
import {
  isSameLocalDay,
  isDailyBloomAvailable,
  msUntilNextLocalDay,
  claimDailyBloom,
} from '../src/core/daily-bloom.js';
import { createDefaultState } from '../src/core/state.js';
import { mulberry32 } from '../src/core/math.js';

/**
 * Local-time constructor. `new Date(y, m, d, h, min)` is local by design, which
 * is exactly what these boundaries are about — never build these from UTC or
 * ISO strings, or the test would assert something different than the feature.
 */
const local = (y, m, d, h = 12, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s).getTime();

describe('isSameLocalDay', () => {
  it('is true across any two times within one calendar day', () => {
    expect(
      isSameLocalDay(new Date(local(2026, 3, 14, 0, 0, 0)), new Date(local(2026, 3, 14, 23, 59, 59)))
    ).toBe(true);
  });

  it('is false for consecutive days even one minute apart', () => {
    expect(
      isSameLocalDay(new Date(local(2026, 3, 14, 23, 59)), new Date(local(2026, 3, 15, 0, 1)))
    ).toBe(false);
  });

  it('distinguishes the same day number in different months', () => {
    expect(isSameLocalDay(new Date(local(2026, 3, 14)), new Date(local(2026, 4, 14)))).toBe(false);
  });

  it('distinguishes the same date in different years', () => {
    expect(isSameLocalDay(new Date(local(2025, 3, 14)), new Date(local(2026, 3, 14)))).toBe(false);
  });
});

describe('isDailyBloomAvailable', () => {
  it('is available when never claimed', () => {
    expect(isDailyBloomAvailable(0, local(2026, 3, 14))).toBe(true);
  });

  it('is unavailable later the same local day', () => {
    expect(isDailyBloomAvailable(local(2026, 3, 14, 8), local(2026, 3, 14, 22))).toBe(false);
  });

  it('is available the next local day', () => {
    expect(isDailyBloomAvailable(local(2026, 3, 14, 22), local(2026, 3, 15, 8))).toBe(true);
  });

  it('flips exactly at local midnight', () => {
    const lastClaim = local(2026, 3, 14, 23, 59, 59);
    // One second before midnight: still the same day.
    expect(isDailyBloomAvailable(lastClaim, local(2026, 3, 14, 23, 59, 59))).toBe(false);
    // One second after: a new day, even though only 2 seconds passed.
    expect(isDailyBloomAvailable(lastClaim, local(2026, 3, 15, 0, 0, 1))).toBe(true);
  });

  it('is not fooled by a 23-hour gap inside one day', () => {
    // Claimed at 00:30, now 23:30 the same day — 23 hours elapsed, still no.
    expect(isDailyBloomAvailable(local(2026, 3, 14, 0, 30), local(2026, 3, 14, 23, 30))).toBe(false);
  });

  it('grants across a short gap that crosses midnight', () => {
    // Only 2 hours elapsed, but the calendar day changed — yes.
    expect(isDailyBloomAvailable(local(2026, 3, 14, 23, 0), local(2026, 3, 15, 1, 0))).toBe(true);
  });

  it('crosses month and year boundaries', () => {
    expect(isDailyBloomAvailable(local(2026, 3, 31, 20), local(2026, 4, 1, 9))).toBe(true);
    expect(isDailyBloomAvailable(local(2025, 12, 31, 23), local(2026, 1, 1, 1))).toBe(true);
  });

  it('treats a backwards clock as a new day rather than locking the player out', () => {
    // Timezone change or manual clock edit: never strand the bonus.
    expect(isDailyBloomAvailable(local(2026, 3, 15, 12), local(2026, 3, 14, 12))).toBe(true);
  });

  it('does not depend on the machine clock', () => {
    // Every assertion above uses explicit timestamps; this pins that the
    // function itself never reads Date.now().
    const source = isDailyBloomAvailable.toString();
    expect(source).not.toContain('Date.now');
  });
});

describe('msUntilNextLocalDay', () => {
  it('counts down to the next local midnight', () => {
    const now = local(2026, 3, 14, 23, 0, 0);
    expect(msUntilNextLocalDay(now)).toBe(60 * 60 * 1000);
  });

  it('is a full day just after midnight', () => {
    const now = local(2026, 3, 14, 0, 0, 0);
    expect(msUntilNextLocalDay(now)).toBe(24 * 60 * 60 * 1000);
  });
});

describe('claimDailyBloom', () => {
  it('grants Petals and stamps the claim time', () => {
    const state = createDefaultState();
    const now = local(2026, 3, 14, 9);
    const result = claimDailyBloom(state, now, mulberry32(1));

    expect(result.ok).toBe(true);
    expect(result.reward.petals).toBeGreaterThan(0);
    expect(result.state.petals).toBe(result.reward.petals);
    expect(result.state.dailyBloom.lastClaimedAt).toBe(now);
  });

  it('refuses a second claim the same local day', () => {
    const state = createDefaultState();
    const first = claimDailyBloom(state, local(2026, 3, 14, 9), mulberry32(1));
    const second = claimDailyBloom(first.state, local(2026, 3, 14, 21), mulberry32(2));

    expect(second.ok).toBe(false);
    expect(second.reason).toBe('ALREADY_CLAIMED_TODAY');
    expect(second.state.petals).toBe(first.state.petals);
  });

  it('allows a claim again the following day', () => {
    const first = claimDailyBloom(createDefaultState(), local(2026, 3, 14, 9), mulberry32(1));
    const second = claimDailyBloom(first.state, local(2026, 3, 15, 9), mulberry32(2));

    expect(second.ok).toBe(true);
    expect(second.state.petals).toBeGreaterThan(first.state.petals);
  });

  it('does not mutate the state it was given', () => {
    const state = createDefaultState();
    claimDailyBloom(state, local(2026, 3, 14, 9), mulberry32(1));

    expect(state.petals).toBe(0);
    expect(state.dailyBloom.lastClaimedAt).toBe(0);
  });

  it('never awards the prestige skin, which is capsule-only', () => {
    let state = createDefaultState();
    for (let day = 1; day <= 60; day++) {
      const result = claimDailyBloom(state, local(2026, 3, day, 9), mulberry32(day));
      if (result.ok) state = result.state;
    }
    expect(state.cosmetics.owned).toEqual(['default']);
  });
});
