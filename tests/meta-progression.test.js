/**
 * Meta-progression tests: the abandoned-run reward threshold.
 *
 * ---------------------------------------------------------------------------
 * THE EXPLOIT THIS CLOSES
 * ---------------------------------------------------------------------------
 * `completeRun` always resolves a large capsule — at minimum a Common-tier
 * Scrap payout, sometimes a livery. Before this threshold existed, a player
 * could press Launch Mission and immediately Abandon Run, and `finishRun`
 * would call `completeRun` exactly as it does for a real run: guaranteed
 * currency for zero risk, repeatable in seconds. `forfeitsRunRewards` and
 * `forfeitRunRewards` are the pair that closes it — the first decides whether
 * a run qualifies, the second is what a caller uses instead of `completeRun`
 * when it does not.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT TESTED HERE
 * ---------------------------------------------------------------------------
 * `completeRun` and `openSmallCapsule` are unchanged by this feature and untouched
 * by these tests — the fix is additive, not a rewrite of the existing reward
 * pipeline. The only new surface is the two exports below and how they use
 * `recordRun`.
 */

import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../src/core/math.js';
import { createDefaultState, recordRun } from '../src/core/state.js';
import { WAVE_CONSTANTS } from '../src/core/wave.js';
import {
  ABANDON_REWARD_THRESHOLD_WAVE,
  forfeitsRunRewards,
  forfeitRunRewards,
  completeRun,
} from '../src/core/meta-progression.js';

const rng = mulberry32(1);

describe('ABANDON_REWARD_THRESHOLD_WAVE', () => {
  it('is pinned to the first boss encounter, not a separate magic number', () => {
    // The threshold has to track WAVE_CONSTANTS.BOSS_WAVE_INTERVAL, or a
    // future retune of the boss cadence silently detaches the reward rule
    // from the "first boss" story the debrief copy and the pause warning
    // both tell the player.
    expect(ABANDON_REWARD_THRESHOLD_WAVE).toBe(WAVE_CONSTANTS.BOSS_WAVE_INTERVAL);
    expect(ABANDON_REWARD_THRESHOLD_WAVE).toBe(5);
  });
});

describe('forfeitsRunRewards', () => {
  it('never forfeits a run that was not abandoned', () => {
    // A death, or a payload with no `abandoned` field at all (a victory), must
    // never be treated as a forfeit however early it happened.
    expect(forfeitsRunRewards({ abandoned: false, wave: 1 })).toBe(false);
    expect(forfeitsRunRewards({ wave: 1 })).toBe(false);
    expect(forfeitsRunRewards({ abandoned: false, wave: 1000 })).toBe(false);
  });

  it('forfeits an abandoned run below the threshold wave', () => {
    expect(forfeitsRunRewards({ abandoned: true, wave: 1 })).toBe(true);
    expect(forfeitsRunRewards({ abandoned: true, wave: 4 })).toBe(true);
  });

  it('does not forfeit an abandoned run at or past the threshold', () => {
    expect(forfeitsRunRewards({ abandoned: true, wave: 5 })).toBe(false);
    expect(forfeitsRunRewards({ abandoned: true, wave: 6 })).toBe(false);
    expect(forfeitsRunRewards({ abandoned: true, wave: 15 })).toBe(false);
  });

  it('treats a missing or sub-1 wave as wave 1', () => {
    expect(forfeitsRunRewards({ abandoned: true })).toBe(true);
    expect(forfeitsRunRewards({ abandoned: true, wave: 0 })).toBe(true);
    expect(forfeitsRunRewards({ abandoned: true, wave: -3 })).toBe(true);
  });

  it('floors a fractional wave rather than rounding it up past the line', () => {
    // A run abandoned mid-wave-4.9 has not reached wave 5's risk yet.
    expect(forfeitsRunRewards({ abandoned: true, wave: 4.9 })).toBe(true);
    expect(forfeitsRunRewards({ abandoned: true, wave: 5.9 })).toBe(false);
  });
});

describe('forfeitRunRewards', () => {
  it('pays exactly nothing', () => {
    const outcome = forfeitRunRewards(createDefaultState(), { wave: 1 });

    expect(outcome.reward.scrap).toBe(0);
    expect(outcome.reward.cosmetics).toEqual([]);
    expect(outcome.newCosmetics).toEqual([]);
    expect(outcome.pityApplied).toBe(false);
    expect(outcome.odds).toBeNull();
    expect(outcome.forfeited).toBe(true);
  });

  it('never touches the pity counter', () => {
    // No capsule was rolled, so nothing about a "dry streak" happened here —
    // advancing runsSinceRareOrBetter for a run that never rolled anything
    // would just be a second, smaller bug riding along with the first.
    const state = { ...createDefaultState(), pity: { runsSinceRareOrBetter: 3 } };
    const outcome = forfeitRunRewards(state, { wave: 1 });

    expect(outcome.state.pity).toEqual({ runsSinceRareOrBetter: 3 });
  });

  it('grants no cosmetics regardless of what the pool would have paid', () => {
    const before = createDefaultState();
    const outcome = forfeitRunRewards(before, { wave: 1 });

    expect(outcome.state.cosmetics).toEqual(before.cosmetics);
  });

  it('still records the run in lifetime stats', () => {
    // A run that happened did happen; totalRuns and bestWaveReached are
    // vanity counters, not currency, and honesty here costs the player
    // nothing.
    const outcome = forfeitRunRewards(createDefaultState(), { wave: 3 });

    expect(outcome.state.stats.totalRuns).toBe(1);
    expect(outcome.state.stats.bestWaveReached).toBe(3);
  });

  it('matches recordRun exactly, so the debrief sees the same stats either path takes', () => {
    const state = createDefaultState();
    const viaForfeit = forfeitRunRewards(state, { wave: 4 }).state;
    const viaRecordRun = recordRun(state, { wave: 4 });

    expect(viaForfeit).toEqual(viaRecordRun);
  });

  it('is pure — the input state is never mutated', () => {
    const before = createDefaultState();
    const snapshot = JSON.parse(JSON.stringify(before));

    forfeitRunRewards(before, { wave: 1 });

    expect(before).toEqual(snapshot);
  });
});

describe('completeRun is unaffected by the threshold', () => {
  it('still pays a real run below wave 5 — only Abandon forfeits, not a short run', () => {
    // forfeitsRunRewards gates on `abandoned`, which completeRun's caller
    // checks BEFORE calling it — completeRun itself has no concept of
    // abandonment and must keep paying out for an ordinary death or a short
    // victory exactly as before.
    const outcome = completeRun(createDefaultState(), { wave: 2 }, rng);

    expect(outcome.forfeited).toBeUndefined();
    expect(outcome.reward.scrap).toBeGreaterThan(0);
  });
});

describe('The forfeited and completed shapes are interchangeable', () => {
  it('exposes the same top-level keys, so a debrief can branch on one flag', () => {
    const completed = completeRun(createDefaultState(), { wave: 6 }, rng);
    const forfeited = forfeitRunRewards(createDefaultState(), { wave: 1 });

    const keys = (obj) => Object.keys(obj).sort();
    expect(keys(forfeited)).toEqual(
      expect.arrayContaining(['state', 'reward', 'newCosmetics', 'pityApplied', 'odds'])
    );
    expect(keys(completed)).toEqual(
      expect.arrayContaining(['state', 'reward', 'newCosmetics', 'pityApplied', 'odds'])
    );
  });
});
