import { describe, it, expect } from 'vitest';
import {
  SAVE_VERSION,
  createDefaultState,
  deepMerge,
  loadState,
  serializeState,
  recordRun,
  clearPendingScrap,
} from '../src/core/state.js';
import { COSMETIC_IDS } from '../src/data/cosmetics.js';

/**
 * A save written by a Phase 4 build: it predates every Phase 5 field.
 * Phase 4 had no persistence at all, so this is the minimal shape a
 * pre-Phase-5 save could plausibly have carried.
 */
function phase4Save() {
  return {
    version: 1,
    stats: { bestWaveReached: 7, totalRuns: 12 },
  };
}

describe('Save state defaults', () => {
  it('starts a new player with the documented shape', () => {
    const state = createDefaultState();

    expect(state).not.toHaveProperty('petals');
    expect(state.pendingScrapTransfer).toBe(0);
    expect(state.metaUpgrades).toEqual({
      startHp: 0,
      pickupRadius: 0,
      startSpeed: 0,
      fourthCardSlot: false,
    });
    expect(state.cosmetics).toEqual({ owned: ['default'], equipped: 'default' });
    expect(state.pity).toEqual({ runsSinceRareOrBetter: 0 });
    expect(state.dailyBloom).toEqual({ lastClaimedAt: 0 });
    expect(state.stats).toEqual({ bestWaveReached: 0, totalRuns: 0 });
  });

  it('hands out an independent copy each call', () => {
    const a = createDefaultState();
    const b = createDefaultState();
    a.pendingScrapTransfer = 999;
    a.cosmetics.owned.push('dew-tint');

    expect(b.pendingScrapTransfer).toBe(0);
    expect(b.cosmetics.owned).toEqual(['default']);
  });
});

describe('deepMerge', () => {
  it('fills in missing keys from the target', () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });

  it('merges nested objects key-by-key instead of replacing the branch', () => {
    const merged = deepMerge(
      { stats: { bestWaveReached: 0, totalRuns: 0 } },
      { stats: { totalRuns: 5 } }
    );
    expect(merged.stats).toEqual({ bestWaveReached: 0, totalRuns: 5 });
  });

  it('replaces arrays rather than concatenating them', () => {
    const merged = deepMerge({ owned: ['default'] }, { owned: ['default', 'dew-tint'] });
    expect(merged.owned).toEqual(['default', 'dew-tint']);
  });

  it('treats undefined as absent but null as a value', () => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
    expect(deepMerge({ a: 1 }, { a: null })).toEqual({ a: null });
  });

  it('does not mutate either input', () => {
    const target = { nested: { value: 1 } };
    const source = { nested: { value: 2 } };
    deepMerge(target, source);

    expect(target.nested.value).toBe(1);
    expect(source.nested.value).toBe(2);
  });
});

describe('Backward compatibility with a Phase 4 save', () => {
  it('produces correct Phase 5 defaults for every missing field', () => {
    const loaded = loadState(phase4Save());

    expect(loaded).not.toHaveProperty('petals');
    expect(loaded.metaUpgrades).toEqual({
      startHp: 0,
      pickupRadius: 0,
      startSpeed: 0,
      fourthCardSlot: false,
    });
    expect(loaded.cosmetics).toEqual({ owned: ['default'], equipped: 'default' });
    expect(loaded.pity).toEqual({ runsSinceRareOrBetter: 0 });
    expect(loaded.dailyBloom).toEqual({ lastClaimedAt: 0 });
  });

  it('leaves every pre-existing field untouched', () => {
    const original = phase4Save();
    const loaded = loadState(original);

    expect(loaded.stats.bestWaveReached).toBe(7);
    expect(loaded.stats.totalRuns).toBe(12);
    // The source object itself must not be edited in place.
    expect(original).toEqual(phase4Save());
  });

  it('stamps every loaded save with the current version', () => {
    expect(loadState(phase4Save()).version).toBe(SAVE_VERSION);
    // 2 is the currency merge: `petals` removed in favour of the single Scrap
    // wallet. A purely additive change must NOT bump this again.
    expect(SAVE_VERSION).toBe(2);
  });

  it('moves a legacy Petal balance out to be banked as Scrap', () => {
    const loaded = loadState({ version: 1, petals: 1750 });

    expect(loaded.pendingScrapTransfer).toBe(1750);
    expect(loaded).not.toHaveProperty('petals');
  });

  it('re-runs the migration rather than risking a skipped one', () => {
    // Deliberately not gated on the stored version: a save mislabelled v2 that
    // still carries `petals` must still hand the balance over. Crediting twice
    // is recoverable; deleting a player's whole balance is not.
    const mislabelled = loadState({ version: 2, petals: 600 });
    expect(mislabelled.pendingScrapTransfer).toBe(600);
  });

  it('is a no-op on a save that has already migrated', () => {
    const migrated = clearPendingScrap(loadState({ version: 1, petals: 900 }));
    const reloaded = loadState(JSON.parse(JSON.stringify(migrated)));

    expect(reloaded.pendingScrapTransfer).toBe(0);
  });

  it('refuses to let a hand-edited save resurrect the dead wallet', () => {
    const loaded = loadState({ version: 2, petals: 0, pendingScrapTransfer: 0 });
    expect(loaded).not.toHaveProperty('petals');
  });

  it('keeps a partially-populated Phase 5 branch and defaults the rest', () => {
    // A save from a build that had Petals but not yet cosmetics.
    const partial = { petals: 340, metaUpgrades: { startHp: 2 } };
    const loaded = loadState(partial);

    // The balance survives as a hand-off, not as a second wallet.
    expect(loaded.pendingScrapTransfer).toBe(340);
    expect(loaded).not.toHaveProperty('petals');
    expect(loaded.metaUpgrades.startHp).toBe(2);
    expect(loaded.metaUpgrades.pickupRadius).toBe(0);
    expect(loaded.metaUpgrades.fourthCardSlot).toBe(false);
    expect(loaded.cosmetics.owned).toEqual(['default']);
  });

  it('round-trips a fully-populated save unchanged', () => {
    // "Fully populated" means every field of the CURRENT schema. A new field
    // belongs here the moment it is added — a save that predates it is the
    // Phase 4 fixture above, and gaining a default for it is the migration
    // working, not a round-trip failure.
    const full = {
      version: 2,
      pendingScrapTransfer: 0,
      metaUpgrades: { startHp: 3, pickupRadius: 2, startSpeed: 1, fourthCardSlot: true },
      cosmetics: { owned: ['default', 'dew-tint', 'prestij-skin'], equipped: 'dew-tint' },
      activeSkillId: 'phase_shift',
      pity: { runsSinceRareOrBetter: 4 },
      dailyBloom: { lastClaimedAt: 1700000000000 },
      stats: { bestWaveReached: 11, totalRuns: 40 },
    };

    expect(serializeState(loadState(full))).toEqual(full);
  });

  it('gives a save that predates active skills the default one', () => {
    expect(loadState(phase4Save()).activeSkillId).toBe('afterburner');
  });
});

describe('Loading hostile or absent saves', () => {
  it('returns clean defaults for null, undefined and junk', () => {
    for (const input of [null, undefined, 42, 'nope', []]) {
      expect(loadState(input)).toEqual(createDefaultState());
    }
  });

  it('clamps a negative, fractional or nonsense legacy balance', () => {
    expect(loadState({ petals: -500 }).pendingScrapTransfer).toBe(0);
    expect(loadState({ petals: 12.9 }).pendingScrapTransfer).toBe(12);
    expect(loadState({ petals: 'abc' }).pendingScrapTransfer).toBe(0);
  });

  it('coerces the one-time unlock to a real boolean', () => {
    expect(loadState({ metaUpgrades: { fourthCardSlot: 1 } }).metaUpgrades.fourthCardSlot).toBe(true);
    expect(loadState({ metaUpgrades: { fourthCardSlot: 0 } }).metaUpgrades.fourthCardSlot).toBe(false);
  });

  it('always leaves the default skin owned', () => {
    const loaded = loadState({ cosmetics: { owned: ['dew-tint'], equipped: 'dew-tint' } });
    expect(loaded.cosmetics.owned).toContain(COSMETIC_IDS.DEFAULT);
    expect(loaded.cosmetics.equipped).toBe('dew-tint');
  });

  it('falls back to the default skin when equipping something unowned', () => {
    const loaded = loadState({ cosmetics: { owned: ['default'], equipped: 'deep-water' } });
    expect(loaded.cosmetics.equipped).toBe(COSMETIC_IDS.DEFAULT);
  });

  it('drops duplicate owned entries', () => {
    const loaded = loadState({ cosmetics: { owned: ['default', 'default', 'dew-tint'] } });
    expect(loaded.cosmetics.owned).toEqual(['default', 'dew-tint']);
  });
});

describe('State mutations stay pure', () => {
  it('records a run without touching the original', () => {
    const state = createDefaultState();
    const next = recordRun(state, { wave: 9 });

    expect(next.stats).toEqual({ bestWaveReached: 9, totalRuns: 1 });
    expect(state.stats).toEqual({ bestWaveReached: 0, totalRuns: 0 });
  });

  it('keeps the best wave when a later run falls short', () => {
    let state = recordRun(createDefaultState(), { wave: 9 });
    state = recordRun(state, { wave: 3 });

    expect(state.stats.bestWaveReached).toBe(9);
    expect(state.stats.totalRuns).toBe(2);
  });

  it('clears the legacy hand-off without mutating', () => {
    const state = loadState({ petals: 500 });
    expect(state.pendingScrapTransfer).toBe(500);

    const cleared = clearPendingScrap(state);
    expect(cleared.pendingScrapTransfer).toBe(0);
    // The caller's copy is untouched, so a failed write can be retried against
    // a state that still knows what it owes.
    expect(state.pendingScrapTransfer).toBe(500);
  });
});
