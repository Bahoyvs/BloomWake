/**
 * Simulation tuning constants for BloomWake.
 *
 * GDD Section 3/4 expresses speeds in abstract "units/sec"; the simulation runs
 * in pixels, so UNIT_PX is the single conversion point between the two.
 */

/** Pixels per GDD movement unit (player 4.8 units/s => 153.6 px/s). */
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
  MAGNET_SPEED: 750,
  LIFETIME_SEC: 30,
};

/**
 * Card mechanics the GDD leaves unspecified — tick rates, hit gating, reach.
 *
 * SINGLE SOURCE OF TRUTH: tests/balance-sim.js imports these to score the card
 * table. If the balance model and the implementation each kept their own copy,
 * the published balance numbers would quietly stop describing the shipped game.
 * Change a value here and the balance table changes with it.
 */
export const CARD_MODEL = {
  /** Sunbeam Lance damages everything in its strip this often while active. */
  BEAM_TICK_SEC: 0.25,
  /** Sunbeam Lance strip length in px. */
  BEAM_LENGTH: 620,

  /**
   * An enemy cannot be re-hit by Glasswing faster than this. Set to 0.35s so
   * levels 4 and 5 still buy something; at 0.5s the cap was reached by level 4.
   */
  ORBIT_HIT_COOLDOWN: 0.35,
  /** Radial thickness of the blade sweep, i.e. blade diameter, in px. */
  ORBIT_BAND: 44,

  /** How far a Petal Storm petal travels before expiring, in px. */
  PETAL_RANGE: 420,
  /** Petal travel speed in px/s; range / speed gives its lifetime. */
  PETAL_SPEED: 360,
  /**
   * Effective sweep width of a petal against an enemy hitbox, in px.
   * Equals 2 x (petal radius 5 + mean enemy radius 12).
   */
  PETAL_SWEEP_WIDTH: 34,

  /** How long an AoE ring (Aurora Pulse, Tidewave) stays visible, in seconds. */
  AOE_EFFECT_SEC: 0.35,
};

/** Level-up draft rules (GDD Section 7). */
export const DRAFT_CFG = {
  /** Cards offered per level-up. A 4th slot is a Phase 5 meta-upgrade. */
  OFFER_COUNT: 3,
  /** Draw weight by rarity. */
  RARITY_WEIGHT: {
    Common: 100,
    Uncommon: 60,
    Rare: 30,
    Legendary: 10,
  },
  /**
   * Owned cards are multiplied by this before drawing, per GDD Section 7:
   * "zaten sahip olunanlar öncelik kazanır" — the build-around feel depends on
   * upgrades showing up more often than brand-new cards.
   */
  OWNED_WEIGHT_MULTIPLIER: 2.5,
};

/**
 * Phase 1 scope: single enemy type, fixed 5-wave run, no cards, no boss.
 * Wave 5 is a boss wave by the GDD formula, but the Rustwhale lands in Phase 4 —
 * here wave 5 is simply the final (hardest) standard wave.
 */
export const PHASE1 = {
  MAX_WAVES: 15,
  ENEMY_TYPE: 'tarling',
  /** Breather between waves (seconds). */
  WAVE_BREAK_SEC: 2.5,
};
