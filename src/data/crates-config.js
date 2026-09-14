/**
 * Salvage Crates, Tactical Chips and the upgrade ladder (Step 3.1).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 * ---------------------------------------------------------------------------
 * The whole meta-economy's tuning surface: what a crate pays, how often a chip
 * of each rarity falls out, what a level costs, and how much stronger a skill
 * gets for paying it. THIS FILE IS DATA ONLY. Nothing in it knows what a
 * Simulation or a save file is — the roll algorithm, the wallet and the
 * persistence all live in src/core/meta-economy.js, keyed by the same ids.
 *
 * That split is the same one src/data/active-skills.js draws, and for the same
 * reason: retuning a drop rate should never mean opening a file with game logic
 * in it, and drop rates are the numbers that get retuned the most.
 *
 * ---------------------------------------------------------------------------
 * ONE CHIP PER SKILL, AND THE VALIDATOR THAT ENFORCES IT
 * ---------------------------------------------------------------------------
 * The chip table is a 1:1 cover of ACTIVE_SKILL_IDS. There is no chip without a
 * skill and no skill without a chip, because a chip that upgrades nothing is a
 * dead drop and a skill nobody can upgrade is a dead hangar slot — and both
 * failures are invisible until a player hits them. `validateCratesConfig()`
 * checks the cover, and checks that every parameter a chip claims to scale
 * actually exists on its skill, so a rename in active-skills.js fails a unit
 * test naming the row instead of silently scaling nothing.
 *
 * ---------------------------------------------------------------------------
 * UNITS
 * ---------------------------------------------------------------------------
 * Scrap is an integer currency. Every `scaling` entry is a MULTIPLIER against
 * the level-1 value in active-skills.js, never an absolute — so a designer who
 * retunes a base cooldown there does not have to retune five numbers here.
 */

import { ACTIVE_SKILL_IDS, ACTIVE_SKILLS } from './active-skills.js';

/**
 * Chip rarity, weakest first. The order is load-bearing: a "rare or better"
 * floor is an index comparison against this array, so inserting a tier in the
 * middle changes what every pity and guarantee rule means.
 */
export const CHIP_RARITIES = ['common', 'rare', 'legendary'];

/** Ceiling for every skill. Level 1 is the un-upgraded baseline, not level 0. */
export const MAX_SKILL_LEVEL = 5;

/**
 * Crates opened with no rare-or-better chip before the next crate's FIRST chip
 * is forced to rare.
 *
 * Three is deliberately short. This is a retention lever, not a gacha ceiling:
 * the point is that a player who opens a handful of standard pods in one
 * evening cannot walk away having seen nothing but commons.
 */
export const PITY_CRATE_THRESHOLD = 3;

/**
 * Cost to reach each level, paid in chips OF THAT SKILL plus shared Scrap.
 *
 * Keyed by the level being PURCHASED, so the key reads the way the hangar label
 * does ("Level 3: 4 chips + 600 scrap"). The chip half roughly doubles while
 * the Scrap half more than doubles, which makes Scrap the binding constraint
 * late — intentional, since Scrap is the half a player can influence by playing
 * better rather than by opening more crates.
 */
export const CHIP_UPGRADE_COSTS = {
  2: { chips: 2, scrap: 250 },
  3: { chips: 4, scrap: 600 },
  4: { chips: 8, scrap: 1400 },
  5: { chips: 15, scrap: 3000 },
};

/**
 * The cooldown reward every chip shares, indexed by level - 1.
 *
 * Uniform on purpose. Cooldown is the one lever a player feels without reading
 * a tooltip, so every skill pays it out on the same curve and each chip's own
 * entries are free to be its signature stats instead. Level 2 is deliberately a
 * small step: the first upgrade should confirm the system works, not rewrite
 * the skill.
 */
const COOLDOWN_CURVE = [1, 0.96, 0.92, 0.88, 0.82];

/**
 * Params whose handler needs a WHOLE number, so a scaled value must be rounded
 * rather than left fractional.
 *
 * Listed by name instead of inferred from the base value, because the base
 * value is a liar: `turnRate: 5` and `cooldown: 8` are integers to JavaScript
 * and continuous quantities to the game, and rounding them would quietly
 * flatten their curves to nothing. These two are genuinely discrete — `count`
 * is a loop bound and `bladeCount` is how many sprites get spawned — and the
 * multipliers that scale them are chosen to land on exact integers anyway, so
 * the rounding is a guard against float noise rather than a balance decision.
 */
export const INTEGER_PARAMS = new Set(['count', 'bladeCount']);

/**
 * @typedef {Object} CrateTypeDef
 * @property {string} id
 * @property {string} name - Player-facing name
 * @property {string} description - Player-facing one-liner
 * @property {[number, number]} scrapRange - Inclusive integer range
 * @property {number} chipCount - Chips rolled per crate
 * @property {Object<string, number>} rarityWeights - Relative; need not sum to 100
 * @property {string|null} guaranteedMinRarity - Floor applied to the LAST chip
 *   if no earlier chip in the same crate already met it
 */

/**
 * The three crates a run can pay out.
 *
 * Weights are relative, not percentages — the roller normalises by their own
 * total. They happen to sum to 100 because that is how they are easiest to
 * reason about, but nothing depends on it, and a pity or guarantee floor
 * re-normalises over the surviving subset rather than renumbering the table.
 *
 * @type {Record<string, CrateTypeDef>}
 */
export const CRATE_TYPES = {
  standard_pod: {
    id: 'standard_pod',
    name: 'Standard Cargo Pod',
    description: 'Routine salvage. One chip, and rarely an interesting one.',
    scrapRange: [80, 160],
    chipCount: 1,
    /**
     * Legendary is flatly zero here, not merely unlikely. The standard pod is
     * the crate a player sees most, and a 1-in-200 legendary on it would make
     * the two earned crates feel like a worse version of grinding.
     */
    rarityWeights: { common: 80, rare: 20, legendary: 0 },
    guaranteedMinRarity: null,
  },

  military_pod: {
    id: 'military_pod',
    name: 'Military Supply Crate',
    description: 'Two chips, at least one of them worth having.',
    scrapRange: [250, 500],
    chipCount: 2,
    rarityWeights: { common: 50, rare: 40, legendary: 10 },
    /**
     * The floor is what separates this from "a standard pod twice". Without it
     * 25% of military crates would be two commons — and a crate the player
     * earned paying out worse than the free one is the fastest way to make an
     * economy feel dishonest.
     */
    guaranteedMinRarity: 'rare',
  },

  prototype_crate: {
    id: 'prototype_crate',
    name: 'Prototype R&D Case',
    description: 'Three chips off the experimental bench, and a heavy scrap haul.',
    scrapRange: [600, 1200],
    chipCount: 3,
    /**
     * No explicit guarantee: at 80% rare-or-better per chip, three chips miss
     * entirely 0.8% of the time, and the shared pity counter already catches
     * that on the next crate. A second floor here would only ever fire in the
     * situation pity was built for.
     */
    rarityWeights: { common: 20, rare: 55, legendary: 25 },
    guaranteedMinRarity: null,
  },
};

/** Fixed display order for any UI listing crates cheapest-first. */
export const CRATE_ORDER = ['standard_pod', 'military_pod', 'prototype_crate'];

/**
 * Which crate a finished run pays out, by the wave it reached. Bands are
 * inclusive on both ends.
 *
 * The bands are deliberately the SAME cuts as
 * LARGE_CAPSULE_WEIGHTS_BY_PERFORMANCE in rewards.js (1-4, 5-9, 10+). A player
 * who learns that wave 5 is where the rewards step up should find that true of
 * both payouts, not of one and not the other — two different definitions of "a
 * good run" in the same debrief is how a reward screen stops teaching anything.
 *
 * @type {Array<{minWave: number, maxWave: number, crateId: string}>}
 */
export const CRATE_REWARD_BANDS = [
  { minWave: 1, maxWave: 4, crateId: 'standard_pod' },
  { minWave: 5, maxWave: 9, crateId: 'military_pod' },
  { minWave: 10, maxWave: 999, crateId: 'prototype_crate' },
];

/**
 * The crate earned by reaching `waveReached`.
 *
 * Clamps rather than throwing at both ends: wave 0 (a run that ended before the
 * first wave finished) still earns the entry crate, and a run past the last
 * band's ceiling takes the top one.
 *
 * @param {number} waveReached
 * @returns {string} A CRATE_TYPES id
 */
export function getCrateTypeForWave(waveReached) {
  const wave = Math.max(1, Math.floor(waveReached) || 1);
  const band = CRATE_REWARD_BANDS.find((row) => wave >= row.minWave && wave <= row.maxWave);
  return (band ?? CRATE_REWARD_BANDS[CRATE_REWARD_BANDS.length - 1]).crateId;
}

/**
 * @typedef {Object} SkillChipDef
 * @property {string} id - Drop-table id, always `chip_` + key
 * @property {string} key - Save-data key; the id without its `chip_` prefix
 * @property {string} skillId - The ACTIVE_SKILLS row this chip upgrades
 * @property {string} name - Player-facing name
 * @property {string} rarity - One of CHIP_RARITIES
 * @property {{cooldown?: number[], duration?: number[], params?: Object<string, number[]>}} scaling
 *   Multipliers against the level-1 value, indexed by level - 1. Index 0 is
 *   always exactly 1: level 1 IS the table in active-skills.js.
 */

/**
 * The seven chips, one per active skill.
 *
 * RARITY IS NOT POWER. A chip's rarity decides how often it drops and nothing
 * else — a level-5 Afterburner costs exactly what a level-5 Singularity Anchor
 * costs. Rarity tracks how much a skill warps a run when a player leans on it:
 * Afterburner, EMP and Point-Defense are the three whose worst case is a wasted
 * cooldown, so they are the commons, and the ones a new player will actually
 * get to level 3. The Singularity Anchor is alone at legendary because it is
 * the only skill that removes a whole wave's worth of positioning pressure, and
 * a player who hit level 5 on it early would flatten the difficulty curve the
 * wave table is built on.
 *
 * @type {Record<string, SkillChipDef>}
 */
export const SKILL_CHIPS = {
  chip_afterburner: {
    id: 'chip_afterburner',
    key: 'afterburner',
    skillId: ACTIVE_SKILL_IDS.AFTERBURNER,
    name: 'Afterburner Coil',
    rarity: 'common',
    scaling: {
      cooldown: COOLDOWN_CURVE,
      /** The burst window, 2.2s -> 3.4s. */
      duration: [1, 1.1, 1.22, 1.36, 1.55],
      params: {
        /**
         * Speed and acceleration move together, as active-skills.js insists:
         * raising top speed alone produces a ship that is faster but takes the
         * same quarter-second to get there, which does not read as a burst.
         */
        speedMultiplier: [1, 1.07, 1.14, 1.22, 1.3],
        accelMultiplier: [1, 1.07, 1.14, 1.22, 1.3],
        ramDamage: [1, 1.15, 1.3, 1.5, 1.75],
      },
    },
  },

  chip_emp: {
    id: 'chip_emp',
    key: 'emp',
    skillId: ACTIVE_SKILL_IDS.EMP_SHOCKWAVE,
    name: 'EMP Capacitor',
    rarity: 'common',
    scaling: {
      cooldown: COOLDOWN_CURVE,
      /** No `duration` entry: the EMP resolves instantly and has no window. */
      params: {
        radius: [1, 1.12, 1.25, 1.4, 1.6],
        stun: [1, 1.1, 1.2, 1.35, 1.5],
        damage: [1, 1.2, 1.45, 1.75, 2.1],
      },
    },
  },

  chip_missiles: {
    id: 'chip_missiles',
    key: 'missiles',
    skillId: ACTIVE_SKILL_IDS.MISSILE_SALVO,
    name: 'Micro-Missile Rack',
    rarity: 'rare',
    scaling: {
      cooldown: COOLDOWN_CURVE,
      params: {
        /**
         * 8 -> 9, 10, 12, 14. `count` is a loop bound in the handler, and the
         * resolver rounds any param whose base value is an integer, so these
         * multipliers are chosen to land cleanly rather than to look tidy.
         */
        count: [1, 1.125, 1.25, 1.5, 1.75],
        damage: [1, 1.15, 1.3, 1.5, 1.7],
        turnRate: [1, 1.05, 1.1, 1.18, 1.28],
      },
    },
  },

  chip_phase_shift: {
    id: 'chip_phase_shift',
    key: 'phase_shift',
    skillId: ACTIVE_SKILL_IDS.PHASE_SHIFT,
    name: 'Phase Inducer',
    rarity: 'rare',
    scaling: {
      cooldown: COOLDOWN_CURVE,
      /**
       * The i-frame window, 0.75s -> 1.0s. This is the real upgrade: distance
       * only moves you, the trailing invulnerability is what saves you, and
       * active-skills.js runs the i-frames for the whole `duration`.
       */
      duration: [1, 1.08, 1.16, 1.26, 1.36],
      params: {
        distance: [1, 1.06, 1.12, 1.2, 1.3],
      },
    },
  },

  chip_singularity: {
    id: 'chip_singularity',
    key: 'singularity',
    skillId: ACTIVE_SKILL_IDS.SINGULARITY_ANCHOR,
    name: 'Singularity Core',
    rarity: 'legendary',
    scaling: {
      cooldown: COOLDOWN_CURVE,
      duration: [1, 1.08, 1.17, 1.28, 1.4],
      params: {
        /** The capture field, 220px -> 330px. The chip's signature stat. */
        radius: [1, 1.12, 1.25, 1.38, 1.5],
        pullSpeed: [1, 1.08, 1.16, 1.26, 1.38],
        damage: [1, 1.2, 1.4, 1.65, 1.95],
      },
    },
  },

  chip_overcharge: {
    id: 'chip_overcharge',
    key: 'overcharge',
    skillId: ACTIVE_SKILL_IDS.OVERCHARGE_CORE,
    name: 'Overcharge Regulator',
    rarity: 'rare',
    scaling: {
      cooldown: COOLDOWN_CURVE,
      duration: [1, 1.1, 1.2, 1.32, 1.45],
      params: {
        fireRateMultiplier: [1, 1.08, 1.16, 1.26, 1.38],
        /**
         * Multiplying the 0.75 PENALTY by >1 walks it back toward 1.0 (0.75 ->
         * 0.855), so levelling buys back some of the speed the skill costs. The
         * regulator never reaches 1.0: the trade-off is the skill.
         */
        moveSpeedMultiplier: [1, 1.03, 1.06, 1.1, 1.14],
      },
    },
  },

  chip_point_defense: {
    id: 'chip_point_defense',
    key: 'point_defense',
    skillId: ACTIVE_SKILL_IDS.POINT_DEFENSE,
    name: 'Point-Defense Servo',
    rarity: 'common',
    scaling: {
      cooldown: COOLDOWN_CURVE,
      duration: [1, 1.1, 1.2, 1.31, 1.43],
      params: {
        /** 2 -> 3, 4, 5, 6 blades; integer-rounded like missile `count`. */
        bladeCount: [1, 1.5, 2, 2.5, 3],
        damage: [1, 1.15, 1.3, 1.45, 1.6],
        interceptRadius: [1, 1.06, 1.12, 1.2, 1.28],
      },
    },
  },
};

/** Fixed display order, matching ACTIVE_SKILL_ORDER so the hangar lines up. */
export const CHIP_ORDER = [
  'chip_afterburner',
  'chip_emp',
  'chip_missiles',
  'chip_phase_shift',
  'chip_singularity',
  'chip_overcharge',
  'chip_point_defense',
];

/** Save-data keys, in display order. The shape of `chips` and `skillLevels`. */
export const CHIP_KEYS = CHIP_ORDER.map((id) => SKILL_CHIPS[id].key);

/**
 * @param {string} id
 * @returns {SkillChipDef|null}
 */
export function getChipById(id) {
  return SKILL_CHIPS[id] ?? null;
}

/**
 * Look a chip up by its save-data key (`afterburner`, not `chip_afterburner`).
 * @param {string} key
 * @returns {SkillChipDef|null}
 */
export function getChipByKey(key) {
  const id = CHIP_ORDER.find((chipId) => SKILL_CHIPS[chipId].key === key);
  return id ? SKILL_CHIPS[id] : null;
}

/**
 * The chip that upgrades a given active skill.
 * @param {string} skillId
 * @returns {SkillChipDef|null}
 */
export function getChipBySkillId(skillId) {
  const id = CHIP_ORDER.find((chipId) => SKILL_CHIPS[chipId].skillId === skillId);
  return id ? SKILL_CHIPS[id] : null;
}

/**
 * Every chip of a rarity, in display order — the roll pool for one bucket.
 * @param {string} rarity
 * @returns {SkillChipDef[]}
 */
export function getChipsByRarity(rarity) {
  return CHIP_ORDER.map((id) => SKILL_CHIPS[id]).filter((chip) => chip.rarity === rarity);
}

/**
 * Is `rarity` at least `minRarity`? Index comparison against CHIP_RARITIES.
 * @param {string} rarity
 * @param {string} minRarity
 * @returns {boolean}
 */
export function isRarityAtLeast(rarity, minRarity) {
  const have = CHIP_RARITIES.indexOf(rarity);
  const need = CHIP_RARITIES.indexOf(minRarity);
  if (have < 0 || need < 0) return false;
  return have >= need;
}

/**
 * @param {string} id
 * @returns {CrateTypeDef|null}
 */
export function getCrateTypeById(id) {
  return CRATE_TYPES[id] ?? null;
}

/**
 * Cost of the NEXT level up from `currentLevel`, or null at the ceiling.
 * @param {number} currentLevel
 * @returns {{chips: number, scrap: number}|null}
 */
export function getUpgradeCost(currentLevel) {
  return CHIP_UPGRADE_COSTS[currentLevel + 1] ?? null;
}

/**
 * Total chips and Scrap to take a skill from level 1 to `level` — for the
 * hangar's "3200 scrap from maxed" line.
 *
 * @param {number} level
 * @returns {{chips: number, scrap: number}}
 */
export function getCumulativeUpgradeCost(level) {
  const target = Math.min(MAX_SKILL_LEVEL, Math.max(1, Math.floor(level) || 1));
  let chips = 0;
  let scrap = 0;
  for (let next = 2; next <= target; next++) {
    chips += CHIP_UPGRADE_COSTS[next].chips;
    scrap += CHIP_UPGRADE_COSTS[next].scrap;
  }
  return { chips, scrap };
}

/**
 * Structural audit of every table in this file, run by
 * tests/crates-config.test.js.
 *
 * One pass, every problem reported — a typo should fail a test that names the
 * row, not produce a chip that scales nothing or a crate that can never roll.
 *
 * @returns {string[]} Human-readable problems; empty means the config is sound
 */
export function validateCratesConfig() {
  const problems = [];
  const rarities = new Set(CHIP_RARITIES);

  /** A scaling curve must be MAX_SKILL_LEVEL long and start at exactly 1. */
  const checkCurve = (where, curve) => {
    if (!Array.isArray(curve) || curve.length !== MAX_SKILL_LEVEL) {
      problems.push(`${where}: scaling curve must have ${MAX_SKILL_LEVEL} entries`);
      return;
    }
    if (curve[0] !== 1) {
      problems.push(`${where}: level 1 multiplier must be exactly 1, got ${curve[0]}`);
    }
    for (let i = 0; i < curve.length; i++) {
      if (!Number.isFinite(curve[i]) || curve[i] <= 0) {
        problems.push(`${where}: multiplier at level ${i + 1} must be a positive number`);
      }
    }
  };

  // ---- Crates ------------------------------------------------------------
  for (const [key, crate] of Object.entries(CRATE_TYPES)) {
    const where = `CRATE_TYPES.${key}`;
    if (crate.id !== key) problems.push(`${where}: id "${crate.id}" does not match its key`);

    const [min, max] = crate.scrapRange ?? [];
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      problems.push(`${where}: scrapRange must be two integers`);
    } else if (min < 0 || max < min) {
      problems.push(`${where}: scrapRange must be 0 <= min <= max`);
    }

    if (!Number.isInteger(crate.chipCount) || crate.chipCount < 1) {
      problems.push(`${where}: chipCount must be an integer >= 1`);
    }

    let weightTotal = 0;
    for (const [rarity, weight] of Object.entries(crate.rarityWeights ?? {})) {
      if (!rarities.has(rarity)) problems.push(`${where}: unknown rarity "${rarity}"`);
      if (!Number.isFinite(weight) || weight < 0) {
        problems.push(`${where}: weight for "${rarity}" must be >= 0`);
      } else {
        weightTotal += weight;
      }
    }
    for (const rarity of CHIP_RARITIES) {
      if (!(rarity in (crate.rarityWeights ?? {}))) {
        problems.push(`${where}: missing a weight for "${rarity}" (use 0 to exclude it)`);
      }
    }
    if (weightTotal <= 0) problems.push(`${where}: rarity weights sum to 0, nothing can drop`);

    // A floor the weights can never satisfy would silently degrade to the
    // unfloored roll, which is exactly the bug the floor exists to prevent.
    const floor = crate.guaranteedMinRarity;
    if (floor !== null && floor !== undefined) {
      if (!rarities.has(floor)) {
        problems.push(`${where}: unknown guaranteedMinRarity "${floor}"`);
      } else {
        const reachable = CHIP_RARITIES.filter((r) => isRarityAtLeast(r, floor)).some(
          (r) => (crate.rarityWeights?.[r] ?? 0) > 0
        );
        if (!reachable) {
          problems.push(`${where}: guaranteedMinRarity "${floor}" has zero weight in this crate`);
        }
      }
    }
  }

  for (const id of CRATE_ORDER) {
    if (!CRATE_TYPES[id]) problems.push(`CRATE_ORDER lists unknown crate "${id}"`);
  }
  if (CRATE_ORDER.length !== Object.keys(CRATE_TYPES).length) {
    problems.push('CRATE_ORDER must list every crate exactly once');
  }

  // A gap between bands would hand a run that landed in it no crate at all,
  // and an overlap would make which crate it earns depend on array order.
  let expectedNextWave = 1;
  for (const [index, band] of CRATE_REWARD_BANDS.entries()) {
    const where = `CRATE_REWARD_BANDS[${index}]`;
    if (!CRATE_TYPES[band.crateId]) {
      problems.push(`${where}: unknown crate "${band.crateId}"`);
    }
    if (band.minWave !== expectedNextWave) {
      problems.push(`${where}: starts at wave ${band.minWave}, expected ${expectedNextWave}`);
    }
    if (band.maxWave < band.minWave) {
      problems.push(`${where}: maxWave must be >= minWave`);
    }
    expectedNextWave = band.maxWave + 1;
  }

  // ---- Chips -------------------------------------------------------------
  const seenSkills = new Set();
  const seenKeys = new Set();

  for (const [id, chip] of Object.entries(SKILL_CHIPS)) {
    const where = `SKILL_CHIPS.${id}`;
    if (chip.id !== id) problems.push(`${where}: id "${chip.id}" does not match its key`);
    if (id !== `chip_${chip.key}`) {
      problems.push(`${where}: id must be "chip_" + key, got key "${chip.key}"`);
    }
    if (seenKeys.has(chip.key)) problems.push(`${where}: duplicate save key "${chip.key}"`);
    seenKeys.add(chip.key);

    if (!rarities.has(chip.rarity)) problems.push(`${where}: unknown rarity "${chip.rarity}"`);

    const skill = ACTIVE_SKILLS[chip.skillId];
    if (!skill) {
      problems.push(`${where}: unknown skillId "${chip.skillId}"`);
      continue;
    }
    if (seenSkills.has(chip.skillId)) {
      problems.push(`${where}: skill "${chip.skillId}" already has a chip`);
    }
    seenSkills.add(chip.skillId);

    const scaling = chip.scaling ?? {};
    if (scaling.cooldown) checkCurve(`${where}.scaling.cooldown`, scaling.cooldown);

    if (scaling.duration) {
      checkCurve(`${where}.scaling.duration`, scaling.duration);
      // Scaling a zero-length active window multiplies 0 by everything and
      // reads, in a tooltip, as an upgrade that does nothing.
      if (!(skill.duration > 0)) {
        problems.push(`${where}: scales duration, but "${chip.skillId}" is instant (duration 0)`);
      }
    }

    for (const [param, curve] of Object.entries(scaling.params ?? {})) {
      const paramWhere = `${where}.scaling.params.${param}`;
      if (!(param in (skill.params ?? {}))) {
        problems.push(`${paramWhere}: "${chip.skillId}" has no such param`);
        continue;
      }
      if (!Number.isFinite(skill.params[param])) {
        problems.push(`${paramWhere}: base value is not a number, cannot be scaled`);
        continue;
      }
      checkCurve(paramWhere, curve);
    }
  }

  for (const skillId of Object.values(ACTIVE_SKILL_IDS)) {
    if (!seenSkills.has(skillId)) problems.push(`No chip upgrades active skill "${skillId}"`);
  }

  for (const id of CHIP_ORDER) {
    if (!SKILL_CHIPS[id]) problems.push(`CHIP_ORDER lists unknown chip "${id}"`);
  }
  if (CHIP_ORDER.length !== Object.keys(SKILL_CHIPS).length) {
    problems.push('CHIP_ORDER must list every chip exactly once');
  }

  // ---- Upgrade ladder ----------------------------------------------------
  let prevChips = 0;
  let prevScrap = 0;
  for (let level = 2; level <= MAX_SKILL_LEVEL; level++) {
    const cost = CHIP_UPGRADE_COSTS[level];
    const where = `CHIP_UPGRADE_COSTS.${level}`;
    if (!cost) {
      problems.push(`${where}: missing a cost for level ${level}`);
      continue;
    }
    if (!Number.isInteger(cost.chips) || cost.chips < 1) {
      problems.push(`${where}: chips must be an integer >= 1`);
    }
    if (!Number.isInteger(cost.scrap) || cost.scrap < 0) {
      problems.push(`${where}: scrap must be a non-negative integer`);
    }
    // A ladder that ever gets cheaper means a later level is a better deal than
    // an earlier one, and the hangar's sort order stops meaning anything.
    if (cost.chips <= prevChips) problems.push(`${where}: chip cost must exceed level ${level - 1}`);
    if (cost.scrap <= prevScrap) problems.push(`${where}: scrap cost must exceed level ${level - 1}`);
    prevChips = cost.chips;
    prevScrap = cost.scrap;
  }
  for (const level of Object.keys(CHIP_UPGRADE_COSTS)) {
    if (Number(level) > MAX_SKILL_LEVEL) {
      problems.push(`CHIP_UPGRADE_COSTS.${level}: beyond MAX_SKILL_LEVEL (${MAX_SKILL_LEVEL})`);
    }
  }

  if (!Number.isInteger(PITY_CRATE_THRESHOLD) || PITY_CRATE_THRESHOLD < 1) {
    problems.push('PITY_CRATE_THRESHOLD must be an integer >= 1');
  }

  // A name left behind by a renamed or deleted param would go on rounding
  // nothing, which is invisible until the day it matches something else.
  for (const param of INTEGER_PARAMS) {
    const used = Object.values(ACTIVE_SKILLS).some((skill) =>
      Number.isInteger(skill.params?.[param])
    );
    if (!used) {
      problems.push(`INTEGER_PARAMS: no active skill has an integer param "${param}"`);
    }
  }

  return problems;
}
