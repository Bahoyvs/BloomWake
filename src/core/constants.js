/**
 * Simulation tuning constants for BloomWake.
 *
 * GDD Section 3/4 expresses speeds in abstract "units/sec"; the simulation runs
 * in pixels, so UNIT_PX is the single conversion point between the two.
 */

/** Pixels per GDD movement unit (player 3.2 units/s => 102.4 px/s). */
export const UNIT_PX = 32;

/**
 * Bounded arena. A closed arena (rather than an infinite field) is deliberate:
 * the Dewling outruns every Phase 1 enemy, so an open world would let a player
 * kite forever and never engage the loop.
 */
export const WORLD = {
  WIDTH: 2400,
  HEIGHT: 1600,
};

export const PLAYER_CFG = {
  RADIUS: 14,
  /** Invulnerability window after taking contact damage (seconds). */
  INVULN_SEC: 0.7,
};

export const SPAWN_CFG = {
  /**
   * Enemies appear on a ring around the Dewling, outside any viewport.
   * MAX_RADIUS must stay below half of the smaller world dimension so the
   * spawner's edge mirroring always lands inside the arena.
   */
  MIN_RADIUS: 620,
  MAX_RADIUS: 780,
  /** Fraction of the wave spent filling up to the concurrent enemy cap. */
  FILL_FRACTION: 0.4,
  MIN_INTERVAL: 0.1,
};

export const PROJECTILE_CFG = {
  /**
   * Card `speed` values are abstract; this scale converts them to px/s.
   * Kept separate from UNIT_PX so bullet readability can be tuned without
   * touching character/enemy movement.
   */
  SPEED_SCALE: 60,
  LIFETIME_SEC: 2.2,
  RADIUS: 5,
  /** Auto-attack acquisition range in px. */
  TARGET_RANGE: 520,
  /** Angular spread between multi-shot projectiles (radians). */
  SPREAD_RAD: 0.22,
};

export const ORB_CFG = {
  RADIUS: 6,
  /** Distance at which an orb starts flying toward the Dewling (px). */
  ATTRACT_RADIUS: 110,
  MAGNET_SPEED: 520,
  LIFETIME_SEC: 30,
};

/**
 * Phase 1 scope: single enemy type, fixed 5-wave run, no cards, no boss.
 * Wave 5 is a boss wave by the GDD formula, but the Rustwhale lands in Phase 4 —
 * here wave 5 is simply the final (hardest) standard wave.
 */
export const PHASE1 = {
  MAX_WAVES: 5,
  ENEMY_TYPE: 'tarling',
  /** Breather between waves (seconds). */
  WAVE_BREAK_SEC: 2.5,
  /** Bonus max HP granted per level once the starter weapon is maxed. */
  OVERFLOW_LEVEL_HP: 5,
};
