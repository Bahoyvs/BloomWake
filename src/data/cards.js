/**
 * Skill Cards Data definitions for BloomWake.
 * Source: Bloomwake_GDD_v1.md Section 7
 */

export const CARD_RARITIES = {
  COMMON: 'Common',
  UNCOMMON: 'Uncommon',
  RARE: 'Rare',
  LEGENDARY: 'Legendary',
};

export const CARD_TYPES = {
  PROJECTILE: 'Projectile',
  BEAM: 'Beam',
  ORBIT: 'Orbit',
  AOE: 'AoE',
  SHIELD: 'Shield',
  PASSIVE: 'Passive',
  CONTROL: 'Control',
};

export const CARDS = [
  {
    id: 'dewdrop_barrage',
    name: 'Dewdrop Barrage',
    type: CARD_TYPES.PROJECTILE,
    rarity: CARD_RARITIES.COMMON,
    description: 'Fires fast water droplets at the nearest enemy target.',
    maxLevel: 5,
    levels: [
      { level: 1, damage: 12, cooldown: 1.0, count: 1, speed: 8 },
      { level: 2, damage: 16, cooldown: 0.9, count: 1, speed: 9 },
      { level: 3, damage: 22, cooldown: 0.8, count: 2, speed: 10 },
      { level: 4, damage: 28, cooldown: 0.7, count: 2, speed: 11 },
      { level: 5, damage: 36, cooldown: 0.5, count: 3, speed: 12 },
    ],
  },
  {
    id: 'sunbeam_lance',
    name: 'Sunbeam Lance',
    type: CARD_TYPES.BEAM,
    rarity: CARD_RARITIES.COMMON,
    description: 'Emits a piercing beam of concentrated light across the field.',
    maxLevel: 5,
    levels: [
      { level: 1, damage: 8, cooldown: 3.0, width: 20, duration: 0.8 },
      { level: 2, damage: 12, cooldown: 2.7, width: 24, duration: 1.0 },
      { level: 3, damage: 18, cooldown: 2.4, width: 28, duration: 1.2 },
      { level: 4, damage: 25, cooldown: 2.0, width: 32, duration: 1.4 },
      { level: 5, damage: 35, cooldown: 1.5, width: 40, duration: 1.8 },
    ],
  },
  {
    id: 'glasswing',
    name: 'Glasswing',
    type: CARD_TYPES.ORBIT,
    rarity: CARD_RARITIES.COMMON,
    description: 'Spins crystalline glass wings around Dewling, slicing nearby enemies.',
    maxLevel: 5,
    levels: [
      { level: 1, damage: 10, count: 2, radius: 60, rotationSpeed: 2.0 },
      { level: 2, damage: 14, count: 3, radius: 65, rotationSpeed: 2.3 },
      { level: 3, damage: 20, count: 4, radius: 70, rotationSpeed: 2.6 },
      { level: 4, damage: 28, count: 5, radius: 75, rotationSpeed: 3.0 },
      { level: 5, damage: 40, count: 6, radius: 85, rotationSpeed: 3.5 },
    ],
  },
  {
    id: 'petal_storm',
    name: 'Petal Storm',
    type: CARD_TYPES.PROJECTILE,
    rarity: CARD_RARITIES.UNCOMMON,
    description: 'Unleashes a flurry of sharp petals in random directions.',
    maxLevel: 5,
    levels: [
      { level: 1, damage: 15, count: 6, cooldown: 4.0 },
      { level: 2, damage: 20, count: 8, cooldown: 3.6 },
      { level: 3, damage: 28, count: 10, cooldown: 3.2 },
      { level: 4, damage: 38, count: 12, cooldown: 2.8 },
      { level: 5, damage: 50, count: 16, cooldown: 2.2 },
    ],
  },
  {
    id: 'aurora_pulse',
    name: 'Aurora Pulse',
    type: CARD_TYPES.AOE,
    rarity: CARD_RARITIES.UNCOMMON,
    description: 'Periodically triggers a glowing shockwave dealing area damage.',
    maxLevel: 5,
    levels: [
      { level: 1, damage: 25, radius: 80, cooldown: 3.5 },
      { level: 2, damage: 35, radius: 95, cooldown: 3.1 },
      { level: 3, damage: 50, radius: 110, cooldown: 2.7 },
      { level: 4, damage: 70, radius: 130, cooldown: 2.3 },
      { level: 5, damage: 100, radius: 150, cooldown: 1.8 },
    ],
  },
  {
    id: 'bloomshield',
    name: 'Bloomshield',
    type: CARD_TYPES.SHIELD,
    rarity: CARD_RARITIES.RARE,
    description: 'Conjures a protective flower shield absorbing incoming damage.',
    maxLevel: 5,
    levels: [
      { level: 1, shieldHp: 30, rechargeTime: 12 },
      { level: 2, shieldHp: 45, rechargeTime: 10 },
      { level: 3, shieldHp: 65, rechargeTime: 8 },
      { level: 4, shieldHp: 90, rechargeTime: 7 },
      { level: 5, shieldHp: 130, rechargeTime: 5 },
    ],
  },
  {
    id: 'buddy_boost',
    name: 'Buddy Boost',
    type: CARD_TYPES.PASSIVE,
    rarity: CARD_RARITIES.COMMON,
    description: 'Passive: Increases movement speed and overall damage output.',
    maxLevel: 5,
    levels: [
      { level: 1, moveSpeedBonus: 0.10, damageBonus: 0.08 },
      { level: 2, moveSpeedBonus: 0.15, damageBonus: 0.14 },
      { level: 3, moveSpeedBonus: 0.22, damageBonus: 0.22 },
      { level: 4, moveSpeedBonus: 0.30, damageBonus: 0.32 },
      { level: 5, moveSpeedBonus: 0.40, damageBonus: 0.45 },
    ],
  },
  {
    id: 'tidewave',
    name: 'Tidewave',
    type: CARD_TYPES.CONTROL,
    rarity: CARD_RARITIES.RARE,
    description: 'Surges a wave of water outward, damaging and knocking enemies back.',
    maxLevel: 5,
    levels: [
      { level: 1, damage: 20, knockback: 100, radius: 120, cooldown: 5.0 },
      { level: 2, damage: 30, knockback: 120, radius: 140, cooldown: 4.5 },
      { level: 3, damage: 45, knockback: 140, radius: 160, cooldown: 4.0 },
      { level: 4, damage: 65, knockback: 170, radius: 180, cooldown: 3.5 },
      { level: 5, damage: 95, knockback: 200, radius: 210, cooldown: 2.8 },
    ],
  },
];

/**
 * Helper to retrieve card definition by ID
 * @param {string} id - Card ID
 * @returns {Object|null}
 */
export function getCardById(id) {
  return CARDS.find((card) => card.id === id) || null;
}
