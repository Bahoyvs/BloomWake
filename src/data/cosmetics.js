/**
 * Dewling cosmetic variants (Pre-production decision: 4 variants at Basic Launch).
 *
 * One is free, two are Petal purchases at opposite ends of the price curve, and
 * the prestige skin is drop-only — it cannot be bought at any price, which is
 * the entire point of it as a Legendary chase item.
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
    name: 'Dewling',
    description: 'The original bloom.',
    cost: 0,
    purchasable: true,
    /** Grey-box tint; the themed art pass is Phase 6. */
    tint: '#dff3ff',
    ring: '#7fd4ff',
  },
  [COSMETIC_IDS.DEW_TINT]: {
    id: COSMETIC_IDS.DEW_TINT,
    name: 'Dew Tint',
    description: 'A soft green shimmer across the surface.',
    cost: 150,
    purchasable: true,
    tint: '#dff7e6',
    ring: '#8fe4b0',
  },
  [COSMETIC_IDS.DEEP_WATER]: {
    id: COSMETIC_IDS.DEEP_WATER,
    name: 'Deep Water',
    description: 'Pressure-dark, lit from within.',
    cost: 1200,
    purchasable: true,
    tint: '#bcd8ff',
    ring: '#4f8fd6',
  },
  [COSMETIC_IDS.PRESTIJ_SKIN]: {
    id: COSMETIC_IDS.PRESTIJ_SKIN,
    name: 'Prestige Bloom',
    description: 'Only ever found inside a Legendary Bloom Capsule.',
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
