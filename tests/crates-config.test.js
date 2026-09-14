import { describe, it, expect } from 'vitest';
import {
  CHIP_KEYS,
  CHIP_ORDER,
  CHIP_RARITIES,
  CHIP_UPGRADE_COSTS,
  CRATE_ORDER,
  CRATE_TYPES,
  INTEGER_PARAMS,
  MAX_SKILL_LEVEL,
  PITY_CRATE_THRESHOLD,
  SKILL_CHIPS,
  getChipById,
  getChipByKey,
  getChipBySkillId,
  getChipsByRarity,
  getCrateTypeById,
  getCumulativeUpgradeCost,
  getUpgradeCost,
  isRarityAtLeast,
  validateCratesConfig,
  CRATE_REWARD_BANDS,
  getCrateTypeForWave,
} from '../src/data/crates-config.js';
import { ACTIVE_SKILL_IDS, ACTIVE_SKILLS } from '../src/data/active-skills.js';
import { LARGE_CAPSULE_WEIGHTS_BY_PERFORMANCE } from '../src/data/rewards.js';

describe('Crates config validator', () => {
  it('reports no problems for the shipped tables', () => {
    const problems = validateCratesConfig();
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('Crate types', () => {
  it('carries the three crates the economy is built on', () => {
    expect(Object.keys(CRATE_TYPES).sort()).toEqual(
      ['military_pod', 'prototype_crate', 'standard_pod'].sort()
    );
    expect(CRATE_ORDER).toHaveLength(3);
  });

  it('pays the designed scrap ranges and chip counts', () => {
    expect(CRATE_TYPES.standard_pod.scrapRange).toEqual([80, 160]);
    expect(CRATE_TYPES.standard_pod.chipCount).toBe(1);

    expect(CRATE_TYPES.military_pod.scrapRange).toEqual([250, 500]);
    expect(CRATE_TYPES.military_pod.chipCount).toBe(2);

    expect(CRATE_TYPES.prototype_crate.scrapRange).toEqual([600, 1200]);
    expect(CRATE_TYPES.prototype_crate.chipCount).toBe(3);
  });

  it('carries the designed rarity weights', () => {
    expect(CRATE_TYPES.standard_pod.rarityWeights).toEqual({
      common: 80,
      rare: 20,
      legendary: 0,
    });
    expect(CRATE_TYPES.military_pod.rarityWeights).toEqual({
      common: 50,
      rare: 40,
      legendary: 10,
    });
    expect(CRATE_TYPES.prototype_crate.rarityWeights).toEqual({
      common: 20,
      rare: 55,
      legendary: 25,
    });
  });

  it('promises a rare-or-better on the military crate only', () => {
    expect(CRATE_TYPES.military_pod.guaranteedMinRarity).toBe('rare');
    expect(CRATE_TYPES.standard_pod.guaranteedMinRarity).toBeNull();
    expect(CRATE_TYPES.prototype_crate.guaranteedMinRarity).toBeNull();
  });

  it('never lets a crate promise a rarity its own weights exclude', () => {
    for (const crate of Object.values(CRATE_TYPES)) {
      if (!crate.guaranteedMinRarity) continue;
      const reachableWeight = CHIP_RARITIES.filter((r) =>
        isRarityAtLeast(r, crate.guaranteedMinRarity)
      ).reduce((sum, r) => sum + crate.rarityWeights[r], 0);
      expect(reachableWeight, `${crate.id} cannot satisfy its own guarantee`).toBeGreaterThan(0);
    }
  });

  it('looks crates up by id and returns null for an unknown one', () => {
    expect(getCrateTypeById('military_pod')).toBe(CRATE_TYPES.military_pod);
    expect(getCrateTypeById('nope')).toBeNull();
  });
});

describe('Skill chips', () => {
  it('covers all seven active skills exactly once', () => {
    const skillIds = Object.values(ACTIVE_SKILL_IDS);
    expect(skillIds).toHaveLength(7);
    expect(CHIP_ORDER).toHaveLength(7);

    const covered = CHIP_ORDER.map((id) => SKILL_CHIPS[id].skillId);
    expect(new Set(covered).size).toBe(7);
    for (const skillId of skillIds) {
      expect(covered, `no chip upgrades ${skillId}`).toContain(skillId);
    }
  });

  it('uses the chip ids named in the brief', () => {
    expect(CHIP_ORDER.sort()).toEqual(
      [
        'chip_afterburner',
        'chip_emp',
        'chip_missiles',
        'chip_phase_shift',
        'chip_singularity',
        'chip_overcharge',
        'chip_point_defense',
      ].sort()
    );
  });

  it('derives every save key from its chip id', () => {
    for (const [id, chip] of Object.entries(SKILL_CHIPS)) {
      expect(id).toBe(`chip_${chip.key}`);
    }
    expect(CHIP_KEYS).toHaveLength(7);
    expect(new Set(CHIP_KEYS).size).toBe(7);
  });

  it('gives every chip a known rarity, and fills every bucket', () => {
    for (const chip of Object.values(SKILL_CHIPS)) {
      expect(CHIP_RARITIES, `${chip.id} rarity`).toContain(chip.rarity);
    }
    // An empty bucket would make its weight unrollable, which the roller has to
    // special-case instead of simply drawing from it.
    for (const rarity of CHIP_RARITIES) {
      expect(getChipsByRarity(rarity).length, `${rarity} bucket is empty`).toBeGreaterThan(0);
    }
  });

  it('scales only params that exist on the skill it upgrades', () => {
    for (const chip of Object.values(SKILL_CHIPS)) {
      const skill = ACTIVE_SKILLS[chip.skillId];
      for (const param of Object.keys(chip.scaling.params ?? {})) {
        expect(skill.params, `${chip.id} scales unknown param ${param}`).toHaveProperty(param);
        expect(Number.isFinite(skill.params[param]), `${chip.id}.${param} is not numeric`).toBe(true);
      }
    }
  });

  it('never scales the duration of an instant skill', () => {
    for (const chip of Object.values(SKILL_CHIPS)) {
      if (!chip.scaling.duration) continue;
      expect(ACTIVE_SKILLS[chip.skillId].duration, `${chip.id} scales a zero duration`).toBeGreaterThan(0);
    }
    // The EMP is the instant skill this rule exists for.
    expect(ACTIVE_SKILLS[ACTIVE_SKILL_IDS.EMP_SHOCKWAVE].duration).toBe(0);
    expect(SKILL_CHIPS.chip_emp.scaling.duration).toBeUndefined();
  });

  it('starts every scaling curve at exactly 1 and runs it to max level', () => {
    for (const chip of Object.values(SKILL_CHIPS)) {
      const curves = [
        ...(chip.scaling.cooldown ? [['cooldown', chip.scaling.cooldown]] : []),
        ...(chip.scaling.duration ? [['duration', chip.scaling.duration]] : []),
        ...Object.entries(chip.scaling.params ?? {}),
      ];
      expect(curves.length, `${chip.id} scales nothing`).toBeGreaterThan(0);

      for (const [name, curve] of curves) {
        expect(curve, `${chip.id}.${name}`).toHaveLength(MAX_SKILL_LEVEL);
        // Level 1 must be the untouched table value, or an un-upgraded skill
        // would behave differently from what active-skills.js says it does.
        expect(curve[0], `${chip.id}.${name} level 1`).toBe(1);
      }
    }
  });

  it('gives the Afterburner the duration and speed growth the brief asks for', () => {
    const { scaling } = SKILL_CHIPS.chip_afterburner;
    expect(scaling.duration[MAX_SKILL_LEVEL - 1]).toBeGreaterThan(1);
    expect(scaling.params.speedMultiplier[MAX_SKILL_LEVEL - 1]).toBeGreaterThan(1);
    // Speed and acceleration must move together or the burst stops reading.
    expect(scaling.params.accelMultiplier).toEqual(scaling.params.speedMultiplier);
  });

  it('grows the Singularity capture field', () => {
    const curve = SKILL_CHIPS.chip_singularity.scaling.params.radius;
    expect(curve[MAX_SKILL_LEVEL - 1]).toBeGreaterThan(1);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i], `radius must not shrink at level ${i + 1}`).toBeGreaterThan(curve[i - 1]);
    }
  });

  it('walks the Overcharge speed penalty back toward 1 without reaching it', () => {
    const base = ACTIVE_SKILLS[ACTIVE_SKILL_IDS.OVERCHARGE_CORE].params.moveSpeedMultiplier;
    const curve = SKILL_CHIPS.chip_overcharge.scaling.params.moveSpeedMultiplier;
    const atMax = base * curve[MAX_SKILL_LEVEL - 1];
    expect(atMax).toBeGreaterThan(base);
    expect(atMax, 'the trade-off is the skill').toBeLessThan(1);
  });

  it('lands every integer param on a whole number at every level', () => {
    for (const chip of Object.values(SKILL_CHIPS)) {
      const skill = ACTIVE_SKILLS[chip.skillId];
      for (const [param, curve] of Object.entries(chip.scaling.params ?? {})) {
        if (!INTEGER_PARAMS.has(param)) continue;
        for (let level = 0; level < curve.length; level++) {
          const scaled = skill.params[param] * curve[level];
          expect(
            Math.abs(scaled - Math.round(scaled)),
            `${chip.id}.${param} at level ${level + 1} is ${scaled}`
          ).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('looks chips up by id, key and skill id', () => {
    expect(getChipById('chip_emp')).toBe(SKILL_CHIPS.chip_emp);
    expect(getChipByKey('emp')).toBe(SKILL_CHIPS.chip_emp);
    expect(getChipBySkillId(ACTIVE_SKILL_IDS.EMP_SHOCKWAVE)).toBe(SKILL_CHIPS.chip_emp);

    expect(getChipById('chip_nope')).toBeNull();
    expect(getChipByKey('nope')).toBeNull();
    expect(getChipBySkillId('nope')).toBeNull();
  });
});

describe('Rarity ordering', () => {
  it('ranks the tiers weakest first', () => {
    expect(CHIP_RARITIES).toEqual(['common', 'rare', 'legendary']);
  });

  it('treats a tier as meeting its own floor', () => {
    expect(isRarityAtLeast('rare', 'rare')).toBe(true);
    expect(isRarityAtLeast('legendary', 'rare')).toBe(true);
    expect(isRarityAtLeast('common', 'rare')).toBe(false);
  });

  it('is false for a rarity it has never heard of', () => {
    expect(isRarityAtLeast('mythic', 'rare')).toBe(false);
    expect(isRarityAtLeast('rare', 'mythic')).toBe(false);
  });
});

describe('Upgrade ladder', () => {
  it('charges the designed price at each level', () => {
    expect(CHIP_UPGRADE_COSTS[2]).toEqual({ chips: 2, scrap: 250 });
    expect(CHIP_UPGRADE_COSTS[3]).toEqual({ chips: 4, scrap: 600 });
    expect(CHIP_UPGRADE_COSTS[4]).toEqual({ chips: 8, scrap: 1400 });
    expect(CHIP_UPGRADE_COSTS[5]).toEqual({ chips: 15, scrap: 3000 });
  });

  it('stops at level 5', () => {
    expect(MAX_SKILL_LEVEL).toBe(5);
    expect(getUpgradeCost(MAX_SKILL_LEVEL)).toBeNull();
    expect(CHIP_UPGRADE_COSTS[MAX_SKILL_LEVEL + 1]).toBeUndefined();
  });

  it('quotes the cost of the level being bought, not the level held', () => {
    expect(getUpgradeCost(1)).toEqual(CHIP_UPGRADE_COSTS[2]);
    expect(getUpgradeCost(4)).toEqual(CHIP_UPGRADE_COSTS[5]);
  });

  it('never gets cheaper as it climbs', () => {
    for (let level = 3; level <= MAX_SKILL_LEVEL; level++) {
      expect(CHIP_UPGRADE_COSTS[level].chips).toBeGreaterThan(CHIP_UPGRADE_COSTS[level - 1].chips);
      expect(CHIP_UPGRADE_COSTS[level].scrap).toBeGreaterThan(CHIP_UPGRADE_COSTS[level - 1].scrap);
    }
  });

  it('totals the whole climb to max', () => {
    expect(getCumulativeUpgradeCost(1)).toEqual({ chips: 0, scrap: 0 });
    expect(getCumulativeUpgradeCost(3)).toEqual({ chips: 6, scrap: 850 });
    expect(getCumulativeUpgradeCost(MAX_SKILL_LEVEL)).toEqual({ chips: 29, scrap: 5250 });
  });

  it('clamps a nonsense level rather than throwing', () => {
    expect(getCumulativeUpgradeCost(0)).toEqual({ chips: 0, scrap: 0 });
    expect(getCumulativeUpgradeCost(99)).toEqual(getCumulativeUpgradeCost(MAX_SKILL_LEVEL));
  });
});

describe('Pity rule', () => {
  it('promises a rare by the fourth crate of a dry streak', () => {
    expect(PITY_CRATE_THRESHOLD).toBe(3);
  });
});

describe('Run reward bands', () => {
  it('pays the crate the brief specifies for each wave band', () => {
    expect(getCrateTypeForWave(1)).toBe('standard_pod');
    expect(getCrateTypeForWave(4)).toBe('standard_pod');
    expect(getCrateTypeForWave(5)).toBe('military_pod');
    expect(getCrateTypeForWave(9)).toBe('military_pod');
    expect(getCrateTypeForWave(10)).toBe('prototype_crate');
    expect(getCrateTypeForWave(47)).toBe('prototype_crate');
  });

  it('covers every wave with exactly one band', () => {
    for (let wave = 1; wave <= 200; wave++) {
      const matches = CRATE_REWARD_BANDS.filter(
        (band) => wave >= band.minWave && wave <= band.maxWave
      );
      expect(matches.length, `wave ${wave} matched ${matches.length} bands`).toBe(1);
    }
  });

  it('names a real crate in every band', () => {
    for (const band of CRATE_REWARD_BANDS) {
      expect(CRATE_TYPES, `band at wave ${band.minWave}`).toHaveProperty(band.crateId);
    }
  });

  it('never pays a worse crate for a deeper run', () => {
    const rank = (id) => CRATE_ORDER.indexOf(id);
    for (let wave = 2; wave <= 200; wave++) {
      expect(
        rank(getCrateTypeForWave(wave)),
        `wave ${wave} pays worse than wave ${wave - 1}`
      ).toBeGreaterThanOrEqual(rank(getCrateTypeForWave(wave - 1)));
    }
  });

  it('clamps a run that ended before wave 1 rather than paying nothing', () => {
    expect(getCrateTypeForWave(0)).toBe('standard_pod');
    expect(getCrateTypeForWave(-3)).toBe('standard_pod');
    expect(getCrateTypeForWave(NaN)).toBe('standard_pod');
  });

  it('cuts its bands where the capsule table cuts its own', () => {
    // The two payouts on the debrief must agree about what a good run is.
    const capsuleCuts = LARGE_CAPSULE_WEIGHTS_BY_PERFORMANCE.map((row) => row.minWave);
    expect(CRATE_REWARD_BANDS.map((row) => row.minWave)).toEqual(capsuleCuts);
  });
});
