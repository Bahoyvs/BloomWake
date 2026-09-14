/**
 * Active skills — the pilot-triggered half of the arsenal.
 *
 * Cards fire themselves on a timer; these fire when the player presses the
 * key. That is the whole design difference, and it is why they live in their
 * own table rather than as another CARD_BEHAVIORS row: a card is a build
 * decision made once at a draft, a skill is a decision made every nine seconds
 * under pressure, and the two want completely different balance levers.
 *
 * THIS FILE IS DATA ONLY.
 * Every number a designer would want to move is here; nothing in it knows what
 * a Simulation is. The behaviour that reads these rows lives in
 * src/core/active-skills.js, keyed by the same ids — so retuning a cooldown
 * never means opening a file with game logic in it.
 *
 * `duration: 0` means the skill resolves the instant it is cast and has no
 * active window. The state machine still runs it through the same
 * cast -> active -> cooldown path; the active phase is simply zero-length.
 */

/**
 * Save-game and dispatch keys. English identifiers, like every other id in
 * src/data — the words a player reads are decided in the UI layer.
 */
export const ACTIVE_SKILL_IDS = {
  AFTERBURNER: 'afterburner',
  EMP_SHOCKWAVE: 'emp_shockwave',
  MISSILE_SALVO: 'missile_salvo',
  PHASE_SHIFT: 'phase_shift',
  SINGULARITY_ANCHOR: 'singularity_anchor',
  OVERCHARGE_CORE: 'overcharge_core',
  POINT_DEFENSE: 'point_defense',
};

/**
 * The skill every run starts with unless the hangar says otherwise.
 *
 * Afterburner on purpose: it is the only one of the seven whose failure mode
 * is "wasted a cooldown" rather than "died somewhere new", so it is the one a
 * first-time player can press at the wrong moment and learn from.
 */
export const DEFAULT_ACTIVE_SKILL_ID = ACTIVE_SKILL_IDS.AFTERBURNER;

/**
 * @typedef {Object} ActiveSkillDef
 * @property {string} id - Dispatch key; matches a handler in core/active-skills.js
 * @property {string} name - Player-facing name
 * @property {string} description - Player-facing one-liner
 * @property {string} mark - Short glyph the HUD socket draws when it has no icon
 * @property {number} cooldown - Seconds before it can be cast again
 * @property {number} duration - Seconds the active window lasts; 0 for instant
 * @property {Object} params - Per-skill tuning, read only by its own handler
 */

/** @type {Record<string, ActiveSkillDef>} */
export const ACTIVE_SKILLS = {
  [ACTIVE_SKILL_IDS.AFTERBURNER]: {
    id: ACTIVE_SKILL_IDS.AFTERBURNER,
    name: 'Afterburner',
    description: 'Overdrive the drive plume: +130% speed, and anything light enough gets thrown aside.',
    mark: '▲',
    cooldown: 8,
    duration: 2.2,
    params: {
      /**
       * 2.3x, i.e. the +130% the brief asks for. Applied to top speed AND to
       * the approach rate, because raising one without the other produces a
       * ship that is faster but takes the same quarter-second to get there —
       * which does not read as a burst at a 2.2s duration.
       */
      speedMultiplier: 2.3,
      accelMultiplier: 2.3,
      /** Contact reach around the hull, in px, measured centre to centre. */
      rammingRadius: 46,
      /** Push applied to whatever the plume catches, in px. */
      knockback: 180,
      ramDamage: 26,
      /**
       * Anything with a bigger collision radius than this shrugs the ram off.
       * The brief says "light enemies"; radius is the roster's only honest
       * proxy for mass, and it is already what damageEnemy scales its kinetic
       * knock by, so the two agree about what heavy means.
       */
      maxRamRadius: 16,
      /** Seconds before the same enemy can be rammed again. */
      ramCooldown: 0.45,
    },
  },

  [ACTIVE_SKILL_IDS.EMP_SHOCKWAVE]: {
    id: ACTIVE_SKILL_IDS.EMP_SHOCKWAVE,
    name: 'EMP Shockwave',
    description: 'Wipes every hostile round on the field and locks the swarm around you.',
    mark: '◎',
    cooldown: 12,
    duration: 0,
    params: {
      /** Stun reach, px. Bullet clearing is arena-wide and takes no radius. */
      radius: 140,
      stun: 1.8,
      damage: 18,
      /** Outward shove so the freeze reads as a blast, not a pause button. */
      knockback: 70,
    },
  },

  [ACTIVE_SKILL_IDS.MISSILE_SALVO]: {
    id: ACTIVE_SKILL_IDS.MISSILE_SALVO,
    name: 'Micro-Missile Salvo',
    description: 'Eight guided micro-missiles break 360° off the hull and hunt down what matters.',
    mark: '✶',
    cooldown: 10,
    duration: 0,
    params: {
      count: 8,
      damage: 34,
      speed: 330,
      /** Radians/sec the seekers may turn. High enough to catch a strafing target. */
      turnRate: 5.0,
      life: 2.6,
      radius: 6,
      /** Acquisition reach. Beyond it a missile flies its launch heading. */
      seekRange: 680,
      /**
       * Half the salvo takes the nearest target and half takes the highest-HP
       * one. Sending all eight at the nearest wastes the burst on a larva
       * while the Goliath behind it walks through; sending all eight at the
       * tankiest leaves the thing about to touch you alive.
       */
      heavySeekerRatio: 0.5,
    },
  },

  [ACTIVE_SKILL_IDS.PHASE_SHIFT]: {
    id: ACTIVE_SKILL_IDS.PHASE_SHIFT,
    name: 'Phase Shift',
    description: 'Blink 240px along your heading. Untouchable through the jump and just after it.',
    mark: '⟡',
    cooldown: 9,
    duration: 0.75,
    params: {
      distance: 240,
      /**
       * The i-frames run for the whole `duration`, which is what makes this a
       * defensive tool rather than a repositioning one: the jump itself is
       * instant, so without a trailing window it would drop you into a fresh
       * contact hit on the landing frame.
       */
      invulnerable: true,
    },
  },

  [ACTIVE_SKILL_IDS.SINGULARITY_ANCHOR]: {
    id: ACTIVE_SKILL_IDS.SINGULARITY_ANCHOR,
    name: 'Singularity Anchor',
    description: 'Throws a gravity well that hauls the swarm into its centre and crushes it.',
    mark: '◉',
    cooldown: 14,
    duration: 3.5,
    params: {
      /** How far ahead of the hull the anomaly is planted, px. */
      throwDistance: 180,
      /** Capture reach, px. */
      radius: 220,
      /**
       * Pull speed in px/s at the rim, easing to zero at the core so captured
       * enemies settle rather than jittering across the centre point.
       */
      pullSpeed: 260,
      /** Damage per crush tick. */
      damage: 14,
      /** Seconds between crush ticks. */
      tickInterval: 0.4,
      /** The boss is immovable; only its escorts get hauled. */
      affectsBoss: false,
    },
  },

  [ACTIVE_SKILL_IDS.OVERCHARGE_CORE]: {
    id: ACTIVE_SKILL_IDS.OVERCHARGE_CORE,
    name: 'Overcharge Core',
    description: 'Dump the reactor into the guns: double fire rate, quarter of your speed gone.',
    mark: '⚛',
    cooldown: 15,
    duration: 4.0,
    params: {
      /** 0.75 = the -25% the brief asks for. */
      moveSpeedMultiplier: 0.75,
      /** 2.0 = +100% fire rate. */
      fireRateMultiplier: 2.0,
    },
  },

  [ACTIVE_SKILL_IDS.POINT_DEFENSE]: {
    id: ACTIVE_SKILL_IDS.POINT_DEFENSE,
    name: 'Point-Defense Overdrive',
    description: 'Two overcharged blades hug the hull, shredding contact and eating incoming fire.',
    mark: '✦',
    cooldown: 11,
    duration: 3.5,
    params: {
      bladeCount: 2,
      /** Orbit radius, px — deliberately tight, this is a last-ditch bubble. */
      orbitRadius: 52,
      bladeRadius: 13,
      /** Radians/sec. Fast enough that the two blades read as a solid ring. */
      rotationSpeed: 11,
      damage: 22,
      /** Seconds before the same enemy can be cut again. */
      hitCooldown: 0.22,
      /**
       * Blades also delete hostile rounds that reach the bubble. The catch
       * radius is the orbit band, not the blade — a bullet that crosses the
       * ring between two blades should still be eaten, or the skill's defence
       * half would depend on the blades' phase at the moment of impact.
       */
      interceptRadius: 64,
    },
  },
};

/**
 * Fixed display order for the hangar and for any UI that lists all seven.
 * Object key order would work today but is not something to depend on.
 */
export const ACTIVE_SKILL_ORDER = [
  ACTIVE_SKILL_IDS.AFTERBURNER,
  ACTIVE_SKILL_IDS.EMP_SHOCKWAVE,
  ACTIVE_SKILL_IDS.MISSILE_SALVO,
  ACTIVE_SKILL_IDS.PHASE_SHIFT,
  ACTIVE_SKILL_IDS.SINGULARITY_ANCHOR,
  ACTIVE_SKILL_IDS.OVERCHARGE_CORE,
  ACTIVE_SKILL_IDS.POINT_DEFENSE,
];

/**
 * @param {string} id
 * @returns {ActiveSkillDef|null}
 */
export function getActiveSkillById(id) {
  return ACTIVE_SKILLS[id] ?? null;
}
