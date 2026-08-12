/**
 * Wave calculation logic and formulas for BloomWake.
 * Implements pure procedural wave math defined in GDD Section 6 & Development Plan.
 */

export const WAVE_CONSTANTS = {
  MAX_ACTIVE_ENEMIES: 200,
  BASE_ENEMY_COUNT: 8,
  ENEMY_COUNT_PER_WAVE: 6,
  HP_SCALING_PER_WAVE: 0.12,
  SPEED_SCALING_PER_WAVE: 0.03,
  MAX_SPEED_MULTIPLIER: 1.5,
  WAVE_DURATION_SEC: 35,
  BOSS_WAVE_INTERVAL: 5,
};

/**
 * Calculates max concurrent enemies allowed on screen for a given wave
 * @param {number} wave - Current wave number (1-based)
 * @returns {number} Enemy cap for the wave (max 200)
 */
export function getEnemyCount(wave) {
  if (wave < 1) return WAVE_CONSTANTS.BASE_ENEMY_COUNT;
  return Math.min(
    WAVE_CONSTANTS.MAX_ACTIVE_ENEMIES,
    WAVE_CONSTANTS.BASE_ENEMY_COUNT + wave * WAVE_CONSTANTS.ENEMY_COUNT_PER_WAVE
  );
}

/**
 * Calculates enemy HP multiplier for a given wave
 * @param {number} wave - Current wave number
 * @returns {number} HP multiplier (e.g. Wave 1 = 1.0, Wave 2 = 1.12)
 */
export function getEnemyHpMultiplier(wave) {
  if (wave < 1) return 1.0;
  return 1 + (wave - 1) * WAVE_CONSTANTS.HP_SCALING_PER_WAVE;
}

/**
 * Calculates enemy movement speed multiplier for a given wave
 * @param {number} wave - Current wave number
 * @returns {number} Speed multiplier (capped at 1.5)
 */
export function getEnemySpeedMultiplier(wave) {
  if (wave < 1) return 1.0;
  return Math.min(
    WAVE_CONSTANTS.MAX_SPEED_MULTIPLIER,
    1 + (wave - 1) * WAVE_CONSTANTS.SPEED_SCALING_PER_WAVE
  );
}

/**
 * Checks if the specified wave is a boss wave
 * @param {number} wave - Current wave number
 * @returns {boolean}
 */
export function isBossWave(wave) {
  return wave > 0 && wave % WAVE_CONSTANTS.BOSS_WAVE_INTERVAL === 0;
}

/**
 * Calculates Rustwhale Boss HP based on wave number
 * @param {number} wave - Boss wave number (e.g., 5, 10, 15)
 * @returns {number} Boss max HP
 */
export function getBossHp(wave) {
  const bossTier = Math.floor(wave / WAVE_CONSTANTS.BOSS_WAVE_INTERVAL);
  return 400 + bossTier * 250;
}

/**
 * Calculates wave duration in seconds
 * @param {number} wave - Current wave number
 * @returns {number} Duration in seconds
 */
export function getWaveDuration(wave) {
  return WAVE_CONSTANTS.WAVE_DURATION_SEC;
}
