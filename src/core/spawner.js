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
    /**
     * Whether new enemies may arrive.
     *
     * False for the whole of a boss wave (the arena belongs to the boss), and
     * false for the tail of a normal wave once the spawn window closes. The
     * flag lives here rather than in the simulation because "should anything
     * spawn" is the spawner's entire remit — a caller that has to remember to
     * stop asking is a caller that will forget.
     */
    this.active = true;

    /**
     * Half-extents of the camera's view in WORLD units, or null.
     *
     * Null is the default and the honest one: the spawner is pure logic and has
     * no idea a screen exists. The renderer pushes the real numbers in on every
     * resize (see Renderer.resize), and until it does — in tests, in the
     * balance sim, on the first frame — spawning falls back to the fixed ring,
     * which is the behaviour this module always had.
     */
    this.viewHalfWidth = null;
    this.viewHalfHeight = null;
  }

  /**
   * Tell the spawner how much arena the player can currently see.
   *
   * @param {number|null} halfWidth - Half the visible arena width, world units
   * @param {number|null} halfHeight - Half the visible arena height, world units
   */
  setViewExtent(halfWidth, halfHeight) {
    const w = Number(halfWidth);
    const h = Number(halfHeight);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      this.viewHalfWidth = null;
      this.viewHalfHeight = null;
      return;
    }
    this.viewHalfWidth = w;
    this.viewHalfHeight = h;
  }

  /**
   * Smallest spawn distance along a given heading that clears the viewport.
   *
   * WHY A RECTANGLE AND NOT A CIRCLE. The obvious version — one radius equal to
   * the view's half-diagonal — pushes every spawn out to the distance the
   * CORNERS need, which on a 21:9 phone is nearly twice what a spawn directly
   * above the player needs. Enemies arriving from above would then have a long
   * silent walk before they were a threat, and the wave would pace differently
   * depending on the player's aspect ratio.
   *
   * Instead the required distance is measured along the spawn's own heading:
   * `min(halfW / |cos|, halfH / |sin|)` is where that ray leaves the view
   * rectangle. Adding VIEW_MARGIN to it puts every arrival the same short
   * distance beyond the frame edge, whichever edge it crosses.
   *
   * @param {number} cos - Cosine of the spawn heading
   * @param {number} sin - Sine of the spawn heading
   * @returns {number} Distance in world units, or 0 when no view is known
   */
  viewClearance(cos, sin) {
    if (this.viewHalfWidth === null || this.viewHalfHeight === null) return 0;

    const ax = Math.abs(cos);
    const ay = Math.abs(sin);
    // A perfectly axis-aligned heading divides by zero on the other axis;
    // Infinity is the correct answer there and `min` discards it.
    const tx = ax > 1e-9 ? this.viewHalfWidth / ax : Infinity;
    const ty = ay > 1e-9 ? this.viewHalfHeight / ay : Infinity;

    return Math.min(tx, ty) + SPAWN_CFG.VIEW_MARGIN;
  }

  /**
   * Furthest a spawn may be placed along a heading and still be mirrorable.
   *
   * The same ray-exits-a-rectangle form as `viewClearance`, applied to the
   * arena's half-extents instead of the view's — which is exactly the elliptical
   * invariant described on SPAWN_CFG.MAX_SAFE_RADIUS. Using the ellipse rather
   * than its inscribed circle is what lets a wide viewport push horizontal
   * spawns properly off-screen: the arena is 3240 wide and only 2160 tall, so a
   * horizontal spawn has half again as much room as a vertical one, and the
   * circle would throw that away.
   *
   * @param {number} cos - Cosine of the spawn heading
   * @param {number} sin - Sine of the spawn heading
   * @returns {number} Distance in world units
   */
  safeRadius(cos, sin) {
    const ax = Math.abs(cos);
    const ay = Math.abs(sin);
    const tx = ax > 1e-9 ? WORLD.WIDTH / 2 / ax : Infinity;
    const ty = ay > 1e-9 ? WORLD.HEIGHT / 2 / ay : Infinity;
    return Math.min(tx, ty);
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
    /**
     * BOSS ARENA ISOLATION. A boss wave spawns no chaff at all — the only
     * things on the field are the Dreadnought and the escorts it calls itself.
     * Mixing a 200-enemy swarm into a boss fight hides the attack patterns the
     * whole encounter is built out of.
     */
    this.active = !isBossWave(wave);
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
    if (!this.active) return 0;

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
   * Close the spawn window: no further arrivals this wave.
   *
   * Called when the wave's spawn clock runs out. What is already on the field
   * stays there, and the wave ends when the last of it is dead.
   */
  close() {
    this.active = false;
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
   * Pick a spawn point around the player: off-screen, and inside the arena.
   *
   * Two distances are computed and the larger wins. The RING (MIN_RADIUS to
   * MAX_RADIUS) is the design distance — it is what the wave pacing is tuned
   * against and it carries the random variation that stops arrivals landing in
   * a visible circle. The VIEW CLEARANCE is a floor: whatever the ring rolled,
   * the spawn must still be past the edge of the frame. On a narrow viewport
   * the ring wins everywhere and nothing changes; on a wide one the clearance
   * takes over along the horizontal arcs, which is exactly where pop-in was.
   *
   * The result is capped at MAX_SAFE_RADIUS so the edge mirroring below stays
   * valid — see the note on that constant.
   *
   * @param {number} playerX
   * @param {number} playerY
   * @returns {{x: number, y: number}}
   */
  spawnPosition(playerX, playerY) {
    const angle = this.rng() * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const ring = randomRange(this.rng, SPAWN_CFG.MIN_RADIUS, SPAWN_CFG.MAX_RADIUS);
    const radius = clamp(
      Math.max(ring, this.viewClearance(cos, sin)),
      SPAWN_CFG.MIN_RADIUS,
      this.safeRadius(cos, sin)
    );

    const offsetX = cos * radius;
    const offsetY = sin * radius;

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
