/**
 * Petal meta-upgrade shop (GDD Section 9, Phase 5 Step D).
 *
 * Pure functions, no DOM. Actions validate and return {ok, reason, state}; the
 * UI never mutates state itself, it renders whatever comes back — the same
 * architectural rule the rest of the codebase follows.
 */

import { META_UPGRADES, META_UPGRADE_IDS, getUpgradeById } from '../data/meta-upgrades.js';

/**
 * Cost of the NEXT level, given how many levels are already owned.
 *
 * Level 1 costs `baseCost`; each subsequent level multiplies by `costGrowth`,
 * so level n costs baseCost * growth^(n-1). Returns null when the upgrade is
 * already maxed and there is no next level to price.
 *
 * @param {string} upgradeId
 * @param {number} currentLevel - Levels already owned
 * @returns {number|null} Petal cost, rounded to a whole Petal
 */
export function getUpgradeCost(upgradeId, currentLevel = 0) {
  const upgrade = getUpgradeById(upgradeId);
  if (!upgrade) return null;
  if (currentLevel >= upgrade.maxLevel) return null;

  return Math.round(upgrade.baseCost * Math.pow(upgrade.costGrowth, currentLevel));
}

/**
 * Current level of an upgrade, normalising the boolean one-time unlock into
 * the same 0/1 integer the level-based ones use.
 *
 * @param {Object} state
 * @param {string} upgradeId
 * @returns {number}
 */
export function getUpgradeLevel(state, upgradeId) {
  const raw = state.metaUpgrades[upgradeId];
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  return Math.max(0, Math.floor(raw || 0));
}

/**
 * Buy one level of an upgrade.
 *
 * @param {Object} state - Persistent meta-state
 * @param {string} upgradeId
 * @returns {{ok: boolean, reason?: string, cost?: number, state: Object}}
 */
export function purchaseUpgrade(state, upgradeId) {
  const upgrade = getUpgradeById(upgradeId);
  if (!upgrade) return { ok: false, reason: 'UNKNOWN_UPGRADE', state };

  const level = getUpgradeLevel(state, upgradeId);
  if (level >= upgrade.maxLevel) return { ok: false, reason: 'MAX_LEVEL', state };

  const cost = getUpgradeCost(upgradeId, level);
  if (state.petals < cost) return { ok: false, reason: 'INSUFFICIENT_PETALS', cost, state };

  const nextValue = upgrade.isBoolean ? true : level + 1;

  return {
    ok: true,
    cost,
    state: {
      ...state,
      petals: state.petals - cost,
      metaUpgrades: { ...state.metaUpgrades, [upgradeId]: nextValue },
    },
  };
}

/**
 * Shop rows for the UI: level, next cost, and whether it can be bought now.
 * @param {Object} state
 * @returns {Array<Object>}
 */
export function describeShop(state) {
  return Object.values(META_UPGRADES).map((upgrade) => {
    const level = getUpgradeLevel(state, upgrade.id);
    const cost = getUpgradeCost(upgrade.id, level);
    const maxed = level >= upgrade.maxLevel;

    return {
      id: upgrade.id,
      name: upgrade.name,
      description: upgrade.description,
      level,
      maxLevel: upgrade.maxLevel,
      cost,
      maxed,
      affordable: !maxed && state.petals >= cost,
    };
  });
}

/**
 * Apply owned meta-upgrades to a run's starting Dewling stats.
 *
 * Pure: returns a new stats object, leaving `initialStats` untouched. This is
 * what run-start calls before handing stats to the simulation.
 *
 * @param {Object} state - Persistent meta-state
 * @param {{maxHp: number, hp: number, moveSpeed: number, pickupRadius: number}} initialStats
 * @returns {Object} Modified copy
 */
export function applyMetaUpgradesToRunStart(state, initialStats) {
  const hpLevels = getUpgradeLevel(state, META_UPGRADE_IDS.START_HP);
  const radiusLevels = getUpgradeLevel(state, META_UPGRADE_IDS.PICKUP_RADIUS);
  const speedLevels = getUpgradeLevel(state, META_UPGRADE_IDS.START_SPEED);

  const hpBonus = hpLevels * META_UPGRADES[META_UPGRADE_IDS.START_HP].hpPerLevel;
  const radiusBonus =
    radiusLevels * META_UPGRADES[META_UPGRADE_IDS.PICKUP_RADIUS].pickupUnitsPerLevel;
  const speedBonus =
    speedLevels * META_UPGRADES[META_UPGRADE_IDS.START_SPEED].speedBonusPerLevel;

  const maxHp = initialStats.maxHp + hpBonus;

  return {
    ...initialStats,
    maxHp,
    // A run always begins at full health, including the bonus.
    hp: maxHp,
    pickupRadius: initialStats.pickupRadius + radiusBonus,
    moveSpeed: initialStats.moveSpeed * (1 + speedBonus),
  };
}

/**
 * How many cards the level-up draft should offer.
 * @param {Object} state
 * @param {number} [baseCount]
 * @returns {number}
 */
export function getDraftOfferCount(state, baseCount = 3) {
  return state.metaUpgrades.fourthCardSlot ? baseCount + 1 : baseCount;
}
