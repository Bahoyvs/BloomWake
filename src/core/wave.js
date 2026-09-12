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
  /**
   * Length of a wave's SPAWN WINDOW, in seconds — not the length of the wave.
   *
   * A wave now ends when the field is empty, not when a clock runs out (see
   * getWaveDuration). This figure is only how long new enemies keep arriving;
   * the tail of the wave is however long the player takes to kill what is
   * already out. Ramping it means later waves keep the pressure on for longer
   * without the concurrent cap having to rise as steeply.
   */
  WAVE_SPAWN_SEC_MIN: 45,
  WAVE_SPAWN_SEC_MAX: 60,
  /** Wave at which the spawn window reaches WAVE_SPAWN_SEC_MAX. */
  WAVE_SPAWN_RAMP_TO: 10,
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
 * Calculates Dreadnought Station HP based on wave number
 * @param {number} wave - Boss wave number (e.g., 5, 10, 15)
 * @returns {number} Boss max HP
 */
export function getBossHp(wave) {
  const bossTier = Math.floor(wave / WAVE_CONSTANTS.BOSS_WAVE_INTERVAL);
  return 1000 + bossTier * 625;
}

/**
 * Length of the wave's spawn window, in seconds.
 *
 * NOT the length of the wave. When this expires the spawner closes and the
 * wave enters its "clear the swarm" tail: no new arrivals, and the wave is not
 * over until the last living enemy is dead. Before this change the clock alone
 * ended the wave, which cut to the card screen with a live swarm still on
 * screen — the player was yanked out of a fight they were in the middle of.
 *
 * Ramps from WAVE_SPAWN_SEC_MIN to WAVE_SPAWN_SEC_MAX over the first
 * WAVE_SPAWN_RAMP_TO waves, then holds.
 *
 * @param {number} wave - Current wave number
 * @returns {number} Duration in seconds
 */
export function getWaveDuration(wave) {
  const { WAVE_SPAWN_SEC_MIN: min, WAVE_SPAWN_SEC_MAX: max, WAVE_SPAWN_RAMP_TO: ramp } =
    WAVE_CONSTANTS;
  if (!(wave > 1)) return min;
  const progress = Math.min(1, (wave - 1) / Math.max(1, ramp - 1));
  return min + (max - min) * progress;
}
