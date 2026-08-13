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

/**
 * Effect kind each card runs. `type` above is the player-facing label; this is
 * the handler key the card system dispatches on, so adding a card means adding
 * a data row, not a branch in the simulation.
 * @see src/core/cards.js
 */
export const CARD_BEHAVIORS = {
  /** Volley of homing projectiles at the nearest enemy. */
  HOMING_VOLLEY: 'HOMING_VOLLEY',
  /** Persistent damage strip fired in a fixed direction. */
  BEAM: 'BEAM',
  /** Blades circling the Dewling, damaging on contact. */
  ORBIT: 'ORBIT',
  /** Salvo of projectiles in random directions. */
  RADIAL_BURST: 'RADIAL_BURST',
  /** Periodic ring blast centred on the Dewling. */
  AOE_PULSE: 'AOE_PULSE',
  /** Damage-absorbing shield that recharges on a timer. */
  SHIELD: 'SHIELD',
  /** Always-on stat modifiers; no per-frame effect. */
  PASSIVE: 'PASSIVE',
  /** Ring blast that also pushes enemies outward. */
  AOE_KNOCKBACK: 'AOE_KNOCKBACK',
};

export const CARDS = [
  {
    id: 'dewdrop_barrage',
    name: 'Dewdrop Barrage',
    type: CARD_TYPES.PROJECTILE,
    behavior: CARD_BEHAVIORS.HOMING_VOLLEY,
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
    behavior: CARD_BEHAVIORS.BEAM,
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
    behavior: CARD_BEHAVIORS.ORBIT,
    rarity: CARD_RARITIES.COMMON,
    description: 'Spins crystalline glass wings around Dewling, slicing nearby enemies.',
    maxLevel: 5,
    // Step B: weakest card in the set (1.5% of build output at L5). Damage and
    // orbit radius both raised — a wider orbit sweeps a larger annulus, which is
    // what actually puts enemies in reach.
    levels: [
      { level: 1, damage: 14, count: 2, radius: 70, rotationSpeed: 2.0 },
      { level: 2, damage: 20, count: 3, radius: 78, rotationSpeed: 2.3 },
      { level: 3, damage: 28, count: 4, radius: 86, rotationSpeed: 2.6 },
      { level: 4, damage: 40, count: 5, radius: 95, rotationSpeed: 3.0 },
      { level: 5, damage: 56, count: 6, radius: 110, rotationSpeed: 3.5 },
    ],
  },
  {
    id: 'petal_storm',
    name: 'Petal Storm',
    type: CARD_TYPES.PROJECTILE,
    behavior: CARD_BEHAVIORS.RADIAL_BURST,
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
    behavior: CARD_BEHAVIORS.AOE_PULSE,
    rarity: CARD_RARITIES.UNCOMMON,
    description: 'Periodically triggers a glowing shockwave dealing area damage.',
    maxLevel: 5,
    // Step B: dead card at L3 (2.53% of build output). Its old 110px radius
    // caught roughly one enemy, so the radius curve was widened to 100 -> 210.
    // Damage is unchanged: the problem was reach, not power.
    levels: [
      { level: 1, damage: 25, radius: 100, cooldown: 3.5 },
      { level: 2, damage: 35, radius: 125, cooldown: 3.1 },
      { level: 3, damage: 50, radius: 150, cooldown: 2.7 },
      { level: 4, damage: 70, radius: 180, cooldown: 2.3 },
      { level: 5, damage: 100, radius: 210, cooldown: 1.8 },
    ],
  },
  {
    id: 'bloomshield',
    name: 'Bloomshield',
    type: CARD_TYPES.SHIELD,
    behavior: CARD_BEHAVIORS.SHIELD,
    rarity: CARD_RARITIES.RARE,
    description: 'Conjures a protective flower shield absorbing incoming damage.',
    maxLevel: 5,
    // Step B: the old curve absorbed 2.5 -> 26 HP/s, which exceeded incoming
    // contact damage from level 1 — binary immunity on first pick. Retuned to
    // 1.25 -> 9.0 HP/s against the SWARM target (13 HP/s of contact pressure),
    // so L5 blunts roughly 70% of incoming damage instead of all of it.
    levels: [
      { level: 1, shieldHp: 20, rechargeTime: 16 },
      { level: 2, shieldHp: 30, rechargeTime: 14 },
      { level: 3, shieldHp: 45, rechargeTime: 12 },
      { level: 4, shieldHp: 65, rechargeTime: 11 },
      { level: 5, shieldHp: 90, rechargeTime: 10 },
    ],
  },
  {
    id: 'buddy_boost',
    name: 'Buddy Boost',
    type: CARD_TYPES.PASSIVE,
    behavior: CARD_BEHAVIORS.PASSIVE,
    rarity: CARD_RARITIES.COMMON,
    description: 'Passive: Increases movement speed and overall damage output.',
    maxLevel: 5,
    // Step B: trimmed from +45% dmg / +40% speed to +30% / +25%. As a pure
    // multiplier this card scales with every other card in the build, so it is
    // the one most able to break a synergy meta.
    levels: [
      { level: 1, moveSpeedBonus: 0.08, damageBonus: 0.06 },
      { level: 2, moveSpeedBonus: 0.12, damageBonus: 0.11 },
      { level: 3, moveSpeedBonus: 0.16, damageBonus: 0.17 },
      { level: 4, moveSpeedBonus: 0.20, damageBonus: 0.23 },
      { level: 5, moveSpeedBonus: 0.25, damageBonus: 0.30 },
    ],
  },
  {
    id: 'tidewave',
    name: 'Tidewave',
    type: CARD_TYPES.CONTROL,
    behavior: CARD_BEHAVIORS.AOE_KNOCKBACK,
    rarity: CARD_RARITIES.RARE,
    description: 'Surges a wave of water outward, damaging and knocking enemies back.',
    maxLevel: 5,
    // Step B: L5 knockback 200 -> 150 and cooldown 2.8 -> 3.2. The old numbers
    // pushed enemies away for 96% of the cooldown, which is contact immunity
    // wearing a crowd-control costume.
    // L4 knockback also eased 170 -> 160 so push uptime stays monotonic across
    // levels — at 170 the L4 curve overtook the retuned L5.
    levels: [
      { level: 1, damage: 20, knockback: 100, radius: 120, cooldown: 5.0 },
      { level: 2, damage: 30, knockback: 120, radius: 140, cooldown: 4.5 },
      { level: 3, damage: 45, knockback: 140, radius: 160, cooldown: 4.0 },
      { level: 4, damage: 65, knockback: 160, radius: 180, cooldown: 3.5 },
      { level: 5, damage: 95, knockback: 150, radius: 210, cooldown: 3.2 },
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
