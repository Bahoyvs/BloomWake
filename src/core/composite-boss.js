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
 * Strictly DOM-free. Bullets leave through `ctx.fire`, events through
 * `ctx.emit`; this class never touches a pool or a bus directly.
 */

import {
  PHASE_TRIGGERS,
  getBossTemplate,
  getTemplateTotalHp,
} from '../data/roster-config.js';
import { fireWeapon } from './enemy-system.js';

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
   * damage arms this frame's guns), then movement, then the transform, then the
   * weapons — a turret must fire from where it IS this frame, not from where it
   * was before the hull turned.
   *
   * @param {number} dt - Seconds
   * @param {Object} ctx - { target: {x, y}, fire(spec), emit(type, payload), rng() }
   */
  update(dt, ctx) {
    if (!this.alive) return;

    this.timeAlive += dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;
    for (const part of this.parts) if (part.hitFlash > 0) part.hitFlash -= dt;

    const emit = ctx.emit ?? noop;
    this.updatePhase(emit);

    const phase = this.phase;
    const speed = this.baseSpeed * (phase.speedScale ?? 1) * this.wreckSpeedScale;
    const target = ctx.target;

    if (speed > 0 && target) {
      const dx = target.x - this.x;
      const dy = target.y - this.y;
      const dist = Math.hypot(dx, dy) || 1e-6;
      this.vx = (dx / dist) * speed;
      this.vy = (dy / dist) * speed;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
    } else {
      this.vx = 0;
      this.vy = 0;
    }

    this.rotation += this.baseSpin * (phase.spinScale ?? 1) * this.wreckSpinScale * dt;
    this.syncParts();
    this.updateWeapons(dt, ctx, phase);
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
