/**
 * Salvage Crates, Tactical Chips and the persistent wallet (Step 3.1).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE OWNS
 * ---------------------------------------------------------------------------
 * The retention loop: a run pays out crates, crates pay out Scrap and chips,
 * chips buy levels on the seven active skills, and all of it survives a closed
 * tab. The numbers it reads are in src/data/crates-config.js and nothing here
 * hardcodes one.
 *
 * ---------------------------------------------------------------------------
 * PURE CORE, INJECTED STORAGE
 * ---------------------------------------------------------------------------
 * Every rule — rolling, pity, upgrading, the daily clock — is a pure function
 * over `(state, args, rng)` that returns a NEW state. No function reaches for
 * `Date.now()` or `Math.random()` on its own: timestamps and RNG come in as
 * parameters, the same rule src/core/state.js and daily-bloom.js follow, which
 * is what lets a test pin an exact dice roll and an exact instant.
 *
 * The persistence half at the bottom of the file is the one exception, and it
 * is kept honest by taking its storage as an argument that defaults to
 * `globalThis.localStorage`. So the browser gets real localStorage for free,
 * a test passes a Map-backed fake, and Node's lack of a `window` is a
 * no-op rather than a crash. Every failure path is non-fatal: a player with a
 * corrupt save, a full disk, or storage disabled entirely still reaches the
 * menu with a clean wallet instead of a white screen.
 *
 * This save is SEPARATE from the Phase-5 meta-state in src/core/state.js, under
 * its own storage key. The two have independent version numbers because they
 * change for independent reasons, and a breaking change to the crate economy
 * should not push a migration onto a player's upgrades and cosmetics.
 */

import {
  CHIP_KEYS,
  CHIP_ORDER,
  CHIP_RARITIES,
  INTEGER_PARAMS,
  MAX_SKILL_LEVEL,
  PITY_CRATE_THRESHOLD,
  SKILL_CHIPS,
  getChipByKey,
  getChipsByRarity,
  getCrateTypeById,
  getUpgradeCost,
  isRarityAtLeast,
} from '../data/crates-config.js';
import { ACTIVE_SKILLS } from '../data/active-skills.js';
import { rollAmount } from './rewards.js';
// A daily shipment and the Daily Bloom ask the same question — "has the
// player's own calendar day rolled over since this timestamp" — so they share
// the answer, including its handling of a clock set backwards.
import { isDailyBloomAvailable as isNewLocalDaySince, msUntilNextLocalDay } from './daily-bloom.js';

/**
 * Bump only on a BREAKING change — a field whose type or meaning changes, or
 * one that is removed. Additive fields must never bump it, because `loadEconomy`
 * fills missing fields from the defaults and an additive change therefore needs
 * no migration.
 */
export const ECONOMY_SAVE_VERSION = 1;

/** Its own key, independent of `bloomwake.save.v1`. */
export const ECONOMY_STORAGE_KEY = 'bloomwake.economy.v1';

/**
 * What the free once-a-day crate is.
 *
 * The standard pod, not a military one: the daily exists to give a lapsed
 * player a reason to open the tab, and it should lose to actually finishing a
 * run or the run stops being the point.
 */
export const DAILY_SHIPMENT_CRATE_ID = 'standard_pod';

/** Rejection reasons, so callers branch on a constant rather than a string. */
export const ECONOMY_ERRORS = {
  UNKNOWN_CRATE: 'UNKNOWN_CRATE',
  UNKNOWN_SKILL: 'UNKNOWN_SKILL',
  MAX_LEVEL: 'MAX_LEVEL',
  NOT_ENOUGH_CHIPS: 'NOT_ENOUGH_CHIPS',
  NOT_ENOUGH_SCRAP: 'NOT_ENOUGH_SCRAP',
  ALREADY_CLAIMED_TODAY: 'ALREADY_CLAIMED_TODAY',
};

/** Why a chip's rarity floor was raised above the crate's own odds. */
export const FORCED_BY = {
  /** The cross-crate dry-streak counter fired. */
  PITY: 'pity',
  /** This crate type promises a rare-or-better and had not delivered one yet. */
  GUARANTEE: 'guarantee',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The canonical shape. Every key here is one `loadEconomy` guarantees exists.
 *
 * `chips` and `skillLevels` are built from CHIP_KEYS rather than written out,
 * so adding an eighth skill is a row in crates-config.js and nothing here.
 *
 * @returns {Object} A fresh deep copy — callers can never mutate the default
 */
export function createDefaultEconomyState() {
  const chips = {};
  const skillLevels = {};
  for (const key of CHIP_KEYS) {
    chips[key] = 0;
    // Level 1 is "owned and usable", not "locked". Every skill is playable from
    // the first run; chips only make one better.
    skillLevels[key] = 1;
  }

  return {
    version: ECONOMY_SAVE_VERSION,
    scrap: 0,
    chips,
    skillLevels,
    /** Crates opened in a row with no rare-or-better chip. */
    pityCounter: 0,
    /** Wall-clock ms of the last daily shipment; 0 means never claimed. */
    lastDailyShipmentTime: 0,
    cratesOpenedTotal: 0,
  };
}

/**
 * Turn an untrusted stored object into a valid economy state.
 *
 * Never throws. A save from an older build, a newer build, or a text editor
 * yields a playable wallet rather than blocking the player, because there is no
 * recovery path a stuck player can take on their own.
 *
 * @param {Object|null} [stored] - Parsed save data, or null/undefined
 * @returns {Object} A complete economy state
 */
export function loadEconomy(stored) {
  const state = createDefaultEconomyState();
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return state;

  state.scrap = toCount(stored.scrap);
  state.pityCounter = Math.min(PITY_CRATE_THRESHOLD, toCount(stored.pityCounter));
  state.lastDailyShipmentTime = Math.max(0, Number(stored.lastDailyShipmentTime) || 0);
  state.cratesOpenedTotal = toCount(stored.cratesOpenedTotal);

  // Only keys this build knows survive. A chip for a skill that has since been
  // cut would otherwise sit in the wallet forever, uncountable and unspendable.
  const storedChips = stored.chips ?? {};
  const storedLevels = stored.skillLevels ?? {};
  for (const key of CHIP_KEYS) {
    state.chips[key] = toCount(storedChips[key]);
    const level = Math.floor(Number(storedLevels[key]));
    state.skillLevels[key] = Number.isFinite(level)
      ? Math.min(MAX_SKILL_LEVEL, Math.max(1, level))
      : 1;
  }

  return state;
}

/**
 * Non-negative integer, for a count or a currency balance.
 * @param {*} value
 * @returns {number}
 */
function toCount(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

/**
 * Plain serialisable snapshot for the storage layer.
 * @param {Object} state
 * @returns {Object}
 */
export function serializeEconomy(state) {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Credit Scrap, guarding against negative or fractional grants.
 * @param {Object} state
 * @param {number} amount
 * @returns {Object} A new state
 */
export function addScrap(state, amount) {
  return { ...state, scrap: state.scrap + toCount(amount) };
}

/**
 * Debit Scrap, clamped at zero.
 *
 * The clamp is a floor, not an authorisation check: whether a purchase is
 * AFFORDABLE is decided by the module that prices it (meta-shop.js,
 * cosmetics.js, upgradeSkill above), which is the only place that knows what is
 * being bought. This just guarantees the balance can never go negative, so a
 * caller that skipped its own check produces a free item rather than a wallet
 * showing -120 that every subsequent purchase then silently fails against.
 *
 * @param {Object} state
 * @param {number} amount
 * @returns {Object} A new state
 */
export function spendScrap(state, amount) {
  return { ...state, scrap: Math.max(0, state.scrap - toCount(amount)) };
}

/**
 * Credit chips by save key. Unknown keys are ignored rather than added, so a
 * typo cannot mint a currency nothing can spend.
 *
 * @param {Object} state
 * @param {Object<string, number>} amounts - key -> count
 * @returns {Object} A new state
 */
export function addChips(state, amounts) {
  const chips = { ...state.chips };
  for (const [key, amount] of Object.entries(amounts ?? {})) {
    if (!(key in chips)) continue;
    chips[key] += toCount(amount);
  }
  return { ...state, chips };
}

// ---------------------------------------------------------------------------
// Rolling
// ---------------------------------------------------------------------------

/**
 * Weighted pick over a rarity -> weight map, with an optional floor.
 *
 * Weights need not sum to anything in particular; they are normalised by their
 * own total. That is what makes a floor cheap: filtering to the rare-and-above
 * subset and re-normalising gives rare and legendary their correct RELATIVE
 * odds (40:10 in a military crate becomes 80%:20%), rather than renormalising
 * against a total that still counts the commons it just excluded.
 *
 * Rarities with no chips in the pool are excluded too — a rarity that can be
 * rolled but cannot produce a chip would be a silent empty drop.
 *
 * @param {Object<string, number>} weights
 * @param {() => number} rng - Returns floats in [0, 1)
 * @param {string|null} [minRarity] - Floor; null for the crate's plain odds
 * @returns {string|null} Rarity id, or null when nothing is rollable
 */
export function rollChipRarity(weights, rng, minRarity = null) {
  const eligible = CHIP_RARITIES.filter(
    (rarity) =>
      (weights?.[rarity] ?? 0) > 0 &&
      getChipsByRarity(rarity).length > 0 &&
      (!minRarity || isRarityAtLeast(rarity, minRarity))
  );

  // A floor the crate's weights cannot satisfy drops back to the plain odds
  // instead of returning nothing. validateCratesConfig() fails the build for
  // any shipped crate in this position, so in practice this catches a caller
  // that asked for a floor the table never promised.
  if (eligible.length === 0) {
    return minRarity ? rollChipRarity(weights, rng, null) : null;
  }

  let total = 0;
  for (const rarity of eligible) total += weights[rarity];

  let roll = rng() * total;
  for (const rarity of eligible) {
    roll -= weights[rarity];
    if (roll < 0) return rarity;
  }
  // Floating-point roll-off at the very top of the range belongs to the last
  // eligible bucket, which is the correct one.
  return eligible[eligible.length - 1];
}

/**
 * Uniform pick among the chips of one rarity.
 *
 * Uniform, not weighted: within a bucket every skill is equally likely, so a
 * player chasing a specific build is never quietly steered away from it.
 *
 * @param {string} rarity
 * @param {() => number} rng
 * @returns {import('../data/crates-config.js').SkillChipDef|null}
 */
export function rollChipOfRarity(rarity, rng) {
  const pool = getChipsByRarity(rarity);
  if (pool.length === 0) return null;
  const index = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  return pool[index];
}

/**
 * Open one crate: roll its Scrap, roll its chips, bank both, update pity.
 *
 * ROLL ORDER IS PART OF THE CONTRACT. Scrap first, then chips in index order,
 * each chip drawing its rarity and then its identity. Tests pin exact outcomes
 * against a seeded mulberry32, so reordering these draws changes every pinned
 * result even when the distributions are unchanged.
 *
 * Two rules can raise a chip's rarity floor above the crate's own odds:
 *
 *  - PITY, on the FIRST chip only, when PITY_CRATE_THRESHOLD crates have gone
 *    by without a rare-or-better. It is a cross-crate counter, so a run of bad
 *    standard pods is repaid by whatever crate comes next.
 *  - The crate's own GUARANTEE, on the LAST chip, and only if no earlier chip
 *    in the same crate already met it. Checking the earlier chips is what keeps
 *    a military crate honest without making it better than its weights say: two
 *    rares roll naturally 16% of the time and the guarantee stays out of it.
 *
 * Both floors can apply in the same crate (a 1-chip crate has one chip that is
 * both first and last); `forcedBy` records which rule moved each chip.
 *
 * @param {Object} state
 * @param {string} crateTypeId
 * @param {() => number} rng
 * @returns {{ok: boolean, reason?: string, state: Object, result?: Object}}
 */
export function openCrate(state, crateTypeId, rng) {
  const crate = getCrateTypeById(crateTypeId);
  if (!crate) return { ok: false, reason: ECONOMY_ERRORS.UNKNOWN_CRATE, state };

  const scrap = rollAmount(crate.scrapRange, rng);

  const pityDue = state.pityCounter >= PITY_CRATE_THRESHOLD;
  const rolled = [];
  let pityApplied = false;
  let guaranteeApplied = false;
  let sawRareOrBetter = false;

  for (let i = 0; i < crate.chipCount; i++) {
    const isLast = i === crate.chipCount - 1;
    let floor = null;
    let forcedBy = null;

    if (i === 0 && pityDue) {
      floor = 'rare';
      forcedBy = FORCED_BY.PITY;
      pityApplied = true;
    }
    if (isLast && crate.guaranteedMinRarity && !sawRareOrBetter) {
      // The stricter of the two floors wins when both fire on the same chip.
      if (!floor || isRarityAtLeast(crate.guaranteedMinRarity, floor)) {
        floor = crate.guaranteedMinRarity;
        forcedBy = forcedBy ?? FORCED_BY.GUARANTEE;
      }
      guaranteeApplied = true;
    }

    const rarity = rollChipRarity(crate.rarityWeights, rng, floor);
    const chip = rarity ? rollChipOfRarity(rarity, rng) : null;
    // Only reachable if every rarity bucket is empty, which the validator
    // rules out; skipping beats pushing a null into the reward screen.
    if (!chip) continue;

    if (isRarityAtLeast(chip.rarity, 'rare')) sawRareOrBetter = true;
    rolled.push({
      chipId: chip.id,
      key: chip.key,
      name: chip.name,
      rarity: chip.rarity,
      skillId: chip.skillId,
      forcedBy,
    });
  }

  const chips = { ...state.chips };
  for (const entry of rolled) chips[entry.key] += 1;

  // A rare-or-better resets the streak however it was obtained — including one
  // that pity itself forced, which is what makes the counter self-clearing.
  const pityCounter = sawRareOrBetter ? 0 : state.pityCounter + 1;

  const nextState = {
    ...state,
    scrap: state.scrap + scrap,
    chips,
    pityCounter,
    cratesOpenedTotal: state.cratesOpenedTotal + 1,
  };

  return {
    ok: true,
    state: nextState,
    result: {
      crateId: crate.id,
      crateName: crate.name,
      scrap,
      chips: rolled,
      pityApplied,
      guaranteeApplied,
      /** The counter AFTER this crate, for the "2 crates to a guarantee" line. */
      pityCounter,
      cratesOpenedTotal: nextState.cratesOpenedTotal,
    },
  };
}

/**
 * Grant the BONUS copies of a crate's payout, for the rewarded-ad 2x.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS GRANTS (multiplier - 1) AND NOT multiplier
 * ---------------------------------------------------------------------------
 * `openCrate` banks its payout immediately, before the modal has drawn a single
 * card. That is deliberate: a player who closes the tab halfway through the
 * reveal animation — or whose browser kills the tab for them — must still find
 * their chips in the wallet. So by the time a doubling can be offered, one copy
 * is already banked, and this function's job is only the difference.
 *
 * That makes `multiplier = 1` an exact no-op, which is the property the ad flow
 * depends on: every failure path (the SDK missing, the player closing the ad,
 * a network error, an exception nobody predicted) collapses to "call this with
 * 1", and the player keeps the rewards they already had. A failed ad can never
 * cost anything, because the base grant does not pass through here at all.
 *
 * Chip counts are granted per rolled chip, so the reveal's "CHIP 3 / 4" badges
 * stay honest after a doubling: two of the same chip in one crate doubles to
 * four of it.
 *
 * Does NOT touch the pity counter or `cratesOpenedTotal` — an ad is not a
 * crate, and letting one advance the dry-streak clock would mean a player who
 * watches ads hits their guarantee sooner than one who does not.
 *
 * @param {Object} state
 * @param {Object} result - The `result` from openCrate()
 * @param {number} [multiplier] - 1 grants nothing; 2 doubles the crate
 * @returns {{state: Object, scrap: number, chips: Object<string, number>}}
 *   The new state plus exactly what was added, for the UI to animate
 */
export function applyCrateRewards(state, result, multiplier = 1) {
  const copies = Math.max(0, Math.floor(Number(multiplier) || 1) - 1);
  const bonusScrap = (result?.scrap ?? 0) * copies;

  // At multiplier 1 this stays empty rather than mapping every key to 0, so
  // "what was added" is a list the UI can render directly instead of one it
  // has to filter.
  const chipGains = {};
  if (copies > 0) {
    for (const chip of result?.chips ?? []) {
      if (!(chip.key in state.chips)) continue;
      chipGains[chip.key] = (chipGains[chip.key] ?? 0) + copies;
    }
  }

  return {
    state: addChips(addScrap(state, bonusScrap), chipGains),
    scrap: bonusScrap,
    chips: chipGains,
  };
}

/**
 * Crates left before pity forces a rare — surfaced in the UI so the guarantee
 * is visible rather than hidden, the same way `runsUntilPity` surfaces the
 * capsule one.
 *
 * @param {Object} state
 * @returns {number} 0 means the next crate is already guaranteed
 */
export function cratesUntilPity(state) {
  return Math.max(0, PITY_CRATE_THRESHOLD - state.pityCounter);
}

// ---------------------------------------------------------------------------
// Upgrades
// ---------------------------------------------------------------------------

/**
 * What the next level on a skill would cost and whether it can be afforded.
 *
 * The hangar needs all of this to draw a row whether or not the button is
 * pressable, so the preview never returns null for a valid skill — a maxed
 * skill returns `cost: null` with `isMax: true`.
 *
 * @param {Object} state
 * @param {string} chipKey - Save key, e.g. 'afterburner'
 * @returns {{ok: boolean, reason?: string, level?: number, isMax?: boolean,
 *   cost?: {chips: number, scrap: number}|null, ownedChips?: number,
 *   scrap?: number, canAfford?: boolean, missingChips?: number,
 *   missingScrap?: number}}
 */
export function getUpgradePreview(state, chipKey) {
  const chip = getChipByKey(chipKey);
  if (!chip) return { ok: false, reason: ECONOMY_ERRORS.UNKNOWN_SKILL };

  const level = state.skillLevels[chipKey] ?? 1;
  const ownedChips = state.chips[chipKey] ?? 0;
  const cost = getUpgradeCost(level);

  if (!cost) {
    return {
      ok: true,
      level,
      isMax: true,
      cost: null,
      ownedChips,
      scrap: state.scrap,
      canAfford: false,
      missingChips: 0,
      missingScrap: 0,
    };
  }

  const missingChips = Math.max(0, cost.chips - ownedChips);
  const missingScrap = Math.max(0, cost.scrap - state.scrap);

  return {
    ok: true,
    level,
    isMax: false,
    cost,
    ownedChips,
    scrap: state.scrap,
    canAfford: missingChips === 0 && missingScrap === 0,
    missingChips,
    missingScrap,
  };
}

/**
 * Spend chips and Scrap to raise a skill one level.
 *
 * One level per call, never "spend everything you can". A player who has banked
 * enough for two levels should see two confirmations and two power jumps; a
 * single button that silently consumed 23 chips and 4400 Scrap would be the
 * kind of irreversible spend a player cannot undo and did not ask for.
 *
 * Both halves of the price are checked before either is deducted, so a failed
 * upgrade never eats the chips and leaves the Scrap short.
 *
 * @param {Object} state
 * @param {string} chipKey
 * @returns {{ok: boolean, reason?: string, state: Object,
 *   cost?: {chips: number, scrap: number}, level?: number}}
 */
export function upgradeSkill(state, chipKey) {
  const preview = getUpgradePreview(state, chipKey);
  if (!preview.ok) return { ok: false, reason: preview.reason, state };
  if (preview.isMax) return { ok: false, reason: ECONOMY_ERRORS.MAX_LEVEL, state };

  // Chips first: it is the more specific shortage, and the more useful thing to
  // say when both are short ("2 more Afterburner Coils" beats "more scrap").
  if (preview.missingChips > 0) {
    return { ok: false, reason: ECONOMY_ERRORS.NOT_ENOUGH_CHIPS, state };
  }
  if (preview.missingScrap > 0) {
    return { ok: false, reason: ECONOMY_ERRORS.NOT_ENOUGH_SCRAP, state };
  }

  const { cost } = preview;
  return {
    ok: true,
    state: {
      ...state,
      scrap: state.scrap - cost.scrap,
      chips: { ...state.chips, [chipKey]: state.chips[chipKey] - cost.chips },
      skillLevels: { ...state.skillLevels, [chipKey]: preview.level + 1 },
    },
    cost,
    level: preview.level + 1,
  };
}

/**
 * Trim float noise. 8 * 1.125 is 9, not 9.000000000000002, and a tooltip should
 * not have to know that. Four places is far finer than anything in
 * active-skills.js is tuned to, so this never changes a balance decision.
 *
 * @param {number} value
 * @returns {number}
 */
function round4(value) {
  return Math.round(value * 1e4) / 1e4;
}

/**
 * Round a scaled param the way its handler will read it.
 *
 * Discreteness is taken from INTEGER_PARAMS, not from whether the base value
 * happens to be a whole number: `turnRate: 5` is an integer to JavaScript and a
 * continuous quantity to the game, and rounding it would flatten its curve.
 *
 * @param {string} param
 * @param {number} scaled
 * @returns {number}
 */
function roundParam(param, scaled) {
  return INTEGER_PARAMS.has(param) ? Math.round(scaled) : round4(scaled);
}

/**
 * The active-skill definition as it behaves at `level`.
 *
 * Returns a full, independent copy of the ACTIVE_SKILLS row with every scaled
 * field already applied, so `ActiveSkillSystem` and the HUD can go on reading
 * `def.cooldown` and `def.params.x` without either of them learning what a chip
 * is. Level 1 returns the table's own values unchanged, because every curve's
 * first entry is exactly 1.
 *
 * @param {string} skillId
 * @param {number} [level]
 * @returns {Object|null} A scaled ActiveSkillDef, or null for an unknown skill
 */
export function resolveSkillDefAtLevel(skillId, level = 1) {
  const base = ACTIVE_SKILLS[skillId];
  if (!base) return null;

  const clamped = Math.min(MAX_SKILL_LEVEL, Math.max(1, Math.floor(level) || 1));
  const index = clamped - 1;
  const chip = CHIP_ORDER.map((id) => SKILL_CHIPS[id]).find((c) => c.skillId === skillId);
  const scaling = chip?.scaling ?? {};

  const def = { ...base, params: { ...base.params }, level: clamped };

  // Cooldown and duration are always continuous seconds, however round they
  // look in the table.
  if (scaling.cooldown) def.cooldown = round4(base.cooldown * scaling.cooldown[index]);
  if (scaling.duration) def.duration = round4(base.duration * scaling.duration[index]);

  for (const [param, curve] of Object.entries(scaling.params ?? {})) {
    const baseValue = base.params[param];
    if (!Number.isFinite(baseValue)) continue;
    def.params[param] = roundParam(param, baseValue * curve[index]);
  }

  return def;
}

/**
 * The scaled definition for a skill at the level THIS SAVE has bought.
 * The one call a run needs when it starts.
 *
 * @param {Object} state
 * @param {string} skillId
 * @returns {Object|null}
 */
export function getSkillDefForState(state, skillId) {
  const chip = CHIP_ORDER.map((id) => SKILL_CHIPS[id]).find((c) => c.skillId === skillId);
  const level = chip ? state.skillLevels[chip.key] ?? 1 : 1;
  return resolveSkillDefAtLevel(skillId, level);
}

/**
 * Every skill's level, holdings and next cost, in hangar display order.
 * One call for the whole upgrade screen.
 *
 * @param {Object} state
 * @returns {Array<Object>}
 */
export function describeSkillProgress(state) {
  return CHIP_ORDER.map((chipId) => {
    const chip = SKILL_CHIPS[chipId];
    const preview = getUpgradePreview(state, chip.key);
    return {
      chipId: chip.id,
      key: chip.key,
      skillId: chip.skillId,
      chipName: chip.name,
      skillName: ACTIVE_SKILLS[chip.skillId]?.name ?? chip.name,
      rarity: chip.rarity,
      level: preview.level,
      maxLevel: MAX_SKILL_LEVEL,
      isMax: preview.isMax,
      ownedChips: preview.ownedChips,
      cost: preview.cost,
      canAfford: preview.canAfford,
      missingChips: preview.missingChips,
      missingScrap: preview.missingScrap,
    };
  });
}

// ---------------------------------------------------------------------------
// Daily shipment
// ---------------------------------------------------------------------------

/**
 * Is the free daily crate waiting?
 *
 * Resets on the PLAYER'S LOCAL calendar day, not on a rolling 24 hours — a
 * player who plays at 21:00 should not find the next one locked until 21:00
 * tomorrow, drifting later every day until it lands in the middle of their
 * night. Shares daily-bloom.js's implementation, including its handling of a
 * clock set backwards.
 *
 * @param {Object} state
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isDailyShipmentAvailable(state, nowMs) {
  return isNewLocalDaySince(state.lastDailyShipmentTime, nowMs);
}

/**
 * Ms until the next shipment unlocks, for the menu countdown.
 * @param {Object} state
 * @param {number} nowMs
 * @returns {number} 0 when one is already claimable
 */
export function msUntilNextShipment(state, nowMs) {
  if (isDailyShipmentAvailable(state, nowMs)) return 0;
  return msUntilNextLocalDay(nowMs);
}

/**
 * Claim the daily shipment: a free crate, stamped against the local day.
 *
 * The stamp is written only on success, and only when the crate actually
 * opened, so a rejected claim can never burn the day.
 *
 * @param {Object} state
 * @param {number} nowMs
 * @param {() => number} rng
 * @returns {{ok: boolean, reason?: string, state: Object, result?: Object}}
 */
export function claimDailyShipment(state, nowMs, rng) {
  if (!isDailyShipmentAvailable(state, nowMs)) {
    return { ok: false, reason: ECONOMY_ERRORS.ALREADY_CLAIMED_TODAY, state };
  }

  const opened = openCrate(state, DAILY_SHIPMENT_CRATE_ID, rng);
  if (!opened.ok) return opened;

  return {
    ok: true,
    state: { ...opened.state, lastDailyShipmentTime: nowMs },
    result: opened.result,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * The storage this module writes to unless one is passed in.
 *
 * Wrapped because merely TOUCHING `localStorage` throws in some hardened and
 * private-browsing configurations, rather than being cleanly absent — and
 * because Node has no such global at all, which is what lets the pure half of
 * this file be tested without a DOM.
 *
 * @param {Storage|null} [storage]
 * @returns {Storage|null}
 */
function resolveStorage(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Can we actually write? Quota and permission failures only show up on a real
 * write, so probe with one rather than testing for the object's existence.
 *
 * @param {Storage|null} storage
 * @returns {boolean}
 */
function isStorageWritable(storage) {
  if (!storage) return false;
  try {
    const probe = '__bloomwake_economy_probe__';
    storage.setItem(probe, probe);
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and validate the economy save, falling back to a fresh wallet.
 *
 * @param {Storage} [storage] - Defaults to globalThis.localStorage
 * @returns {Object} A complete economy state
 */
export function loadEconomyFromStorage(storage) {
  const store = resolveStorage(storage);
  if (!store) return createDefaultEconomyState();

  try {
    const raw = store.getItem(ECONOMY_STORAGE_KEY);
    if (!raw) return createDefaultEconomyState();
    return loadEconomy(JSON.parse(raw));
  } catch (error) {
    // Corrupt JSON: start clean rather than trapping the player on a dead save.
    console.warn('[BloomWake] Economy save could not be read, starting fresh.', error);
    return createDefaultEconomyState();
  }
}

/**
 * Persist the economy state.
 *
 * @param {Object} state
 * @param {Storage} [storage] - Defaults to globalThis.localStorage
 * @returns {boolean} Whether the write succeeded
 */
export function saveEconomyToStorage(state, storage) {
  const store = resolveStorage(storage);
  if (!isStorageWritable(store)) return false;

  try {
    store.setItem(ECONOMY_STORAGE_KEY, JSON.stringify(serializeEconomy(state)));
    return true;
  } catch (error) {
    console.warn('[BloomWake] Economy save could not be written.', error);
    return false;
  }
}

/** Wipe the economy save. Exposed for debugging and for a "reset progress" UI. */
export function clearEconomyStorage(storage) {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.removeItem(ECONOMY_STORAGE_KEY);
  } catch {
    /* nothing useful to do */
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * Stateful convenience wrapper over the pure functions above.
 *
 * The browser layer wants one object it can hold and call, not a pure-function
 * pipeline it has to thread a state through and remember to persist. This gives
 * it that — and writes through to storage after every mutation, because the
 * failure mode of forgetting is a player losing a legendary chip to a closed
 * tab, which is the one bug in this system nobody forgives.
 *
 * The pure functions remain the API for anything that wants to reason about a
 * hypothetical state (a preview, a simulation, a test); this class is for the
 * one real save.
 */
export class MetaEconomy {
  /**
   * @param {Object} [options]
   * @param {Object} [options.state] - Starting state; loaded from storage if absent
   * @param {Storage} [options.storage] - Defaults to globalThis.localStorage
   * @param {() => number} [options.rng] - Defaults to Math.random
   * @param {() => number} [options.now] - Clock, ms. Defaults to Date.now
   * @param {boolean} [options.autoSave] - Write through on every mutation
   */
  constructor({ state, storage, rng, now, autoSave = true } = {}) {
    this.storage = storage;
    this.rng = rng ?? Math.random;
    this.now = now ?? (() => Date.now());
    this.autoSave = autoSave;
    this.state = state ? loadEconomy(state) : loadEconomyFromStorage(storage);
  }

  /** @returns {Object} The live state. Treat as read-only. */
  getState() {
    return this.state;
  }

  /**
   * Adopt a new state and persist it. The single choke point every mutation
   * goes through, so autosave cannot be forgotten in one method.
   * @param {Object} next
   * @returns {Object}
   */
  #commit(next) {
    this.state = next;
    if (this.autoSave) this.save();
    return next;
  }

  /**
   * @param {string} crateTypeId
   * @returns {{ok: boolean, reason?: string, result?: Object}}
   */
  openCrate(crateTypeId) {
    const outcome = openCrate(this.state, crateTypeId, this.rng);
    if (outcome.ok) this.#commit(outcome.state);
    return { ok: outcome.ok, reason: outcome.reason, result: outcome.result };
  }

  /**
   * Bank the bonus copies of a crate's payout after a rewarded ad.
   * @param {Object} result - The `result` from a previous openCrate()
   * @param {number} multiplier - 1 grants nothing
   * @returns {{scrap: number, chips: Object<string, number>}} What was added
   */
  applyCrateRewards(result, multiplier = 1) {
    const outcome = applyCrateRewards(this.state, result, multiplier);
    this.#commit(outcome.state);
    return { scrap: outcome.scrap, chips: outcome.chips };
  }

  /**
   * @param {string} chipKey
   * @returns {{ok: boolean, reason?: string, cost?: Object, level?: number}}
   */
  upgradeSkill(chipKey) {
    const outcome = upgradeSkill(this.state, chipKey);
    if (outcome.ok) this.#commit(outcome.state);
    return { ok: outcome.ok, reason: outcome.reason, cost: outcome.cost, level: outcome.level };
  }

  /** @param {number} amount */
  addScrap(amount) {
    this.#commit(addScrap(this.state, amount));
    return this.state.scrap;
  }

  /**
   * Debit Scrap for a purchase priced elsewhere — a hull upgrade or a livery.
   * The caller has already checked affordability; see spendScrap.
   * @param {number} amount
   * @returns {number} The remaining balance
   */
  spendScrap(amount) {
    this.#commit(spendScrap(this.state, amount));
    return this.state.scrap;
  }

  /** @param {Object<string, number>} amounts */
  addChips(amounts) {
    this.#commit(addChips(this.state, amounts));
    return this.state.chips;
  }

  /** @returns {boolean} */
  isDailyShipmentAvailable() {
    return isDailyShipmentAvailable(this.state, this.now());
  }

  /** @returns {number} */
  msUntilNextShipment() {
    return msUntilNextShipment(this.state, this.now());
  }

  /** @returns {{ok: boolean, reason?: string, result?: Object}} */
  claimDailyShipment() {
    const outcome = claimDailyShipment(this.state, this.now(), this.rng);
    if (outcome.ok) this.#commit(outcome.state);
    return { ok: outcome.ok, reason: outcome.reason, result: outcome.result };
  }

  /**
   * The scaled skill definition a run should start with.
   * @param {string} skillId
   * @returns {Object|null}
   */
  getSkillDef(skillId) {
    return getSkillDefForState(this.state, skillId);
  }

  /** @returns {Array<Object>} Every skill's upgrade row, in display order. */
  describeSkills() {
    return describeSkillProgress(this.state);
  }

  /** @returns {number} Crates left before pity guarantees a rare. */
  cratesUntilPity() {
    return cratesUntilPity(this.state);
  }

  /** @returns {boolean} Whether the write succeeded. */
  save() {
    return saveEconomyToStorage(this.state, this.storage);
  }

  /** Discard in-memory state and re-read the save. */
  reload() {
    this.state = loadEconomyFromStorage(this.storage);
    return this.state;
  }

  /** Wipe the wallet and the stored save. */
  reset() {
    clearEconomyStorage(this.storage);
    this.state = createDefaultEconomyState();
    if (this.autoSave) this.save();
    return this.state;
  }
}
