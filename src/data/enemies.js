/**
 * Enemy data definitions for BloomWake.
 * Source: Bloomwake_GDD_v1.md Section 4 & Development Plan Section 1
 */

export const ENEMY_TYPES = {
  TARLING: 'tarling',
  ASHFISH: 'ashfish',
  CRACKED_WISP: 'cracked_wisp',
  RUSTBLOOM: 'rustbloom',
  SMOGMOTH: 'smogmoth',
  RUSTWHALE: 'rustwhale',
};

export const ENEMIES = {
  [ENEMY_TYPES.TARLING]: {
    id: ENEMY_TYPES.TARLING,
    name: 'Tarling',
    description: 'Small, oily black droplet moving in a straight line.',
    baseHp: 10,
    baseSpeed: 2.0,
    behavior: 'DIRECT',
    minWave: 1,
    spawnWeight: 10,
    color: '#1a1a24',
    radius: 12,
    contactDamage: 8,
    xpValue: 4,
    scoreValue: 10,
    shape: 'square',
  },
  [ENEMY_TYPES.ASHFISH]: {
    id: ENEMY_TYPES.ASHFISH,
    name: 'Ashfish',
    description: 'Ashen dead fish swimming in sine-wave paths in swarms.',
    baseHp: 15,
    baseSpeed: 2.2,
    behavior: 'SINE_WAVE',
    minWave: 3,
    spawnWeight: 7,
    color: '#4a5568',
    radius: 14,
    contactDamage: 10,
    xpValue: 6,
    scoreValue: 15,
    shape: 'circle',
  },
  [ENEMY_TYPES.CRACKED_WISP]: {
    id: ENEMY_TYPES.CRACKED_WISP,
    name: 'Cracked Wisp',
    description: 'Fragile shard spirit charging fast in large swarms.',
    baseHp: 6,
    baseSpeed: 3.5,
    behavior: 'FAST_SWARM',
    minWave: 4,
    spawnWeight: 8,
    color: '#a0aec0',
    radius: 9,
    contactDamage: 6,
    xpValue: 3,
    scoreValue: 8,
    shape: 'triangle',
  },
  [ENEMY_TYPES.RUSTBLOOM]: {
    id: ENEMY_TYPES.RUSTBLOOM,
    name: 'Rustbloom',
    description: 'Slow rusty flower dropping periodic toxic spores.',
    baseHp: 30,
    baseSpeed: 0.8,
    behavior: 'STATIONARY_SPORE',
    minWave: 6,
    spawnWeight: 4,
    color: '#7b341e',
    radius: 20,
    contactDamage: 14,
    xpValue: 12,
    scoreValue: 30,
    shape: 'square',
  },
  [ENEMY_TYPES.SMOGMOTH]: {
    id: ENEMY_TYPES.SMOGMOTH,
    name: 'Smogmoth',
    description: 'Soot moth flying in erratic zig-zag contact patterns.',
    baseHp: 12,
    baseSpeed: 2.5,
    behavior: 'ZIGZAG_FLYING',
    minWave: 8,
    spawnWeight: 5,
    color: '#2d3748',
    radius: 13,
    contactDamage: 9,
    xpValue: 8,
    scoreValue: 20,
    shape: 'triangle',
  },
  [ENEMY_TYPES.RUSTWHALE]: {
    id: ENEMY_TYPES.RUSTWHALE,
    name: 'Rustwhale',
    description: 'Boss: Monstrous corrupted leviathan with telegraph Black Tide AoE.',
    baseHp: 400, // Dynamic HP formula applied in wave logic
    baseSpeed: 1.0,
    behavior: 'BOSS_TELEGRAPH_AOE',
    minWave: 5,
    isBoss: true,
    color: '#321c1c',
    radius: 45,
    contactDamage: 25,
    xpValue: 120,
    scoreValue: 500,
    shape: 'circle',
    telegraphRadius: 130,
    telegraphCooldown: 6.0,
    telegraphDamage: 40,
  },
};

/**
 * Calculates deterministic telegraph duration for Rustwhale Boss AoE
 * Formula: telegraph_ms = (AoE_radius / dewling_speed) * 1000 + 300ms_safety_margin
 * @param {number} aoeRadius - Radius of AoE telegraph circle in pixels
 * @param {number} dewlingSpeedPxPerSec - Dewling player speed in pixels per second
 * @param {number} [safetyMarginMs=300] - Safety margin in milliseconds
 * @returns {number} Duration in milliseconds
 */
export function calculateTelegraphMs(aoeRadius, dewlingSpeedPxPerSec, safetyMarginMs = 300) {
  if (dewlingSpeedPxPerSec <= 0) return 1500;
  return (aoeRadius / dewlingSpeedPxPerSec) * 1000 + safetyMarginMs;
}

/**
 * Returns available enemy types unlocked for a given wave (excluding bosses)
 * @param {number} wave - Current wave number
 * @returns {Array<Object>} List of unlocked enemy definitions
 */
export function getUnlockedEnemiesForWave(wave) {
  return Object.values(ENEMIES).filter(
    (enemy) => !enemy.isBoss && wave >= enemy.minWave
  );
}
