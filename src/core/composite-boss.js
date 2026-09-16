/**
 * Composite bosses — a chassis carrying independently-targetable parts.
 *
 * ---------------------------------------------------------------------------
 * WHY A BOSS IS MADE OF PARTS
 * ---------------------------------------------------------------------------
 * A single-HP-bar boss with scripted attacks gives the player one decision:
 * shoot it, and dodge. A modular one gives them a target list. Silence the
 * spread turret first and the fight is longer but calmer; go for the reactor
 * and the ring stops but the flanks are still live. The pattern changes because
 * the thing that fired it is *gone*, not because a script advanced a line.
 *
 * The chassis is armoured while its named parts live (`chassis.armoredBy`), so
 * "ignore the modules, focus the big bar" is not available. That single rule is
 * what makes the parts load-bearing rather than decorative.
 *
 * ---------------------------------------------------------------------------
 * ONE TRANSFORM, TWO CONSUMERS
 * ---------------------------------------------------------------------------
 * Parts are authored in chassis-local pixels and rotate with the hull. This
 * file computes `worldX`/`worldY`/`worldRotation` once a tick;
 * src/render/composite-boss-renderer.js builds its Pixi container tree from the
 * SAME `offset` values. Sprite and hitbox therefore cannot drift apart — the
 * failure mode where a player shoots a turret they can see and hits nothing
 * simply has nowhere to live.
 *
 * ---------------------------------------------------------------------------
 * THE ENRAGED CORE
 * ---------------------------------------------------------------------------
 * `armoredBy` has a cost, and it lands at the end of the fight. Every gun on a
 * composite boss belongs to a PART, so the frame the player finishes stripping
 * the armour is the frame the boss stops being able to answer — and what is
 * left is two to three thousand HP of scenery that cannot shoot, cannot
 * threaten, and takes a minute to grind off. The hardest part of the encounter
 * is followed by its dullest, and the player's reward for solving the puzzle is
 * to be bored by its corpse.
 *
 * `chassis.enrage` closes that hole. The hull keeps whatever HP it has left —
 * nothing here heals, because a threshold that healed would make stripping the
 * armour a mistake — and starts fighting with weapons that are ITS OWN rather
 * than a dead module's:
 *
 *   - `innateWeapons` are guns bolted to the chassis, fired on the enrage
 *     state instead of on a phase's weapon list. A phase list describes the
 *     boss while its parts live; these exist for when they do not.
 *   - `chargeAttack` is a four-beat lock/commit/recover cycle, the same deal
 *     the Dart Ravager offers (see stepRammer): the vector is frozen when the
 *     telegraph appears and never re-aimed, and a dodge buys a punish window.
 *   - `gravityWell` is a standing field, not an attack — it bends every line
 *     the player flies and charges them for the ground they need.
 *   - `ventMinions` and the shockwave rings are the boss spending its own body:
 *     a carrier hull cracked open spills what was inside it.
 *
 * Enrage is a LATCH. Once set it never clears, because the condition that set
 * it (a wrecked part) can never un-happen, and a boss that flickered in and out
 * of it would be unreadable.
 *
 * Strictly DOM-free. Bullets leave through `ctx.fire`, events through
 * `ctx.emit`, hazard patches through `ctx.hazard`, vented minions through
 * `ctx.spawn`, the gravity pull through `ctx.impulse` and shockwave hits
 * through `ctx.hurt`. Every one of those is a callback the caller supplies:
 * this class never touches a pool, a bus or the player directly, and a test
 * passes collecting stubs for all six.
 */

import {
  ENRAGE_TRIGGERS,
  PHASE_TRIGGERS,
  WEAPON_TYPES,
  getBossTemplate,
  getTemplateTotalHp,
  gravityWellForce,
} from '../data/roster-config.js';
import { fireWeapon } from './enemy-system.js';

/**
 * The enraged chassis's ramming cycle.
 *
 * Exported for the same reason RAMMER_STATE is: the renderer paints the
 * telegraph beam from `chargeState === TELEGRAPH`, so the warning the player
 * sees and the state that makes the charge happen are one fact rather than two
 * that can disagree. A boss that lunges with no warning is the worst bug this
 * file can ship, and there is nowhere for it to hide if both halves read the
 * same field.
 */
export const CHARGE_STATE = {
  /** Enraged cruise, closing on the target while the cooldown runs. */
  IDLE_DRIFT: 'idle_drift',
  /** Vector locked, hull braced and motionless. The stillness is the "when". */
  TELEGRAPH: 'telegraph',
  /** Committed, at chargeSpeed, down the locked vector. Drops its wake. */
  CHARGING: 'charging',
  /** Coasting to a stop. The window a player who read the telegraph earned. */
  RECOVERY: 'recovery',
};

/**
 * Fraction of a cooldown the first charge / first shockwave / first innate
 * volley waits after the enrage.
 *
 * Not zero and not one. Zero means the roar and the attack land on the same
 * frame and the player never gets to read the transition; one means five and a
 * half seconds of a boss that has visibly changed doing nothing, which reads as
 * the enrage having failed to work.
 */
const ENRAGE_OPENING_BEAT = 0.45;

/** Seconds of coast after a charge, when the template does not say. */
const DEFAULT_RECOVERY_SEC = 0.9;

/**
 * Tangential share of a spiralling gravity well's pull, as a fraction of the
 * inward component. 0 is a straight line into the core, which the player fights
 * by holding one key; this curves them into an orbit they have to actually fly
 * out of.
 */
const DEFAULT_SPIRAL_SCALE = 0.4;

export class CompositeBoss {
  /**
   * @param {string|Object} templateOrId - Row from COMPOSITE_BOSSES, or its id
   * @param {Object} [options]
   * @param {number} [options.x]
   * @param {number} [options.y]
   * @param {number} [options.hpScale] - Wave scaling, applied to chassis AND parts
   * @param {number} [options.id] - Entity id, assigned by the caller's allocator
   * @param {() => number} [options.rng] - Seeded RNG, for firing stagger
   */
  constructor(templateOrId, options = {}) {
    const template =
      typeof templateOrId === 'string' ? getBossTemplate(templateOrId) : templateOrId;
    if (!template) throw new Error(`Unknown boss template: ${templateOrId}`);

    const { x = 0, y = 0, hpScale = 1, id = 0, rng = Math.random } = options;

    this.template = template;
    this.templateId = template.id;
    this.id = id;
    this.isBoss = true;
    this.isComposite = true;
    this.rng = rng;

    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    /** Hull heading, radians. Parts rotate with it. */
    this.rotation = 0;
    this.timeAlive = 0;
    this.alive = true;

    const chassis = template.chassis;
    this.radius = chassis.radius;
    this.chassisHp = chassis.hp * hpScale;
    this.chassisMaxHp = this.chassisHp;
    this.baseSpeed = chassis.speed ?? 0;
    this.baseSpin = chassis.spin ?? 0;
    this.contactDamage = chassis.contactDamage ?? 0;
    this.scoreValue = template.scoreValue ?? 0;
    this.scrapValue = template.scrapValue ?? 0;
    this.xpValue = template.xpValue ?? 0;
    this.hitFlash = 0;

    /**
     * Multipliers accumulated from wrecked parts (`onDestroyed`). Separate from
     * the phase's own scales because they are permanent consequences of player
     * action, while a phase scale is a state the boss is currently in —
     * multiplying them together keeps both readable.
     */
    this.wreckSpeedScale = 1;
    this.wreckSpinScale = 1;

    this.parts = (template.parts ?? []).map((def) => ({
      id: def.id,
      def,
      role: def.role ?? 'module',
      localX: def.offset.x,
      localY: def.offset.y,
      localRotation: def.rotation ?? 0,
      radius: def.radius,
      hp: def.hp * hpScale,
      maxHp: def.hp * hpScale,
      alive: true,
      /** World transform, recomputed every tick by syncParts(). */
      worldX: x + def.offset.x,
      worldY: y + def.offset.y,
      worldRotation: def.rotation ?? 0,
      /** Staggered so a freshly spawned boss does not open with a full salvo. */
      fireTimer: def.weapon ? (def.weapon.fireInterval ?? 1) * (0.4 + rng() * 0.6) : 0,
      hitFlash: 0,
      destroyedAt: -1,
      scoreValue: def.scoreValue ?? 0,
      scrapValue: def.scrapValue ?? 0,
    }));

    this.totalMaxHp = getTemplateTotalHp(template) * hpScale;
    /** Index into template.phases. Phase 0 is the `initial` phase. */
    this.phaseIndex = 0;
    this.destroyedCount = 0;

    /* ---- The enraged core ---- */
    /** @type {Object|null} chassis.enrage, or null for a boss that stays inert. */
    this.enrageConfig = chassis.enrage ?? null;
    /** Guns bolted to the chassis rather than to a part. */
    this.innateWeapons = chassis.innateWeapons ?? [];
    /** Latched on the frame the armour comes off; never cleared. */
    this.isEnraged = false;
    /** Seconds since the enrage. The renderer ramps its flare-up off this. */
    this.enrageTime = 0;

    /**
     * One clock per innate weapon, keyed by id, and one burst counter for the
     * ones whose ring walks its gap round the circle (`spiralOffset`).
     *
     * Maps rather than fields on the weapon rows: those rows are the SHARED
     * template objects out of roster-config, and writing a timer onto one would
     * make two simultaneous bosses of the same kind fire in lockstep off each
     * other's clock.
     */
    this.innateTimers = new Map();
    this.innateBursts = new Map();
    for (const weapon of this.innateWeapons) {
      this.innateTimers.set(weapon.id, 0);
      this.innateBursts.set(weapon.id, 0);
    }

    this.chargeState = CHARGE_STATE.IDLE_DRIFT;
    this.chargeTimer = 0;
    /** Unit vector, frozen when the telegraph appears. The charge flies THIS. */
    this.chargeDirX = 1;
    this.chargeDirY = 0;
    /** Span of the current recovery, so its deceleration can be normalised. */
    this.recoverySpan = DEFAULT_RECOVERY_SEC;

    this.ventTimer = 0;
    this.shockwaveTimer = 0;
    /** Live expanding rings. Each one hits the player at most once. */
    this.shockwaves = [];
    /**
     * Last frame's gravity pull, px/s, for the renderer and for tests. The
     * pull itself has already been handed to `ctx.impulse`; this is a record of
     * it, not the channel it travels down.
     */
    this.gravityPullX = 0;
    this.gravityPullY = 0;

    this.syncParts();
  }

  /* ---------------------------------------------------------------- */
  /* Queries                                                           */
  /* ---------------------------------------------------------------- */

  /** @returns {number} Chassis HP plus every living part's HP. */
  get totalHp() {
    let total = Math.max(0, this.chassisHp);
    for (const part of this.parts) if (part.alive) total += Math.max(0, part.hp);
    return total;
  }

  /** @returns {number} 0..1, the fraction the HP bar draws and phases trigger on. */
  get hpFraction() {
    return this.totalMaxHp > 0 ? this.totalHp / this.totalMaxHp : 0;
  }

  /** @returns {Object} The active phase row. */
  get phase() {
    return this.template.phases[this.phaseIndex] ?? this.template.phases[0];
  }

  /** @returns {number} 1-based phase number, for HUD and events. */
  get phaseNumber() {
    return this.phaseIndex + 1;
  }

  /**
   * Is the chassis takeable yet?
   *
   * False while ANY part named in `chassis.armoredBy` still stands. This is the
   * rule that makes the modules matter; without it every composite boss is a
   * normal boss with scenery bolted to it.
   *
   * @returns {boolean}
   */
  isChassisVulnerable() {
    const armor = this.template.chassis.armoredBy ?? [];
    for (const partId of armor) {
      const part = this.getPart(partId);
      if (part && part.alive) return false;
    }
    return true;
  }

  /**
   * Is every part named in `chassis.armoredBy` wrecked?
   *
   * NOT the same question as isChassisVulnerable(), and the difference is the
   * whole reason this exists. That method answers "can a shot land?", and for a
   * chassis with an EMPTY `armoredBy` the answer is yes from frame one — it has
   * no armour to lose. This one answers "has the player taken the armour off?",
   * which for a chassis that never had any is no, forever. Enrage hangs off this
   * one, because driving it off the vacuous truth would have every unarmoured
   * boss spawn already enraged.
   *
   * @returns {boolean}
   */
  isArmorStripped() {
    const armor = this.template.chassis.armoredBy ?? [];
    if (armor.length === 0) return false;
    for (const partId of armor) {
      const part = this.getPart(partId);
      if (part && part.alive) return false;
    }
    return true;
  }

  /**
   * @param {string} partId
   * @returns {Object|null}
   */
  getPart(partId) {
    return this.parts.find((p) => p.id === partId) ?? null;
  }

  /** @returns {Array<Object>} Parts still standing. */
  livingParts() {
    return this.parts.filter((p) => p.alive);
  }

  /**
   * Aimable proxies for the player's OWN targeting systems.
   *
   * Simulation.findNearestEnemy / findHighestHpEnemy / findNearestEnemyTo know
   * nothing about a boss made of parts — they scan a flat list of things with
   * an x, y and hp. This turns the boss into exactly that list: one proxy per
   * living part, plus the chassis once it stops being armoured, so a weapon
   * that has run out of chaff to shoot at keeps firing at the boss instead of
   * falling silent.
   *
   * `isBoss: true` opts them out of the swarm-only knockback and frenzy-speed
   * scaling in updateEnemies (both guarded with `!enemy.isBoss`), the same way
   * the legacy Dreadnought opts out. `isCompositeTarget` is the flag
   * Simulation.damageEnemy uses to redirect real damage back onto THIS boss —
   * a proxy is thrown away every call, so writing hp onto it directly would
   * vanish into nothing.
   *
   * Rebuilt on every call rather than cached: it is only read a few times a
   * second, once per weapon's own cooldown, and caching would mean
   * invalidating it the instant a part dies mid-frame.
   *
   * @returns {Array<Object>}
   */
  getTargetProxies() {
    const proxies = [];
    for (const part of this.parts) {
      if (!part.alive) continue;
      proxies.push({
        id: `boss:${this.id}:part:${part.id}`,
        x: part.worldX,
        y: part.worldY,
        radius: part.radius,
        hp: part.hp,
        maxHp: part.maxHp,
        alive: true,
        isBoss: true,
        isCompositeTarget: true,
        stunTimer: 0,
        bossId: this.id,
        partId: part.id,
      });
    }
    // The chassis only joins the target pool once its armour is gone — while
    // any named part still stands, aiming a weapon at it is aiming at nothing.
    if (this.isChassisVulnerable()) {
      proxies.push({
        id: `boss:${this.id}:chassis`,
        x: this.x,
        y: this.y,
        radius: this.radius,
        hp: this.chassisHp,
        maxHp: this.chassisMaxHp,
        alive: true,
        isBoss: true,
        isCompositeTarget: true,
        stunTimer: 0,
        bossId: this.id,
        partId: null,
      });
    }
    return proxies;
  }

  /* ---------------------------------------------------------------- */
  /* Transform                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Push the chassis transform down to every part.
   *
   * Local offsets are rotated by the hull angle, so a turret authored on the
   * port flank stays on the port flank as the station turns. Wrecked parts are
   * transformed too — the renderer still draws their debris bolted to the hull,
   * and a wreck that stopped moving with the ship would visibly detach.
   */
  syncParts() {
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);

    for (const part of this.parts) {
      part.worldX = this.x + part.localX * cos - part.localY * sin;
      part.worldY = this.y + part.localX * sin + part.localY * cos;
      // Aiming parts overwrite this in updateWeapons; non-aiming ones are
      // welded at their authored angle and simply turn with the hull.
      if (!part.def.aims) part.worldRotation = this.rotation + part.localRotation;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Tick                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Advance the boss by one tick.
   *
   * ORDER MATTERS. Phase first (so a threshold crossed by the last frame's
   * damage arms this frame's guns), then the enrage latch, then movement, then
   * the transform, then the weapons — a turret must fire from where it IS this
   * frame, not from where it was before the hull turned.
   *
   * The enrage check sits between the phase and the movement because it REPLACES
   * the movement rule for the rest of the fight: a boss that evaluated its
   * enrage after moving would drift one frame as a wreck before it woke up, and
   * the transition is the single most important frame of the encounter to get
   * right.
   *
   * @param {number} dt - Seconds
   * @param {Object} ctx - { target: {x, y}, fire(spec), emit(type, payload),
   *   rng(), hazard(spec), spawn(spec), impulse(dvx, dvy), hurt(amount) }.
   *   Everything past `rng` is optional; a caller that supplies none of them
   *   gets an enraged boss that still charges and rams, just without wake,
   *   larvae, pull or shockwave hits.
   */
  update(dt, ctx) {
    if (!this.alive) return;

    this.timeAlive += dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;
    for (const part of this.parts) if (part.hitFlash > 0) part.hitFlash -= dt;

    const emit = ctx.emit ?? noop;
    this.updatePhase(emit);
    if (!this.isEnraged && this.shouldEnrage()) this.enrage(ctx);

    const phase = this.phase;
    if (this.isEnraged) {
      this.enrageTime += dt;
      this.updateEnragedMovement(dt, ctx);
      // Enraged spin is the statline, not a modifier on it: see the note on
      // `enrage.speed` in the roster. A hull that kept the reactor's 0.5 spin
      // penalty would be visibly calmer at its angriest.
      this.rotation += (this.enrageConfig.spin ?? this.baseSpin) * dt;
    } else {
      const speed = this.baseSpeed * (phase.speedScale ?? 1) * this.wreckSpeedScale;
      this.updateDrift(dt, ctx.target, speed);
      this.rotation += this.baseSpin * (phase.spinScale ?? 1) * this.wreckSpinScale * dt;
    }

    this.syncParts();
    this.updateWeapons(dt, ctx, phase);

    if (this.isEnraged) {
      this.updateInnateWeapons(dt, ctx);
      this.updateGravityWell(dt, ctx);
      this.updateVenting(dt, ctx);
      this.updateShockwaves(dt, ctx);
    }
  }

  /**
   * Standard closing drift: straight at the target at `speed`, or a dead stop
   * for a station whose template says speed 0.
   *
   * @param {number} dt
   * @param {{x: number, y: number}|null} target
   * @param {number} speed - px/s
   */
  updateDrift(dt, target, speed) {
    if (!(speed > 0) || !target) {
      this.vx = 0;
      this.vy = 0;
      return;
    }
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.hypot(dx, dy) || 1e-6;
    this.moveAlong(dt, dx / dist, dy / dist, speed);
  }

  /**
   * Integrate one step along a unit vector. The one place an enraged chassis
   * writes velocity, so `vx`/`vy` always agree with where it actually went —
   * the renderer reads them for the thruster flare.
   *
   * @param {number} dt
   * @param {number} dirX - Unit
   * @param {number} dirY - Unit
   * @param {number} speed - px/s
   */
  moveAlong(dt, dirX, dirY, speed) {
    this.vx = dirX * speed;
    this.vy = dirY * speed;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  /* ---------------------------------------------------------------- */
  /* Enrage                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Has the chassis earned its enrage this frame?
   *
   * @returns {boolean}
   */
  shouldEnrage() {
    if (this.isEnraged || !this.enrageConfig) return false;

    switch (this.enrageConfig.trigger) {
      case ENRAGE_TRIGGERS.ALL_PARTS_DESTROYED:
        /*
         * Either reading satisfies it, and they are not the same moment. The
         * Hive Cruiser's armour is its two flank turrets, so the hull wakes up
         * with the reactor STILL FIRING if the player left it alone — which is
         * the interesting version of the fight, and the reason this is an `or`
         * rather than "every part". The second clause is there for a chassis
         * with no named armour at all, which can only be judged on its whole
         * parts list.
         */
        if (this.parts.length === 0) return false;
        return this.isArmorStripped() || this.parts.every((part) => !part.alive);
      default:
        return false;
    }
  }

  /**
   * Wake the chassis up. Called once; the flag latches.
   *
   * HP IS NOT TOUCHED. Nothing here reads or writes chassisHp, and that is the
   * contract the whole feature rests on: the enrage is a state layered on top of
   * the damage the player has already done, so the fight gets harder without any
   * of their work being undone.
   *
   * @param {Object} ctx
   */
  enrage(ctx) {
    const cfg = this.enrageConfig;
    this.isEnraged = true;
    this.enrageTime = 0;
    if (cfg.contactDamage !== undefined) this.contactDamage = cfg.contactDamage;

    this.chargeState = CHARGE_STATE.IDLE_DRIFT;
    this.chargeTimer = (cfg.chargeAttack?.cooldown ?? 0) * ENRAGE_OPENING_BEAT;
    this.shockwaveTimer = (cfg.shockwaveInterval ?? 0) * ENRAGE_OPENING_BEAT;
    for (const weapon of this.innateWeapons) {
      const interval = weapon.fireInterval ?? weapon.interval ?? 0;
      this.innateTimers.set(weapon.id, interval * ENRAGE_OPENING_BEAT);
    }
    /*
     * The vent is the ONE thing that fires on the enrage frame itself, at zero
     * delay. It is not an attack on a cooldown, it is the hull coming apart:
     * the larvae spilling out of the breach are what tells the player the boss
     * just changed, before any of the slower beats have had time to land.
     */
    this.ventTimer = 0;

    (ctx.emit ?? noop)('boss:enraged', {
      id: this.id,
      templateId: this.templateId,
      x: this.x,
      y: this.y,
      radius: this.radius,
      /** HP the hull woke up with. Deliberately not full, and never reset. */
      hp: this.chassisHp,
      hpFraction: this.hpFraction,
      phase: this.phaseNumber,
      /** Parts the player left standing — the reactor, usually. */
      partsLeft: this.livingParts().length,
    });
  }

  /**
   * The ramming cycle: IDLE_DRIFT -> TELEGRAPH -> CHARGING -> RECOVERY.
   *
   * A chassis whose enrage has no `chargeAttack` (the Spire) falls through to a
   * plain drift at the enraged speed, which for a station is zero.
   *
   * @param {number} dt
   * @param {Object} ctx
   */
  updateEnragedMovement(dt, ctx) {
    const cfg = this.enrageConfig;
    const charge = cfg.chargeAttack ?? null;
    const speed = cfg.speed ?? 0;

    if (!charge) {
      this.updateDrift(dt, ctx.target, speed);
      return;
    }

    const emit = ctx.emit ?? noop;
    this.chargeTimer -= dt;

    switch (this.chargeState) {
      case CHARGE_STATE.TELEGRAPH:
        // Braced. Zero movement for the whole window, because the beam says
        // WHERE and standing perfectly still is the only thing that says WHEN.
        this.vx = 0;
        this.vy = 0;
        if (this.chargeTimer <= 0) {
          this.chargeState = CHARGE_STATE.CHARGING;
          this.chargeTimer = charge.chargeDuration;
          emit('boss:charge', {
            id: this.id,
            x: this.x,
            y: this.y,
            dirX: this.chargeDirX,
            dirY: this.chargeDirY,
            speed: charge.chargeSpeed,
            durationSec: charge.chargeDuration,
          });
        }
        return;

      case CHARGE_STATE.CHARGING:
        this.moveAlong(dt, this.chargeDirX, this.chargeDirY, charge.chargeSpeed);
        if (this.chargeTimer <= 0) {
          this.chargeState = CHARGE_STATE.RECOVERY;
          this.recoverySpan = charge.recoveryDuration ?? DEFAULT_RECOVERY_SEC;
          this.chargeTimer = this.recoverySpan;
        }
        return;

      case CHARGE_STATE.RECOVERY: {
        /*
         * Coasting down the SAME vector, not steering back onto the target.
         * A boss that re-acquired during its recovery would erase the window
         * the telegraph promised, and the promise is the only reason reading
         * the telegraph is worth doing.
         */
        const remaining = Math.max(0, this.chargeTimer) / (this.recoverySpan || 1);
        this.moveAlong(dt, this.chargeDirX, this.chargeDirY, charge.chargeSpeed * remaining);
        if (this.chargeTimer <= 0) {
          this.chargeState = CHARGE_STATE.IDLE_DRIFT;
          this.chargeTimer = charge.cooldown;
        }
        return;
      }

      default: {
        if (this.chargeTimer <= 0 && ctx.target) {
          const dx = ctx.target.x - this.x;
          const dy = ctx.target.y - this.y;
          const dist = Math.hypot(dx, dy) || 1e-6;
          // THE LOCK, taken here and never touched again until the next cycle.
          this.chargeDirX = dx / dist;
          this.chargeDirY = dy / dist;
          this.chargeState = CHARGE_STATE.TELEGRAPH;
          this.chargeTimer = charge.telegraphDuration;
          // Braced on the same frame the lock is taken: one frame of drift
          // after the beam appears is one frame of the telegraph lying.
          this.vx = 0;
          this.vy = 0;
          emit('boss:charge_telegraph', {
            id: this.id,
            x: this.x,
            y: this.y,
            dirX: this.chargeDirX,
            dirY: this.chargeDirY,
            durationSec: charge.telegraphDuration,
          });
          return;
        }
        this.updateDrift(dt, ctx.target, speed);
        return;
      }
    }
  }

  /**
   * Arm the highest phase whose trigger is satisfied.
   *
   * Phases are evaluated in order and the LAST match wins, so a boss that takes
   * a burst big enough to skip a threshold lands in the phase its HP says it
   * should be in rather than stepping through the intermediate one on the way.
   * Phases never step backwards — healing is not a thing here, but a
   * partsDestroyed trigger paired with an hpFraction one could otherwise
   * oscillate on the frame a part dies.
   *
   * @param {(type: string, payload: Object) => void} emit
   */
  updatePhase(emit) {
    const phases = this.template.phases ?? [];
    let next = this.phaseIndex;

    for (let i = 0; i < phases.length; i++) {
      if (this.isTriggerSatisfied(phases[i].trigger)) next = Math.max(next, i);
    }

    if (next !== this.phaseIndex) {
      this.phaseIndex = next;
      emit('boss:phase', {
        id: this.id,
        phase: this.phaseNumber,
        phaseId: this.phase.id,
        hpFraction: this.hpFraction,
      });
    }
  }

  /**
   * @param {Object} trigger
   * @returns {boolean}
   */
  isTriggerSatisfied(trigger) {
    if (!trigger) return false;
    switch (trigger.type) {
      case PHASE_TRIGGERS.INITIAL:
        return true;
      case PHASE_TRIGGERS.HP_FRACTION:
        return this.hpFraction <= (trigger.value ?? 0);
      case PHASE_TRIGGERS.TIME_ELAPSED:
        return this.timeAlive >= (trigger.value ?? 0);
      case PHASE_TRIGGERS.PARTS_DESTROYED: {
        const need = trigger.count ?? 1;
        if (!trigger.parts) return this.destroyedCount >= need;
        // A named list counts only those parts, so "lose a pylon" and "lose the
        // reactor" can be two different thresholds on the same boss.
        let gone = 0;
        for (const partId of trigger.parts) {
          const part = this.getPart(partId);
          if (part && !part.alive) gone++;
        }
        return gone >= need;
      }
      default:
        return false;
    }
  }

  /**
   * Run every armed weapon's clock.
   *
   * A weapon fires only if the phase arms it AND its part still stands. The
   * second condition is not redundant with the first: phases list weapons
   * absolutely, so the meltdown phase still names the reactor's ring even in
   * the runs where the player wrecked the reactor to get there.
   *
   * @param {number} dt
   * @param {Object} ctx
   * @param {Object} phase
   */
  updateWeapons(dt, ctx, phase) {
    const armed = phase.weapons ?? [];
    if (armed.length === 0) return;
    const rateScale = phase.fireRateScale ?? 1;
    const target = ctx.target;

    for (const part of this.parts) {
      const weapon = part.def.weapon;
      if (!part.alive || !weapon) continue;
      if (!armed.includes(weapon.id)) continue;

      let aimX = Math.cos(part.worldRotation);
      let aimY = Math.sin(part.worldRotation);
      if (part.def.aims && target) {
        const dx = target.x - part.worldX;
        const dy = target.y - part.worldY;
        const dist = Math.hypot(dx, dy) || 1e-6;
        aimX = dx / dist;
        aimY = dy / dist;
        // The barrel the player sees and the vector the round flies are one
        // number, written here and read by the renderer.
        part.worldRotation = Math.atan2(dy, dx);
      }

      // Scaled on the way IN rather than by shortening the interval, so a phase
      // change speeds up the next shot instead of retroactively firing the one
      // already in progress.
      part.fireTimer -= dt * rateScale;
      if (part.fireTimer > 0) continue;
      part.fireTimer += weapon.fireInterval ?? 1;
      if (part.fireTimer <= 0) part.fireTimer = weapon.fireInterval ?? 1;

      const muzzle = weapon.muzzle ?? 0;
      fireWeapon(
        weapon,
        {
          x: part.worldX + aimX * muzzle,
          y: part.worldY + aimY * muzzle,
          aimX,
          aimY,
        },
        ctx
      );
      (ctx.emit ?? noop)('boss:weapon_fire', {
        id: this.id,
        partId: part.id,
        weaponId: weapon.id,
        x: part.worldX,
        y: part.worldY,
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Enraged weapons and hazards                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Run the chassis's own guns.
   *
   * These do NOT consult the phase's weapon list. A phase list is the set of
   * PART guns armed while the parts live; an innate weapon exists for the state
   * after that, and gating it on a phase would mean every boss needed a fourth
   * phase whose only job was to name it.
   *
   * @param {number} dt
   * @param {Object} ctx
   */
  updateInnateWeapons(dt, ctx) {
    for (const weapon of this.innateWeapons) {
      if (weapon.type === WEAPON_TYPES.TRAIL_HAZARD) {
        this.updateTrailHazard(dt, ctx, weapon);
        continue;
      }

      const interval = weapon.fireInterval ?? 1;
      let timer = (this.innateTimers.get(weapon.id) ?? 0) - dt;
      if (timer > 0) {
        this.innateTimers.set(weapon.id, timer);
        continue;
      }
      timer += interval;
      if (timer <= 0) timer = interval;
      this.innateTimers.set(weapon.id, timer);

      // Fired from the hull centre and aimed at the target. A radial burst
      // ignores the aim vector entirely (its angles are absolute), so this only
      // decides anything for a chassis gun that is actually pointed somewhere.
      let aimX = Math.cos(this.rotation);
      let aimY = Math.sin(this.rotation);
      if (ctx.target) {
        const dx = ctx.target.x - this.x;
        const dy = ctx.target.y - this.y;
        const dist = Math.hypot(dx, dy) || 1e-6;
        aimX = dx / dist;
        aimY = dy / dist;
      }

      const muzzle = weapon.muzzle ?? 0;
      const origin = {
        x: this.x + aimX * muzzle,
        y: this.y + aimY * muzzle,
        aimX,
        aimY,
      };
      /*
       * A ring that WALKS its gap instead of rolling it. The counter is per
       * boss instance (see innateBursts in the constructor), so the spiral is a
       * continuous sweep across the whole enrage rather than something that
       * resets when the player looks away.
       */
      if (weapon.spiralOffset) {
        const burst = this.innateBursts.get(weapon.id) ?? 0;
        origin.angleOffset = burst * weapon.spiralOffset;
        this.innateBursts.set(weapon.id, burst + 1);
      }

      fireWeapon(weapon, origin, ctx);
      (ctx.emit ?? noop)('boss:weapon_fire', {
        id: this.id,
        /** null, because no part fired it — the hull did. */
        partId: null,
        weaponId: weapon.id,
        x: this.x,
        y: this.y,
        innate: true,
      });
    }
  }

  /**
   * Drop lingering hazard patches behind the hull.
   *
   * GATED ON THE CHARGE, when the chassis has one. A cruiser that paved the
   * arena at drift speed would leave the player nowhere to stand and nothing to
   * learn; one that paves only the LINE it just flew turns each charge into a
   * piece of terrain — the player dodges the ram, and then has to not chase the
   * boss home down the lane it is still burning. The wake is the charge's
   * after-image, not a second attack.
   *
   * @param {number} dt
   * @param {Object} ctx
   * @param {Object} weapon
   */
  updateTrailHazard(dt, ctx, weapon) {
    const gated = Boolean(this.enrageConfig?.chargeAttack);
    if (gated && this.chargeState !== CHARGE_STATE.CHARGING) {
      // Held at zero rather than counted down, so the first patch lands on the
      // first frame of the next charge instead of an interval into it — a
      // charge whose wake starts late has a clean lane down its own middle.
      this.innateTimers.set(weapon.id, 0);
      return;
    }
    if (!ctx.hazard) return;

    const interval = weapon.interval ?? 0.2;
    let timer = (this.innateTimers.get(weapon.id) ?? 0) - dt;
    if (timer > 0) {
      this.innateTimers.set(weapon.id, timer);
      return;
    }
    timer += interval;
    if (timer <= 0) timer = interval;
    this.innateTimers.set(weapon.id, timer);

    // Trailing edge: behind the hull along whatever it is travelling down.
    // Dropping at the centre would put the patch under the boss, where the
    // player cannot be standing anyway, and the wake would read as starting
    // a hull-length late.
    let dirX = this.chargeDirX;
    let dirY = this.chargeDirY;
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > 1e-3) {
      dirX = this.vx / speed;
      dirY = this.vy / speed;
    }

    const x = this.x - dirX * this.radius;
    const y = this.y - dirY * this.radius;
    ctx.hazard({
      x,
      y,
      radius: weapon.radius ?? this.radius * 0.5,
      life: weapon.duration ?? 2,
      /** Per second of contact, matching the spore pools' contract. */
      damagePerSec: weapon.damage ?? 0,
      kind: 'afterburner',
      sourceId: this.id,
      weaponId: weapon.id,
    });
    (ctx.emit ?? noop)('boss:wake_drop', {
      id: this.id,
      weaponId: weapon.id,
      x,
      y,
      radius: weapon.radius ?? this.radius * 0.5,
    });
  }

  /**
   * Drag the target toward the core.
   *
   * The falloff itself is gravityWellForce() over in the roster, next to the
   * numbers it reads — see the note there on why it is continuous at the rim and
   * strongest at the centre. What happens here is the turning of that scalar
   * into a vector and the handing of it to the caller.
   *
   * The pull goes out as a VELOCITY DELTA (already multiplied by dt) rather
   * than as a teleport, so the player's own thrust and drag fight it on equal
   * terms: hold a direction and you make headway against the current, let go and
   * it takes you. A well that wrote positions would be taking the controls away.
   *
   * @param {number} dt
   * @param {Object} ctx
   */
  updateGravityWell(dt, ctx) {
    this.gravityPullX = 0;
    this.gravityPullY = 0;

    const well = this.enrageConfig?.gravityWell ?? null;
    if (!well || !ctx.target) return;

    // D = P_boss - P_player, so it already points INWARD and needs no negation.
    const dx = this.x - ctx.target.x;
    const dy = this.y - ctx.target.y;
    const dist = Math.hypot(dx, dy);
    const force = gravityWellForce(dist, well.radius, well.pullForce);
    if (force <= 0) return;

    const inv = 1 / (dist || 1e-6);
    const inX = dx * inv;
    const inY = dy * inv;
    let pullX = inX * force;
    let pullY = inY * force;

    if (well.inwardSpiral) {
      // Tangential, and swirling the way the hull turns: the pull and the spin
      // are the same object misbehaving, so they had better agree about which
      // way round it is going.
      const scale = (well.spiralScale ?? DEFAULT_SPIRAL_SCALE) * force;
      const sign = (this.enrageConfig.spin ?? this.baseSpin) < 0 ? -1 : 1;
      pullX += -inY * scale * sign;
      pullY += inX * scale * sign;
    }

    this.gravityPullX = pullX;
    this.gravityPullY = pullY;
    if (ctx.impulse) ctx.impulse(pullX * dt, pullY * dt);
  }

  /**
   * Spill minions out of the breached hull.
   *
   * Requests go out through `ctx.spawn` with an ENEMY_ARCHETYPES id and a world
   * position; what pool they come from, how they are HP-scaled for the wave and
   * whether the arena is already full are all the caller's business. The boss
   * knows what it is venting and where, and nothing else.
   *
   * @param {number} dt
   * @param {Object} ctx
   */
  updateVenting(dt, ctx) {
    const vent = this.enrageConfig?.ventMinions ?? null;
    if (!vent) return;

    this.ventTimer -= dt;
    if (this.ventTimer > 0) return;
    this.ventTimer += vent.cooldown ?? 6;
    if (this.ventTimer <= 0) this.ventTimer = vent.cooldown ?? 6;
    if (!ctx.spawn) return;

    const count = Math.max(1, vent.count ?? 1);
    const spread = vent.spreadAngle ?? Math.PI * 2;
    const reach = vent.spawnRadius ?? this.radius + 24;
    /*
     * A full circle divides by `count` and a partial arc by `count - 1`: on a
     * closed ring the last bearing must not land on top of the first, and on an
     * open fan the two end bearings are the edges the designer authored. One
     * formula for both puts either a doubled larva or a fan that stops short.
     */
    const full = spread >= Math.PI * 2 - 1e-6;
    const step = full ? spread / count : count > 1 ? spread / (count - 1) : 0;
    // Anchored on the hull's CURRENT heading, so successive vents do not stack
    // their minions on the same bearings while the boss spins.
    const base = this.rotation - (full ? 0 : spread / 2);

    for (let i = 0; i < count; i++) {
      const angle = base + step * i;
      ctx.spawn({
        archetypeId: vent.archetypeId,
        x: this.x + Math.cos(angle) * reach,
        y: this.y + Math.sin(angle) * reach,
        /** Outward, for a caller that wants to give them launch momentum. */
        dirX: Math.cos(angle),
        dirY: Math.sin(angle),
        bossId: this.id,
      });
    }

    (ctx.emit ?? noop)('boss:vent', {
      id: this.id,
      archetypeId: vent.archetypeId,
      count,
      x: this.x,
      y: this.y,
      radius: reach,
    });
  }

  /**
   * Release and advance the expanding rings.
   *
   * Each ring is a BAND, not a growing disc: `thickness` px wide, travelling
   * outward at `speed`, and the space it has already crossed is safe again. That
   * is what makes "dash through it, toward the core" the answer rather than
   * "run", and running is the thing the gravity well is already punishing — the
   * two mechanics have to push the player the same way or they cancel out.
   *
   * A ring hits at most once (`hasHit`). Without that, a player clipped by the
   * leading edge would be re-hit every frame the band still overlapped them,
   * which at 46px and 340 px/s is eight frames of a 28-damage hit.
   *
   * @param {number} dt
   * @param {Object} ctx
   */
  updateShockwaves(dt, ctx) {
    const interval = this.enrageConfig?.shockwaveInterval ?? 0;
    const cfg = this.enrageConfig?.shockwave ?? null;
    if (!cfg || !(interval > 0)) return;

    const emit = ctx.emit ?? noop;

    this.shockwaveTimer -= dt;
    if (this.shockwaveTimer <= 0) {
      this.shockwaveTimer += interval;
      if (this.shockwaveTimer <= 0) this.shockwaveTimer = interval;
      this.shockwaves.push({
        radius: 0,
        /** Counts down before the ring is released; the renderer draws it. */
        warnTimer: cfg.warnDuration ?? 0,
        warnSpan: cfg.warnDuration ?? 0,
        released: !(cfg.warnDuration > 0),
        hasHit: false,
      });
      emit('boss:shockwave_warn', {
        id: this.id,
        x: this.x,
        y: this.y,
        maxRadius: cfg.maxRadius,
        warnSec: cfg.warnDuration ?? 0,
      });
    }

    const target = ctx.target;
    const targetDist = target ? Math.hypot(target.x - this.x, target.y - this.y) : Infinity;
    const half = (cfg.thickness ?? 40) / 2;

    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const ring = this.shockwaves[i];

      if (!ring.released) {
        ring.warnTimer -= dt;
        if (ring.warnTimer > 0) continue;
        ring.released = true;
        emit('boss:shockwave', { id: this.id, x: this.x, y: this.y, maxRadius: cfg.maxRadius });
      }

      ring.radius += (cfg.speed ?? 300) * dt;

      if (!ring.hasHit && Math.abs(targetDist - ring.radius) <= half) {
        ring.hasHit = true;
        if (ctx.hurt) ctx.hurt(cfg.damage ?? 0);
        emit('boss:shockwave_hit', {
          id: this.id,
          damage: cfg.damage ?? 0,
          radius: ring.radius,
        });
      }

      if (ring.radius >= (cfg.maxRadius ?? 500)) this.shockwaves.splice(i, 1);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Damage                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Which component does a shot at (x, y) with radius `r` hit?
   *
   * PARTS WIN TIES. A turret overlapping the hull silhouette is hit as the
   * turret, because that is what the player was aiming at — resolving to the
   * chassis there would make the modules unhittable at exactly the angle they
   * are most visible from. Nearest part wins among several, so a shot between
   * two pylons goes to the one it is actually closer to.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} [r] - Projectile radius
   * @returns {{kind: 'part'|'chassis', part: Object|null}|null} null on a miss
   */
  hitTest(x, y, r = 0) {
    let best = null;
    let bestDistSq = Infinity;

    for (const part of this.parts) {
      if (!part.alive) continue;
      const reach = part.radius + r;
      const dx = x - part.worldX;
      const dy = y - part.worldY;
      const distSq = dx * dx + dy * dy;
      if (distSq <= reach * reach && distSq < bestDistSq) {
        bestDistSq = distSq;
        best = part;
      }
    }
    if (best) return { kind: 'part', part: best };

    const reach = this.radius + r;
    const dx = x - this.x;
    const dy = y - this.y;
    if (dx * dx + dy * dy <= reach * reach) return { kind: 'chassis', part: null };

    return null;
  }

  /**
   * Apply damage at a point, resolving what it hit.
   *
   * Returns how much damage actually landed, which is 0 for a shot that reached
   * an armoured chassis. The caller uses that to tell the player the difference
   * between a hit and a deflection — a boss that eats a full clip in silence
   * reads as broken, not as armoured.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} amount
   * @param {Object} [ctx] - { emit(type, payload) }
   * @param {number} [r] - Projectile radius
   * @returns {{applied: number, kind: string|null, partId: string|null,
   *   deflected: boolean, destroyed: boolean}} `destroyed` is true on the one
   *   call that took the component down, so the caller can pay out a wreck
   *   exactly once without polling every part every frame.
   */
  damageAt(x, y, amount, ctx = {}, r = 0) {
    const hit = this.hitTest(x, y, r);
    if (!hit) return { applied: 0, kind: null, partId: null, deflected: false, destroyed: false };

    if (hit.kind === 'part') {
      const applied = this.damagePart(hit.part.id, amount, ctx);
      return {
        applied,
        kind: 'part',
        partId: hit.part.id,
        deflected: false,
        destroyed: !hit.part.alive,
      };
    }

    if (!this.isChassisVulnerable()) {
      (ctx.emit ?? noop)('boss:deflected', { id: this.id, x, y });
      return { applied: 0, kind: 'chassis', partId: null, deflected: true, destroyed: false };
    }

    const applied = this.damageChassis(amount, ctx);
    return {
      applied,
      kind: 'chassis',
      partId: null,
      deflected: false,
      destroyed: !this.alive,
    };
  }

  /**
   * @param {string} partId
   * @param {number} amount
   * @param {Object} [ctx] - { emit(type, payload) }
   * @returns {number} Damage applied (0 if the part was already wrecked)
   */
  damagePart(partId, amount, ctx = {}) {
    const part = this.getPart(partId);
    if (!part || !part.alive) return 0;

    const emit = ctx.emit ?? noop;
    const applied = Math.min(amount, part.hp);
    part.hp -= applied;
    part.hitFlash = HIT_FLASH_SEC;

    emit('boss:part_damaged', {
      id: this.id,
      partId: part.id,
      damage: applied,
      remainingHp: part.hp,
      x: part.worldX,
      y: part.worldY,
    });

    if (part.hp <= 0) this.destroyPart(part, ctx);
    return applied;
  }

  /**
   * Wreck a part: silence its gun, apply its parting gift to the chassis, and
   * leave the hulk bolted on for the renderer.
   *
   * The part is NOT removed from `this.parts`. Its debris still turns with the
   * hull, its id still answers a phase trigger, and the ship keeps the
   * silhouette it earned — a boss whose modules vanish on death looks
   * progressively cleaner as the fight gets worse, which is backwards.
   *
   * @param {Object} part
   * @param {Object} [ctx]
   */
  destroyPart(part, ctx = {}) {
    part.alive = false;
    part.hp = 0;
    part.destroyedAt = this.timeAlive;
    this.destroyedCount++;

    const onDestroyed = part.def.onDestroyed ?? null;
    if (onDestroyed) {
      if (onDestroyed.chassisSpeedScale !== undefined) {
        this.wreckSpeedScale *= onDestroyed.chassisSpeedScale;
      }
      if (onDestroyed.chassisSpinScale !== undefined) {
        this.wreckSpinScale *= onDestroyed.chassisSpinScale;
      }
    }

    (ctx.emit ?? noop)('boss:part_destroyed', {
      id: this.id,
      partId: part.id,
      role: part.role,
      x: part.worldX,
      y: part.worldY,
      radius: part.radius,
      scoreValue: part.scoreValue,
      scrapValue: part.scrapValue,
      /** True the moment the last piece of armour comes off. */
      exposesChassis: this.isChassisVulnerable(),
      remainingParts: this.livingParts().length,
    });
  }

  /**
   * @param {number} amount
   * @param {Object} [ctx]
   * @returns {number} Damage applied (0 while armoured)
   */
  damageChassis(amount, ctx = {}) {
    if (!this.alive) return 0;
    if (!this.isChassisVulnerable()) return 0;

    const applied = Math.min(amount, this.chassisHp);
    this.chassisHp -= applied;
    this.hitFlash = HIT_FLASH_SEC;

    (ctx.emit ?? noop)('boss:damaged', {
      id: this.id,
      damage: applied,
      remainingHp: this.chassisHp,
      hpFraction: this.hpFraction,
      x: this.x,
      y: this.y,
    });

    if (this.chassisHp <= 0) this.destroy(ctx);
    return applied;
  }

  /**
   * The chassis goes, and the whole assembly with it.
   *
   * @param {Object} [ctx]
   */
  destroy(ctx = {}) {
    if (!this.alive) return;
    this.alive = false;
    this.chassisHp = 0;

    (ctx.emit ?? noop)('boss:destroyed', {
      id: this.id,
      templateId: this.templateId,
      x: this.x,
      y: this.y,
      radius: this.radius,
      scoreValue: this.scoreValue,
      scrapValue: this.scrapValue,
      xpValue: this.xpValue,
      /** Parts the player never got round to, for a results screen. */
      partsLeft: this.livingParts().length,
    });
  }

  /**
   * How far through the telegraph window the boss is, 0 -> 1.
   * @returns {number}
   */
  telegraphProgress() {
    const span = this.enrageConfig?.chargeAttack?.telegraphDuration ?? 0;
    if (!(span > 0)) return 1;
    return Math.min(1, Math.max(0, 1 - this.chargeTimer / span));
  }

  /**
   * Engine load, 0..1, for the thruster flare.
   *
   * Derived from actual speed against the fastest thing the chassis can do
   * rather than from the charge state, so the flare ramps through the recovery
   * coast instead of snapping off the frame the charge timer expires. A thruster
   * that cuts out while the hull is still visibly travelling at 300 px/s reads
   * as the boss having died.
   *
   * @returns {number}
   */
  thrustLoad() {
    if (!this.isEnraged) return 0;
    /*
     * A telegraph is the engines SPOOLING. The hull is deliberately motionless
     * for that whole window, so velocity says nothing about it — and a flare
     * that stayed dark right up to the launch would waste the best part of the
     * warning. A boss visibly winding up says "soon" in a way a beam on the
     * floor cannot, and it is the one cue that still reads when the player is
     * looking at their own ship rather than at the arena.
     */
    if (this.chargeState === CHARGE_STATE.TELEGRAPH) return this.telegraphProgress();

    const top =
      this.enrageConfig?.chargeAttack?.chargeSpeed ?? this.enrageConfig?.speed ?? 0;
    if (!(top > 0)) return 0;
    return Math.min(1, Math.hypot(this.vx, this.vy) / top);
  }

  /**
   * Everything the renderer and the HUD need, without either of them reaching
   * into simulation internals.
   * @returns {Object}
   */
  getRenderState() {
    return {
      id: this.id,
      templateId: this.templateId,
      x: this.x,
      y: this.y,
      rotation: this.rotation,
      radius: this.radius,
      alive: this.alive,
      hitFlash: this.hitFlash,
      hpFraction: this.hpFraction,
      phase: this.phaseNumber,
      chassisVulnerable: this.isChassisVulnerable(),
      /* ---- The enraged core ---- */
      enraged: this.isEnraged,
      enrageTime: this.enrageTime,
      chargeState: this.chargeState,
      /**
       * The charge telegraph, or null.
       *
       * Built only while the state machine is actually in TELEGRAPH, off the
       * SAME `chargeDirX`/`chargeDirY` the charge will fly and the SAME timer
       * that ends the window. The beam and the lunge therefore cannot disagree
       * about direction or timing — there is one copy of each number.
       *
       * `progress` runs 0 -> 1 across the window so the renderer can tighten
       * the beam as the clock runs out without knowing the duration.
       */
      chargeTelegraph:
        this.chargeState === CHARGE_STATE.TELEGRAPH
          ? {
              dirX: this.chargeDirX,
              dirY: this.chargeDirY,
              progress: this.telegraphProgress(),
            }
          : null,
      charging: this.chargeState === CHARGE_STATE.CHARGING,
      /** Engine load, 0..1. Drives the thruster flare; 1 during a charge. */
      thrust: this.thrustLoad(),
      gravityWell:
        this.isEnraged && this.enrageConfig?.gravityWell
          ? {
              radius: this.enrageConfig.gravityWell.radius,
              /** Live pull magnitude, px/s. 0 when the target is outside. */
              pull: Math.hypot(this.gravityPullX, this.gravityPullY),
            }
          : null,
      /**
       * Live rings, copied out rather than handed over. The renderer is welcome
       * to read these every frame; it is not welcome to hold the array the
       * simulation is splicing rings out of.
       */
      shockwaves: this.shockwaves.map((ring) => ({
        radius: ring.radius,
        released: ring.released,
        warnProgress: ring.warnSpan > 0 ? 1 - Math.max(0, ring.warnTimer) / ring.warnSpan : 1,
        /**
         * The ring's own reach, carried per-ring rather than left for the
         * renderer to guess at from the hull radius.
         *
         * The warning is drawn at THIS radius while the ring is still held, so
         * the boundary the player picks their ground against is the boundary
         * the wave will actually sweep. A warning circle at any other size
         * would be a telegraph that lies about where it is safe to stand.
         */
        maxRadius: this.enrageConfig?.shockwave?.maxRadius ?? 0,
      })),
      parts: this.parts.map((part) => ({
        id: part.id,
        role: part.role,
        x: part.worldX,
        y: part.worldY,
        rotation: part.worldRotation,
        radius: part.radius,
        alive: part.alive,
        hpFraction: part.maxHp > 0 ? Math.max(0, part.hp) / part.maxHp : 0,
        hitFlash: part.hitFlash,
      })),
    };
  }
}

/** Seconds a damaged component stays flashed. Matches the swarm's own flash. */
export const HIT_FLASH_SEC = 0.08;

function noop() {}
