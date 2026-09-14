/**
 * Active-skill state machine and effects.
 *
 * Same seam as CardSystem: the Simulation owns one of these, hands it `dt`
 * every tick, and never reaches inside it. Nothing here touches the DOM or
 * PixiJS — the renderer and the HUD read the public state off this object and
 * draw whatever they like, which is what lets the whole system be tested in
 * plain Node with no canvas.
 *
 * THE STATE MACHINE IS THE SIMPLE PART, AND IT IS THE PART THAT MATTERS.
 *
 *     idle ──trigger()──> active (activeTimer > 0) ──> idle
 *       │                                               │
 *       └────────────── cooldownTimer ticks down <──────┘
 *
 * Cooldown starts on CAST, not on expiry. A 4s skill on a 15s cooldown is
 * usable again 15s after you pressed it, not 19s — the alternative makes long
 * skills feel worse the better they are, and makes the socket's radial mask
 * lie about when the next cast is available.
 *
 * An instant skill (`duration: 0`) runs the exact same path with a zero-length
 * active phase, so there is no second code path for "burst" skills to drift
 * out of sync with.
 *
 * WHY HANDLERS RATHER THAN A SWITCH
 * Each skill is a small object with up to three hooks. A switch would put
 * seven unrelated effects in one function and make "what does Phase Shift
 * actually do" a search problem; this way the answer is one object literal.
 */

import { clamp, distanceSq, normalize } from './math.js';
import { WORLD, PLAYER_CFG } from './constants.js';
import { PROJECTILE_KINDS } from './cards.js';
import {
  ACTIVE_SKILLS,
  ACTIVE_SKILL_IDS,
  ACTIVE_SKILL_ORDER,
  DEFAULT_ACTIVE_SKILL_ID,
  getActiveSkillById,
} from '../data/active-skills.js';

/**
 * How long the hull flashes on a successful cast, in seconds.
 *
 * Deliberately shorter than a comfortable frame at 30fps: this exists to tell
 * the player "your press registered" on the same frame they pressed, and
 * anything long enough to read as an animation would instead read as part of
 * the skill's own effect.
 */
export const PRE_CAST_FLASH_SEC = 0.08;

/** Reasons trigger() can decline, surfaced on the return value for tests. */
export const CAST_REJECTED = {
  COOLING: 'COOLING',
  NO_CHARGES: 'NO_CHARGES',
  UNKNOWN_SKILL: 'UNKNOWN_SKILL',
};

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

/**
 * One entry per skill id.
 *
 * `cast`  — fires once, the instant the key is pressed.
 * `tick`  — runs every frame while activeTimer > 0. Omit for instant skills.
 * `end`   — runs once when the active window closes. Omit if nothing to undo.
 *
 * `sys` is the ActiveSkillSystem, `def` the row from src/data/active-skills.js,
 * `p` its `params` (passed separately purely to keep the bodies readable).
 */
const HANDLERS = {
  /* ---------------------------------------------------------------- */
  [ACTIVE_SKILL_IDS.AFTERBURNER]: {
    cast(sys) {
      // Slam velocity to the new ceiling instead of letting drag ramp into it.
      // Without this the first half-second of a 2.2s burn is spent accelerating
      // and the skill reads as sluggish exactly when it should read as a kick.
      const sim = sys.sim;
      const speed = Math.hypot(sim.playerVx, sim.playerVy);
      if (speed > 0) {
        const boost = sys.def.params.speedMultiplier;
        sim.playerVx *= boost;
        sim.playerVy *= boost;
      }
      sys.bus.emit('skill:afterburner', { x: sys.player.x, y: sys.player.y });
    },

    tick(sys, def, p, dt) {
      const player = sys.player;
      const sim = sys.sim;

      for (const enemy of sim.enemies) {
        if (!enemy.alive || enemy.isBoss) continue;
        // Heavies are not shoved: the roster's radius is the only mass proxy
        // it has, and damageEnemy already scales its kinetic knock by it.
        if (enemy.radius > p.maxRamRadius) continue;
        if (enemy.rammedTimer > 0) continue;

        const reach = p.rammingRadius + enemy.radius;
        if (distanceSq(player.x, player.y, enemy.x, enemy.y) > reach * reach) continue;

        const dir = normalize(enemy.x - player.x, enemy.y - player.y);
        enemy.x = clamp(enemy.x + dir.x * p.knockback, enemy.radius, WORLD.WIDTH - enemy.radius);
        enemy.y = clamp(enemy.y + dir.y * p.knockback, enemy.radius, WORLD.HEIGHT - enemy.radius);
        enemy.rammedTimer = p.ramCooldown;

        // Damage last: a kill removes the enemy, but the shove should still
        // have read as happening to anything that survives it.
        sim.damageEnemy(enemy, p.ramDamage, dir.x * 240, dir.y * 240);
      }

      void dt;
    },
  },

  /* ---------------------------------------------------------------- */
  [ACTIVE_SKILL_IDS.EMP_SHOCKWAVE]: {
    cast(sys, def, p) {
      const sim = sys.sim;
      const player = sys.player;

      // Arena-wide, not radius-limited: the brief says every hostile round on
      // the field, and a boss ring that has already spread past 140px is
      // exactly the situation this is pressed in.
      const cleared = sim.enemyBullets.length;
      for (const bullet of sim.enemyBullets) bullet.alive = false;

      let stunned = 0;
      for (const enemy of sim.enemies) {
        if (!enemy.alive) continue;
        const reach = p.radius + enemy.radius;
        if (distanceSq(player.x, player.y, enemy.x, enemy.y) > reach * reach) continue;

        if (!enemy.isBoss) {
          // Longest stun wins rather than accumulating — overlapping EMPs
          // should refresh the lock, never stack it into a permanent one.
          if (enemy.stunTimer < p.stun) enemy.stunTimer = p.stun;
          const dir = normalize(enemy.x - player.x, enemy.y - player.y);
          enemy.x = clamp(enemy.x + dir.x * p.knockback, enemy.radius, WORLD.WIDTH - enemy.radius);
          enemy.y = clamp(enemy.y + dir.y * p.knockback, enemy.radius, WORLD.HEIGHT - enemy.radius);
          stunned += 1;
        }
        sim.damageEnemy(enemy, p.damage);
      }

      sim.spawnEffect(player.x, player.y, p.radius, 'tide');
      sys.bus.emit('skill:emp', { x: player.x, y: player.y, radius: p.radius, cleared, stunned });
    },
  },

  /* ---------------------------------------------------------------- */
  [ACTIVE_SKILL_IDS.MISSILE_SALVO]: {
    cast(sys, def, p) {
      const sim = sys.sim;
      const player = sys.player;

      // Both acquisitions resolved once for the whole salvo rather than per
      // missile: eight identical nearest-enemy scans over a 200-enemy field is
      // eight times the work for the same answer.
      const near = sim.findNearestEnemy(p.seekRange);
      const heavy = sim.findHighestHpEnemy(p.seekRange);
      const heavyCount = Math.round(p.count * p.heavySeekerRatio);

      for (let i = 0; i < p.count; i++) {
        // Launch headings fan evenly around the hull; the seeker turns them in
        // afterwards. The half-step offset keeps a missile off the exact +X
        // axis so an even count never launches two straight down the same line.
        const angle = ((Math.PI * 2) / p.count) * i + Math.PI / p.count;
        const target = i < heavyCount ? heavy ?? near : near ?? heavy;

        sim.spawnProjectile({
          x: player.x + Math.cos(angle) * PLAYER_CFG.RADIUS,
          y: player.y + Math.sin(angle) * PLAYER_CFG.RADIUS,
          vx: Math.cos(angle) * p.speed,
          vy: Math.sin(angle) * p.speed,
          damage: sim.cards.damageOf(p.damage),
          radius: p.radius,
          life: p.life,
          kind: PROJECTILE_KINDS.MISSILE,
          targetId: target?.id ?? 0,
          turnRate: p.turnRate,
        });
      }

      sys.bus.emit('skill:salvo', { x: player.x, y: player.y, count: p.count });
    },
  },

  /* ---------------------------------------------------------------- */
  [ACTIVE_SKILL_IDS.PHASE_SHIFT]: {
    cast(sys, def, p) {
      const sim = sys.sim;
      const player = sys.player;
      const facing = sim.getFacing();

      const fromX = player.x;
      const fromY = player.y;

      player.x = clamp(
        player.x + facing.x * p.distance,
        PLAYER_CFG.RADIUS,
        WORLD.WIDTH - PLAYER_CFG.RADIUS
      );
      player.y = clamp(
        player.y + facing.y * p.distance,
        PLAYER_CFG.RADIUS,
        WORLD.HEIGHT - PLAYER_CFG.RADIUS
      );

      // The jump keeps its momentum. Zeroing velocity here would dump the ship
      // out of the blink at a dead stop, which is the worst possible state to
      // land in when the thing you blinked away from is still chasing you.
      sys.bus.emit('skill:phase_shift', {
        fromX,
        fromY,
        toX: player.x,
        toY: player.y,
      });
    },
  },

  /* ---------------------------------------------------------------- */
  [ACTIVE_SKILL_IDS.SINGULARITY_ANCHOR]: {
    cast(sys, def, p) {
      const sim = sys.sim;
      const player = sys.player;
      const facing = sim.getFacing();

      const anchor = sys.anchor;
      anchor.active = true;
      anchor.x = clamp(player.x + facing.x * p.throwDistance, 0, WORLD.WIDTH);
      anchor.y = clamp(player.y + facing.y * p.throwDistance, 0, WORLD.HEIGHT);
      anchor.radius = p.radius;
      anchor.life = sys.def.duration;
      anchor.maxLife = sys.def.duration;
      anchor.tickTimer = 0;

      sys.bus.emit('skill:singularity', { x: anchor.x, y: anchor.y, radius: p.radius });
    },

    tick(sys, def, p, dt) {
      const sim = sys.sim;
      const anchor = sys.anchor;

      anchor.life -= dt;
      anchor.tickTimer -= dt;
      const crushing = anchor.tickTimer <= 0;
      if (crushing) anchor.tickTimer = p.tickInterval;

      for (const enemy of sim.enemies) {
        if (!enemy.alive) continue;
        if (enemy.isBoss && !p.affectsBoss) continue;

        const dx = anchor.x - enemy.x;
        const dy = anchor.y - enemy.y;
        const distSq = dx * dx + dy * dy;
        const reach = p.radius + enemy.radius;
        if (distSq > reach * reach) continue;

        const dist = Math.sqrt(distSq);
        if (dist > 1) {
          /*
           * Pull eases to zero at the core. A constant inward speed makes
           * captured enemies overshoot the centre and oscillate across it,
           * which looks like a bug rather than like gravity; scaling by
           * distance settles them into the well instead.
           */
          const falloff = Math.min(1, dist / p.radius);
          const step = Math.min(dist, p.pullSpeed * falloff * dt);
          enemy.x += (dx / dist) * step;
          enemy.y += (dy / dist) * step;
        }

        if (crushing) sim.damageEnemy(enemy, p.damage);
      }
    },

    end(sys) {
      sys.anchor.active = false;
    },
  },

  /* ---------------------------------------------------------------- */
  [ACTIVE_SKILL_IDS.OVERCHARGE_CORE]: {
    // Nothing to do per frame: the two multipliers are read straight off this
    // system by updatePlayer and CardSystem.update while the window is open.
    // A tick hook that only set flags something else already reads would be a
    // second source of truth for the same fact.
    cast(sys) {
      sys.bus.emit('skill:overcharge', { x: sys.player.x, y: sys.player.y });
    },
  },

  /* ---------------------------------------------------------------- */
  [ACTIVE_SKILL_IDS.POINT_DEFENSE]: {
    cast(sys, def, p) {
      sys.syncBlades(p.bladeCount);
      sys.bladeAngle = 0;
      sys.bus.emit('skill:point_defense', { x: sys.player.x, y: sys.player.y });
    },

    tick(sys, def, p, dt) {
      const sim = sys.sim;
      const player = sys.player;

      sys.bladeAngle += p.rotationSpeed * dt;
      const step = (Math.PI * 2) / p.bladeCount;

      for (let i = 0; i < sys.blades.length; i++) {
        const blade = sys.blades[i];
        const angle = sys.bladeAngle + i * step;
        blade.x = player.x + Math.cos(angle) * p.orbitRadius;
        blade.y = player.y + Math.sin(angle) * p.orbitRadius;
        blade.radius = p.bladeRadius;

        for (const enemy of sim.enemies) {
          // One re-hit clock per enemy rather than per blade, so the DPS the
          // balance model sees does not scale with blade count. `pdCooldown`
          // is its own field, not the satellites' `orbitCooldown`: these are
          // two different weapons and one must not eat the other's hits.
          if (!enemy.alive || enemy.pdCooldown > 0) continue;
          const reach = p.bladeRadius + enemy.radius;
          if (distanceSq(blade.x, blade.y, enemy.x, enemy.y) > reach * reach) continue;

          sim.damageEnemy(enemy, sim.cards.damageOf(p.damage));
          enemy.pdCooldown = p.hitCooldown;
        }
      }

      /*
       * Interception is checked against the orbit BAND, not against the
       * blades. A round that slips between two blades should still be eaten —
       * otherwise the defensive half of the skill silently depends on the
       * blades' phase at the moment of impact, which the player cannot see
       * and could not act on if they could.
       */
      for (const bullet of sim.enemyBullets) {
        if (!bullet.alive) continue;
        const reach = p.interceptRadius + bullet.radius;
        if (distanceSq(player.x, player.y, bullet.x, bullet.y) > reach * reach) continue;
        bullet.alive = false;
        sys.bus.emit('skill:intercept', { x: bullet.x, y: bullet.y });
      }
    },

    end(sys) {
      sys.syncBlades(0);
    },
  },
};

/* ------------------------------------------------------------------ */
/* System                                                              */
/* ------------------------------------------------------------------ */

/**
 * Equip a skill in the meta-state. Pure — returns a new state, like every
 * other meta action, so the caller commits it the same way.
 *
 * @param {Object} state - Meta-state
 * @param {string} skillId
 * @returns {{ok: boolean, reason?: string, state: Object}}
 */
export function equipActiveSkill(state, skillId) {
  if (!getActiveSkillById(skillId)) return { ok: false, reason: 'UNKNOWN_SKILL', state };
  return { ok: true, state: { ...state, activeSkillId: skillId } };
}

/**
 * Rows for the hangar list: every skill, with the equipped one flagged.
 *
 * All seven are always available. They are a tactical choice, not a purchase —
 * nothing in the brief gates them behind Scrap, and making the player buy a
 * playstyle would turn a loadout decision into an economy one.
 *
 * @param {Object} state - Meta-state
 * @returns {Array<Object>}
 */
export function describeActiveSkills(state) {
  return ACTIVE_SKILL_ORDER.map((id) => {
    const def = ACTIVE_SKILLS[id];
    return {
      id,
      name: def.name,
      description: def.description,
      mark: def.mark,
      cooldown: def.cooldown,
      duration: def.duration,
      equipped: state.activeSkillId === id,
    };
  });
}

export class ActiveSkillSystem {
  /**
   * @param {import('./simulation.js').Simulation} sim
   */
  constructor(sim) {
    this.sim = sim;
    this.bus = sim.bus;

    /** Currently equipped skill id. Set from meta-state at run start. */
    this.skillId = DEFAULT_ACTIVE_SKILL_ID;
    /** Chip-scaled def for the equipped skill; null means the level-1 table. */
    this.defOverride = null;
    /** Seconds until the next cast is allowed. */
    this.cooldownTimer = 0;
    /** Seconds of active window left. 0 when idle or between casts. */
    this.activeTimer = 0;
    /** Casts banked. 1 by default; a meta-upgrade can raise it. */
    this.charges = 1;
    this.maxCharges = 1;
    /** Counts down from PRE_CAST_FLASH_SEC on a successful cast. */
    this.preCastFlashTimer = 0;

    /** Singularity Anchor's live anomaly. Inert unless that skill is running. */
    this.anchor = {
      active: false,
      x: 0,
      y: 0,
      radius: 0,
      life: 0,
      maxLife: 1,
      tickTimer: 0,
    };

    /** Point-Defense blades, recycled through the simulation's blade pool. */
    this.blades = [];
    this.bladeAngle = 0;
  }

  get player() {
    return this.sim.state.player;
  }

  /**
   * The equipped skill's data row — scaled to the chip level bought for it,
   * when the run was started with one.
   *
   * EVERY HANDLER READS THROUGH HERE, which is the whole reason the level
   * system is a single override on this getter rather than a lookup inside
   * each of the seven handlers. `resolveSkillDefAtLevel` in meta-economy.js
   * returns an ordinary ActiveSkillDef with its numbers already multiplied, so
   * a level-5 Singularity Anchor reaches `HANDLERS.singularity_anchor` as a
   * row with `radius: 330` and nothing in this file has to know a chip exists.
   *
   * Falls back to the level-1 table whenever no override was supplied — the
   * Phase 1-4 call sites, every test that equips by id alone, and any run
   * started without a meta-state.
   */
  get def() {
    return this.defOverride ?? getActiveSkillById(this.skillId);
  }

  /** True while the active window is open. */
  get isActive() {
    return this.activeTimer > 0;
  }

  /**
   * True when the key press would actually do something.
   *
   * CHARGES, NOT THE CLOCK, GATE THE CAST.
   * Gating on `cooldownTimer <= 0` as well would make maxCharges > 1 dead
   * weight: the second charge could only ever be spent at the moment the
   * cooldown expired, which is exactly when the first one came back anyway.
   * Banked casts are the whole point of the upgrade, so a charge in hand is
   * castable even mid-cooldown — the clock's job is to refill, not to block.
   *
   * At the default maxCharges of 1 this is indistinguishable from the stricter
   * rule: spending the only charge leaves zero, and zero is not castable.
   */
  get isReady() {
    return this.charges > 0;
  }

  /** True for the ~80ms after a cast registers; drives the hull flash. */
  get preCastFlash() {
    return this.preCastFlashTimer > 0;
  }

  /**
   * 0..1 cooldown progress, for the HUD's radial mask. 1 means ready.
   *
   * Derived rather than stored so it cannot disagree with cooldownTimer, and
   * guarded against a zero-cooldown definition so a debug skill with no
   * cooldown reports ready instead of NaN.
   */
  get charge() {
    const total = this.def?.cooldown ?? 0;
    if (total <= 0) return 1;
    return clamp(1 - this.cooldownTimer / total, 0, 1);
  }

  /**
   * Full reset, called from Simulation.resetEntities.
   *
   * Keeps `skillId` — the equipped skill is a loadout choice that survives a
   * restart, the same way the equipped cosmetic does. Everything else is
   * per-run state and goes back to a fresh, ready-to-cast slate.
   */
  reset() {
    this.cooldownTimer = 0;
    this.activeTimer = 0;
    this.charges = this.maxCharges;
    this.preCastFlashTimer = 0;
    this.anchor.active = false;
    this.anchor.life = 0;
    this.bladeAngle = 0;
    this.syncBlades(0);
  }

  /**
   * Equip a skill. Unknown ids fall back to the default rather than leaving
   * the system pointing at a row that does not exist — a bad save should cost
   * the player their choice, not their whole run.
   *
   * @param {string} id
   * @param {Object} [options]
   * @param {number} [options.maxCharges]
   * @param {Object} [options.def] - A scaled ActiveSkillDef to use in place of
   *   the level-1 table row. Ignored unless its `id` matches the skill actually
   *   equipped, so a stale def left over from a previous loadout can never
   *   drive a different skill's handler.
   */
  equip(id, { maxCharges = 1, def = null } = {}) {
    this.skillId = getActiveSkillById(id) ? id : DEFAULT_ACTIVE_SKILL_ID;
    this.defOverride = def?.id === this.skillId ? def : null;
    this.maxCharges = Math.max(1, Math.floor(maxCharges));
    this.charges = this.maxCharges;
    this.cooldownTimer = 0;
    this.activeTimer = 0;
    this.syncBlades(0);
    this.anchor.active = false;
  }

  /**
   * Fire the equipped skill.
   *
   * Safe to call every frame and on every key repeat: a press while cooling or
   * out of charges is declined, and the reason comes back on the result so a
   * test can assert WHY rather than just that nothing happened.
   *
   * @returns {{ok: boolean, reason?: string, skillId: string}}
   */
  trigger() {
    const def = this.def;
    if (!def) return { ok: false, reason: CAST_REJECTED.UNKNOWN_SKILL, skillId: this.skillId };
    if (this.charges <= 0) {
      // COOLING and NO_CHARGES describe the same moment at maxCharges 1, and
      // the clock is the honest explanation of it — the charge is missing
      // *because* the cooldown has not finished refilling it.
      const reason = this.cooldownTimer > 0 ? CAST_REJECTED.COOLING : CAST_REJECTED.NO_CHARGES;
      return { ok: false, reason, skillId: this.skillId };
    }

    this.charges -= 1;
    // Only START the refill clock; never restart one already running, or
    // spending a banked charge would push the first charge's refill back.
    if (this.cooldownTimer <= 0) this.cooldownTimer = def.cooldown;
    this.activeTimer = def.duration;
    this.preCastFlashTimer = PRE_CAST_FLASH_SEC;

    HANDLERS[def.id]?.cast?.(this, def, def.params);

    this.bus.emit('skill:cast', {
      skillId: def.id,
      cooldown: def.cooldown,
      duration: def.duration,
    });

    // An instant skill has already done its whole job inside cast(); close the
    // window now rather than leaving a zero-length one open for a frame.
    if (this.activeTimer <= 0) this.endActive(def);

    return { ok: true, skillId: def.id };
  }

  /**
   * Advance cooldown, the active window and whatever the running skill does
   * per frame.
   *
   * @param {number} dt
   */
  update(dt) {
    if (this.preCastFlashTimer > 0) this.preCastFlashTimer -= dt;

    const def = this.def;
    if (!def) return;

    if (this.activeTimer > 0) {
      this.activeTimer -= dt;
      HANDLERS[def.id]?.tick?.(this, def, def.params, dt);
      if (this.activeTimer <= 0) {
        this.activeTimer = 0;
        this.endActive(def);
      }
    }

    if (this.cooldownTimer > 0) {
      this.cooldownTimer -= dt;
      if (this.cooldownTimer <= 0) {
        this.cooldownTimer = 0;
        // Refund one charge per full cooldown, so a 2-charge loadout refills
        // one at a time instead of both at once.
        if (this.charges < this.maxCharges) {
          this.charges += 1;
          // Still short? Start the next cooldown immediately.
          if (this.charges < this.maxCharges) this.cooldownTimer = def.cooldown;
        }
        this.bus.emit('skill:ready', { skillId: def.id, charges: this.charges });
      }
    }
  }

  /** @param {Object} def */
  endActive(def) {
    HANDLERS[def.id]?.end?.(this, def, def.params);
  }

  /* ---------------------------------------------------------------- */
  /* Read by the Simulation                                            */
  /* ---------------------------------------------------------------- */

  /** Top-speed multiplier the running skill contributes. */
  get moveSpeedMultiplier() {
    if (!this.isActive) return 1;
    const p = this.def?.params;
    return p?.speedMultiplier ?? p?.moveSpeedMultiplier ?? 1;
  }

  /** Acceleration multiplier the running skill contributes. */
  get accelMultiplier() {
    if (!this.isActive) return 1;
    return this.def?.params?.accelMultiplier ?? 1;
  }

  /** Weapon-cooldown multiplier the running skill contributes. */
  get fireRateMultiplier() {
    if (!this.isActive) return 1;
    return this.def?.params?.fireRateMultiplier ?? 1;
  }

  /** True while the running skill grants i-frames. */
  get invulnerable() {
    return this.isActive && this.def?.params?.invulnerable === true;
  }

  /**
   * Match the blade list to `count`, drawing from and returning to the
   * simulation's blade pool rather than reallocating per cast.
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

  /** Everything the HUD needs, in one read. */
  getSnapshot() {
    const def = this.def;
    return {
      skillId: this.skillId,
      name: def?.name ?? '',
      mark: def?.mark ?? '',
      cooldown: def?.cooldown ?? 0,
      duration: def?.duration ?? 0,
      cooldownTimer: this.cooldownTimer,
      activeTimer: this.activeTimer,
      charge: this.charge,
      charges: this.charges,
      maxCharges: this.maxCharges,
      ready: this.isReady,
      active: this.isActive,
      preCastFlash: this.preCastFlash,
    };
  }
}

export { HANDLERS };
