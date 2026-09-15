/**
 * Card effect system for BloomWake (Phase 3).
 *
 * Every card is a data row in src/data/cards.js carrying a `behavior` tag; this
 * module holds one handler per behavior. Adding a card is a data change, not a
 * new branch in the simulation.
 *
 * Pure JS, no DOM. The handlers read the simulation's entity arrays and pools
 * but never touch rendering — card visuals live in src/render/renderer.js.
 *
 * IMPORTANT: the tick rates and hit rules here come from CARD_MODEL in
 * constants.js, which tests/balance-sim.js imports to score the card table.
 * Changing how a handler ticks changes the published balance numbers, so the
 * two must be edited together.
 */

import { CARD_MODEL, PROJECTILE_CFG, WORLD } from './constants.js';
import { clamp, distanceSq, normalize } from './math.js';
import { CARD_BEHAVIORS, getCardById } from '../data/cards.js';

/** Marks a projectile as a guided Nanite missile rather than a dumb bolt. */
export const PROJECTILE_KINDS = {
  BOLT: 'bolt',
  MISSILE: 'missile',
  /** Fired by a Tactical Wingman drone, not by the Drifter. */
  DRONE_BOLT: 'drone_bolt',
};

/**
 * Shortest-arc angle interpolation (radians).
 * @param {number} from
 * @param {number} to
 * @param {number} t
 * @returns {number}
 */
export function lerpAngle(from, to, t) {
  let diff = (to - from) % (Math.PI * 2);
  if (diff < -Math.PI) diff += Math.PI * 2;
  if (diff > Math.PI) diff -= Math.PI * 2;
  return from + diff * t;
}

/**
 * Per-behavior handlers.
 *
 * `create()` builds the card's runtime state (timers, angles, shield charge).
 * `update(sys, rt, stats, dt)` advances it, where `sys` is the CardSystem,
 * `rt` the runtime state and `stats` the current level's data row.
 */
const HANDLERS = {
  /* ---------------------------------------------------------------- */
  [CARD_BEHAVIORS.HOMING_VOLLEY]: {
    create: () => ({ cooldown: 0 }),
    update(sys, rt, stats, dt) {
      rt.cooldown -= dt;
      if (rt.cooldown > 0) return;

      const target = sys.sim.findNearestEnemy(PROJECTILE_CFG.TARGET_RANGE);
      if (!target) {
        // Stay primed so the next enemy in range is engaged immediately.
        rt.cooldown = 0;
        return;
      }

      const player = sys.player;
      const baseAngle = Math.atan2(target.y - player.y, target.x - player.x);
      const speed = stats.speed * PROJECTILE_CFG.SPEED_SCALE;
      const count = stats.count ?? 1;
      const damage = sys.damageOf(stats.damage);

      /*
       * TWIN PARALLEL STREAMS — wing hardpoints, one shared aim vector.
       *
       * `u` is the forward unit vector and `n` its left-hand perpendicular.
       * Bolts are displaced along `n` to sit on the wingtips and then all fly
       * along `u`, so their tracks never converge or diverge. See the geometry
       * argument on PROJECTILE_CFG.HARDPOINT_OFFSET for why this replaced the
       * angular fan and why the offset is smaller than the drawn wingspan.
       */
      const ux = Math.cos(baseAngle);
      const uy = Math.sin(baseAngle);
      const nx = -uy;
      const ny = ux;

      for (let i = 0; i < count; i++) {
        /*
         * Hardpoint position across the wing span, in [-1, 1].
         *
         * A single bolt sits on the nose. Two sit on the wingtips. Three or
         * more spread evenly between the tips, which always puts one on the
         * centreline at odd counts and, at even counts above two, puts the
         * inner pair close enough to it that nothing can pass between them.
         */
        const lateral = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;
        const offset = lateral * PROJECTILE_CFG.HARDPOINT_OFFSET;

        // Parallel below three bolts; a slight outward fan above it.
        const angle =
          count >= 3 ? baseAngle + lateral * PROJECTILE_CFG.SALVO_SPLAY_RAD : baseAngle;

        sys.sim.spawnProjectile({
          x: player.x + nx * offset,
          y: player.y + ny * offset,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          damage,
          radius: PROJECTILE_CFG.RADIUS,
          life: PROJECTILE_CFG.LIFETIME_SEC,
          // Extra enemies the needle passes through. A Bio-Goliath strips this
          // back to 0 on contact — see resolveCollisions.
          pierce: stats.pierce ?? 0,
        });
      }

      rt.cooldown = stats.cooldown;
      // baseAngle travels with the event so the renderer can aim the muzzle
      // spray and the recoil without reaching back into simulation entities —
      // the same reason enemy:damaged carries its position.
      sys.bus.emit('weapon:fire', { cardId: 'dewdrop_barrage', count, angle: baseAngle });
    },
  },

  /* ---------------------------------------------------------------- */
  /**
   * Tesla Arc / Chain Lightning.
   * Auto-targets nearest enemy within range regardless of ship facing.
   * On hitting first target, chains/bounces to nearby enemies up to stats.bounces times.
   * At level 3+, applies shock slow.
   */
  [CARD_BEHAVIORS.BEAM]: {
    create: () => ({ cooldown: 0, active: false, timeLeft: 0, chain: [], origin: { x: 0, y: 0 }, dx: 1, dy: 0 }),
    update(sys, rt, stats, dt) {
      if (rt.active) {
        rt.timeLeft -= dt;
        if (rt.timeLeft <= 0) {
          rt.active = false;
        }
      }

      rt.cooldown -= dt;
      if (rt.cooldown > 0) return;

      const player = sys.player;
      const primary = sys.sim.findNearestEnemyTo(player.x, player.y, stats.range ?? 300);
      if (!primary) return;

      const damage = sys.damageOf(stats.damage);
      const chain = [{ x: primary.x, y: primary.y }];
      const hitIds = new Set([primary.id]);

      sys.sim.damageEnemy(primary, damage);
      if (stats.shockSlow > 0) {
        primary.stunTimer = Math.max(primary.stunTimer, stats.shockDuration ?? 1.2);
      }

      let current = primary;
      const maxBounces = stats.bounces ?? 1;
      const bounceRadius = stats.bounceRadius ?? 180;
      const bounceRadiusSq = bounceRadius * bounceRadius;

      for (let b = 0; b < maxBounces; b++) {
        let nextTarget = null;
        let bestDistSq = bounceRadiusSq;

        for (const enemy of sys.sim.enemies) {
          if (!enemy.alive || hitIds.has(enemy.id)) continue;
          const dSq = distanceSq(current.x, current.y, enemy.x, enemy.y);
          if (dSq < bestDistSq) {
            bestDistSq = dSq;
            nextTarget = enemy;
          }
        }

        if (!nextTarget) break;

        hitIds.add(nextTarget.id);
        sys.sim.damageEnemy(nextTarget, damage);
        if (stats.shockSlow > 0) {
          nextTarget.stunTimer = Math.max(nextTarget.stunTimer, stats.shockDuration ?? 1.2);
        }
        chain.push({ x: nextTarget.x, y: nextTarget.y });
        current = nextTarget;
      }

      const dir = normalize(primary.x - player.x, primary.y - player.y);
      rt.dx = dir.x;
      rt.dy = dir.y;
      rt.active = true;
      rt.timeLeft = 0.22;
      rt.origin = { x: player.x, y: player.y };
      rt.chain = chain;
      rt.cooldown = stats.cooldown;

      sys.bus.emit('weapon:chain_lightning', { origin: rt.origin, chain, bounces: chain.length - 1 });
      sys.bus.emit('card:beam', { x: player.x, y: player.y, dx: dir.x, dy: dir.y });
    },
  },

  /* ---------------------------------------------------------------- */
  [CARD_BEHAVIORS.ORBIT]: {
    create: () => ({ angle: 0 }),
    update(sys, rt, stats, dt) {
      rt.angle += stats.rotationSpeed * dt;

      const player = sys.player;
      const bladeRadius = CARD_MODEL.ORBIT_BAND / 2;
      const damage = sys.damageOf(stats.damage);
      const step = (Math.PI * 2) / stats.count;

      sys.syncBlades(stats.count);

      for (let i = 0; i < stats.count; i++) {
        const angle = rt.angle + i * step;
        const blade = sys.blades[i];
        blade.x = player.x + Math.cos(angle) * stats.radius;
        blade.y = player.y + Math.sin(angle) * stats.radius;
        blade.radius = bladeRadius;

        for (const enemy of sys.sim.enemies) {
          // One re-hit clock per enemy, not per blade: the balance model caps
          // an enemy at 1 / ORBIT_HIT_COOLDOWN hits per second regardless of
          // how many blades sweep past it.
          if (!enemy.alive || enemy.orbitCooldown > 0) continue;
          const reach = bladeRadius + enemy.radius;
          if (distanceSq(blade.x, blade.y, enemy.x, enemy.y) > reach * reach) continue;

          sys.sim.damageEnemy(enemy, damage);
          enemy.orbitCooldown = CARD_MODEL.ORBIT_HIT_COOLDOWN;
        }
      }
    },
  },

  /* ---------------------------------------------------------------- */
  [CARD_BEHAVIORS.RADIAL_BURST]: {
    create: () => ({ cooldown: 0 }),
    update(sys, rt, stats, dt) {
      rt.cooldown -= dt;
      if (rt.cooldown > 0) return;

      const player = sys.player;
      const damage = sys.damageOf(stats.damage);
      const life = CARD_MODEL.PETAL_RANGE / CARD_MODEL.PETAL_SPEED;

      for (let i = 0; i < stats.count; i++) {
        // Random directions per GDD ("rastgele yönlere yaprak salvo"). The
        // balance model scores each petal independently, which only holds if
        // directions really are independent — even spacing would score higher.
        const angle = sys.rng() * Math.PI * 2;
        sys.sim.spawnProjectile({
          x: player.x,
          y: player.y,
          vx: Math.cos(angle) * CARD_MODEL.PETAL_SPEED,
          vy: Math.sin(angle) * CARD_MODEL.PETAL_SPEED,
          damage,
          radius: PROJECTILE_CFG.RADIUS,
          life,
        });
      }

      rt.cooldown = stats.cooldown;
      sys.bus.emit('card:burst', { count: stats.count });
    },
  },

  /* ---------------------------------------------------------------- */
  /**
   * Nanite Swarm — micro-missiles that launch outward and then turn onto the
   * highest-HP enemy on the field.
   *
   * The launch is deliberately NOT aimed at the target. Each missile is thrown
   * out with a sideways kick and only then starts steering, so a salvo blooms
   * outward and arcs back in. Firing them straight at the target would make
   * them slow bolts wearing a missile sprite.
   */
  [CARD_BEHAVIORS.HOMING_MISSILE]: {
    create: () => ({ cooldown: 0 }),
    update(sys, rt, stats, dt) {
      rt.cooldown -= dt;
      if (rt.cooldown > 0) return;

      const target = sys.sim.findHighestHpEnemy(PROJECTILE_CFG.TARGET_RANGE);
      if (!target) {
        // Stay primed, same as the repeater: the next thing in range is
        // engaged on the frame it arrives.
        rt.cooldown = 0;
        return;
      }

      const player = sys.player;
      const count = stats.count ?? 1;
      const damage = sys.damageOf(stats.damage);
      // Fan the salvo across the ship's beam rather than down the firing line.
      const launch = Math.atan2(target.y - player.y, target.x - player.x);

      for (let i = 0; i < count; i++) {
        const offset = count > 1 ? (i / (count - 1)) * 2 - 1 : 0;
        const angle = launch + offset * Math.PI * 0.5;
        sys.sim.spawnProjectile({
          x: player.x,
          y: player.y,
          vx: Math.cos(angle) * CARD_MODEL.NANITE_SPEED,
          vy: Math.sin(angle) * CARD_MODEL.NANITE_SPEED,
          damage,
          radius: CARD_MODEL.NANITE_RADIUS,
          life: CARD_MODEL.NANITE_LIFETIME_SEC,
          kind: PROJECTILE_KINDS.MISSILE,
          targetId: target.id,
          turnRate: CARD_MODEL.NANITE_TURN_RATE,
        });
      }

      rt.cooldown = stats.cooldown;
      sys.bus.emit('card:nanite_launch', { count, targetId: target.id });
    },
  },

  /* ---------------------------------------------------------------- */
  [CARD_BEHAVIORS.AOE_KNOCKBACK]: {
    create: () => ({ cooldown: 0 }),
    update(sys, rt, stats, dt) {
      rt.cooldown -= dt;
      if (rt.cooldown > 0) return;

      // The stun is the second half of the card and is flat across levels —
      // see the note on the card's data row.
      sys.blast(stats.radius, sys.damageOf(stats.damage), stats.knockback, CARD_MODEL.EMP_STUN_SEC);
      sys.spawnEffect(stats.radius, 'tide');
      rt.cooldown = stats.cooldown;
    },
  },

  /* ---------------------------------------------------------------- */
  /**
   * Hyperion Shield — a charge, not a pool.
   *
   * `ready` is the whole state. It negates one incoming hit of any size, then
   * spends `rechargeTime` down. See the card's data row for why this replaced
   * an absorbing HP bucket.
   */
  [CARD_BEHAVIORS.SHIELD]: {
    create: () => ({ ready: true, timer: 0, spentAt: -Infinity }),
    update(sys, rt, stats, dt) {
      if (rt.ready) return;

      rt.timer -= dt;
      if (rt.timer <= 0) {
        rt.ready = true;
        rt.timer = 0;
        sys.bus.emit('card:shield_ready', {});
      }
    },
  },

  /* ---------------------------------------------------------------- */
  /**
   * Tactical Wingman — escort drones with independent simulation entity physics.
   *
   * Formations trail in a V behind the ship's facing, but drones do NOT snap
   * or teleport. They use spring-acceleration follow physics (~0.12 responsiveness)
   * and smooth banking orientation, swooping gracefully when the ship maneuvers.
   */
  [CARD_BEHAVIORS.WINGMAN]: {
    create: () => ({ drones: [], cooldown: 0 }),
    update(sys, rt, stats, dt) {
      const player = sys.player;
      const wanted = stats.drones ?? 1;

      while (rt.drones.length > wanted) rt.drones.pop();
      while (rt.drones.length < wanted) {
        const id = sys.sim.nextEntityId++;
        const initialAngle = Math.atan2(sys.sim.getFacing().y, sys.sim.getFacing().x);
        rt.drones.push({
          id,
          x: player.x,
          y: player.y,
          vx: 0,
          vy: 0,
          angle: initialAngle,
          aimAngle: initialAngle,
          aimTimer: 0,
        });
      }

      const facing = sys.sim.getFacing();
      const heading = Math.atan2(facing.y, facing.x);

      // Spring-acceleration follow physics for smooth curving maneuvers
      const springK = 26.0;
      const damping = 8.5;

      for (let i = 0; i < rt.drones.length; i++) {
        const drone = rt.drones[i];
        const side = i % 2 === 0 ? -1 : 1;
        const rank = Math.floor(i / 2) + 1;
        const slotAngle = heading + Math.PI + side * CARD_MODEL.WINGMAN_SPREAD_RAD;
        const dist = CARD_MODEL.WINGMAN_FOLLOW_DIST * rank;

        const targetX = player.x + Math.cos(slotAngle) * dist;
        const targetY = player.y + Math.sin(slotAngle) * dist;

        const dx = targetX - drone.x;
        const dy = targetY - drone.y;

        drone.vx += (dx * springK - drone.vx * damping) * dt;
        drone.vy += (dy * springK - drone.vy * damping) * dt;

        drone.x += drone.vx * dt;
        drone.y += drone.vy * dt;

        // Smooth orientation: bank towards movement direction or turret aim
        if (drone.aimTimer > 0) {
          drone.aimTimer -= dt;
          drone.angle = lerpAngle(drone.angle, drone.aimAngle, 1 - Math.pow(0.05, dt * 60));
        } else {
          const moveSpeed = Math.hypot(drone.vx, drone.vy);
          const flightHeading = moveSpeed > 25 ? Math.atan2(drone.vy, drone.vx) : heading;
          drone.angle = lerpAngle(drone.angle, flightHeading, 1 - Math.pow(0.88, dt * 60));
        }
      }

      rt.cooldown -= dt;
      if (rt.cooldown > 0 || rt.drones.length === 0) return;

      let fired = false;
      for (const drone of rt.drones) {
        const target = sys.sim.findNearestEnemyTo(
          drone.x,
          drone.y,
          CARD_MODEL.WINGMAN_RANGE
        );
        if (!target) continue;

        const angle = Math.atan2(target.y - drone.y, target.x - drone.x);
        drone.aimAngle = angle;
        drone.aimTimer = 0.35;
        drone.angle = angle;
        sys.sim.spawnProjectile({
          x: drone.x,
          y: drone.y,
          vx: Math.cos(angle) * CARD_MODEL.WINGMAN_BOLT_SPEED,
          vy: Math.sin(angle) * CARD_MODEL.WINGMAN_BOLT_SPEED,
          damage: sys.damageOf(stats.droneDamage ?? 0),
          radius: PROJECTILE_CFG.RADIUS * 0.8,
          life: PROJECTILE_CFG.LIFETIME_SEC,
          kind: PROJECTILE_KINDS.DRONE_BOLT,
        });
        fired = true;
      }

      if (fired) rt.cooldown = stats.droneCooldown ?? 1;
    },
  },
};

/**
 * Apply one Sunbeam Lance tick to everything inside the strip.
 * Extracted so the beam handler stays readable.
 */
function BEAM_DAMAGE(sys, rt, stats) {
  const player = sys.player;
  const halfWidth = stats.width / 2;
  const damage = sys.damageOf(stats.damage);

  for (const enemy of sys.sim.enemies) {
    if (!enemy.alive) continue;
    const relX = enemy.x - player.x;
    const relY = enemy.y - player.y;

    // Distance along the beam, and perpendicular offset from its centre line.
    const along = relX * rt.dx + relY * rt.dy;
    if (along < 0 || along > CARD_MODEL.BEAM_LENGTH) continue;

    const perp = Math.abs(relX * rt.dy - relY * rt.dx);
    if (perp > halfWidth + enemy.radius) continue;

    sys.sim.damageEnemy(enemy, damage);
  }
}

/**
 * Shared empty list handed back by `drones` when the card is not owned.
 * A fresh `[]` per frame would allocate once per frame for a card most builds
 * never take.
 */
const EMPTY_DRONES = [];

export class CardSystem {
  /**
   * @param {import('./simulation.js').Simulation} sim
   */
  constructor(sim) {
    this.sim = sim;
    this.bus = sim.bus;
    this.rng = sim.rng;

    /** cardId -> handler runtime state. */
    this.runtime = new Map();
    /** Live orbit blades, recycled through the simulation's blade pool. */
    this.blades = [];
  }

  get player() {
    return this.sim.state.player;
  }

  /** Clear all card runtime state and return blades to the pool. */
  reset() {
    this.runtime.clear();
    this.sim.releaseBlades(this.blades);
    this.blades.length = 0;
  }

  /**
   * Current level's stat row for an owned card.
   * @param {string} cardId
   * @returns {Object|null}
   */
  getStats(cardId) {
    const level = this.sim.state.activeCards.get(cardId);
    if (!level) return null;
    return getCardById(cardId).levels[level - 1];
  }

  /**
   * Damage after Buddy Boost's multiplier.
   * @param {number} base
   * @returns {number}
   */
  damageOf(base) {
    return base * this.damageMultiplier;
  }

  /** Build-wide damage multiplier contributed by passives. */
  get damageMultiplier() {
    const stats = this.getStats('buddy_boost');
    return stats ? 1 + stats.damageBonus : 1;
  }

  /** Build-wide movement multiplier contributed by passives. */
  get moveSpeedMultiplier() {
    const stats = this.getStats('buddy_boost');
    return stats ? 1 + stats.moveSpeedBonus : 1;
  }

  /**
   * Ensure the blade list matches the card's current blade count, drawing from
   * and returning to the pool rather than reallocating on every level-up.
   * @param {number} count
   */
  syncBlades(count) {
    while (this.blades.length > count) {
      this.sim.bladePool.release(this.blades.pop());
    }
    while (this.blades.length < count) {
      const blade = this.sim.bladePool.acquire();
      blade.alive = true;
      this.blades.push(blade);
    }
  }

  /**
   * Damage, push and optionally stun every enemy within `radius` of the Drifter.
   *
   * @param {number} radius
   * @param {number} damage
   * @param {number} knockback - Push distance in px (0 for none)
   * @param {number} [stun] - Seconds to freeze survivors (0 for none)
   */
  blast(radius, damage, knockback, stun = 0) {
    const player = this.player;
    const enemies = this.sim.enemies;

    for (let i = enemies.length - 1; i >= 0; i--) {
      const enemy = enemies[i];
      if (!enemy.alive) continue;
      const reach = radius + enemy.radius;
      if (distanceSq(player.x, player.y, enemy.x, enemy.y) > reach * reach) continue;

      if (knockback > 0) {
        const dir = normalize(enemy.x - player.x, enemy.y - player.y);
        enemy.x = clamp(enemy.x + dir.x * knockback, 0, WORLD.WIDTH);
        enemy.y = clamp(enemy.y + dir.y * knockback, 0, WORLD.HEIGHT);
      }

      // Longest stun wins rather than accumulating: overlapping EMPs should
      // refresh the freeze, not stack it into a permanent lock.
      if (stun > 0 && !enemy.isBoss && enemy.stunTimer < stun) {
        enemy.stunTimer = stun;
      }

      // Damage last: a killed enemy is removed, but the push should still read
      // as having happened for anything that survives.
      this.sim.damageEnemy(enemy, damage);
    }
  }

  /**
   * Queue a short-lived ring for the renderer.
   * @param {number} radius
   * @param {string} kind - 'pulse' | 'tide'
   */
  spawnEffect(radius, kind) {
    this.sim.spawnEffect(this.player.x, this.player.y, radius, kind);
  }

  /**
   * Offer an incoming hit to the Hyperion Shield.
   *
   * All or nothing: a charged barrier eats the ENTIRE hit and goes down, and a
   * spent one lets all of it through. There is no partial absorption to
   * compute, which is the point — the player either got the save or did not,
   * and can tell which at a glance from the hex ring.
   *
   * @param {number} amount
   * @returns {number} Damage remaining after the barrier (0 or `amount`)
   */
  absorb(amount) {
    const rt = this.runtime.get('bloomshield');
    const stats = this.getStats('bloomshield');
    if (!rt || !stats || !rt.ready) return amount;

    rt.ready = false;
    rt.timer = stats.rechargeTime;
    rt.spentAt = this.sim.elapsed;
    this.bus.emit('card:shield_negate', {
      negated: amount,
      rechargeIn: stats.rechargeTime,
    });
    return 0;
  }

  /**
   * Barrier state for the HUD and the renderer's hex ring.
   * @returns {{ready: boolean, timer: number, rechargeTime: number}|null}
   */
  getShieldState() {
    const rt = this.runtime.get('bloomshield');
    const stats = this.getStats('bloomshield');
    if (!rt || !stats) return null;
    return {
      ready: rt.ready,
      timer: rt.timer,
      rechargeTime: stats.rechargeTime,
      spentAt: rt.spentAt,
    };
  }

  /**
   * 0..1 barrier readiness, for the HUD.
   *
   * 1 means the next hit is free. Was an HP number before the shield became a
   * charge; the HUD renders it as a fraction either way.
   */
  get shieldCharge() {
    const state = this.getShieldState();
    if (!state) return 0;
    if (state.ready) return 1;
    return state.rechargeTime > 0
      ? Math.max(0, 1 - state.timer / state.rechargeTime)
      : 0;
  }

  /**
   * Live Tactical Wingman drones, for the renderer. Empty when unowned.
   * @returns {Array<{x: number, y: number, angle: number}>}
   */
  get drones() {
    return this.runtime.get('buddy_boost')?.drones ?? EMPTY_DRONES;
  }

  /**
   * Live Sunbeam Lance geometry, or null when the beam is not firing.
   * Read by the renderer; the beam itself is not an entity.
   * @returns {{dx: number, dy: number, width: number, length: number}|null}
   */
  getBeamState() {
    const rt = this.runtime.get('sunbeam_lance');
    const stats = this.getStats('sunbeam_lance');
    if (!rt || !stats || !rt.active) return null;
    return {
      active: rt.active,
      origin: rt.origin ?? { x: this.player.x, y: this.player.y },
      chain: rt.chain ?? [],
      dx: rt.dx ?? 1,
      dy: rt.dy ?? 0,
      width: 16,
      length: stats.range ?? 300,
      fade: Math.max(0, rt.timeLeft / 0.22),
    };
  }

  /**
   * Create runtime state for any newly acquired card, and refresh state that
   * depends on the level (a levelled shield tops up to its new capacity).
   * @param {string} cardId
   */
  onCardChanged(cardId) {
    const card = getCardById(cardId);
    const stats = this.getStats(cardId);
    if (!card || !stats) return;

    const existing = this.runtime.get(cardId);
    if (!existing) {
      this.runtime.set(cardId, HANDLERS[card.behavior].create(stats));
      return;
    }
    /*
     * Levelling the barrier shortens its recharge; it does not refund a spent
     * charge. Re-arming on level-up would let a player bank a hit by holding
     * an XP orb until they needed one, and the new timer already applies to
     * the recharge in flight — rt.timer is compared against the CURRENT
     * stats row on the next tick.
     */
    if (card.behavior === CARD_BEHAVIORS.SHIELD && !existing.ready) {
      existing.timer = Math.min(existing.timer, stats.rechargeTime);
    }
  }

  /**
   * Tick every owned card.
   * @param {number} dt
   */
  /**
   * Advance every owned card.
   *
   * OVERCHARGE CORE SCALES THE CLOCK, NOT THE STATS.
   * Handlers all measure their own recovery by subtracting `dt` from a
   * cooldown, so handing them a stretched `dt` doubles every weapon's rate
   * without a single handler knowing the skill exists — and without a
   * `fireRateMultiplier` having to be threaded through nine stat rows that
   * would each need to remember to apply it.
   *
   * It does also spin the Aegis Satellites faster and shorten the Tesla arc's
   * flash, because those read the same clock. That is the intended reading of
   * "all automatic weapons": the satellites ARE a weapon, and a reactor dumped
   * into the guns spinning the blades harder is the behaviour a player would
   * predict. Nothing that persists past the run is on this clock.
   *
   * @param {number} dt
   */
  update(dt) {
    dt *= this.sim.activeSkills?.fireRateMultiplier ?? 1;

    for (const [cardId] of this.sim.state.activeCards) {
      const card = getCardById(cardId);
      const stats = this.getStats(cardId);
      if (!card || !stats) continue;

      let rt = this.runtime.get(cardId);
      if (!rt) {
        rt = HANDLERS[card.behavior].create(stats);
        this.runtime.set(cardId, rt);
      }
      HANDLERS[card.behavior].update(this, rt, stats, dt);
    }
  }
}

export { HANDLERS };
