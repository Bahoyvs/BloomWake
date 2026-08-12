/**
 * Wave spawn scheduling for BloomWake.
 * Pure logic: decides *how many* enemies appear and *where*, never renders.
 */

import { WORLD, SPAWN_CFG } from './constants.js';
import { clamp, mulberry32, randomRange } from './math.js';
import { getEnemyCount, getWaveDuration } from './wave.js';

export class WaveSpawner {
  /**
   * @param {() => number} [rng] - RNG returning floats in [0, 1)
   */
  constructor(rng = mulberry32(1337)) {
    this.rng = rng;
    this.cap = 0;
    this.interval = 1;
    this.timer = 0;
  }

  /**
   * Configure the spawner for a wave.
   * `getEnemyCount(wave)` is treated as the *concurrent* cap (GDD Section 5's
   * bounded swarm); spawning is continuous and refills as enemies die.
   * @param {number} wave
   */
  beginWave(wave) {
    this.cap = getEnemyCount(wave);
    this.interval = Math.max(
      SPAWN_CFG.MIN_INTERVAL,
      (getWaveDuration(wave) * SPAWN_CFG.FILL_FRACTION) / this.cap
    );
    // First enemies arrive immediately so the wave never opens on an empty field.
    this.timer = 0;
  }

  /**
   * Advance the spawn clock and report how many enemies should appear now.
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
   * Pick a spawn point on a ring around the player, always inside the arena.
   *
   * Near an arena edge the ring offset would fall outside the world; that axis
   * is mirrored rather than clamped, which keeps the offset magnitude — and so
   * the distance to the Dewling — exactly `radius`. Clamping instead would let
   * enemies pop into view in a corner.
   *
   * @param {number} playerX
   * @param {number} playerY
   * @returns {{x: number, y: number}}
   */
  spawnPosition(playerX, playerY) {
    const angle = this.rng() * Math.PI * 2;
    const radius = randomRange(this.rng, SPAWN_CFG.MIN_RADIUS, SPAWN_CFG.MAX_RADIUS);
    const offsetX = Math.cos(angle) * radius;
    const offsetY = Math.sin(angle) * radius;

    // Mirroring is only guaranteed to land in-bounds while each world dimension
    // exceeds 2 * MAX_RADIUS; the clamps below are a belt-and-braces fallback.
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
