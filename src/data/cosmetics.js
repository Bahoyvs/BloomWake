/**
 * Void Drifter hull liveries (4 variants at Basic Launch).
 *
 * One is free, two are purchases at opposite ends of the price curve, and the
 * prestige livery is drop-only — it cannot be bought at any price, which is the
 * entire point of it as a Legendary chase item.
 *
 * IDs are save keys and stay as-is; only the names, descriptions and colours
 * carry the re-skin.
 *
 * `tint` is applied straight to the hero's white atlas hull, which makes every
 * one of these subject to the Visual Soup contract: a livery below the hero
 * luminance floor would hide the player inside their own swarm. That is
 * asserted in tests/data.test.js rather than left to review.
 */

export const COSMETIC_IDS = {
  DEFAULT: 'default',
  DEW_TINT: 'dew-tint',
  DEEP_WATER: 'deep-water',
  PRESTIJ_SKIN: 'prestij-skin',
};

export const COSMETICS = {
  [COSMETIC_IDS.DEFAULT]: {
    id: COSMETIC_IDS.DEFAULT,
    name: 'Void Drifter',
    description: 'Standart filo livresi.',
    cost: 0,
    purchasable: true,
    /** Matches HERO_TINT, so equipping the default changes nothing. */
    tint: '#cffcff',
    ring: '#7df9ff',
  },
  [COSMETIC_IDS.DEW_TINT]: {
    id: COSMETIC_IDS.DEW_TINT,
    name: 'Ion Wash',
    description: 'Motor taşmasının gövdeye vurduğu soluk iyon parıltısı.',
    cost: 150,
    purchasable: true,
    tint: '#8fd8ff',
    ring: '#3b82f6',
  },
  [COSMETIC_IDS.DEEP_WATER]: {
    id: COSMETIC_IDS.DEEP_WATER,
    name: 'Deep Field',
    description: 'Uzun menzil keşif boyası; içeriden aydınlanır.',
    cost: 1200,
    purchasable: true,
    tint: '#b9e8ff',
    ring: '#1d4ea8',
  },
  [COSMETIC_IDS.PRESTIJ_SKIN]: {
    id: COSMETIC_IDS.PRESTIJ_SKIN,
    name: 'Nova Prestige',
    description: 'Yalnızca efsanevi kurtarma kapsülünden çıkar.',
    cost: 0,
    /** Drop-only: never appears in the shop and cannot be bought. */
    purchasable: false,
    tint: '#ffe9b0',
    ring: '#e0b354',
  },
};

/** Stable display order for the shop. */
export const COSMETIC_ORDER = [
  COSMETIC_IDS.DEFAULT,
  COSMETIC_IDS.DEW_TINT,
  COSMETIC_IDS.DEEP_WATER,
  COSMETIC_IDS.PRESTIJ_SKIN,
];

/**
 * @param {string} id
 * @returns {Object|null}
 */
export function getCosmeticById(id) {
  return COSMETICS[id] ?? null;
}
