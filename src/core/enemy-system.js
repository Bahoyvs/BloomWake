/**
 * Enemy behaviour state machines — the code half of the roster.
 *
 * ---------------------------------------------------------------------------
 * THE SPLIT
 * ---------------------------------------------------------------------------
 * src/data/roster-config.js says WHAT a species is (how fast, how far it stands
 * off, how long it telegraphs). This file says HOW each behaviour is executed,
 * and it reads every number it uses out of that row. There are no species names
 * in here and no tuning constants: a handler that hardcoded "220px" would make
 * the config's standoffMin a lie, and the next designer would tune a number
 * that does nothing.
 *
 * ---------------------------------------------------------------------------
 * SHAPE OF A HANDLER
 * ---------------------------------------------------------------------------
 * A handler decides a HEADING and a SPEED and writes them into the shared `out`
 * record. It does not move the entity. One integration step in the caller turns
 * heading x speed into velocity, adds knockback, and writes `vx`/`vy` — which
 * the renderer reads for facing. Handlers that moved entities themselves would
 * each have to remember to write velocity too, and the one that forgot would
 * leave its species sliding sideways while pointing straight ahead.
 *
 * Firing is not a handler's job either: it calls ctx.fire() with a bullet spec
 * and the caller decides where bullets live. The simulation owns its pools; the
 * tests pass a collecting array and assert on what came out.
 *
 * Strictly DOM-free and allocation-light: these run up to 200 times a frame.
 */

import { BEHAVIORS, BULLET_TYPES, WEAPON_TYPES, getArchetype } from '../data/roster-config.js';

/**
 * The rammer's four beats. Exported because the renderer paints the telegraph
 * from `rammerState === TELEGRAPH` — the warning line and the state that makes
 * the dash happen have to be the same fact, or the boss of all bugs appears:
 * a lunge with no warning.
 */
export const RAMMER_STATE = {
  CRUISE: 'cruise',
  TELEGRAPH: 'telegraph',
  DASH: 'dash',
  RECOVER: 'recover',
};

/**
 * Shared step result, mutated in place.
 *
 * Module-level for the same reason as FACING in simulation.js: stepEnemy is
 * called once per enemy per frame and a fresh literal each time is 200
 * allocations a frame to carry three numbers. Callers must read it before the
 * next call, never store it.
 */
const STEP = { headingX: 0, headingY: 0, speed: 0 };

/**
 * Bring a pooled entity to life as an instance of an archetype.
 *
 * Every field the behaviour state machines touch is (re)initialised here,
 * including the ones only one behaviour uses. A recycled entity that kept its
 * predecessor's `rammerTimer` would dash on its first frame, which is exactly
 * the class of bug pooling is famous for.
 *
 * @param {Object} entity - A pooled enemy record
 * @param {string|Object} archetypeOrId - Row from ENEMY_ARCHETYPES, or its id
 * @param {Object} [options]
 * @param {number} [options.hpScale] - Wave HP multiplier
 * @param {number} [options.speedScale] - Wave speed multiplier
 * @param {() => number} [options.rng] - Seeded RNG, for stagger
 * @returns {Object} The same entity
 */
export function applyArchetype(entity, archetypeOrId, options = {}) {
  const archetype =
    typeof archetypeOrId === 'string' ? getArchetype(archetypeOrId) : archetypeOrId;
  if (!archetype) throw new Error(`Unknown archetype: ${archetypeOrId}`);

  const { hpScale = 1, speedScale = 1, rng = Math.random } = options;
  const params = archetype.behaviorParams ?? {};

  entity.archetypeId = archetype.id;
  entity.typeId = archetype.id;
  entity.behavior = archetype.behavior;
  entity.spriteKey = archetype.spriteKey;
  entity.radius = archetype.radius;
  entity.hp = archetype.hp * hpScale;
  entity.maxHp = entity.hp;
  entity.baseSpeed = archetype.speed * speedScale;
  entity.speed = entity.baseSpeed;
  entity.mass = archetype.mass ?? 1;
  entity.contactDamage = archetype.contactDamage ?? 0;
  entity.scoreValue = archetype.scoreValue ?? 0;
  entity.scrapValue = archetype.scrapValue ?? 0;
  entity.xpValue = archetype.xpValue ?? 0;
  entity.alive = true;
  entity.timeAlive = 0;

  /* ---- Behaviour state, reset on every acquire ---- */
  /**
   * Strafe sense and its flip clock (kiting). Drawn from the RNG so a pack of
   * scouts does not orbit in unison — a ring of enemies all going the same way
   * has a permanent safe spot in the middle of it.
   */
  entity.strafeSign = rng() < 0.5 ? -1 : 1;
  entity.strafeTimer = (params.strafeFlipSec ?? 2.6) * (0.5 + rng() * 0.5);
  /** Weapon clock. Staggered, so an arriving pack does not volley as one. */
  entity.fireTimer = archetype.attack ? (archetype.attack.fireInterval ?? 1) * rng() : 0;
  /* Rammer cycle. */
  entity.rammerState = RAMMER_STATE.CRUISE;
  entity.rammerTimer = 0;
  entity.lockDirX = 0;
  entity.lockDirY = 0;

  return entity;
}

/* ------------------------------------------------------------------ */
/* Behaviour handlers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Straight at the target, full speed, forever. The floor the rest is measured
 * against: if a species does not play differently from this, it is a re-skin.
 */
function stepSwarm(entity, ctx, dt, params, out) {
  out.headingX = ctx.dirX;
  out.headingY = ctx.dirY;
  out.speed = entity.baseSpeed;
}

/**
 * Sine weave across the approach vector.
 *
 * The weave rides the PERPENDICULAR, so the entity still closes while it arcs
 * and arrives off the shoulder instead of down the same lane as everything
 * else. Amplitude eases off inside `settleRange`: a full-amplitude weave at
 * contact distance is a coin flip about whether it connects, which reads as the
 * enemy missing by accident rather than the player dodging on purpose.
 */
function stepSine(entity, ctx, dt, params, out) {
  const amount = params.weaveAmount ?? 0.55;
  const rate = params.weaveRate ?? 4.2;
  const settle = params.settleRange ?? 0;

  let amplitude = amount;
  if (settle > 0 && ctx.distance < settle) {
    amplitude = amount * (ctx.distance / settle);
  }

  const weave = Math.sin(entity.timeAlive * rate + (entity.phaseOffset ?? 0)) * amplitude;
  out.headingX = ctx.dirX + -ctx.dirY * weave;
  out.headingY = ctx.dirY + ctx.dirX * weave;
  out.speed = entity.baseSpeed;
}

/**
 * Hold a standoff band and shoot across it.
 *
 * Three zones, and the middle one is the species: outside `standoffMax` it
 * closes, inside `standoffMin` it backs off, and in between it strafes at
 * `strafeScale` of cruise and fires. The BAND is what makes it readable — a
 * kiter holding one exact radius crosses that radius every frame and reads as
 * jitter rather than as an enemy keeping its distance.
 */
function stepKiting(entity, ctx, dt, params, out) {
  const min = params.standoffMin ?? 220;
  const max = params.standoffMax ?? 300;

  entity.strafeTimer -= dt;
  if (entity.strafeTimer <= 0) {
    entity.strafeSign = -entity.strafeSign;
    entity.strafeTimer = params.strafeFlipSec ?? 2.6;
  }

  const perpX = -ctx.dirY * entity.strafeSign;
  const perpY = ctx.dirX * entity.strafeSign;

  if (ctx.distance > max) {
    // Close, but keep some lateral travel: a kiter that approaches dead
    // straight is a slow swarm enemy for the whole of its approach.
    out.headingX = ctx.dirX + perpX * 0.35;
    out.headingY = ctx.dirY + perpY * 0.35;
    out.speed = entity.baseSpeed;
  } else if (ctx.distance < min) {
    out.headingX = -ctx.dirX + perpX * 0.5;
    out.headingY = -ctx.dirY + perpY * 0.5;
    out.speed = entity.baseSpeed;
  } else {
    entity.inStandoffBand = true;
    out.headingX = perpX;
    out.headingY = perpY;
    out.speed = entity.baseSpeed * (params.strafeScale ?? 0.85);
    return;
  }
  entity.inStandoffBand = false;
}

/**
 * Creep, lock, commit, recover.
 *
 * THE LOCK IS THE CONTRACT. For `telegraphSec` the rammer sits still on the
 * vector it is about to fly, and that vector is frozen at the moment the lock
 * is taken — the dash goes where the warning pointed, not where the Drifter has
 * since moved. A dash that re-aims during its wind-up is an unavoidable hit
 * wearing a telegraph's clothes.
 *
 * `recoverSec` is the other half of the deal: a dodged lunge leaves the rammer
 * committed and harmless for a beat, so reading the telegraph is rewarded twice
 * over — once by not being hit, and once by the free window that follows.
 */
function stepRammer(entity, ctx, dt, params, out) {
  const lockRange = params.lockRange ?? 420;

  entity.rammerTimer -= dt;

  switch (entity.rammerState) {
    case RAMMER_STATE.TELEGRAPH:
      if (entity.rammerTimer <= 0) {
        entity.rammerState = RAMMER_STATE.DASH;
        entity.rammerTimer = params.dashSec ?? 0.9;
        ctx.emit('enemy:dash', { id: entity.id, x: entity.x, y: entity.y });
      }
      // Braced in place: the warning line says where, standing still says when.
      out.headingX = entity.lockDirX;
      out.headingY = entity.lockDirY;
      out.speed = 0;
      return;

    case RAMMER_STATE.DASH:
      if (entity.rammerTimer <= 0) {
        entity.rammerState = RAMMER_STATE.RECOVER;
        entity.rammerTimer = params.recoverSec ?? 1.1;
        out.headingX = entity.lockDirX;
        out.headingY = entity.lockDirY;
        out.speed = entity.baseSpeed;
        return;
      }
      out.headingX = entity.lockDirX;
      out.headingY = entity.lockDirY;
      out.speed = params.dashSpeed ?? 350;
      return;

    case RAMMER_STATE.RECOVER:
      if (entity.rammerTimer <= 0) entity.rammerState = RAMMER_STATE.CRUISE;
      out.headingX = ctx.dirX;
      out.headingY = ctx.dirY;
      // Drifting, not stopped: a dead-stopped enemy reads as a bug, and a
      // half-speed one still gives the player their punish window.
      out.speed = entity.baseSpeed * 0.35;
      return;

    default:
      if (ctx.distance <= lockRange) {
        entity.rammerState = RAMMER_STATE.TELEGRAPH;
        entity.rammerTimer = params.telegraphSec ?? 1.2;
        // Lock taken HERE, at the start of the wind-up, so the line the warning
        // draws is the line the dash will fly.
        entity.lockDirX = ctx.dirX;
        entity.lockDirY = ctx.dirY;
        ctx.emit('enemy:lock_on', {
          id: entity.id,
          x: entity.x,
          y: entity.y,
          dirX: ctx.dirX,
          dirY: ctx.dirY,
          durationSec: params.telegraphSec ?? 1.2,
        });
        // Brace on the SAME frame the lock is taken. One frame of drift after
        // the warning appears is one frame of the telegraph lying.
        out.headingX = ctx.dirX;
        out.headingY = ctx.dirY;
        out.speed = 0;
        return;
      }
      out.headingX = ctx.dirX;
      out.headingY = ctx.dirY;
      out.speed = entity.baseSpeed;
  }
}

/**
 * Behaviour dispatch. Adding a movement rule means a handler here and a value
 * in BEHAVIORS — validateRosterConfig() checks the two stay in step.
 */
export const BEHAVIOR_HANDLERS = {
  [BEHAVIORS.SWARM]: stepSwarm,
  [BEHAVIORS.SINE]: stepSine,
  [BEHAVIORS.KITING]: stepKiting,
  [BEHAVIORS.RAMMER]: stepRammer,
};

/* ------------------------------------------------------------------ */
/* Weapons                                                             */
/* ------------------------------------------------------------------ */

/**
 * Turn one weapon row into bullets.
 *
 * Shared with src/core/composite-boss.js on purpose: a scout's gun and a
 * cruiser's turret are the same three patterns at different numbers, and two
 * copies of "evenly space `count` rounds around a circle" would drift apart the
 * first time one of them was fixed.
 *
 * @param {Object} weapon - Row from an archetype's `attack` or a part's `weapon`
 * @param {{x: number, y: number, aimX: number, aimY: number}} origin - Muzzle
 *   position and a unit aim vector
 * @param {Object} ctx - { fire(spec), rng() }
 * @returns {number} Rounds fired
 */
export function fireWeapon(weapon, origin, ctx) {
  if (!weapon) return 0;
  const bullet = BULLET_TYPES[weapon.bulletType] ?? null;
  const speed = weapon.speed ?? 200;
  const damage = weapon.damage ?? 0;
  const base = Math.atan2(origin.aimY, origin.aimX);

  const shoot = (angle) => {
    ctx.fire({
      x: origin.x,
      y: origin.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      damage,
      radius: bullet?.radius,
      life: bullet?.lifeSec,
      bulletType: weapon.bulletType,
    });
  };

  switch (weapon.type) {
    case WEAPON_TYPES.SPREAD_VOLLEY: {
      const count = Math.max(1, weapon.count ?? 3);
      const spread = weapon.spreadRad ?? 0.3;
      // Centred on the aim vector: an odd count puts one round dead on target,
      // an even count straddles it. Both are intentional reads for the player.
      const start = base - (spread * (count - 1)) / 2;
      for (let i = 0; i < count; i++) shoot(start + spread * i);
      return count;
    }

    case WEAPON_TYPES.RADIAL_BURST: {
      const count = Math.max(2, weapon.count ?? 12);
      /**
       * Rolled each burst rather than fixed. A ring that always leaves its gap
       * at the same angle teaches the player one safe bearing and then stops
       * being an attack.
       */
      const offset = (ctx.rng ? ctx.rng() : Math.random()) * Math.PI * 2;
      for (let i = 0; i < count; i++) shoot(offset + (i / count) * Math.PI * 2);
      return count;
    }

    case WEAPON_TYPES.SINGLE_AIMED:
    default:
      shoot(base);
      return 1;
  }
}

/* ------------------------------------------------------------------ */
/* The per-entity step                                                 */
/* ------------------------------------------------------------------ */

/**
 * Advance one archetype-driven enemy by a tick.
 *
 * Does NOT integrate position — see the note at the top of the file. The caller
 * turns the returned heading and speed into velocity so that knockback, frenzy
 * scaling and world clamping stay in one place for every species.
 *
 * @param {Object} entity - An entity previously passed through applyArchetype
 * @param {Object} ctx - { target: {x, y}, fire(spec), emit(type, payload), rng() }
 * @param {number} dt - Seconds
 * @returns {{headingX: number, headingY: number, speed: number}} Shared record;
 *   read it before the next call
 */
export function stepEnemy(entity, ctx, dt) {
  const archetype = getArchetype(entity.archetypeId);
  const params = archetype?.behaviorParams ?? {};

  entity.timeAlive += dt;

  const target = ctx.target;
  const dx = target.x - entity.x;
  const dy = target.y - entity.y;
  const distance = Math.hypot(dx, dy) || 1e-6;

  // Written onto the ctx the caller handed us rather than into a new object:
  // handlers need the aim vector and the range, and recomputing a hypot inside
  // three of the four handlers is the kind of waste a 200-entity loop notices.
  ctx.dirX = dx / distance;
  ctx.dirY = dy / distance;
  ctx.distance = distance;
  if (!ctx.emit) ctx.emit = noop;

  STEP.headingX = ctx.dirX;
  STEP.headingY = ctx.dirY;
  STEP.speed = entity.baseSpeed;

  const handler = BEHAVIOR_HANDLERS[entity.behavior] ?? stepSwarm;
  handler(entity, ctx, dt, params, STEP);

  stepAttack(entity, ctx, dt, archetype);

  return STEP;
}

/**
 * Run an archetype's own gun, if it has one.
 *
 * `requiresBand` is what keeps the Spore Scout honest: it only shoots from
 * inside its standoff band, so a player who closes the gap has actually
 * achieved something. A kiter that keeps firing while it retreats punishes the
 * one counter-play it is supposed to have.
 *
 * @param {Object} entity
 * @param {Object} ctx
 * @param {number} dt
 * @param {Object} archetype
 */
function stepAttack(entity, ctx, dt, archetype) {
  const attack = archetype?.attack;
  if (!attack || !ctx.fire) return;

  entity.fireTimer -= dt;
  if (entity.fireTimer > 0) return;

  if (attack.requiresBand && !entity.inStandoffBand) {
    /**
     * Held, not reset. The clock keeps sitting at zero while the scout is out
     * of position, so the shot goes off the instant it settles back into the
     * band rather than starting a fresh 2.8s wait — otherwise a player who
     * shoves it out of position repeatedly disarms it for free.
     */
    entity.fireTimer = 0;
    return;
  }

  entity.fireTimer = attack.fireInterval ?? 1;
  fireWeapon(
    attack,
    {
      x: entity.x + ctx.dirX * entity.radius,
      y: entity.y + ctx.dirY * entity.radius,
      aimX: ctx.dirX,
      aimY: ctx.dirY,
    },
    ctx
  );
  ctx.emit('enemy:fire', { id: entity.id, x: entity.x, y: entity.y, weapon: attack.type });
}

function noop() {}
