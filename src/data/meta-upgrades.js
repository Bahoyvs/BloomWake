/**
 * Permanent hull-refit table, bought with salvage (GDD Section 9).
 *
 * IDs stay as-is — they are save-state keys. Only the player-facing name and
 * description carry the re-skin, same split as the card and enemy tables.
 *
 * COSTS ARE FINAL and are not subject to economy calibration — the calibration
 * script tunes reward amounts instead, so that these prices land where the
 * retention design wants them. Do not tune these numbers.
 */

import { UNIT_PX } from '../core/constants.js';

export const META_UPGRADE_IDS = {
  START_HP: 'startHp',
  PICKUP_RADIUS: 'pickupRadius',
  START_SPEED: 'startSpeed',
  FOURTH_CARD_SLOT: 'fourthCardSlot',
};

/**
 * `baseCost` is the price of level 1; each further level multiplies by
 * `costGrowth`. One-time unlocks use `maxLevel: 1` and a growth of 1.
 */
export const META_UPGRADES = {
  [META_UPGRADE_IDS.START_HP]: {
    id: META_UPGRADE_IDS.START_HP,
    name: 'Reinforced Hull',
    description: 'Seviye başına +10 başlangıç canı.',
    baseCost: 50,
    costGrowth: 1.4,
    maxLevel: 5,
    /** Flat HP added per level. */
    hpPerLevel: 10,
  },
  [META_UPGRADE_IDS.PICKUP_RADIUS]: {
    id: META_UPGRADE_IDS.PICKUP_RADIUS,
    name: 'Tractor Field',
    description: 'Seviye başına +12px toplama yarıçapı.',
    baseCost: 40,
    costGrowth: 1.4,
    maxLevel: 5,
    /**
     * Player pickupRadius is stored in GDD movement units, so the +12px design
     * value is converted once here rather than at every call site.
     */
    pickupPxPerLevel: 12,
    get pickupUnitsPerLevel() {
      return this.pickupPxPerLevel / UNIT_PX;
    },
  },
  [META_UPGRADE_IDS.START_SPEED]: {
    id: META_UPGRADE_IDS.START_SPEED,
    name: 'Thruster Tune',
    description: 'Seviye başına +%4 hareket hızı.',
    baseCost: 80,
    costGrowth: 1.5,
    maxLevel: 3,
    /** Fractional speed bonus per level, applied multiplicatively to the base. */
    speedBonusPerLevel: 0.04,
  },
  [META_UPGRADE_IDS.FOURTH_CARD_SLOT]: {
    id: META_UPGRADE_IDS.FOURTH_CARD_SLOT,
    name: 'Fourth Slot',
    description: 'Seviye atlama seçiminde 4. kart açılır.',
    baseCost: 2000,
    costGrowth: 1,
    maxLevel: 1,
    /** Stored as a boolean in save state rather than a level counter. */
    isBoolean: true,
  },
};

/** Stable display order for the shop. */
export const META_UPGRADE_ORDER = [
  META_UPGRADE_IDS.START_HP,
  META_UPGRADE_IDS.PICKUP_RADIUS,
  META_UPGRADE_IDS.START_SPEED,
  META_UPGRADE_IDS.FOURTH_CARD_SLOT,
];

/**
 * @param {string} id
 * @returns {Object|null}
 */
export function getUpgradeById(id) {
  return META_UPGRADES[id] ?? null;
}
