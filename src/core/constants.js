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
 *
 * EXPANDED BY 35% (2400x1600 -> 3240x2160) when the camera learned to zoom out.
 * The two changes are one change: a wider field of view shows more arena, and
 * at the old dimensions a mobile landscape viewport could see the better part
 * of the playfield at once — which turns a kiting arena into a single room and
 * leaves nowhere for the swarm to come FROM. The extra 35% restores the ratio
 * of arena to viewport the movement and spawn pacing were tuned against.
 *
 * Nothing else needs touching: every clamp in the simulation, the skills and
 * the spawner is already written against these two numbers rather than against
 * literals, so the perimeter moves and the boundary behaviour comes with it.
 */
export const WORLD = {
  WIDTH: 3240,
  HEIGHT: 2160,
};

export const PLAYER_CFG = {
  RADIUS: 14,
  /** Invulnerability window after taking contact damage (seconds). */
  INVULN_SEC: 0.7,

  /* ---- Inertia ---- */

  /**
   * The Drifter has mass.
   *
   * Movement used to be `position += direction * speed * dt`, which is exact,
   * trivially testable, and feels like dragging a cursor: full speed on the
   * frame a key goes down, dead stop on the frame it comes up. A ship in
   * vacuum should not do either.
   *
   * ACCEL is the rate at which velocity closes on the input target, in 1/s.
   * The approach is exponential (`1 - e^(-ACCEL*dt)`), so it is frame-rate
   * independent and never overshoots — at 12 the ship is at ~95% of top speed
   * a quarter-second after the key goes down. Higher feels twitchy, lower
   * feels like piloting a barge.
   *
   * TOP SPEED IS UNCHANGED. This governs how long the ship takes to reach the
   * speed the GDD specifies, not what that speed is — so the balance envelope
   * (kiting distance, contact-damage pressure) is the same as before.
   */
  ACCEL: 12,

  /**
   * Coasting decay per 1/60s frame, applied when there is no input.
   *
   * 0.92 gives a ~0.14s velocity half-life: enough glide that releasing a key
   * reads as cutting the engines, short enough that the player never fights
   * the ship for position. Raise it toward 1 for more drift.
   */
  DRAG: 0.92,

  /**
   * Below this speed (px/s) the ship is treated as stopped.
   *
   * Exponential decay never actually reaches zero, and a Drifter creeping at
   * 0.001 px/s would keep the animation director in its `move` state forever
   * and keep the engine flames lit while parked.
   */
  STOP_EPSILON: 1.5,
};

/**
 * The clear-out frenzy.
 *
 * WHY THIS HAS TO EXIST. A wave now ends when the field is empty rather than
 * when a clock runs out, and that rule has a failure mode the timer used to
 * hide: the Drifter is faster than most of the roster, its auto-cannon leads
 * nothing, and a single Xeno Larva chasing a kiting player is never caught and
 * never lands a shot. Measured on the acceptance bot, one straggler held wave 2
 * open for ten minutes — a hard softlock, not a slow wave.
 *
 * So once the spawn window closes, the survivors stop pacing the player and
 * come for them. Expressed as a FLOOR ON SPEED rather than a multiplier, and
 * relative to the Drifter's own top speed: a multiplier would have to be
 * enormous to let the slowest species catch up and would make the fastest one
 * undodgeable, whereas a floor pulls the whole field to the same closing pace
 * whatever it started at. The tail becomes the tense part of the wave instead
 * of a chore, and "clear the swarm" is always achievable.
 */
export const FRENZY_CFG = {
  /** Seconds after the spawn window closes before the enrage is fully applied. */
  RAMP_SEC: 10,
  /**
   * Maximum speed multiplier applied to enemies during clear-out tail.
   * Capped at 1.08x (within 1.05x - 1.1x range) to keep tension while preventing unfair swarming.
   */
  CATCH_RATIO: 1.08,
  MAX_ENRAGE_MULTIPLIER: 1.08,
};

export const SPAWN_CFG = {
  /**
   * Enemies appear on a ring around the Dewling, outside any viewport.
   * MAX_RADIUS must stay below half of the smaller world dimension so the
   * spawner's edge mirroring always lands inside the arena.
   *
   * Scaled with the 35% arena expansion (620/780 -> 840/1040). The ring is the
   * FLOOR on spawn distance, not the whole rule: once the renderer reports the
   * camera's world-space extents the spawner pushes each arrival out past the
   * frame edge as well — see VIEW_MARGIN and WaveSpawner.spawnPosition.
   */
  MIN_RADIUS: 840,
  MAX_RADIUS: 1040,
  /**
   * How far outside the visible frame an enemy must appear, in world units.
   *
   * The complaint this fixes is pop-in: at the old fixed ring a wide viewport
   * put the left and right arcs of the ring ON SCREEN, so enemies materialised
   * in plain sight instead of arriving out of the dark. 125 is mid-band of the
   * 100-150 design window — far enough that nothing appears inside the frame
   * even mid-turn, close enough that the swarm still reaches the player at the
   * pace the wave pacing assumes.
   */
  VIEW_MARGIN: 125,
  /**
   * THE EDGE-MIRRORING INVARIANT, as a circular bound.
   *
   * spawnPosition reflects an out-of-bounds offset back across the player
   * rather than clamping it, which preserves the spawn distance exactly. The
   * reflection is only guaranteed to land inside the arena while each OFFSET
   * COMPONENT is at most half its own dimension: |dx| <= WIDTH/2 and
   * |dy| <= HEIGHT/2. (Proof: px + dx > WIDTH forces dx > WIDTH - px, so if
   * px < WIDTH/2 then dx > WIDTH/2 — excluded. Therefore px >= WIDTH/2 and the
   * mirrored px - dx >= 0.)
   *
   * That is an ELLIPSE, and WaveSpawner.safeRadius enforces it per heading.
   * This constant is the largest circle inscribed in it — the bound that holds
   * along every heading at once, which is what MIN_RADIUS and MAX_RADIUS, being
   * heading-independent, have to respect.
   *
   * The distinction is not pedantry: capping at this circle instead of the
   * ellipse was the first attempt, and it clamped horizontal spawns on a wide
   * viewport back INSIDE the frame — reintroducing the exact pop-in the view
   * margin exists to remove, on the widest screens only.
   */
  get MAX_SAFE_RADIUS() {
    return Math.min(WORLD.WIDTH, WORLD.HEIGHT) / 2;
  },
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
  /**
   * Lateral distance from the ship's centreline to a wing hardpoint, in px.
   *
   * ---------------------------------------------------------------------
   * WHY SALVOS ARE PARALLEL TRACKS AND NOT AN ANGULAR FAN
   * ---------------------------------------------------------------------
   * This replaces SPREAD_RAD, which fanned a salvo out at +/- spread/2 around
   * the aim line. That geometry had a BLIND ANNULUS: with an even `count` no
   * bolt travelled down the aim line at all, and the lateral gap between the
   * straddling pair grew with distance (`range * sin(spread / 2)`). Past about
   *
   *     (enemy radius + PROJECTILE_CFG.RADIUS) / sin(spread / 2)
   *
   * — roughly 155px against a 12px-radius Tarling — a target sitting dead
   * centre in the crosshairs could not be hit at all. Worse, the miss was
   * DETERMINISTIC: freeze the relative geometry and the same shot misses by
   * the same margin forever, which is how a kiting bot held a wave open
   * indefinitely (see the mop-up note in tests/simulation.test.js).
   *
   * Parallel tracks remove the failure mode rather than shrinking it. Both
   * bolts fly along the true aim vector, offset sideways to the wingtips, so
   * the gap between them is CONSTANT at 2 * HARDPOINT_OFFSET at every range.
   *
   * ---------------------------------------------------------------------
   * WHY 11 AND NOT THE VISUAL WINGSPAN
   * ---------------------------------------------------------------------
   * The hull is drawn ~73px across (PLAYER_CFG.RADIUS * 2 * HERO_FIT), so the
   * visible wingtips are near +/-30. Firing from there would re-open the dead
   * zone at a fixed 60px width — worse than the fan, because it would never
   * close at any range. The binding constraint is not what the art looks like,
   * it is the SMALLEST target the pair must not straddle:
   *
   *     HARDPOINT_OFFSET <= min(enemy radius) + PROJECTILE_CFG.RADIUS
   *
   * The Dart Ravager is the roster's smallest at radius 9, giving a ceiling of
   * 14; 11 sits under it with 3px of margin. tests/weapons.test.js asserts this
   * against the live roster, so adding a smaller enemy fails CI instead of
   * quietly reintroducing the hole.
   */
  HARDPOINT_OFFSET: 11,

  /**
   * Outward splay applied to the OUTER bolts of a 3-or-more salvo, radians.
   *
   * Zero for a one- or two-bolt salvo, on purpose: the two-bolt case is the one
   * the parallel geometry exists to fix, and any divergence there starts the
   * gap growing with range again. From three bolts up there is always a centre
   * bolt on the aim line, so a slight fan widens the net against a swarm
   * without anything being able to slip between them.
   */
  SALVO_SPLAY_RAD: 0.04,
};

/**
 * Hostile ordnance — the Dreadnought Station's radial rings.
 *
 * Separate from PROJECTILE_CFG so enemy bullets can be tuned for readability
 * (they have to be dodgeable at a glance) without touching player weapons.
 */
export const ENEMY_BULLET_CFG = {
  RADIUS: 7,
  LIFETIME_SEC: 6.0,
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

  /** How long an AoE ring (Corona Pulse, Graviton EMP) stays visible, in seconds. */
  AOE_EFFECT_SEC: 0.35,

  /* ---- Nanite Swarm ---- */

  /** Launch speed of a micro-missile, px/s, before it turns onto its target. */
  NANITE_SPEED: 300,
  /**
   * Turn rate, rad/s.
   *
   * Deliberately finite. An infinitely agile missile is a hitscan weapon with a
   * travel delay; a missile that has to come round is one the player watches
   * arc across the field, which is the whole appeal of the card.
   */
  NANITE_TURN_RATE: 5.2,
  /** Seconds before a missile that never found its mark expires. */
  NANITE_LIFETIME_SEC: 3.0,
  NANITE_RADIUS: 6,
  /** Sideways kick at launch, px/s, so a salvo fans out instead of stacking. */
  NANITE_LAUNCH_SPREAD: 190,

  /* ---- Graviton EMP ---- */

  /** How long a caught enemy is frozen, in seconds. */
  EMP_STUN_SEC: 1.2,

  /* ---- Tactical Wingman ---- */

  /** Trailing distance behind the Drifter, px, and the V's half-angle. */
  WINGMAN_FOLLOW_DIST: 62,
  WINGMAN_SPREAD_RAD: 0.62,
  /** Fraction of the gap the drone closes per 60Hz frame; it lags, on purpose. */
  WINGMAN_LERP: 0.11,
  /** Independent turret range, px. */
  WINGMAN_RANGE: 430,
  /** Drone bolt speed, px/s. */
  WINGMAN_BOLT_SPEED: 620,

  /* ---- Hyperion Shield ---- */

  /**
   * How long the hex barrier is visibly "spent" after eating a hit, in seconds.
   * Purely a presentation window — the recharge itself is the card's own timer.
   */
  SHIELD_FLASH_SEC: 0.4,
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
