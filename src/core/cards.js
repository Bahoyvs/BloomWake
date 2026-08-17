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

      for (let i = 0; i < count; i++) {
        // Centre the salvo on the target: -n/2 .. +n/2 spread.
        const angle = baseAngle + (i - (count - 1) / 2) * PROJECTILE_CFG.SPREAD_RAD;
        sys.sim.spawnProjectile({
          x: player.x,
          y: player.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          damage,
          radius: PROJECTILE_CFG.RADIUS,
          life: PROJECTILE_CFG.LIFETIME_SEC,
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
  [CARD_BEHAVIORS.BEAM]: {
    create: () => ({ cooldown: 0, active: false, timeLeft: 0, tick: 0, dx: 1, dy: 0 }),
    update(sys, rt, stats, dt) {
      if (rt.active) {
        rt.timeLeft -= dt;
        rt.tick -= dt;

        if (rt.tick <= 0 && rt.timeLeft > 0) {
          BEAM_DAMAGE(sys, rt, stats);
          rt.tick += CARD_MODEL.BEAM_TICK_SEC;
        }

        if (rt.timeLeft <= 0) {
          rt.active = false;
          rt.cooldown = stats.cooldown;
        }
        return;
      }

      rt.cooldown -= dt;
      if (rt.cooldown > 0) return;

      // "Fixed direction" per GDD Section 7: aimed once at cast, then held for
      // the whole duration rather than tracking the target.
      const target = sys.sim.findNearestEnemy(CARD_MODEL.BEAM_LENGTH);
      if (!target) {
        rt.cooldown = 0;
        return;
      }
      const dir = normalize(target.x - sys.player.x, target.y - sys.player.y);
      rt.dx = dir.x;
      rt.dy = dir.y;
      rt.active = true;
      rt.timeLeft = stats.duration;
      // First tick lands one interval in, giving floor(duration / tick) hits.
      rt.tick = CARD_MODEL.BEAM_TICK_SEC;
      sys.bus.emit('card:beam', { x: sys.player.x, y: sys.player.y, dx: dir.x, dy: dir.y });
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
  [CARD_BEHAVIORS.AOE_PULSE]: {
    create: () => ({ cooldown: 0 }),
    update(sys, rt, stats, dt) {
      rt.cooldown -= dt;
      if (rt.cooldown > 0) return;

      sys.blast(stats.radius, sys.damageOf(stats.damage), 0);
      sys.spawnEffect(stats.radius, 'pulse');
      rt.cooldown = stats.cooldown;
    },
  },

  /* ---------------------------------------------------------------- */
  [CARD_BEHAVIORS.AOE_KNOCKBACK]: {
    create: () => ({ cooldown: 0 }),
    update(sys, rt, stats, dt) {
      rt.cooldown -= dt;
      if (rt.cooldown > 0) return;

      sys.blast(stats.radius, sys.damageOf(stats.damage), stats.knockback);
      sys.spawnEffect(stats.radius, 'tide');
      rt.cooldown = stats.cooldown;
    },
  },

  /* ---------------------------------------------------------------- */
  [CARD_BEHAVIORS.SHIELD]: {
    create: (stats) => ({ charge: stats.shieldHp, recharging: false, timer: 0 }),
    update(sys, rt, stats, dt) {
      if (!rt.recharging) return;

      rt.timer -= dt;
      if (rt.timer <= 0) {
        rt.charge = stats.shieldHp;
        rt.recharging = false;
        sys.bus.emit('card:shield_ready', { charge: rt.charge });
      }
    },
  },

  /* ---------------------------------------------------------------- */
  [CARD_BEHAVIORS.PASSIVE]: {
    create: () => ({}),
    // Stat modifiers are read directly by damageOf() / moveSpeedMultiplier.
    update() {},
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
   * Damage and optionally push every enemy within `radius` of the Dewling.
   * @param {number} radius
   * @param {number} damage
   * @param {number} knockback - Push distance in px (0 for none)
   */
  blast(radius, damage, knockback) {
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
   * Route incoming player damage through Bloomshield first.
   * @param {number} amount
   * @returns {number} Damage remaining after absorption
   */
  absorb(amount) {
    const rt = this.runtime.get('bloomshield');
    const stats = this.getStats('bloomshield');
    if (!rt || !stats || rt.recharging || rt.charge <= 0) return amount;

    const absorbed = Math.min(rt.charge, amount);
    rt.charge -= absorbed;
    this.bus.emit('card:shield_absorb', { absorbed, remaining: rt.charge });

    if (rt.charge <= 0) {
      rt.recharging = true;
      rt.timer = stats.rechargeTime;
      this.bus.emit('card:shield_broken', { rechargeIn: stats.rechargeTime });
    }
    return amount - absorbed;
  }

  /** Current shield charge, for the HUD. */
  get shieldCharge() {
    const rt = this.runtime.get('bloomshield');
    return rt ? rt.charge : 0;
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
      dx: rt.dx,
      dy: rt.dy,
      width: stats.width,
      length: CARD_MODEL.BEAM_LENGTH,
      fade: Math.min(1, rt.timeLeft / stats.duration),
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
    if (card.behavior === CARD_BEHAVIORS.SHIELD && !existing.recharging) {
      existing.charge = stats.shieldHp;
    }
  }

  /**
   * Tick every owned card.
   * @param {number} dt
   */
  update(dt) {
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
