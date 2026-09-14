import { describe, it, expect, vi } from 'vitest';
import {
  ECONOMY_ERRORS,
  ECONOMY_SAVE_VERSION,
  ECONOMY_STORAGE_KEY,
  FORCED_BY,
  MetaEconomy,
  addChips,
  addScrap,
  applyCrateRewards,
  spendScrap,
  claimDailyShipment,
  clearEconomyStorage,
  cratesUntilPity,
  createDefaultEconomyState,
  describeSkillProgress,
  getSkillDefForState,
  getUpgradePreview,
  isDailyShipmentAvailable,
  loadEconomy,
  loadEconomyFromStorage,
  msUntilNextShipment,
  openCrate,
  resolveSkillDefAtLevel,
  rollChipOfRarity,
  rollChipRarity,
  saveEconomyToStorage,
  serializeEconomy,
  upgradeSkill,
} from '../src/core/meta-economy.js';
import {
  CHIP_KEYS,
  CHIP_RARITIES,
  CRATE_TYPES,
  MAX_SKILL_LEVEL,
  PITY_CRATE_THRESHOLD,
  isRarityAtLeast,
} from '../src/data/crates-config.js';
import { ACTIVE_SKILL_IDS, ACTIVE_SKILLS } from '../src/data/active-skills.js';
import { mulberry32 } from '../src/core/math.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * An RNG that always returns the same number.
 *
 * 0.1 is the useful constant here: it lands in the first bucket of every weight
 * table in the config and on index 0 of every chip pool, which makes the whole
 * crate outcome hand-computable and every pity/guarantee override visible as a
 * departure from it.
 */
const constantRng = (value) => () => value;

/** An RNG that plays a fixed script of draws, then cycles. */
function scriptedRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

/** localStorage stand-in. Real enough for the round trip, inspectable in a test. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** Storage that fails every operation, like a full disk or a locked-down browser. */
function hostileStorage() {
  return {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('quota exceeded');
    },
    removeItem() {
      throw new Error('denied');
    },
  };
}

/** A local-calendar timestamp, matching the local-day rule the clock uses. */
const localTime = (y, m, d, h = 12, min = 0) => new Date(y, m, d, h, min, 0, 0).getTime();

/** Deal `count` crates off one seeded stream. */
function openMany(state, crateId, count, seed = 1234) {
  const rng = mulberry32(seed);
  const results = [];
  let current = state;
  for (let i = 0; i < count; i++) {
    const outcome = openCrate(current, crateId, rng);
    current = outcome.state;
    results.push(outcome.result);
  }
  return { state: current, results };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

describe('Default economy state', () => {
  it('matches the documented schema', () => {
    const state = createDefaultEconomyState();
    expect(state.version).toBe(ECONOMY_SAVE_VERSION);
    expect(state.scrap).toBe(0);
    expect(state.pityCounter).toBe(0);
    expect(state.lastDailyShipmentTime).toBe(0);
    expect(state.cratesOpenedTotal).toBe(0);
  });

  it('carries a wallet and a level for all seven skills', () => {
    const state = createDefaultEconomyState();
    expect(Object.keys(state.chips).sort()).toEqual([...CHIP_KEYS].sort());
    expect(Object.keys(state.skillLevels).sort()).toEqual([...CHIP_KEYS].sort());

    for (const key of CHIP_KEYS) {
      expect(state.chips[key]).toBe(0);
      // Every skill is playable from run one; chips only make one better.
      expect(state.skillLevels[key]).toBe(1);
    }
  });

  it('hands out an independent copy each call', () => {
    const a = createDefaultEconomyState();
    a.scrap = 999;
    a.chips.afterburner = 5;
    expect(createDefaultEconomyState().scrap).toBe(0);
    expect(createDefaultEconomyState().chips.afterburner).toBe(0);
  });
});

describe('addScrap / addChips', () => {
  it('credits scrap without mutating the caller', () => {
    const state = createDefaultEconomyState();
    const next = addScrap(state, 120);
    expect(next.scrap).toBe(120);
    expect(state.scrap).toBe(0);
  });

  it('refuses negative and fractional grants', () => {
    const state = addScrap(createDefaultEconomyState(), 100);
    expect(addScrap(state, -50).scrap).toBe(100);
    expect(addScrap(state, 10.7).scrap).toBe(110);
    expect(addScrap(state, NaN).scrap).toBe(100);
  });

  it('credits chips by key and ignores keys it does not know', () => {
    const state = createDefaultEconomyState();
    const next = addChips(state, { afterburner: 3, emp: 1, not_a_chip: 99 });
    expect(next.chips.afterburner).toBe(3);
    expect(next.chips.emp).toBe(1);
    expect(next.chips).not.toHaveProperty('not_a_chip');
    expect(state.chips.afterburner).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rolling
// ---------------------------------------------------------------------------

describe('Rarity rolling', () => {
  const TRIALS = 20000;
  const TOLERANCE = 0.01;

  /** Empirical rarity frequencies over many rolls. */
  function measure(weights, minRarity = null, seed = 9876) {
    const rng = mulberry32(seed);
    const counts = Object.fromEntries(CHIP_RARITIES.map((r) => [r, 0]));
    for (let i = 0; i < TRIALS; i++) counts[rollChipRarity(weights, rng, minRarity)]++;
    return Object.fromEntries(Object.entries(counts).map(([r, n]) => [r, n / TRIALS]));
  }

  it('matches the standard pod weights within 1%', () => {
    const observed = measure(CRATE_TYPES.standard_pod.rarityWeights);
    expect(Math.abs(observed.common - 0.8)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(observed.rare - 0.2)).toBeLessThanOrEqual(TOLERANCE);
    expect(observed.legendary).toBe(0);
  });

  it('matches the prototype crate weights within 1%', () => {
    const observed = measure(CRATE_TYPES.prototype_crate.rarityWeights);
    expect(Math.abs(observed.common - 0.2)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(observed.rare - 0.55)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(observed.legendary - 0.25)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('re-normalises a floored roll over the surviving tiers only', () => {
    // Military is 40 rare : 10 legendary, so a rare floor must read 80/20 —
    // not 40/10 against a total that still counts the excluded commons.
    const observed = measure(CRATE_TYPES.military_pod.rarityWeights, 'rare');
    expect(observed.common).toBe(0);
    expect(Math.abs(observed.rare - 0.8)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(observed.legendary - 0.2)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('never rolls a zero-weight tier', () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 5000; i++) {
      expect(rollChipRarity(CRATE_TYPES.standard_pod.rarityWeights, rng)).not.toBe('legendary');
    }
  });

  it('falls back to the plain odds when a floor is unreachable', () => {
    // The standard pod has no legendary weight at all; a legendary floor has to
    // degrade rather than return nothing for the caller to crash on.
    const rarity = rollChipRarity(
      CRATE_TYPES.standard_pod.rarityWeights,
      constantRng(0.1),
      'legendary'
    );
    expect(CHIP_RARITIES).toContain(rarity);
  });

  it('returns null when every weight is zero', () => {
    expect(rollChipRarity({ common: 0, rare: 0, legendary: 0 }, constantRng(0.5))).toBeNull();
  });

  it('draws uniformly inside a rarity bucket', () => {
    const rng = mulberry32(5150);
    const counts = new Map();
    for (let i = 0; i < 9000; i++) {
      const chip = rollChipOfRarity('common', rng);
      counts.set(chip.id, (counts.get(chip.id) ?? 0) + 1);
    }
    // Three commons; each should land near a third.
    expect(counts.size).toBe(3);
    for (const [id, n] of counts) {
      expect(Math.abs(n / 9000 - 1 / 3), `${id} skewed`).toBeLessThanOrEqual(0.02);
    }
  });

  it('never draws from an unknown bucket', () => {
    expect(rollChipOfRarity('mythic', constantRng(0.5))).toBeNull();
  });
});

describe('Opening a crate', () => {
  it('resolves a standard pod exactly, for a pinned die', () => {
    const { ok, state, result } = openCrate(
      createDefaultEconomyState(),
      'standard_pod',
      constantRng(0.1)
    );

    expect(ok).toBe(true);
    // 80 + floor(0.1 * 81) = 88.
    expect(result.scrap).toBe(88);
    expect(result.chips).toHaveLength(1);
    expect(result.chips[0]).toMatchObject({
      chipId: 'chip_afterburner',
      key: 'afterburner',
      rarity: 'common',
      skillId: ACTIVE_SKILL_IDS.AFTERBURNER,
      forcedBy: null,
    });

    expect(state.scrap).toBe(88);
    expect(state.chips.afterburner).toBe(1);
    expect(state.cratesOpenedTotal).toBe(1);
    expect(state.pityCounter).toBe(1);
  });

  it('rolls one chip per crate, as the crate type declares', () => {
    const rng = mulberry32(77);
    for (const [id, crate] of Object.entries(CRATE_TYPES)) {
      const { result } = openCrate(createDefaultEconomyState(), id, rng);
      expect(result.chips, `${id} chip count`).toHaveLength(crate.chipCount);
    }
  });

  it('keeps scrap inside the crate range over many opens', () => {
    for (const [id, crate] of Object.entries(CRATE_TYPES)) {
      const { results } = openMany(createDefaultEconomyState(), id, 500, 31337);
      const [min, max] = crate.scrapRange;
      for (const result of results) {
        expect(result.scrap, `${id} paid ${result.scrap}`).toBeGreaterThanOrEqual(min);
        expect(result.scrap, `${id} paid ${result.scrap}`).toBeLessThanOrEqual(max);
      }
      // And the range is actually exercised, not pinned to one end.
      const paid = results.map((r) => r.scrap);
      expect(Math.min(...paid)).toBeLessThan(Math.max(...paid));
    }
  });

  it('banks every rolled chip into the wallet', () => {
    const { state, results } = openMany(createDefaultEconomyState(), 'prototype_crate', 40, 808);
    const expected = {};
    for (const result of results) {
      for (const chip of result.chips) expected[chip.key] = (expected[chip.key] ?? 0) + 1;
    }
    for (const key of CHIP_KEYS) {
      expect(state.chips[key], `${key} banked`).toBe(expected[key] ?? 0);
    }
    expect(state.cratesOpenedTotal).toBe(40);
  });

  it('never drops a legendary from a standard pod', () => {
    const { results } = openMany(createDefaultEconomyState(), 'standard_pod', 2000, 5);
    for (const result of results) {
      for (const chip of result.chips) expect(chip.rarity).not.toBe('legendary');
    }
  });

  it('rejects an unknown crate without touching the state', () => {
    const state = createDefaultEconomyState();
    const outcome = openCrate(state, 'golden_pod', constantRng(0.5));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(ECONOMY_ERRORS.UNKNOWN_CRATE);
    expect(outcome.state).toBe(state);
  });

  it('leaves the caller state untouched', () => {
    const state = createDefaultEconomyState();
    const snapshot = JSON.stringify(state);
    openCrate(state, 'prototype_crate', mulberry32(9));
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Pity and guarantees
// ---------------------------------------------------------------------------

describe('Pity', () => {
  /** A die that always picks the first (common) bucket and the first chip. */
  const alwaysCommon = () => constantRng(0.1);

  it('counts up while a streak of commons runs', () => {
    let state = createDefaultEconomyState();
    const rng = alwaysCommon();
    for (let i = 1; i <= PITY_CRATE_THRESHOLD; i++) {
      const outcome = openCrate(state, 'standard_pod', rng);
      state = outcome.state;
      expect(outcome.result.pityApplied).toBe(false);
      expect(state.pityCounter).toBe(i);
    }
  });

  it('forces the next crate first chip to rare once the streak is full', () => {
    let state = createDefaultEconomyState();
    const rng = alwaysCommon();
    for (let i = 0; i < PITY_CRATE_THRESHOLD; i++) {
      state = openCrate(state, 'standard_pod', rng).state;
    }
    expect(cratesUntilPity(state)).toBe(0);

    const outcome = openCrate(state, 'standard_pod', rng);
    expect(outcome.result.pityApplied).toBe(true);
    expect(outcome.result.chips[0].rarity).toBe('rare');
    expect(outcome.result.chips[0].forcedBy).toBe(FORCED_BY.PITY);
    // The forced rare clears its own streak.
    expect(outcome.state.pityCounter).toBe(0);
  });

  it('applies the floor only to the first chip of the crate', () => {
    let state = createDefaultEconomyState();
    const rng = alwaysCommon();
    for (let i = 0; i < PITY_CRATE_THRESHOLD; i++) {
      state = openCrate(state, 'standard_pod', rng).state;
    }

    const { result } = openCrate(state, 'prototype_crate', rng);
    expect(result.chips[0].forcedBy).toBe(FORCED_BY.PITY);
    expect(result.chips.slice(1).every((chip) => chip.forcedBy === null)).toBe(true);
  });

  it('resets the counter on a naturally rolled rare', () => {
    let state = createDefaultEconomyState();
    state = openCrate(state, 'standard_pod', constantRng(0.1)).state;
    expect(state.pityCounter).toBe(1);

    // 0.9 * 100 = 90; past common's 80, so this lands on rare.
    const outcome = openCrate(state, 'standard_pod', constantRng(0.9));
    expect(outcome.result.chips[0].rarity).toBe('rare');
    expect(outcome.result.pityApplied).toBe(false);
    expect(outcome.state.pityCounter).toBe(0);
  });

  it('never lets more than the threshold go by dry, on any seed', () => {
    for (const seed of [1, 2, 3, 99, 4242]) {
      let state = createDefaultEconomyState();
      const rng = mulberry32(seed);
      let dryStreak = 0;

      for (let i = 0; i < 400; i++) {
        const outcome = openCrate(state, 'standard_pod', rng);
        state = outcome.state;
        const gotRare = outcome.result.chips.some((chip) => isRarityAtLeast(chip.rarity, 'rare'));
        dryStreak = gotRare ? 0 : dryStreak + 1;
        expect(dryStreak, `seed ${seed} went dry ${dryStreak} crates`).toBeLessThanOrEqual(
          PITY_CRATE_THRESHOLD
        );
      }
    }
  });

  it('counts down to the guarantee for the UI', () => {
    let state = createDefaultEconomyState();
    expect(cratesUntilPity(state)).toBe(PITY_CRATE_THRESHOLD);
    state = openCrate(state, 'standard_pod', constantRng(0.1)).state;
    expect(cratesUntilPity(state)).toBe(PITY_CRATE_THRESHOLD - 1);
  });
});

describe('Crate guarantees', () => {
  it('lifts the last military chip to rare when the crate has been all commons', () => {
    const { result } = openCrate(createDefaultEconomyState(), 'military_pod', constantRng(0.1));

    expect(result.scrap).toBe(275); // 250 + floor(0.1 * 251)
    expect(result.chips[0].rarity).toBe('common');
    expect(result.chips[0].forcedBy).toBeNull();
    expect(result.chips[1].rarity).toBe('rare');
    expect(result.chips[1].forcedBy).toBe(FORCED_BY.GUARANTEE);
    expect(result.guaranteeApplied).toBe(true);
  });

  it('stays out of the way when the crate already rolled a rare', () => {
    // Draws: scrap, chip0 rarity, chip0 index, chip1 rarity, chip1 index.
    // 0.6 * 100 lands past common's 50, so both chips roll rare on their own.
    const { result } = openCrate(
      createDefaultEconomyState(),
      'military_pod',
      scriptedRng([0, 0.6, 0, 0.6, 0])
    );

    expect(result.chips[0].rarity).toBe('rare');
    expect(result.guaranteeApplied).toBe(false);
    expect(result.chips.every((chip) => chip.forcedBy === null)).toBe(true);
  });

  it('always pays a military crate at least one rare-or-better', () => {
    const { results } = openMany(createDefaultEconomyState(), 'military_pod', 1000, 24680);
    for (const result of results) {
      expect(
        result.chips.some((chip) => isRarityAtLeast(chip.rarity, 'rare')),
        'a military crate paid two commons'
      ).toBe(true);
    }
  });

  it('lets pity and the guarantee both fire on a one-chip crate', () => {
    let state = createDefaultEconomyState();
    const rng = constantRng(0.1);
    for (let i = 0; i < PITY_CRATE_THRESHOLD; i++) {
      state = openCrate(state, 'standard_pod', rng).state;
    }
    // A single chip is both the first and the last, so the pity floor claims it
    // and the guarantee records that it was satisfied.
    const { result } = openCrate(state, 'military_pod', rng);
    expect(result.pityApplied).toBe(true);
    expect(result.chips[0].forcedBy).toBe(FORCED_BY.PITY);
    expect(isRarityAtLeast(result.chips[0].rarity, 'rare')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Upgrades
// ---------------------------------------------------------------------------

describe('Upgrade previews', () => {
  it('reports what is missing on a fresh save', () => {
    const preview = getUpgradePreview(createDefaultEconomyState(), 'afterburner');
    expect(preview).toMatchObject({
      ok: true,
      level: 1,
      isMax: false,
      cost: { chips: 2, scrap: 250 },
      ownedChips: 0,
      canAfford: false,
      missingChips: 2,
      missingScrap: 250,
    });
  });

  it('flips to affordable once both halves are paid for', () => {
    let state = addChips(createDefaultEconomyState(), { afterburner: 2 });
    state = addScrap(state, 250);
    expect(getUpgradePreview(state, 'afterburner')).toMatchObject({
      canAfford: true,
      missingChips: 0,
      missingScrap: 0,
    });
  });

  it('describes a maxed skill without a cost', () => {
    const state = createDefaultEconomyState();
    state.skillLevels.emp = MAX_SKILL_LEVEL;
    expect(getUpgradePreview(state, 'emp')).toMatchObject({
      ok: true,
      isMax: true,
      cost: null,
      canAfford: false,
    });
  });

  it('rejects a key it does not know', () => {
    expect(getUpgradePreview(createDefaultEconomyState(), 'warp_drive')).toEqual({
      ok: false,
      reason: ECONOMY_ERRORS.UNKNOWN_SKILL,
    });
  });

  it('describes all seven skills in display order for the hangar', () => {
    const rows = describeSkillProgress(createDefaultEconomyState());
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.level).toBe(1);
      expect(row.maxLevel).toBe(MAX_SKILL_LEVEL);
      expect(row.skillName).toBe(ACTIVE_SKILLS[row.skillId].name);
      expect(row.cost).toEqual({ chips: 2, scrap: 250 });
    }
  });
});

describe('Upgrading a skill', () => {
  /** A state holding exactly the price of the next level. */
  function fundedFor(key, level = 1) {
    const state = createDefaultEconomyState();
    state.skillLevels[key] = level;
    const { cost } = getUpgradePreview(state, key);
    return addScrap(addChips(state, { [key]: cost.chips }), cost.scrap);
  }

  it('spends both halves of the price and raises the level', () => {
    const state = fundedFor('afterburner');
    const outcome = upgradeSkill(state, 'afterburner');

    expect(outcome.ok).toBe(true);
    expect(outcome.level).toBe(2);
    expect(outcome.cost).toEqual({ chips: 2, scrap: 250 });
    expect(outcome.state.skillLevels.afterburner).toBe(2);
    expect(outcome.state.chips.afterburner).toBe(0);
    expect(outcome.state.scrap).toBe(0);
  });

  it('touches only the skill being upgraded', () => {
    const state = fundedFor('singularity');
    const { state: next } = upgradeSkill(state, 'singularity');
    for (const key of CHIP_KEYS) {
      if (key === 'singularity') continue;
      expect(next.skillLevels[key], `${key} level moved`).toBe(1);
      expect(next.chips[key], `${key} chips moved`).toBe(0);
    }
  });

  it('leaves the caller state untouched', () => {
    const state = fundedFor('emp');
    const snapshot = JSON.stringify(state);
    upgradeSkill(state, 'emp');
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('climbs one level at a time, never spending a second level in one call', () => {
    let state = createDefaultEconomyState();
    state = addChips(state, { missiles: 29 });
    state = addScrap(state, 5250);

    const first = upgradeSkill(state, 'missiles');
    expect(first.level).toBe(2);
    // The rest of the bank is still there, unspent.
    expect(first.state.chips.missiles).toBe(27);
    expect(first.state.scrap).toBe(5000);
  });

  it('reaches max level for exactly the cumulative price', () => {
    let state = addScrap(addChips(createDefaultEconomyState(), { missiles: 29 }), 5250);
    for (let level = 2; level <= MAX_SKILL_LEVEL; level++) {
      const outcome = upgradeSkill(state, 'missiles');
      expect(outcome.ok, `level ${level} was unaffordable`).toBe(true);
      expect(outcome.level).toBe(level);
      state = outcome.state;
    }
    expect(state.skillLevels.missiles).toBe(MAX_SKILL_LEVEL);
    expect(state.chips.missiles).toBe(0);
    expect(state.scrap).toBe(0);
  });

  it('refuses to go past max level', () => {
    let state = addScrap(addChips(createDefaultEconomyState(), { emp: 99 }), 99999);
    state.skillLevels.emp = MAX_SKILL_LEVEL;

    const outcome = upgradeSkill(state, 'emp');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(ECONOMY_ERRORS.MAX_LEVEL);
    expect(outcome.state).toBe(state);
  });

  it('refuses without enough chips, and charges nothing', () => {
    const state = addScrap(addChips(createDefaultEconomyState(), { phase_shift: 1 }), 9999);
    const outcome = upgradeSkill(state, 'phase_shift');

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(ECONOMY_ERRORS.NOT_ENOUGH_CHIPS);
    expect(outcome.state.scrap).toBe(9999);
    expect(outcome.state.chips.phase_shift).toBe(1);
  });

  it('refuses without enough scrap, and does not eat the chips', () => {
    const state = addScrap(addChips(createDefaultEconomyState(), { phase_shift: 5 }), 10);
    const outcome = upgradeSkill(state, 'phase_shift');

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(ECONOMY_ERRORS.NOT_ENOUGH_SCRAP);
    expect(outcome.state.chips.phase_shift).toBe(5);
    expect(outcome.state.scrap).toBe(10);
  });

  it('names the chip shortage first when both halves are short', () => {
    const outcome = upgradeSkill(createDefaultEconomyState(), 'overcharge');
    expect(outcome.reason).toBe(ECONOMY_ERRORS.NOT_ENOUGH_CHIPS);
  });

  it('rejects a key it does not know', () => {
    const state = createDefaultEconomyState();
    const outcome = upgradeSkill(state, 'warp_drive');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(ECONOMY_ERRORS.UNKNOWN_SKILL);
    expect(outcome.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Scaled skill definitions
// ---------------------------------------------------------------------------

describe('Resolving a skill at a level', () => {
  it('returns the table untouched at level 1', () => {
    for (const skillId of Object.values(ACTIVE_SKILL_IDS)) {
      const base = ACTIVE_SKILLS[skillId];
      const def = resolveSkillDefAtLevel(skillId, 1);
      expect(def.cooldown, `${skillId} cooldown`).toBe(base.cooldown);
      expect(def.duration, `${skillId} duration`).toBe(base.duration);
      expect(def.params, `${skillId} params`).toEqual(base.params);
      expect(def.level).toBe(1);
    }
  });

  it('hands back a copy the caller cannot write through', () => {
    const def = resolveSkillDefAtLevel(ACTIVE_SKILL_IDS.AFTERBURNER, 3);
    def.params.speedMultiplier = 99;
    def.cooldown = 0;
    expect(ACTIVE_SKILLS[ACTIVE_SKILL_IDS.AFTERBURNER].params.speedMultiplier).toBe(2.3);
    expect(ACTIVE_SKILLS[ACTIVE_SKILL_IDS.AFTERBURNER].cooldown).toBe(8);
  });

  it('lengthens the Afterburner window and shortens its cooldown', () => {
    const def = resolveSkillDefAtLevel(ACTIVE_SKILL_IDS.AFTERBURNER, MAX_SKILL_LEVEL);
    expect(def.duration).toBe(3.41); // 2.2 * 1.55
    expect(def.cooldown).toBe(6.56); // 8 * 0.82
    expect(def.params.speedMultiplier).toBe(2.99);
    // Speed and acceleration stay locked together.
    expect(def.params.accelMultiplier).toBe(def.params.speedMultiplier);
  });

  it('keeps a continuous param continuous even when its base looks whole', () => {
    // turnRate is 5 in the table; rounding it would flatten the curve entirely.
    const def = resolveSkillDefAtLevel(ACTIVE_SKILL_IDS.MISSILE_SALVO, 3);
    expect(def.params.turnRate).toBe(5.5);
  });

  it('keeps discrete params whole at every level', () => {
    const counts = [1, 2, 3, 4, 5].map(
      (level) => resolveSkillDefAtLevel(ACTIVE_SKILL_IDS.MISSILE_SALVO, level).params.count
    );
    expect(counts).toEqual([8, 9, 10, 12, 14]);

    const blades = [1, 2, 3, 4, 5].map(
      (level) => resolveSkillDefAtLevel(ACTIVE_SKILL_IDS.POINT_DEFENSE, level).params.bladeCount
    );
    expect(blades).toEqual([2, 3, 4, 5, 6]);
  });

  it('grows the Singularity capture field', () => {
    const base = ACTIVE_SKILLS[ACTIVE_SKILL_IDS.SINGULARITY_ANCHOR].params.radius;
    const maxed = resolveSkillDefAtLevel(ACTIVE_SKILL_IDS.SINGULARITY_ANCHOR, MAX_SKILL_LEVEL);
    expect(maxed.params.radius).toBe(330); // 220 * 1.5
    expect(maxed.params.radius).toBeGreaterThan(base);
  });

  it('leaves the EMP instant at every level', () => {
    for (let level = 1; level <= MAX_SKILL_LEVEL; level++) {
      expect(resolveSkillDefAtLevel(ACTIVE_SKILL_IDS.EMP_SHOCKWAVE, level).duration).toBe(0);
    }
  });

  it('carries non-numeric params through untouched', () => {
    const def = resolveSkillDefAtLevel(ACTIVE_SKILL_IDS.PHASE_SHIFT, MAX_SKILL_LEVEL);
    expect(def.params.invulnerable).toBe(true);
    expect(def.id).toBe(ACTIVE_SKILL_IDS.PHASE_SHIFT);
    expect(def.name).toBe(ACTIVE_SKILLS[ACTIVE_SKILL_IDS.PHASE_SHIFT].name);
  });

  it('never produces float noise', () => {
    for (const skillId of Object.values(ACTIVE_SKILL_IDS)) {
      for (let level = 1; level <= MAX_SKILL_LEVEL; level++) {
        const def = resolveSkillDefAtLevel(skillId, level);
        for (const [param, value] of Object.entries(def.params)) {
          if (typeof value !== 'number') continue;
          expect(
            String(value).replace('-', '').split('.')[1]?.length ?? 0,
            `${skillId}.${param} at level ${level} is ${value}`
          ).toBeLessThanOrEqual(4);
        }
      }
    }
  });

  it('clamps a level outside the ladder instead of throwing', () => {
    const max = resolveSkillDefAtLevel(ACTIVE_SKILL_IDS.AFTERBURNER, MAX_SKILL_LEVEL);
    expect(resolveSkillDefAtLevel(ACTIVE_SKILL_IDS.AFTERBURNER, 99)).toEqual(max);
    expect(resolveSkillDefAtLevel(ACTIVE_SKILL_IDS.AFTERBURNER, 0)).toEqual(
      resolveSkillDefAtLevel(ACTIVE_SKILL_IDS.AFTERBURNER, 1)
    );
  });

  it('returns null for an unknown skill', () => {
    expect(resolveSkillDefAtLevel('warp_drive', 2)).toBeNull();
  });

  it('reads the level out of the save', () => {
    const state = createDefaultEconomyState();
    state.skillLevels.missiles = 4;
    const def = getSkillDefForState(state, ACTIVE_SKILL_IDS.MISSILE_SALVO);
    expect(def.level).toBe(4);
    expect(def.params.count).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Daily shipment
// ---------------------------------------------------------------------------

describe('Daily shipment', () => {
  const NOW = localTime(2026, 8, 14, 21, 30);

  it('is waiting on a save that has never claimed one', () => {
    expect(isDailyShipmentAvailable(createDefaultEconomyState(), NOW)).toBe(true);
    expect(msUntilNextShipment(createDefaultEconomyState(), NOW)).toBe(0);
  });

  it('pays a crate and stamps the claim', () => {
    const outcome = claimDailyShipment(createDefaultEconomyState(), NOW, constantRng(0.1));
    expect(outcome.ok).toBe(true);
    expect(outcome.result.crateId).toBe('standard_pod');
    expect(outcome.result.scrap).toBe(88);
    expect(outcome.state.scrap).toBe(88);
    expect(outcome.state.chips.afterburner).toBe(1);
    expect(outcome.state.cratesOpenedTotal).toBe(1);
    expect(outcome.state.lastDailyShipmentTime).toBe(NOW);
  });

  it('locks out a second claim on the same local day', () => {
    const first = claimDailyShipment(createDefaultEconomyState(), NOW, constantRng(0.1));
    const laterSameDay = localTime(2026, 8, 14, 23, 59);

    expect(isDailyShipmentAvailable(first.state, laterSameDay)).toBe(false);
    const second = claimDailyShipment(first.state, laterSameDay, constantRng(0.1));
    expect(second.ok).toBe(false);
    expect(second.reason).toBe(ECONOMY_ERRORS.ALREADY_CLAIMED_TODAY);
    expect(second.state).toBe(first.state);
  });

  it('reopens on the next local calendar day, not 24 hours later', () => {
    const lateClaim = localTime(2026, 8, 14, 23, 0);
    const claimed = claimDailyShipment(createDefaultEconomyState(), lateClaim, constantRng(0.1));

    // 02:00 the next morning is three hours later and a new day: available.
    const nextMorning = localTime(2026, 8, 15, 2, 0);
    expect(isDailyShipmentAvailable(claimed.state, nextMorning)).toBe(true);
    expect(msUntilNextShipment(claimed.state, nextMorning)).toBe(0);
  });

  it('counts down to local midnight while it is locked', () => {
    const claimed = claimDailyShipment(createDefaultEconomyState(), NOW, constantRng(0.1));
    const remaining = msUntilNextShipment(claimed.state, NOW);
    // 21:30 to midnight is two and a half hours.
    expect(remaining).toBe(2.5 * 60 * 60 * 1000);
  });

  it('reopens rather than locking out when the clock jumps backwards', () => {
    const claimed = claimDailyShipment(createDefaultEconomyState(), NOW, constantRng(0.1));
    const rewound = NOW - 5 * 24 * 60 * 60 * 1000;
    expect(isDailyShipmentAvailable(claimed.state, rewound)).toBe(true);
  });

  it('feeds the same pity counter as any other crate', () => {
    let state = createDefaultEconomyState();
    const rng = constantRng(0.1);
    for (let i = 0; i < PITY_CRATE_THRESHOLD; i++) {
      state = openCrate(state, 'standard_pod', rng).state;
    }
    const outcome = claimDailyShipment(state, NOW, rng);
    expect(outcome.result.pityApplied).toBe(true);
    expect(outcome.result.chips[0].rarity).toBe('rare');
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('Loading an untrusted save', () => {
  it('falls back to defaults for anything that is not an object', () => {
    for (const junk of [null, undefined, 'nope', 42, [], true]) {
      expect(loadEconomy(junk)).toEqual(createDefaultEconomyState());
    }
  });

  it('fills in fields an older save never had', () => {
    const state = loadEconomy({ scrap: 500 });
    expect(state.scrap).toBe(500);
    expect(state.pityCounter).toBe(0);
    expect(state.cratesOpenedTotal).toBe(0);
    for (const key of CHIP_KEYS) {
      expect(state.chips[key]).toBe(0);
      expect(state.skillLevels[key]).toBe(1);
    }
  });

  it('repairs negative, fractional and non-numeric counts', () => {
    const state = loadEconomy({
      scrap: -900,
      cratesOpenedTotal: 12.9,
      chips: { afterburner: -3, emp: 'lots', missiles: 4.7 },
    });
    expect(state.scrap).toBe(0);
    expect(state.cratesOpenedTotal).toBe(12);
    expect(state.chips.afterburner).toBe(0);
    expect(state.chips.emp).toBe(0);
    expect(state.chips.missiles).toBe(4);
  });

  it('clamps hand-edited skill levels into the ladder', () => {
    const state = loadEconomy({ skillLevels: { afterburner: 99, emp: 0, missiles: -4, singularity: 3 } });
    expect(state.skillLevels.afterburner).toBe(MAX_SKILL_LEVEL);
    expect(state.skillLevels.emp).toBe(1);
    expect(state.skillLevels.missiles).toBe(1);
    expect(state.skillLevels.singularity).toBe(3);
  });

  it('clamps a hand-edited pity counter to the threshold', () => {
    expect(loadEconomy({ pityCounter: 9999 }).pityCounter).toBe(PITY_CRATE_THRESHOLD);
    expect(loadEconomy({ pityCounter: -5 }).pityCounter).toBe(0);
  });

  it('drops chips for skills this build no longer has', () => {
    const state = loadEconomy({ chips: { afterburner: 2, chip_of_theseus: 50 } });
    expect(state.chips.afterburner).toBe(2);
    expect(state.chips).not.toHaveProperty('chip_of_theseus');
    expect(Object.keys(state.chips).sort()).toEqual([...CHIP_KEYS].sort());
  });

  it('stamps this build version over whatever the save claimed', () => {
    expect(loadEconomy({ version: 0 }).version).toBe(ECONOMY_SAVE_VERSION);
    expect(loadEconomy({ version: 99 }).version).toBe(ECONOMY_SAVE_VERSION);
  });

  it('survives a full round trip through JSON', () => {
    let state = addScrap(createDefaultEconomyState(), 1234);
    state = addChips(state, { singularity: 7, emp: 2 });
    state.skillLevels.singularity = 3;
    state.pityCounter = 2;
    state.cratesOpenedTotal = 41;
    state.lastDailyShipmentTime = localTime(2026, 8, 14);

    const restored = loadEconomy(JSON.parse(JSON.stringify(serializeEconomy(state))));
    expect(restored).toEqual(state);
  });
});

describe('localStorage round trip', () => {
  it('writes under its own key, separate from the Petals save', () => {
    const storage = fakeStorage();
    expect(saveEconomyToStorage(addScrap(createDefaultEconomyState(), 300), storage)).toBe(true);
    expect(storage.map.has(ECONOMY_STORAGE_KEY)).toBe(true);
    expect(ECONOMY_STORAGE_KEY).not.toBe('bloomwake.save.v1');
  });

  it('reads back exactly what a session banked', () => {
    const storage = fakeStorage();
    let state = createDefaultEconomyState();
    ({ state } = openCrate(state, 'prototype_crate', mulberry32(4)));
    state = addScrap(state, 1000);
    saveEconomyToStorage(state, storage);

    expect(loadEconomyFromStorage(storage)).toEqual(state);
  });

  it('starts clean when nothing has been saved yet', () => {
    expect(loadEconomyFromStorage(fakeStorage())).toEqual(createDefaultEconomyState());
  });

  it('starts clean on a corrupt save rather than trapping the player', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = fakeStorage({ [ECONOMY_STORAGE_KEY]: '{not json at all' });

    expect(loadEconomyFromStorage(storage)).toEqual(createDefaultEconomyState());
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reports a failed write instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(saveEconomyToStorage(createDefaultEconomyState(), hostileStorage())).toBe(false);
    warn.mockRestore();
  });

  it('still yields a playable wallet when storage cannot be read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadEconomyFromStorage(hostileStorage())).toEqual(createDefaultEconomyState());
    warn.mockRestore();
  });

  it('wipes the save, and swallows a storage that refuses', () => {
    const storage = fakeStorage();
    saveEconomyToStorage(createDefaultEconomyState(), storage);
    clearEconomyStorage(storage);
    expect(storage.map.has(ECONOMY_STORAGE_KEY)).toBe(false);
    expect(() => clearEconomyStorage(hostileStorage())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

describe('MetaEconomy', () => {
  /** A manager wired to a fake disk, a pinned die and a pinned clock. */
  function makeEconomy(overrides = {}) {
    const storage = overrides.storage ?? fakeStorage();
    const economy = new MetaEconomy({
      storage,
      rng: overrides.rng ?? constantRng(0.1),
      now: overrides.now ?? (() => localTime(2026, 8, 14, 21, 30)),
      ...overrides,
    });
    return { economy, storage };
  }

  it('starts from whatever is on disk', () => {
    const storage = fakeStorage();
    saveEconomyToStorage(addScrap(createDefaultEconomyState(), 777), storage);
    const { economy } = makeEconomy({ storage });
    expect(economy.getState().scrap).toBe(777);
  });

  it('persists a crate the moment it is opened', () => {
    const { economy, storage } = makeEconomy();
    const outcome = economy.openCrate('standard_pod');

    expect(outcome.ok).toBe(true);
    expect(outcome.result.scrap).toBe(88);
    // A second manager on the same disk sees it — the closed-tab case.
    expect(loadEconomyFromStorage(storage).scrap).toBe(88);
    expect(loadEconomyFromStorage(storage).chips.afterburner).toBe(1);
  });

  it('writes nothing when an operation is rejected', () => {
    const { economy, storage } = makeEconomy();
    economy.openCrate('standard_pod');
    const before = storage.map.get(ECONOMY_STORAGE_KEY);

    expect(economy.openCrate('golden_pod').ok).toBe(false);
    expect(economy.upgradeSkill('afterburner').reason).toBe(ECONOMY_ERRORS.NOT_ENOUGH_CHIPS);
    expect(storage.map.get(ECONOMY_STORAGE_KEY)).toBe(before);
  });

  it('persists an upgrade', () => {
    const { economy, storage } = makeEconomy();
    economy.addChips({ afterburner: 2 });
    economy.addScrap(250);

    const outcome = economy.upgradeSkill('afterburner');
    expect(outcome).toMatchObject({ ok: true, level: 2 });
    expect(loadEconomyFromStorage(storage).skillLevels.afterburner).toBe(2);
  });

  it('serves the scaled skill definition for the level it has bought', () => {
    const { economy } = makeEconomy();
    expect(economy.getSkillDef(ACTIVE_SKILL_IDS.MISSILE_SALVO).params.count).toBe(8);

    economy.addChips({ missiles: 29 });
    economy.addScrap(5250);
    for (let level = 2; level <= MAX_SKILL_LEVEL; level++) economy.upgradeSkill('missiles');

    expect(economy.getSkillDef(ACTIVE_SKILL_IDS.MISSILE_SALVO).params.count).toBe(14);
  });

  it('claims the daily shipment against its injected clock', () => {
    let now = localTime(2026, 8, 14, 21, 30);
    const { economy } = makeEconomy({ now: () => now });

    expect(economy.isDailyShipmentAvailable()).toBe(true);
    expect(economy.claimDailyShipment().ok).toBe(true);
    expect(economy.isDailyShipmentAvailable()).toBe(false);
    expect(economy.claimDailyShipment().reason).toBe(ECONOMY_ERRORS.ALREADY_CLAIMED_TODAY);

    now = localTime(2026, 8, 15, 8, 0);
    expect(economy.isDailyShipmentAvailable()).toBe(true);
    expect(economy.msUntilNextShipment()).toBe(0);
  });

  it('surfaces the pity countdown', () => {
    const { economy } = makeEconomy();
    expect(economy.cratesUntilPity()).toBe(PITY_CRATE_THRESHOLD);
    economy.openCrate('standard_pod');
    expect(economy.cratesUntilPity()).toBe(PITY_CRATE_THRESHOLD - 1);
  });

  it('describes every skill for the hangar', () => {
    const { economy } = makeEconomy();
    expect(economy.describeSkills()).toHaveLength(7);
  });

  it('re-reads the disk on reload, discarding unsaved memory', () => {
    const { economy, storage } = makeEconomy();
    economy.openCrate('standard_pod');

    saveEconomyToStorage(addScrap(createDefaultEconomyState(), 5), storage);
    expect(economy.reload().scrap).toBe(5);
  });

  it('wipes both memory and disk on reset', () => {
    const { economy, storage } = makeEconomy();
    economy.openCrate('prototype_crate');
    economy.reset();

    expect(economy.getState()).toEqual(createDefaultEconomyState());
    expect(loadEconomyFromStorage(storage)).toEqual(createDefaultEconomyState());
  });

  it('holds state in memory when autosave is off', () => {
    const { economy, storage } = makeEconomy({ autoSave: false });
    economy.openCrate('standard_pod');

    expect(economy.getState().scrap).toBe(88);
    expect(storage.map.has(ECONOMY_STORAGE_KEY)).toBe(false);
    expect(economy.save()).toBe(true);
    expect(loadEconomyFromStorage(storage).scrap).toBe(88);
  });

  it('works with no storage at all, as it would in Node', () => {
    const economy = new MetaEconomy({ storage: null, rng: constantRng(0.1), autoSave: false });
    expect(economy.getState()).toEqual(createDefaultEconomyState());
    expect(economy.openCrate('standard_pod').ok).toBe(true);
    expect(economy.getState().scrap).toBe(88);
  });
});

// ---------------------------------------------------------------------------
// Rewarded-ad doubling
// ---------------------------------------------------------------------------

describe('Doubling a crate', () => {
  /** A banked military crate: 275 scrap, one afterburner + one missiles chip. */
  function bankedCrate() {
    return openCrate(createDefaultEconomyState(), 'military_pod', constantRng(0.1));
  }

  it('grants nothing at multiplier 1, so a failed ad costs the player nothing', () => {
    const { state, result } = bankedCrate();
    const outcome = applyCrateRewards(state, result, 1);

    expect(outcome.scrap).toBe(0);
    expect(outcome.chips).toEqual({});
    // The base payout openCrate already banked is untouched.
    expect(outcome.state).toEqual(state);
  });

  it('treats a missing or nonsense multiplier as 1', () => {
    const { state, result } = bankedCrate();
    for (const multiplier of [undefined, 0, -3, NaN, 'two']) {
      expect(applyCrateRewards(state, result, multiplier).scrap, `multiplier ${multiplier}`).toBe(0);
    }
  });

  it('grants exactly one more copy at multiplier 2', () => {
    const { state, result } = bankedCrate();
    const outcome = applyCrateRewards(state, result, 2);

    expect(outcome.scrap).toBe(result.scrap);
    expect(outcome.state.scrap).toBe(result.scrap * 2);
    expect(outcome.chips).toEqual({ afterburner: 1, missiles: 1 });
    expect(outcome.state.chips.afterburner).toBe(2);
    expect(outcome.state.chips.missiles).toBe(2);
  });

  it('doubles a repeated chip to four, not to two', () => {
    // Both chips of this crate roll rare -> missiles, so the crate holds two.
    const { state, result } = openCrate(
      createDefaultEconomyState(),
      'military_pod',
      scriptedRng([0, 0.6, 0, 0.6, 0])
    );
    expect(state.chips.missiles).toBe(2);

    const outcome = applyCrateRewards(state, result, 2);
    expect(outcome.chips.missiles).toBe(2);
    expect(outcome.state.chips.missiles).toBe(4);
  });

  it('never advances the pity clock or the crate counter', () => {
    const { state, result } = bankedCrate();
    const outcome = applyCrateRewards(state, result, 2);

    // An ad is not a crate. Letting one tick the dry streak would give a player
    // who watches ads an earlier guarantee than one who does not.
    expect(outcome.state.pityCounter).toBe(state.pityCounter);
    expect(outcome.state.cratesOpenedTotal).toBe(state.cratesOpenedTotal);
  });

  it('leaves the caller state untouched', () => {
    const { state, result } = bankedCrate();
    const snapshot = JSON.stringify(state);
    applyCrateRewards(state, result, 2);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('ignores chips for skills this build no longer has', () => {
    const { state } = bankedCrate();
    const forged = { scrap: 10, chips: [{ key: 'chip_of_theseus', rarity: 'legendary' }] };

    const outcome = applyCrateRewards(state, forged, 2);
    expect(outcome.chips).toEqual({});
    expect(outcome.state.chips).not.toHaveProperty('chip_of_theseus');
    expect(outcome.state.scrap).toBe(state.scrap + 10);
  });

  it('survives a malformed result rather than throwing at the player', () => {
    const { state } = bankedCrate();
    expect(() => applyCrateRewards(state, null, 2)).not.toThrow();
    expect(applyCrateRewards(state, {}, 2).scrap).toBe(0);
  });

  it('persists the bonus through the manager', () => {
    const storage = fakeStorage();
    const economy = new MetaEconomy({ storage, rng: constantRng(0.1) });
    const { result } = economy.openCrate('military_pod');

    const granted = economy.applyCrateRewards(result, 2);
    expect(granted.scrap).toBe(275);
    expect(loadEconomyFromStorage(storage).scrap).toBe(550);
    expect(loadEconomyFromStorage(storage).chips.missiles).toBe(2);
  });
});

describe('Spending from the one wallet', () => {
  it('debits the amount', () => {
    const state = addScrap(createDefaultEconomyState(), 500);
    expect(spendScrap(state, 150).scrap).toBe(350);
  });

  it('clamps at zero rather than going negative', () => {
    // The floor is a guard, not an authorisation check — a caller that skipped
    // its own affordability test gives away a free item, which is recoverable,
    // instead of leaving a -120 balance that every later purchase fails against.
    const state = addScrap(createDefaultEconomyState(), 100);
    expect(spendScrap(state, 250).scrap).toBe(0);
  });

  it('ignores negative and fractional debits', () => {
    const state = addScrap(createDefaultEconomyState(), 100);
    expect(spendScrap(state, -50).scrap).toBe(100);
    expect(spendScrap(state, NaN).scrap).toBe(100);
    expect(spendScrap(state, 10.9).scrap).toBe(90);
  });

  it('never mutates the caller', () => {
    const state = addScrap(createDefaultEconomyState(), 500);
    spendScrap(state, 200);
    expect(state.scrap).toBe(500);
  });

  it('touches nothing but the balance', () => {
    let state = addScrap(createDefaultEconomyState(), 500);
    state = addChips(state, { emp: 3 });
    const spent = spendScrap(state, 200);

    expect(spent.chips).toEqual(state.chips);
    expect(spent.skillLevels).toEqual(state.skillLevels);
    expect(spent.pityCounter).toBe(state.pityCounter);
  });

  it('persists through the manager', () => {
    const storage = fakeStorage();
    const economy = new MetaEconomy({ storage, rng: constantRng(0.1) });
    economy.addScrap(1000);

    expect(economy.spendScrap(250)).toBe(750);
    expect(loadEconomyFromStorage(storage).scrap).toBe(750);
  });

  it('is the same wallet a chip upgrade spends from', () => {
    // The point of the merge: a hull upgrade paid through spendScrap and a chip
    // level paid through upgradeSkill draw down one number.
    const economy = new MetaEconomy({ storage: null, autoSave: false });
    economy.addScrap(1000);
    economy.addChips({ afterburner: 2 });

    economy.spendScrap(250);
    expect(economy.getState().scrap).toBe(750);

    expect(economy.upgradeSkill('afterburner').ok).toBe(true);
    expect(economy.getState().scrap).toBe(500);
  });
});
