/**
 * Wave spawn scheduling for BloomWake.
 * Pure logic: decides *how many* enemies appear, *which type*, and *where*, never renders.
 */

import { WORLD, SPAWN_CFG } from './constants.js';
import { clamp, mulberry32, randomRange } from './math.js';
import { getEnemyCount, getWaveDuration, isBossWave } from './wave.js';
import { ENEMIES, ENEMY_TYPES, getUnlockedEnemiesForWave } from '../data/enemies.js';

export class WaveSpawner {
  /**
   * @param {() => number} [rng] - RNG returning floats in [0, 1)
   */
  constructor(rng = mulberry32(1337)) {
    this.rng = rng;
    this.cap = 0;
    this.interval = 1;
    this.timer = 0;
    this.currentWave = 1;
    this.bossSpawned = false;
  }

  /**
   * Configure the spawner for a wave.
   * `getEnemyCount(wave)` is treated as the *concurrent* cap (GDD Section 5's
   * bounded swarm); spawning is continuous and refills as enemies die.
   * @param {number} wave
   */
  beginWave(wave) {
    this.currentWave = wave;
    this.bossSpawned = false;
    this.cap = getEnemyCount(wave);
    this.interval = Math.max(
      SPAWN_CFG.MIN_INTERVAL,
      (getWaveDuration(wave) * SPAWN_CFG.FILL_FRACTION) / this.cap
    );
    // First enemies arrive immediately so the wave never opens on an empty field.
    this.timer = 0;
  }

  /**
   * Advance the spawn clock and report how many regular enemies should appear now.
   * @param {number} dt - Delta time in seconds
   * @param {number} activeCount - Enemies currently alive
   * @returns {number} Number of enemies to spawn this step
   */
  update(dt, activeCount) {
    const room = this.cap - activeCount;
    if (room <= 0) {
      // Field is full: hold the timer ready so a kill refills promptly.
      this.timer = 0;
      return 0;
    }

    this.timer -= dt;
    let count = 0;
    while (this.timer <= 0 && count < room) {
      count++;
      this.timer += this.interval;
    }
    if (this.timer < 0) this.timer = 0;
    return count;
  }

  /**
   * Check if a boss should spawn on this frame
   * @returns {boolean}
   */
  shouldSpawnBoss() {
    if (isBossWave(this.currentWave) && !this.bossSpawned) {
      this.bossSpawned = true;
      return true;
    }
    return false;
  }

  /**
   * Pick an enemy type unlocked for the current wave using weighted random selection.
   * @param {number} [wave] - Wave number (defaults to currentWave)
   * @returns {Object} Enemy definition object from ENEMIES
   */
  pickEnemyType(wave = this.currentWave) {
    const unlocked = getUnlockedEnemiesForWave(wave);
    if (unlocked.length === 0) return ENEMIES[ENEMY_TYPES.TARLING];

    let totalWeight = 0;
    for (let i = 0; i < unlocked.length; i++) {
      totalWeight += unlocked[i].spawnWeight || 1;
    }

    let roll = this.rng() * totalWeight;
    for (let i = 0; i < unlocked.length; i++) {
      roll -= unlocked[i].spawnWeight || 1;
      if (roll <= 0) {
        return unlocked[i];
      }
    }
    return unlocked[unlocked.length - 1];
  }

  /**
   * Pick a spawn point on a ring around the player, always inside the arena.
   * @param {number} playerX
   * @param {number} playerY
   * @returns {{x: number, y: number}}
   */
  spawnPosition(playerX, playerY) {
    const angle = this.rng() * Math.PI * 2;
    const radius = randomRange(this.rng, SPAWN_CFG.MIN_RADIUS, SPAWN_CFG.MAX_RADIUS);
    const offsetX = Math.cos(angle) * radius;
    const offsetY = Math.sin(angle) * radius;

    let x = playerX + offsetX;
    if (x < 0 || x > WORLD.WIDTH) x = playerX - offsetX;

    let y = playerY + offsetY;
    if (y < 0 || y > WORLD.HEIGHT) y = playerY - offsetY;

    return {
      x: clamp(x, 0, WORLD.WIDTH),
      y: clamp(y, 0, WORLD.HEIGHT),
    };
  }
}
