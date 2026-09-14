/**
 * BloomWake simulation — the core survival loop.
 *
 * Owns every runtime entity (enemies, projectiles, XP orbs, card effects, spore hazards) and
 * advances them with a plain delta-time step. Strictly DOM-free: the renderer
 * reads this state, the simulation never knows a canvas exists.
 *
 * Phase 4 scope: Full Frutevil enemy roster (Tarling, Ashfish, Cracked Wisp, Rustbloom, Smogmoth),
 * Rustwhale Boss with deterministic Black Tide telegraph formula, 64px Spatial Hash Grid
 * broadphase collision, and procedural wave progression.
 */

import { EventBus } from './event-bus.js';
import { AnimationDirector } from './animation.js';
import { GameState, GAME_STATES, DEFAULT_PLAYER_STATS } from './game-state.js';
import { applyMetaUpgradesToRunStart, getDraftOfferCount } from './meta-shop.js';
import { WaveSpawner } from './spawner.js';
import { CardSystem } from './cards.js';
import { drawDraft } from './draft.js';
import { ObjectPool, sweepToPool } from './pool.js';
import { SpatialHashGrid } from './spatial.js';
import {
  UNIT_PX,
  WORLD,
  PLAYER_CFG,
  PROJECTILE_CFG,
  ENEMY_BULLET_CFG,
  FRENZY_CFG,
  ORB_CFG,
  CARD_MODEL,
  DRAFT_CFG,
  PHASE1,
} from './constants.js';
import { clamp, distanceSq, mulberry32, normalize, randomRange, removeDead } from './math.js';
import { getEnemyHpMultiplier, getEnemySpeedMultiplier, isBossWave, getBossHp } from './wave.js';
import {
  ENEMIES,
  ENEMY_TYPES,
  ENEMY_BEHAVIORS,
  calculateTelegraphMs,
  getBossPhase,
  BOSS_PHASES,
} from '../data/enemies.js';
import { PROJECTILE_KINDS } from './cards.js';
import { ActiveSkillSystem } from './active-skills.js';
import { applyArchetype, stepEnemy } from './enemy-system.js';
import { CompositeBoss } from './composite-boss.js';
import { pickArchetypeForWave, pickBossTemplate } from '../data/roster-config.js';

const STARTER_CARD_ID = 'dewdrop_barrage';

/** Shared empty result for getCompositeTargets(). Never mutate this. */
const EMPTY_ARRAY = [];

export class Simulation {
  /**
   * @param {Object} [options]
   * @param {EventBus} [options.bus]
   * @param {GameState} [options.state]
   * @param {number} [options.seed] - Seed for deterministic spawning and drafts
   * @param {number} [options.maxWaves]
   */
  constructor({
    bus,
    state,
    seed = 1337,
    maxWaves = PHASE1.MAX_WAVES,
    useCompositeBosses = false,
    useRosterConfig = false,
  } = {}) {
    this.bus = bus ?? new EventBus();
    this.state = state ?? new GameState(this.bus, { maxWaves });
    this.rng = mulberry32(seed);
    /**
     * Which boss a boss wave puts on the field.
     *
     * False keeps the shipped Dreadnought Station (src/data/enemies.js), whose
     * phase-gating rules the balance suites are written against. True switches
     * boss waves to the modular templates in roster-config. A FLAG rather than
     * a code edit because that is the whole premise of the migration: the boss
     * a wave spawns is configuration, and flipping it must not mean touching
     * this file.
     */
    this.useCompositeBosses = useCompositeBosses;
    /**
     * Which chaff catalogue updateSpawning draws regular arrivals from.
     *
     * False keeps the shipped Chitin Swarm roster (src/data/enemies.js) via
     * WaveSpawner.pickEnemyType + spawnEnemy — the species the balance and
     * roster suites are written against. True switches regular arrivals to
     * src/data/roster-config.js's archetypes via pickArchetypeForWave +
     * spawnArchetype, unlocking larva_swarm/spore_kiter/mantis_weaver early,
     * dart_rammer at wave 3, spore_barrage at wave 4 and brood_bastion at
     * wave 5 — each by its own `minWave`/`spawnWeight`. Same FLAG contract as
     * useCompositeBosses: which catalogue a wave spawns from is configuration,
     * not a code edit.
     */
    this.useRosterConfig = useRosterConfig;
    this.spawner = new WaveSpawner(this.rng);
    this.spatialGrid = new SpatialHashGrid(64);

    this.enemies = [];
    this.projectiles = [];
    /** Hostile ordnance — the Dreadnought's radial rings. */
    this.enemyBullets = [];
    this.orbs = [];
    /** Short-lived rings drawn for AoE cards. */
    this.effects = [];
    /** Brood Spore acid pools on the ground. */
    this.sporePools = [];

    /** Active Boss Telegraph state */
    this.bossTelegraph = {
      active: false,
      x: 0,
      y: 0,
      radius: 0,
      damage: 0,
      elapsedMs: 0,
      totalMs: 0,
    };

    /**
     * The Dreadnought's phase-3 sweeping death ray.
     *
     * Two stages in one record: `telegraph` draws the warning cone and does no
     * damage, then `firing` turns the same cone into a beam that tracks the
     * Drifter at a capped rate. Keeping both in one object means the renderer
     * reads one thing and the angle it drew the warning at is exactly the
     * angle the beam starts from.
     */
    this.deathRay = {
      active: false,
      firing: false,
      x: 0,
      y: 0,
      angle: 0,
      elapsed: 0,
      telegraphSec: 0,
      sweepSec: 0,
      length: 0,
      halfWidth: 0,
      damagePerSec: 0,
      turnRate: 0,
    };

    // Card-spawned objects are recycled
    this.projectilePool = new ObjectPool(makeProjectile, 64);
    this.bladePool = new ObjectPool(makeBlade, 6);
    this.effectPool = new ObjectPool(makeEffect, 8);
    /**
     * The boss throws 18 bullets a ring every 2.6s and they live six seconds,
     * so a hundred can be in flight at once. Same reasoning as the enemy pool:
     * anything spawned on a repeating timer gets recycled.
     */
    this.enemyBulletPool = new ObjectPool(makeEnemyBullet, 48);
    /**
     * Enemies are pooled at the wave cap (WAVE_CONSTANTS.MAX_ACTIVE_ENEMIES).
     * Before Phase 7 every spawn allocated a fresh literal and every death
     * dropped it on the floor — at a 200-enemy cap with continuous refill that
     * is a steady stream of garbage. Tier B adds four more fields per enemy, so
     * recycling them is what keeps "zero new GC pressure" an honest claim
     * rather than a slightly worse status quo.
     */
    this.enemyPool = new ObjectPool(makeEnemy, 64);

    /**
     * Modular bosses (src/core/composite-boss.js). A separate list from
     * `enemies` on purpose: a composite boss is not one circle with one HP bar,
     * so it cannot go through the enemy pool, the spatial grid, or the
     * single-radius collision path without every one of them learning about
     * parts. Kept apart, each stays simple and the boss owns its own hit
     * resolution.
     */
    this.compositeBosses = [];
    /**
     * Reusable context handed to the enemy-system state machines.
     *
     * One object for the whole run rather than one per enemy per frame: at the
     * 200-enemy cap a fresh literal here would be the single largest source of
     * allocation in the tick. stepEnemy writes its aim vector into it, so
     * nothing may hold a reference to it across calls.
     */
    this.behaviorCtx = {
      target: null,
      dirX: 0,
      dirY: 0,
      distance: 0,
      rng: () => this.rng(),
      fire: (spec) => this.spawnEnemyBullet(spec),
      emit: (type, payload) => this.bus.emit(type, payload),
    };

    this.cards = new CardSystem(this);
    /**
     * Pilot-triggered skills. Owns its own cooldown clock and effects; the
     * Simulation only forwards `dt` and reads a handful of multipliers off it.
     */
    this.activeSkills = new ActiveSkillSystem(this);
    this.animation = new AnimationDirector(this.bus);

    this.nextEntityId = 1;
    /** True while the Dewling has non-zero movement input; read by the director. */
    this.playerMoving = false;
    /**
     * Drifter momentum in px/s. Not on `state.player`: that object is
     * serialised into saves, and velocity is a fact about the current frame.
     * The renderer reads these for hull facing and engine throttle.
     */
    this.playerVx = 0;
    this.playerVy = 0;
    /**
     * Unit heading the hull is pointing, kept across a full stop.
     *
     * Velocity goes to zero when the player lets go; facing must not, or the
     * Singularity Lance would fire out of a parked ship along +X and the
     * wingman formation would snap round to the world axes. Updated only while
     * the ship is actually moving.
     */
    this.facingX = 1;
    this.facingY = 0;
    this.invulnTimer = 0;
    this.waveBreakTimer = 0;
    this.elapsed = 0;
    /** Simulation time the spawn window closed; drives the clear-out frenzy. */
    this.frenzyStart = Infinity;
    /** Level-ups waiting for a draft; several can arrive in one frame. */
    this.pendingLevelUps = 0;

    this.bus.on('wave:start', (data) => {
      this.spawner.beginWave(data.wave);
      this.frenzyStart = Infinity;
      // A boss wave opens on an empty field, whatever the last wave left.
      if (isBossWave(data.wave)) this.clearArenaForBoss();
    });
    this.bus.on('wave:complete', () => this.onWaveComplete());
    // Stamped here rather than read off the wave clock: the window can also be
    // closed early, and the ramp has to start from whenever that happened.
    this.bus.on('wave:spawn_closed', () => {
      this.frenzyStart = this.elapsed;
    });
    this.bus.on('player:level_up', () => this.onLevelUp());
    this.bus.on('card:selected', ({ cardId }) => this.cards.onCardChanged(cardId));
    this.bus.on('draft:choice', () => this.onDraftResolved());

    this.resetEntities();
  }

  /** Clear all entities and per-run timers (does not touch GameState). */
  resetEntities() {
    for (const p of this.projectiles) this.projectilePool.release(p);
    for (const b of this.enemyBullets) this.enemyBulletPool.release(b);
    for (const e of this.effects) this.effectPool.release(e);
    for (const enemy of this.enemies) this.enemyPool.release(enemy);
    this.projectiles.length = 0;
    this.enemyBullets.length = 0;
    this.effects.length = 0;
    this.enemies.length = 0;
    this.compositeBosses.length = 0;
    this.orbs.length = 0;
    this.sporePools.length = 0;
    this.spatialGrid.clear();

    this.bossTelegraph.active = false;
    this.deathRay.active = false;
    this.deathRay.firing = false;
    this.cards.reset();
    this.activeSkills.reset();
    this.animation.reset();
    this.playerMoving = false;
    this.playerVx = 0;
    this.playerVy = 0;
    this.facingX = 1;
    this.facingY = 0;
    this.invulnTimer = 0;
    this.waveBreakTimer = 0;
    this.elapsed = 0;
    this.frenzyStart = Infinity;
    this.pendingLevelUps = 0;
  }

  /**
   * Begin a fresh run: reset state, centre the Dewling, open wave 1.
   *
   * @param {Object} [metaState] - Persistent meta-state. When supplied, its
   *   purchased upgrades are folded into the Dewling's starting stats and the
   *   draft width. Omitted in tests and Phase 1-4 call sites, which run with
   *   unmodified base stats.
   */
  startRun(metaState = null) {
    this.resetEntities();
    this.state.startRun();

    if (metaState) {
      Object.assign(
        this.state.player,
        applyMetaUpgradesToRunStart(metaState, DEFAULT_PLAYER_STATS)
      );
      this.offerCount = getDraftOfferCount(metaState, DRAFT_CFG.OFFER_COUNT);
      // Equipped in the hangar, carried in here. equip() validates the id, so
      // a save naming a skill this build does not have falls back rather than
      // starting the run with a dead key.
      this.activeSkills.equip(metaState.activeSkillId);
    } else {
      this.offerCount = DRAFT_CFG.OFFER_COUNT;
    }

    this.state.player.x = WORLD.WIDTH / 2;
    this.state.player.y = WORLD.HEIGHT / 2;
    this.cards.onCardChanged(STARTER_CARD_ID);
  }

  /**
   * Advance the simulation one step.
   * @param {number} dt - Delta time in seconds
   * @param {{x: number, y: number}} [input] - Desired movement direction
   */
  update(dt, input = { x: 0, y: 0 }) {
    const status = this.state.currentState;
    const running = status === GAME_STATES.RUNNING;
    const inBreak = status === GAME_STATES.WAVE_COMPLETE;
    if (!running && !inBreak) return;

    this.elapsed += dt;
    this.updatePlayer(dt, input);
    this.updateOrbs(dt);
    this.updateEffects(dt);

    if (inBreak) {
      removeDead(this.orbs);
      // The field is empty during a break, but the Dewling still idles/moves.
      this.animation.update(this);
      this.waveBreakTimer -= dt;
      if (this.waveBreakTimer <= 0) this.state.nextWave();
      return;
    }

    // On non-boss waves, state.update handles countdown. On boss wave, timer pauses until boss is dead.
    if (!isBossWave(this.state.wave)) {
      this.state.update(dt);
    }
    if (this.state.currentState !== GAME_STATES.RUNNING) return;

    /*
     * Before the enemies move, not after. An Afterburner ram or a Singularity
     * pull that resolves after updateEnemies would be overwritten by the
     * enemy's own step on the same frame, so the push would be invisible for
     * one tick and the crush would land on stale positions.
     */
    this.activeSkills.update(dt);
    this.updateSpawning(dt);
    this.updateEnemies(dt);
    this.updateCompositeBosses(dt);
    this.updateSporePools(dt);
    this.updateBossTelegraph(dt);
    this.updateDeathRay(dt);
    this.cards.update(dt);
    this.updateProjectiles(dt);
    this.updateEnemyBullets(dt);

    // Populate Spatial Hash Grid for fast O(n) collision broadphase
    this.spatialGrid.clear();
    for (let i = 0; i < this.enemies.length; i++) {
      if (this.enemies[i].alive) {
        this.spatialGrid.insert(this.enemies[i]);
      }
    }

    this.resolveCollisions();

    // Runs BEFORE the sweep: a boss killed this tick is still in the list with
    // alive === false, which is the only moment its 'death' state can be
    // observed. After the sweep it is gone and the transition is lost.
    this.animation.update(this);

    sweepToPool(this.enemies, this.enemyPool);
    removeDead(this.orbs);
    removeDead(this.sporePools);
    sweepToPool(this.projectiles, this.projectilePool);
    sweepToPool(this.enemyBullets, this.enemyBulletPool);

    // AFTER the sweep, so "the field is empty" is checked against the list the
    // player can actually see. Checking before it would hold the wave open for
    // one extra frame on corpses that are already gone.
    this.checkSwarmCleared();
  }

  /**
   * The "clear the swarm" rule.
   *
   * A wave used to end when its clock hit zero, which cut to the card screen
   * mid-fight with a live swarm still on the field. Now the clock only closes
   * the spawn window (GameState.closeSpawnWindow); the wave is over when the
   * last enemy is dead.
   *
   * Boss waves are exempt: killing the Dreadnought completes the wave outright
   * (see killEnemy), because its escorts are its property and leaving the
   * player to mop them up after the kill is anticlimax, not tension.
   */
  checkSwarmCleared() {
    if (!this.state.spawnWindowClosed) return;
    if (this.state.currentState !== GAME_STATES.RUNNING) return;
    if (isBossWave(this.state.wave)) return;
    if (this.enemies.length > 0) return;

    this.state.completeWave();
  }

  /* ------------------------------------------------------------------ */
  /* Player                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Move the Drifter under inertia.
   *
   * The ship carries velocity rather than being teleported by input: it
   * accelerates toward the input direction while a key is held and coasts on
   * drag when it is not. See PLAYER_CFG for the constants and why they sit
   * where they do.
   *
   * WHAT THIS DOES NOT CHANGE: top speed, and therefore the balance envelope.
   * `speed` is still the GDD figure, velocity still converges on exactly it,
   * and diagonal input is still normalised — so a held direction covers the
   * same ground per second as before, minus a fixed ~13px ramp-up at the start
   * of each burst. Kite distance, spawn ring and contact pressure are untouched.
   *
   * Velocity lives on the Simulation rather than on `state.player` on purpose:
   * player state is serialised into saves, and momentum is a per-frame fact
   * about a run in progress, not something to persist.
   *
   * @param {number} dt
   * @param {{x: number, y: number}} input - Desired direction, unnormalised
   */
  updatePlayer(dt, input) {
    const player = this.state.player;
    const dir = normalize(input.x ?? 0, input.y ?? 0);
    const skills = this.activeSkills;
    // Multiplicative with the card passive rather than replacing it: Afterburner
    // on a Wingman build should be faster than Afterburner without one.
    const speed =
      player.moveSpeed * this.cards.moveSpeedMultiplier * skills.moveSpeedMultiplier * UNIT_PX;
    const thrusting = dir.x !== 0 || dir.y !== 0;

    // Movement INTENT, not displacement: a Dewling pushing into a wall is
    // still visually "moving" even though its clamped position does not change.
    this.playerMoving = thrusting;

    if (thrusting) {
      // Exponential approach — frame-rate independent, and it cannot overshoot
      // the target the way a fixed `v += a * dt` step can at a low frame rate.
      const k = 1 - Math.exp(-PLAYER_CFG.ACCEL * skills.accelMultiplier * dt);
      this.playerVx += (dir.x * speed - this.playerVx) * k;
      this.playerVy += (dir.y * speed - this.playerVy) * k;
      // Facing follows INPUT, not velocity: during a drifting reversal the two
      // point opposite ways, and the ship should already be aimed where the
      // player is steering rather than where its momentum is still carrying it.
      this.facingX = dir.x;
      this.facingY = dir.y;
    } else {
      const decay = Math.pow(PLAYER_CFG.DRAG, dt * 60);
      this.playerVx *= decay;
      this.playerVy *= decay;
      if (Math.hypot(this.playerVx, this.playerVy) < PLAYER_CFG.STOP_EPSILON) {
        this.playerVx = 0;
        this.playerVy = 0;
      }
    }

    const nextX = clamp(
      player.x + this.playerVx * dt,
      PLAYER_CFG.RADIUS,
      WORLD.WIDTH - PLAYER_CFG.RADIUS
    );
    const nextY = clamp(
      player.y + this.playerVy * dt,
      PLAYER_CFG.RADIUS,
      WORLD.HEIGHT - PLAYER_CFG.RADIUS
    );

    // Kill the component that just drove into a wall. Without this, holding
    // into the arena edge banks momentum the player then has to spend turning
    // around, and the ship reads as sticking to the wall and peeling off it.
    if (nextX === player.x && this.playerVx !== 0) this.playerVx = 0;
    if (nextY === player.y && this.playerVy !== 0) this.playerVy = 0;

    player.x = nextX;
    player.y = nextY;

    if (this.invulnTimer > 0) this.invulnTimer -= dt;
  }

  /**
   * The hull's unit heading, held across a full stop.
   *
   * Read by the Singularity Lance (which fires along it) and by the Tactical
   * Wingman (whose V opens behind it). Returns the shared vector rather than a
   * fresh object — this is called every frame by every owned card.
   *
   * @returns {{x: number, y: number}}
   */
  getFacing() {
    FACING.x = this.facingX;
    FACING.y = this.facingY;
    return FACING;
  }

  /**
   * Active Tactical Wingman escort entities.
   * @returns {Array<{id: number, x: number, y: number, vx: number, vy: number, angle: number}>}
   */
  get wingmen() {
    return this.cards?.drones ?? [];
  }

  /**
   * Fire the equipped active skill.
   *
   * The one entry point input has into the skill system, and it is deliberately
   * a thin forward: the guard about WHEN a skill may be cast belongs here (a
   * run must be in progress), the guard about WHETHER it is off cooldown
   * belongs to the system that owns the clock.
   *
   * Safe to call on a held key or a repeated tap — a rejected cast is a no-op
   * that reports why.
   *
   * @returns {{ok: boolean, reason?: string, skillId: string}}
   */
  triggerActiveSkill() {
    if (this.state.currentState !== GAME_STATES.RUNNING) {
      return { ok: false, reason: 'NOT_RUNNING', skillId: this.activeSkills.skillId };
    }
    return this.activeSkills.trigger();
  }

  /**
   * The Point-Defense blades currently in the air, for the renderer.
   * @returns {Array<{x: number, y: number, radius: number}>}
   */
  get skillBlades() {
    return this.activeSkills.blades;
  }

  /**
   * A level-up opens a card draft. Several level-ups can land in one frame
   * (a big orb pickup), so they queue and are offered one at a time.
   */
  onLevelUp() {
    this.pendingLevelUps += 1;
    if (this.state.currentState !== GAME_STATES.LEVEL_UP) this.openDraft();
  }

  /** Offer the next queued draft, or skip it if every card is maxed. */
  openDraft() {
    while (this.pendingLevelUps > 0) {
      const offer = drawDraft(
        this.rng,
        this.state.activeCards,
        this.offerCount ?? DRAFT_CFG.OFFER_COUNT,
        this.state.player.level
      );
      if (offer.length === 0) {
        this.pendingLevelUps -= 1;
        continue;
      }
      this.state.offerDraft(offer);
      return;
    }
  }

  onDraftResolved() {
    this.pendingLevelUps = Math.max(0, this.pendingLevelUps - 1);
    if (this.pendingLevelUps > 0) this.openDraft();
  }

  /* ------------------------------------------------------------------ */
  /* Enemies & Spawning                                                 */
  /* ------------------------------------------------------------------ */

  updateSpawning(dt) {
    // Check boss spawn on boss wave
    if (this.spawner.shouldSpawnBoss()) {
      this.spawnBoss();
    }

    // The clock closed the window: stop asking the spawner for arrivals. The
    // spawner is told rather than merely not called, so anything else holding
    // a reference to it sees the same answer.
    if (this.state.spawnWindowClosed && this.spawner.active) {
      this.spawner.close();
    }

    // Spawn regular enemies up to concurrent cap. WaveSpawner still owns the
    // TIMING (cap, interval, spawn ring) regardless of catalogue — only WHICH
    // species fills each slot changes with the flag.
    const toSpawn = this.spawner.update(dt, this.enemies.length);
    for (let i = 0; i < toSpawn; i++) {
      if (this.useRosterConfig) {
        this.spawnRosterEnemy(this.state.wave);
      } else {
        const enemyDef = this.spawner.pickEnemyType();
        this.spawnEnemy(enemyDef.id);
      }
    }
  }

  /**
   * Clear the arena for a boss.
   *
   * BOSS ARENA ISOLATION, the second half. The spawner refuses to produce new
   * chaff on a boss wave (WaveSpawner.beginWave), and this removes whatever
   * survived the previous wave's tail. The result is the contract the fight is
   * designed around: on a boss wave the only things on the field are the
   * Dreadnought and the escorts it calls itself.
   *
   * Enemies are released rather than killed — no XP orbs, no score, no death
   * particles. They did not die; the encounter simply took the stage.
   */
  clearArenaForBoss() {
    if (this.enemies.length === 0) return;

    let removed = 0;
    for (const enemy of this.enemies) {
      if (enemy.isBoss) continue;
      this.enemyPool.release(enemy);
      removed++;
    }
    const boss = this.enemies.filter((enemy) => enemy.isBoss);
    this.enemies.length = 0;
    for (const enemy of boss) this.enemies.push(enemy);

    this.sporePools.length = 0;
    this.spatialGrid.clear();
    if (removed > 0) this.bus.emit('arena:cleared', { removed });
  }

  /**
   * @param {string} typeId - Key from the enemy data table
   * @param {Object} [options]
   * @param {number} [options.x] - Spawn here instead of on the spawn ring
   * @param {number} [options.y]
   * @returns {Object} The spawned enemy
   */
  spawnEnemy(typeId, options = null) {
    const def = ENEMIES[typeId] || ENEMIES[ENEMY_TYPES.TARLING];
    const wave = this.state.wave;
    const hp = def.baseHp * getEnemyHpMultiplier(wave);
    const pos =
      options && options.x !== undefined
        ? {
          x: clamp(options.x, def.radius, WORLD.WIDTH - def.radius),
          y: clamp(options.y, def.radius, WORLD.HEIGHT - def.radius),
        }
        : this.spawner.spawnPosition(this.state.player.x, this.state.player.y);

    const enemy = this.enemyPool.acquire();
    enemy.id = this.nextEntityId++;
    enemy.typeId = def.id;
    enemy.behavior = def.behavior;
    enemy.isBoss = false;
    enemy.x = pos.x;
    enemy.y = pos.y;
    enemy.radius = def.radius;
    enemy.hp = hp;
    enemy.maxHp = hp;
    enemy.baseSpeed = def.baseSpeed * UNIT_PX * getEnemySpeedMultiplier(wave);
    enemy.speed = enemy.baseSpeed;
    enemy.contactDamage = def.contactDamage;
    enemy.xpValue = def.xpValue;
    enemy.scoreValue = def.scoreValue;
    enemy.hitFlash = 0;
    enemy.orbitCooldown = 0;
    enemy.pdCooldown = 0;
    enemy.rammedTimer = 0;
    enemy.timeAlive = 0;
    enemy.sporeTimer = randomRange(this.rng, 1.0, 3.5);
    enemy.telegraphTimer = 0;
    enemy.vx = 0;
    enemy.vy = 0;
    enemy.alive = true;

    /* ---- Per-species runtime, reset on every acquire ---- */
    enemy.stunTimer = 0;
    enemy.knockVx = 0;
    enemy.knockVy = 0;
    enemy.breaksPierce = Boolean(def.breaksPierce);
    // Charge cycle (Dart Ravager). Staggered on spawn so an incoming pack does
    // not lock on in unison and arrive as one wall.
    enemy.chargeState = CHARGE_STATE.IDLE;
    enemy.chargeTimer = def.chargeInterval
      ? randomRange(this.rng, def.chargeInterval * 0.35, def.chargeInterval)
      : 0;
    enemy.chargeDirX = 0;
    enemy.chargeDirY = 0;
    // Cloak (Phantom Stalker). 1 = fully visible; the renderer reads it.
    enemy.visibility = 1;
    enemy.cloaked = false;

    this.stampAnimationFields(enemy);

    this.enemies.push(enemy);
    return enemy;
  }

  /**
   * Spawn an enemy from the roster config.
   *
   * The parametric twin of spawnEnemy: same pool, same wave scaling, same
   * animation stamp, but every number comes out of ENEMY_ARCHETYPES and the
   * behaviour runs on src/core/enemy-system.js instead of on the switch in
   * updateEnemies. A designer adding a species touches the config and nothing
   * else.
   *
   * @param {string} archetypeId - Key from ENEMY_ARCHETYPES
   * @param {Object} [options]
   * @param {number} [options.x] - Spawn here instead of on the spawn ring
   * @param {number} [options.y]
   * @returns {Object} The spawned enemy
   */
  spawnArchetype(archetypeId, options = null) {
    const wave = this.state.wave;
    const pos =
      options && options.x !== undefined
        ? { x: options.x, y: options.y }
        : this.spawner.spawnPosition(this.state.player.x, this.state.player.y);

    const enemy = this.enemyPool.acquire();
    applyArchetype(enemy, archetypeId, {
      hpScale: getEnemyHpMultiplier(wave),
      speedScale: getEnemySpeedMultiplier(wave),
      rng: this.rng,
    });

    enemy.id = this.nextEntityId++;
    enemy.isBoss = false;
    enemy.x = clamp(pos.x, enemy.radius, WORLD.WIDTH - enemy.radius);
    enemy.y = clamp(pos.y, enemy.radius, WORLD.HEIGHT - enemy.radius);
    enemy.vx = 0;
    enemy.vy = 0;
    enemy.hitFlash = 0;
    enemy.orbitCooldown = 0;
    enemy.pdCooldown = 0;
    enemy.rammedTimer = 0;
    enemy.stunTimer = 0;
    enemy.knockVx = 0;
    enemy.knockVy = 0;
    enemy.breaksPierce = false;
    enemy.visibility = 1;
    enemy.cloaked = false;

    this.stampAnimationFields(enemy);
    this.enemies.push(enemy);
    return enemy;
  }

  /**
   * Weighted spawn from the roster config's unlock table.
   *
   * @param {number} [wave]
   * @returns {Object|null} The spawned enemy, or null if nothing is unlocked
   */
  spawnRosterEnemy(wave = this.state.wave) {
    const archetype = pickArchetypeForWave(wave, this.rng);
    if (!archetype) return null;
    return this.spawnArchetype(archetype.id);
  }

  /**
   * Reset the Tier B procedural-animation fields on a pooled entity.
   *
   * phaseOffset is the one that matters: without it every member of a swarm
   * flutters on the same sine phase and 150 Ashfish pulse in lockstep, which
   * reads as one organism rather than many. It is drawn from the seeded run RNG
   * so replays stay deterministic, and it is re-drawn on every acquire — a
   * recycled entity inheriting its predecessor's phase would slowly cluster the
   * swarm back into unison as the pool churns.
   *
   * @param {Object} entity - A pooled entity being brought to life
   */
  stampAnimationFields(entity) {
    entity.phaseOffset = this.rng() * Math.PI * 2;
    entity.spawnTime = this.elapsed;
    entity.lastHitTime = -Infinity;
    entity.deathTime = -Infinity;
  }

  /**
   * Spawn the Dreadnought Station on a boss wave.
   */
  spawnBoss() {
    if (this.useCompositeBosses) return this.spawnCompositeBoss();

    const def = ENEMIES[ENEMY_TYPES.RUSTWHALE];
    const wave = this.state.wave;
    const hp = getBossHp(wave);
    const pos = this.spawner.spawnPosition(this.state.player.x, this.state.player.y);

    const boss = this.enemyPool.acquire();
    boss.id = this.nextEntityId++;
    boss.typeId = def.id;
    boss.behavior = def.behavior;
    boss.isBoss = true;
    boss.x = pos.x;
    boss.y = pos.y;
    boss.radius = def.radius;
    boss.hp = hp;
    boss.maxHp = hp;
    boss.baseSpeed = def.baseSpeed * UNIT_PX;
    boss.speed = boss.baseSpeed;
    boss.contactDamage = def.contactDamage;
    boss.xpValue = def.xpValue;
    boss.scoreValue = def.scoreValue;
    boss.hitFlash = 0;
    boss.orbitCooldown = 0;
    boss.pdCooldown = 0;
    boss.rammedTimer = 0;
    boss.timeAlive = 0;
    boss.sporeTimer = 0;
    boss.telegraphTimer = 2.0;
    boss.vx = 0;
    boss.vy = 0;
    boss.alive = true;
    boss.stunTimer = 0;
    boss.knockVx = 0;
    boss.knockVy = 0;
    boss.breaksPierce = false;
    boss.chargeState = CHARGE_STATE.IDLE;
    boss.chargeTimer = 0;
    boss.chargeDirX = 0;
    boss.chargeDirY = 0;
    boss.visibility = 1;
    boss.cloaked = false;
    /*
     * The three attack clocks, offset from each other on purpose.
     *
     * The ring goes out first (short fuse), the escort call lands next, and the
     * ray last. Starting them all at zero would open the fight with every
     * pattern firing at once — the player would never get to learn any of them
     * separately, which is the whole point of a phased boss.
     */
    boss.radialTimer = 1.6;
    boss.escortTimer = def.escortInterval * 0.6;
    boss.rayTimer = def.rayInterval * 0.75;
    boss.phase = 1;
    boss.radialCountExecuted = 0;
    boss.escortCountExecuted = 0;
    boss.rayCountExecuted = 0;

    this.stampAnimationFields(boss);

    this.enemies.push(boss);
    this.bus.emit('boss:spawned', { wave, hp, id: boss.id, phase: 1 });
    return boss;
  }

  /* ------------------------------------------------------------------ */
  /* Composite bosses                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Put a modular boss on the field.
   *
   * Lives in `compositeBosses`, not in `enemies`: it is not one circle with one
   * HP bar, and forcing it through the enemy pool would mean teaching the pool,
   * the spatial grid and the contact check about parts. It resolves its own
   * hits instead — see CompositeBoss.damageAt.
   *
   * @param {string} [templateId] - Key from COMPOSITE_BOSSES. Defaults to the
   *   template this wave's tier calls for.
   * @param {Object} [options]
   * @param {number} [options.x]
   * @param {number} [options.y]
   * @param {number} [options.hpScale] - Defaults to the wave's HP multiplier
   * @returns {CompositeBoss|null}
   */
  spawnCompositeBoss(templateId = null, options = {}) {
    const wave = this.state.wave;
    const template = templateId ?? pickBossTemplate(wave)?.id ?? null;
    if (!template) return null;

    const pos =
      options.x !== undefined
        ? { x: options.x, y: options.y }
        : this.spawner.spawnPosition(this.state.player.x, this.state.player.y);

    const boss = new CompositeBoss(template, {
      x: clamp(pos.x, 0, WORLD.WIDTH),
      y: clamp(pos.y, 0, WORLD.HEIGHT),
      hpScale: options.hpScale ?? getEnemyHpMultiplier(wave),
      id: this.nextEntityId++,
      rng: this.rng,
    });

    this.compositeBosses.push(boss);
    this.bus.emit('boss:spawned', {
      wave,
      id: boss.id,
      hp: boss.totalHp,
      templateId: boss.templateId,
      composite: true,
      phase: boss.phaseNumber,
    });
    return boss;
  }

  /**
   * Whichever boss is currently up, in one shape the HUD can read without
   * caring which system spawned it.
   *
   * The legacy Dreadnought lives in `this.enemies` with its HP directly on the
   * entity; a CompositeBoss lives in `this.compositeBosses` with its HP spread
   * across a chassis and several parts. A HUD health bar needs neither of
   * those shapes — it needs a name, a phase number, and a current/max HP — so
   * that normalisation happens here, once, instead of in the UI layer.
   *
   * @returns {{name: string, phase: number, hp: number, maxHp: number}|null}
   */
  getActiveBossView() {
    const legacy = this.enemies.find((e) => e.alive && e.isBoss);
    if (legacy) {
      const def = ENEMIES[legacy.typeId];
      return { name: def?.name ?? 'Dreadnought Station', phase: legacy.phase, hp: legacy.hp, maxHp: legacy.maxHp };
    }

    const composite = this.compositeBosses.find((b) => b.alive);
    if (composite) {
      return {
        name: composite.template.name,
        phase: composite.phaseNumber,
        hp: composite.totalHp,
        maxHp: composite.totalMaxHp,
      };
    }

    return null;
  }

  /**
   * Every live modular boss's aimable proxies, flattened.
   *
   * Empty when there is no composite boss on the field, which is the common
   * case for most of the game — kept as a cheap early-out rather than
   * allocating an empty array every call.
   *
   * @returns {Array<Object>}
   */
  getCompositeTargets() {
    if (this.compositeBosses.length === 0) return EMPTY_ARRAY;
    const targets = [];
    for (const boss of this.compositeBosses) {
      if (!boss.alive) continue;
      for (const proxy of boss.getTargetProxies()) targets.push(proxy);
    }
    return targets;
  }

  /**
   * Re-acquire a specific live target by id — legacy enemy or composite proxy
   * alike. Used by steerMissile so a Nanite missile keeps tracking the SAME
   * turret across frames instead of re-rolling findHighestHpEnemy on every one.
   *
   * @param {number|string} id
   * @returns {Object|null}
   */
  findTargetById(id) {
    for (let i = 0; i < this.enemies.length; i++) {
      const enemy = this.enemies[i];
      if (enemy.alive && enemy.id === id) return enemy;
    }
    for (const boss of this.compositeBosses) {
      if (!boss.alive) continue;
      for (const proxy of boss.getTargetProxies()) {
        if (proxy.id === id) return proxy;
      }
    }
    return null;
  }

  /**
   * Tick every modular boss, then collect the wrecks.
   *
   * Contact damage is checked here rather than in resolveCollisions because a
   * composite boss is several colliders: the hull AND every part that still
   * stands. Routing that through the spatial grid would mean inserting parts
   * into it as if they were enemies, and then every projectile query, every
   * targeting card and every kill count would have to learn to ignore them.
   *
   * @param {number} dt
   */
  updateCompositeBosses(dt) {
    if (this.compositeBosses.length === 0) return;
    const player = this.state.player;
    const ctx = this.behaviorCtx;
    ctx.target = player;

    for (const boss of this.compositeBosses) {
      if (!boss.alive) continue;
      boss.update(dt, ctx);

      if (this.invulnTimer > 0) continue;
      const hit = boss.hitTest(player.x, player.y, PLAYER_CFG.RADIUS);
      if (hit) this.damagePlayer(boss.contactDamage);
    }

    for (let i = this.compositeBosses.length - 1; i >= 0; i--) {
      const boss = this.compositeBosses[i];
      if (boss.alive) continue;
      this.onCompositeBossDown(boss);
      this.compositeBosses.splice(i, 1);
    }
  }

  /**
   * Pay out a dead modular boss and end the wave.
   *
   * Parts the player wrecked have already paid their own score through
   * onCompositeBossPartDown; this is the chassis bounty on top, which is why
   * clearing the modules first is worth doing rather than merely necessary.
   *
   * @param {CompositeBoss} boss
   */
  onCompositeBossDown(boss) {
    this.state.registerKill(boss.scoreValue);
    this.spawnOrb(boss.x, boss.y, boss.xpValue);
    if (isBossWave(this.state.wave)) this.state.completeWave();
  }

  /**
   * Score and XP for a wrecked module.
   * @param {CompositeBoss} boss
   * @param {Object} part
   */
  onCompositeBossPartDown(boss, part) {
    this.state.registerKill(part.scoreValue ?? 0);
    this.spawnOrb(part.worldX, part.worldY, Math.round((part.scoreValue ?? 0) / 4));
  }

  /**
   * Advance every enemy: per-species behaviour, then one shared integration.
   *
   * SHAPE OF THIS LOOP. Each branch decides a HEADING and may scale `speed`;
   * a single step at the bottom turns that into velocity, adds the hit kick,
   * and integrates. Branches that moved entities directly would each have to
   * remember to write `vx`/`vy` for the renderer's facing transform, and one
   * that forgot would leave its species pointing flatly at the Drifter.
   *
   * @param {number} dt
   */
  updateEnemies(dt) {
    const player = this.state.player;
    // Computed once per frame, not per enemy: it is the same number for all of
    // them and this loop runs up to 200 times.
    const frenzyFloor = this.getFrenzyFloor();

    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;

      /**
       * Archetype-driven enemies keep their own clock inside stepEnemy, so the
       * legacy roster's tick is skipped for them. Advancing it in both places
       * would run a Mantis Strider's weave at double rate — the kind of bug
       * that looks like a tuning problem and is not.
       */
      if (!enemy.archetypeId) enemy.timeAlive += dt;
      if (enemy.hitFlash > 0) enemy.hitFlash -= dt;
      if (enemy.orbitCooldown > 0) enemy.orbitCooldown -= dt;
      if (enemy.pdCooldown > 0) enemy.pdCooldown -= dt;
      if (enemy.rammedTimer > 0) enemy.rammedTimer -= dt;

      // Kinetic recoil from being shot, decaying toward zero. Applied to every
      // species and outside the stun check: a frozen enemy still gets shoved.
      const kick = Math.pow(HIT_KICK_DECAY, dt * 60);
      enemy.knockVx *= kick;
      enemy.knockVy *= kick;
      if (Math.abs(enemy.knockVx) < 1) enemy.knockVx = 0;
      if (Math.abs(enemy.knockVy) < 1) enemy.knockVy = 0;

      const dir = normalize(player.x - enemy.x, player.y - enemy.y);
      const perpX = -dir.y;
      const perpY = dir.x;

      let headingX = dir.x;
      let headingY = dir.y;
      let speed = enemy.baseSpeed;

      /*
       * A stunned enemy holds its heading but contributes no speed of its own.
       * It still slides on whatever knockback is on it, which is what makes
       * the Graviton EMP read as a shove-and-freeze rather than two effects.
       */
      if (enemy.stunTimer > 0) {
        enemy.stunTimer -= dt;
        speed = 0;
      } else if (enemy.archetypeId) {
        /*
         * ROSTER-CONFIG PATH. Everything about how this enemy moves lives in
         * src/data/roster-config.js and is executed by the state machines in
         * src/core/enemy-system.js. The switch below is the pre-migration
         * roster; a species moves from there to here by gaining a row in the
         * config, and nothing in this file changes when it does.
         */
        const ctx = this.behaviorCtx;
        ctx.target = player;
        const step = stepEnemy(enemy, ctx, dt);
        headingX = step.headingX;
        headingY = step.headingY;
        speed = step.speed;
      } else {
        switch (enemy.behavior) {
          case ENEMY_BEHAVIORS.SINE_WAVE: {
            // Mantis Strider — weaves across the approach vector, so it comes
            // in from the flank instead of down the same line as everything
            // else. The weave is on the PERPENDICULAR, so it still closes.
            const def = ENEMIES[enemy.typeId];
            const weave =
              Math.sin(enemy.timeAlive * (def?.weaveRate ?? 4.2) + enemy.phaseOffset) *
              (def?.weaveAmount ?? 0.55);
            headingX = dir.x + perpX * weave;
            headingY = dir.y + perpY * weave;
            break;
          }

          case ENEMY_BEHAVIORS.LOCK_ON_CHARGE: {
            speed = this.updateChargeCycle(enemy, dt, dir);
            if (enemy.chargeState === CHARGE_STATE.DASHING) {
              // The dash is committed: it flies the direction it locked, not
              // the direction the Drifter has since moved. That commitment is
              // what makes the wind-up worth reading.
              headingX = enemy.chargeDirX;
              headingY = enemy.chargeDirY;
            } else if (enemy.chargeState === CHARGE_STATE.WINDUP) {
              // Braces in place while the warning shows.
              headingX = 0;
              headingY = 0;
            }
            break;
          }

          case ENEMY_BEHAVIORS.BROOD_SPORE: {
            // Slow drift, leaving acid behind it. The burst is on death — see
            // killEnemy.
            const def = ENEMIES[enemy.typeId];
            enemy.sporeTimer -= dt;
            if (enemy.sporeTimer <= 0) {
              enemy.sporeTimer = def?.sporeInterval ?? 3.5;
              this.spawnSporePool(enemy.x, enemy.y);
            }
            break;
          }

          case ENEMY_BEHAVIORS.CLOAK_STALK: {
            speed = this.updateCloak(enemy, player);
            break;
          }

          case ENEMY_BEHAVIORS.ARMORED_GUARD: {
            // Bio-Goliath. Deliberately the dullest movement on the roster:
            // it walks in a straight line at half everyone else's pace,
            // because its job is to BE somewhere, not to get somewhere.
            break;
          }

          case ENEMY_BEHAVIORS.BOSS_STATION: {
            this.updateBossAttacks(enemy, dt, player);
            break;
          }

          case ENEMY_BEHAVIORS.DIRECT:
          default: {
            // Xeno Larva — straight in.
            break;
          }
        }
      }

      /*
       * Clear-out enrage multiplier.
       * Capped at max 1.05x - 1.1x (FRENZY_CFG.MAX_ENRAGE_MULTIPLIER = 1.08) so enemies
       * do not aggressively outrun or trap the player unfairly.
       */
      if (frenzyFloor > 1 && speed > 0 && !enemy.isBoss) {
        speed = speed * frenzyFloor;
      }

      enemy.speed = speed;
      enemy.vx = headingX * speed + enemy.knockVx;
      enemy.vy = headingY * speed + enemy.knockVy;
      enemy.x += enemy.vx * dt;
      enemy.y += enemy.vy * dt;

      // Clamp within world boundaries
      enemy.x = clamp(enemy.x, enemy.radius, WORLD.WIDTH - enemy.radius);
      enemy.y = clamp(enemy.y, enemy.radius, WORLD.HEIGHT - enemy.radius);
    }
  }

  /**
   * Minimum speed every survivor travels at during the clear-out tail, in px/s.
   *
   * Zero while the spawn window is open — during the wave proper the roster's
   * speed spread IS the roster, and flattening it would erase the difference
   * between chaff and a cruiser. It only comes up once nothing new is arriving,
   * which is exactly when a species being outrunnable stops being flavour and
   * starts being a softlock. See FRENZY_CFG.
   *
   * Ramped rather than switched on, so the moment the window closes reads as
   * the swarm turning toward the player rather than as a teleport.
   *
   * @returns {number} px/s, or 0 when no frenzy applies
   */
  getFrenzyFloor() {
    if (!this.state.spawnWindowClosed) return 0;
    if (isBossWave(this.state.wave)) return 0;

    const since = this.elapsed - this.frenzyStart;
    const ramp = clamp(since / FRENZY_CFG.RAMP_SEC, 0, 1);
    return 1 + (FRENZY_CFG.MAX_ENRAGE_MULTIPLIER - 1) * ramp;
  }

  /**
   * Dart Ravager's three-beat charge cycle: drift -> lock -> dash.
   *
   * The lock is the contract. `chargeWindup` seconds of the enemy sitting
   * still with `chargeState === WINDUP` is what the renderer paints the red
   * warning from, and it is exactly the window the player has to step out of
   * the line. Without it a 2x-speed striker is an unavoidable hit.
   *
   * @param {Object} enemy
   * @param {number} dt
   * @param {{x: number, y: number}} dir - Unit vector toward the Drifter
   * @returns {number} Speed to travel at this tick
   */
  updateChargeCycle(enemy, dt, dir) {
    const def = ENEMIES[enemy.typeId];
    enemy.chargeTimer -= dt;

    switch (enemy.chargeState) {
      case CHARGE_STATE.WINDUP:
        if (enemy.chargeTimer <= 0) {
          enemy.chargeState = CHARGE_STATE.DASHING;
          enemy.chargeTimer = def?.chargeDuration ?? 0.8;
        }
        return 0;

      case CHARGE_STATE.DASHING:
        if (enemy.chargeTimer <= 0) {
          enemy.chargeState = CHARGE_STATE.IDLE;
          enemy.chargeTimer = def?.chargeInterval ?? 3.4;
          return enemy.baseSpeed;
        }
        return enemy.baseSpeed * (def?.chargeSpeedMultiplier ?? 2);

      default:
        if (enemy.chargeTimer <= 0) {
          enemy.chargeState = CHARGE_STATE.WINDUP;
          enemy.chargeTimer = def?.chargeWindup ?? 0.55;
          // The lock is taken HERE, at the start of the wind-up, so the line
          // the warning draws is the line the dash will actually fly.
          enemy.chargeDirX = dir.x;
          enemy.chargeDirY = dir.y;
          this.bus.emit('enemy:lock_on', { id: enemy.id, x: enemy.x, y: enemy.y });
          // Brace on the SAME frame the lock is taken. Returning baseSpeed here
          // would let it drift for one frame after the warning appeared, which
          // is a frame of the telegraph lying about where the dash starts from.
          return 0;
        }
        return enemy.baseSpeed;
    }
  }

  /**
   * Phantom Stalker's camouflage.
   *
   * Faster while dark, and it MUST surface before it can reach you: the
   * decloak range is well outside contact range, so the reveal is a warning
   * rather than a hit arriving with its own announcement. `visibility` is a
   * plain number the renderer turns into alpha — the simulation has no opinion
   * about how invisible looks.
   *
   * @param {Object} enemy
   * @param {Object} player
   * @returns {number} Speed to travel at this tick
   */
  updateCloak(enemy, player) {
    const def = ENEMIES[enemy.typeId];
    const range = def?.decloakRange ?? 190;
    const near = distanceSq(player.x, player.y, enemy.x, enemy.y) <= range * range;

    if (near) {
      if (enemy.cloaked) this.bus.emit('enemy:decloak', { id: enemy.id, x: enemy.x, y: enemy.y });
      enemy.cloaked = false;
      enemy.visibility = 1;
      return enemy.baseSpeed;
    }

    enemy.cloaked = true;
    enemy.visibility = def?.cloakAlpha ?? 0.2;
    return enemy.baseSpeed * (def?.cloakSpeedMultiplier ?? 1.45);
  }

  /* ------------------------------------------------------------------ */
  /* The Dreadnought Station                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Run the station's attack clocks for one tick.
   *
   * PHASES ACCUMULATE, THEY DO NOT SWAP. At full health it only sprays rings;
   * under 75% it also calls escorts; under 45% it also sweeps the ray. A boss
   * that trades one attack for another gets EASIER as it dies, which is the
   * wrong shape for the wall at the end of a wave — each threshold has to add
   * pressure, not move it.
   *
   * @param {Object} boss
   * @param {number} dt
   * @param {Object} player
   */
  updateBossAttacks(boss, dt, player) {
    const def = ENEMIES[ENEMY_TYPES.RUSTWHALE];
    const hpFrac = boss.maxHp > 0 ? boss.hp / boss.maxHp : 1;

    const phase = getBossPhase(hpFrac);

    if (phase.phase !== boss.phase) {
      boss.phase = phase.phase;
      this.bus.emit('boss:phase', { id: boss.id, phase: phase.phase, hp: boss.hp });
    }

    /* ---- Phase 1: radial bullet ring ---- */
    boss.radialTimer -= dt;
    if (boss.radialTimer <= 0) {
      boss.radialTimer = def.radialInterval;
      this.fireRadialRing(boss, def);
      boss.radialCountExecuted++;
    }

    /* ---- Phase 2: escort call ---- */
    if (boss.phase >= 2) {
      boss.escortTimer -= dt;
      if (boss.escortTimer <= 0) {
        boss.escortTimer = def.escortInterval;
        this.callEscorts(boss, def);
        boss.escortCountExecuted++;
      }
    }

    /* ---- Phase 3: sweeping death ray ---- */
    if (boss.phase >= 3) {
      boss.rayTimer -= dt;
      if (boss.rayTimer <= 0 && !this.deathRay.active) {
        boss.rayTimer = def.rayInterval;
        this.beginDeathRay(boss, def, player);
        boss.rayCountExecuted++;
      }
    }

    /* ---- The legacy Bio-Acid Bloom, still on its own clock ---- */
    boss.telegraphTimer -= dt;
    if (boss.telegraphTimer <= 0 && !this.bossTelegraph.active) {
      boss.telegraphTimer = def.telegraphCooldown;
      this.triggerBossTelegraph(player.x, player.y);
    }
  }

  /**
   * A ring of bullets thrown out from the turrets in every direction.
   *
   * Evenly spaced and rotated by a random offset each time, so consecutive
   * rings never leave the same gap twice — a fixed offset teaches the player
   * one safe angle and then stops being an attack.
   *
   * @param {Object} boss
   * @param {Object} def
   */
  fireRadialRing(boss, def) {
    const count = def.radialCount;
    const offset = this.rng() * Math.PI * 2;

    for (let i = 0; i < count; i++) {
      const angle = offset + (i / count) * Math.PI * 2;
      this.spawnEnemyBullet({
        x: boss.x + Math.cos(angle) * boss.radius * 0.7,
        y: boss.y + Math.sin(angle) * boss.radius * 0.7,
        vx: Math.cos(angle) * def.radialSpeed,
        vy: Math.sin(angle) * def.radialSpeed,
        damage: def.radialDamage,
      });
    }

    this.bus.emit('boss:radial', { id: boss.id, x: boss.x, y: boss.y, count });
  }

  /**
   * Phase 2 — four Dart Ravagers thrown out of the reactor.
   *
   * They spawn ON the boss and are spread around it rather than arriving from
   * the spawn ring, because the whole read is "the station launched these".
   *
   * @param {Object} boss
   * @param {Object} def
   */
  callEscorts(boss, def) {
    for (let i = 0; i < def.escortCount; i++) {
      const angle = (i / def.escortCount) * Math.PI * 2 + this.rng() * 0.4;
      this.spawnEnemy(def.escortType, {
        x: boss.x + Math.cos(angle) * def.escortSpread,
        y: boss.y + Math.sin(angle) * def.escortSpread,
      });
    }
    this.bus.emit('boss:escorts', { id: boss.id, x: boss.x, y: boss.y, count: def.escortCount });
  }

  /**
   * Phase 3 — start the death ray's warning cone.
   *
   * The cone is drawn at the angle the beam will START from, and the beam then
   * tracks at `rayTurnRate`. The rate is the fairness knob: it is well under
   * the Drifter's angular speed at any sane radius, so a player who keeps
   * moving laterally always outruns it, and a player who stands still does not.
   *
   * @param {Object} boss
   * @param {Object} def
   * @param {Object} player
   */
  beginDeathRay(boss, def, player) {
    const ray = this.deathRay;
    ray.active = true;
    ray.firing = false;
    ray.x = boss.x;
    ray.y = boss.y;
    ray.angle = Math.atan2(player.y - boss.y, player.x - boss.x);
    ray.elapsed = 0;
    ray.telegraphSec = def.rayTelegraphSec;
    ray.sweepSec = def.raySweepSec;
    ray.length = def.rayLength;
    ray.halfWidth = def.rayHalfWidth;
    ray.damagePerSec = def.rayDamagePerSec;
    ray.turnRate = def.rayTurnRate;
    ray.bossId = boss.id;

    this.bus.emit('boss:ray_telegraph', {
      id: boss.id,
      x: ray.x,
      y: ray.y,
      angle: ray.angle,
      durationMs: def.rayTelegraphSec * 1000,
    });
  }

  /**
   * Advance the death ray: warning cone, then a tracking beam.
   *
   * Damage is dealt per second while the Drifter is inside the strip, and it
   * bypasses invulnerability frames on purpose — i-frames exist to stop a
   * contact hit from being applied sixty times a second, and a beam that ticks
   * once every 0.7s would be a beam you can stand in.
   *
   * @param {number} dt
   */
  updateDeathRay(dt) {
    const ray = this.deathRay;
    if (!ray.active) return;

    // The beam is welded to the station: if the boss dies mid-sweep it stops.
    const boss = this.enemies.find((e) => e.id === ray.bossId && e.alive);
    if (!boss) {
      ray.active = false;
      ray.firing = false;
      return;
    }
    ray.x = boss.x;
    ray.y = boss.y;

    ray.elapsed += dt;

    if (!ray.firing) {
      if (ray.elapsed < ray.telegraphSec) return;
      ray.firing = true;
      ray.elapsed = 0;
      this.bus.emit('boss:ray_fire', { id: boss.id, x: ray.x, y: ray.y, angle: ray.angle });
      return;
    }

    if (ray.elapsed >= ray.sweepSec) {
      ray.active = false;
      ray.firing = false;
      this.bus.emit('boss:ray_end', { id: boss.id });
      return;
    }

    // Track the Drifter along the short arc, capped at turnRate.
    const player = this.state.player;
    const want = Math.atan2(player.y - ray.y, player.x - ray.x);
    let delta = (want - ray.angle) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    const step = ray.turnRate * dt;
    ray.angle += clamp(delta, -step, step);

    if (this.pointInRay(player.x, player.y, PLAYER_CFG.RADIUS)) {
      this.state.damagePlayer(ray.damagePerSec * dt);
      this.bus.emit('boss:ray_hit', { x: player.x, y: player.y });
    }
  }

  /**
   * Is a circle inside the death ray's strip?
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @returns {boolean}
   */
  pointInRay(x, y, radius = 0) {
    const ray = this.deathRay;
    if (!ray.active || !ray.firing) return false;

    const relX = x - ray.x;
    const relY = y - ray.y;
    const dx = Math.cos(ray.angle);
    const dy = Math.sin(ray.angle);

    const along = relX * dx + relY * dy;
    if (along < 0 || along > ray.length) return false;

    const perp = Math.abs(relX * dy - relY * dx);
    return perp <= ray.halfWidth + radius;
  }

  /* ------------------------------------------------------------------ */
  /* Hostile ordnance                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * @param {Object} spec - x, y, vx, vy, damage
   * @returns {Object}
   */
  spawnEnemyBullet(spec) {
    const b = this.enemyBulletPool.acquire();
    b.id = this.nextEntityId++;
    b.x = spec.x;
    b.y = spec.y;
    b.vx = spec.vx;
    b.vy = spec.vy;
    b.damage = spec.damage;
    b.radius = spec.radius ?? ENEMY_BULLET_CFG.RADIUS;
    b.life = spec.life ?? ENEMY_BULLET_CFG.LIFETIME_SEC;
    b.alive = true;
    this.enemyBullets.push(b);
    return b;
  }

  /**
   * Fly the boss's bullets and check them against the Drifter.
   *
   * Checked here rather than in resolveCollisions because these are the only
   * things in the game that hit the PLAYER by projectile, and running them
   * through the enemy-indexed spatial grid would mean indexing the player.
   *
   * @param {number} dt
   */
  updateEnemyBullets(dt) {
    const player = this.state.player;

    for (const b of this.enemyBullets) {
      if (!b.alive) continue;

      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;

      if (b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD.WIDTH || b.y > WORLD.HEIGHT) {
        b.alive = false;
        continue;
      }

      if (this.invulnTimer > 0) continue;
      const reach = b.radius + PLAYER_CFG.RADIUS;
      if (distanceSq(player.x, player.y, b.x, b.y) > reach * reach) continue;

      b.alive = false;
      this.damagePlayer(b.damage);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Spore Hazards & Boss Telegraph                                      */
  /* ------------------------------------------------------------------ */

  spawnSporePool(x, y) {
    this.sporePools.push({
      id: this.nextEntityId++,
      x,
      y,
      radius: 35,
      life: 4.0,
      maxLife: 4.0,
      damagePerSec: 6,
      alive: true,
    });
  }

  updateSporePools(dt) {
    const player = this.state.player;

    for (const pool of this.sporePools) {
      if (!pool.alive) continue;
      pool.life -= dt;
      if (pool.life <= 0) {
        pool.alive = false;
        continue;
      }

      // Check contact with Dewling
      const hitRadius = pool.radius + PLAYER_CFG.RADIUS;
      if (distanceSq(player.x, player.y, pool.x, pool.y) <= hitRadius * hitRadius) {
        if (this.invulnTimer <= 0) {
          this.damagePlayer(pool.damagePerSec * dt);
        }
      }
    }
  }

  triggerBossTelegraph(targetX, targetY) {
    const player = this.state.player;
    const playerSpeedPx = player.moveSpeed * UNIT_PX;
    const radius = ENEMIES[ENEMY_TYPES.RUSTWHALE].telegraphRadius;
    const durationMs = calculateTelegraphMs(radius, playerSpeedPx, 300);

    this.bossTelegraph.active = true;
    this.bossTelegraph.x = targetX;
    this.bossTelegraph.y = targetY;
    this.bossTelegraph.radius = radius;
    this.bossTelegraph.damage = ENEMIES[ENEMY_TYPES.RUSTWHALE].telegraphDamage;
    this.bossTelegraph.elapsedMs = 0;
    this.bossTelegraph.totalMs = durationMs;

    this.bus.emit('boss:telegraph_start', {
      x: targetX,
      y: targetY,
      radius,
      durationMs,
    });
  }

  updateBossTelegraph(dt) {
    if (!this.bossTelegraph.active) return;

    this.bossTelegraph.elapsedMs += dt * 1000;
    if (this.bossTelegraph.elapsedMs >= this.bossTelegraph.totalMs) {
      this.eruptBossTelegraph();
    }
  }

  eruptBossTelegraph() {
    const { x, y, radius, damage } = this.bossTelegraph;
    this.bossTelegraph.active = false;

    // Visual wave shockwave
    this.spawnEffect(x, y, radius, 'tide');

    this.bus.emit('boss:telegraph_erupt', { x, y, radius, damage });

    // Check hit on player
    const player = this.state.player;
    const hitRadius = radius + PLAYER_CFG.RADIUS;
    if (distanceSq(player.x, player.y, x, y) <= hitRadius * hitRadius) {
      this.damagePlayer(damage);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Card-spawned entities                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Take a projectile from the pool and add it to the live list.
   * @param {Object} spec - x, y, vx, vy, damage, radius, life
   * @returns {Object}
   */
  spawnProjectile(spec) {
    const p = this.projectilePool.acquire();
    p.id = this.nextEntityId++;
    p.x = spec.x;
    p.y = spec.y;
    p.vx = spec.vx;
    p.vy = spec.vy;
    p.damage = spec.damage;
    p.radius = spec.radius;
    p.life = spec.life;
    p.alive = true;
    p.kind = spec.kind ?? PROJECTILE_KINDS.BOLT;
    /** Extra enemies this may pass through. A Bio-Goliath zeroes it. */
    p.pierce = spec.pierce ?? 0;
    /**
     * Last enemy hit. A pierced bolt must not re-damage the same enemy on the
     * next frame while it is still overlapping it — one id is enough, because
     * a bolt travelling at 480+ px/s never returns to a target it has left.
     */
    p.lastHitId = 0;
    p.targetId = spec.targetId ?? 0;
    p.turnRate = spec.turnRate ?? 0;
    this.projectiles.push(p);
    return p;
  }

  /**
   * Queue a short-lived ring for the renderer.
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {string} kind - 'pulse' | 'tide'
   */
  spawnEffect(x, y, radius, kind) {
    const fx = this.effectPool.acquire();
    fx.x = x;
    fx.y = y;
    fx.radius = radius;
    fx.kind = kind;
    fx.life = CARD_MODEL.AOE_EFFECT_SEC;
    fx.maxLife = CARD_MODEL.AOE_EFFECT_SEC;
    fx.alive = true;
    this.effects.push(fx);
    return fx;
  }

  /**
   * Hand a card system's blades back to the pool.
   * @param {Array<Object>} blades
   */
  releaseBlades(blades) {
    for (const blade of blades) this.bladePool.release(blade);
  }

  updateEffects(dt) {
    for (const fx of this.effects) {
      fx.life -= dt;
      if (fx.life <= 0) fx.alive = false;
    }
    sweepToPool(this.effects, this.effectPool);
  }

  updateProjectiles(dt) {
    for (const p of this.projectiles) {
      if (p.turnRate > 0) this.steerMissile(p, dt);

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;

      const outOfBounds = p.x < 0 || p.y < 0 || p.x > WORLD.WIDTH || p.y > WORLD.HEIGHT;
      if (p.life <= 0 || outOfBounds) p.alive = false;
    }
  }

  /**
   * Turn a Nanite missile toward its target, at a capped rate.
   *
   * Speed is preserved through the turn — only the heading rotates — so a
   * missile that has to come all the way round takes longer to arrive rather
   * than arriving slower. If its target dies mid-flight it re-acquires the
   * next-biggest thing; failing that it flies on straight and expires, which
   * is a better read than a missile stopping in mid-air.
   *
   * @param {Object} p
   * @param {number} dt
   */
  steerMissile(p, dt) {
    // Re-acquires by id first, so a missile keeps tracking the SAME turret it
    // launched at rather than re-rolling a target every frame — legacy enemy
    // or composite boss proxy alike.
    let target = p.targetId ? this.findTargetById(p.targetId) : null;
    if (!target) {
      target = this.findHighestHpEnemy(PROJECTILE_CFG.TARGET_RANGE);
      if (!target) return;
      p.targetId = target.id;
    }

    const speed = Math.hypot(p.vx, p.vy);
    if (speed <= 0) return;

    const current = Math.atan2(p.vy, p.vx);
    const want = Math.atan2(target.y - p.y, target.x - p.x);
    let delta = (want - current) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;

    const step = p.turnRate * dt;
    const angle = current + clamp(delta, -step, step);
    p.vx = Math.cos(angle) * speed;
    p.vy = Math.sin(angle) * speed;
  }

  /**
   * Nearest living enemy within range, used by targeting cards.
   * @param {number} maxRange - Acquisition range in px
   * @returns {Object|null}
   */
  findNearestEnemy(maxRange) {
    const player = this.state.player;
    const maxRangeSq = maxRange * maxRange;
    let best = null;
    let bestDistSq = maxRangeSq;

    for (let i = 0; i < this.enemies.length; i++) {
      const enemy = this.enemies[i];
      if (!enemy.alive) continue;
      const dSq = distanceSq(player.x, player.y, enemy.x, enemy.y);
      if (dSq <= bestDistSq) {
        bestDistSq = dSq;
        best = enemy;
      }
    }
    /*
     * A MODULAR BOSS IS NOT IN `this.enemies` (see spawnCompositeBoss), so a
     * weapon that only scanned that list goes cold the instant the last swarm
     * enemy dies with a boss still standing on the field. Its aimable parts
     * are checked here as a second, equally weighted pass.
     */
    for (const proxy of this.getCompositeTargets()) {
      const dSq = distanceSq(player.x, player.y, proxy.x, proxy.y);
      if (dSq <= bestDistSq) {
        bestDistSq = dSq;
        best = proxy;
      }
    }
    return best;
  }

  /**
   * Nearest living enemy to an arbitrary point — the Wingman drones' turrets.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} maxRange
   * @returns {Object|null}
   */
  findNearestEnemyTo(x, y, maxRange) {
    let best = null;
    let bestDistSq = maxRange * maxRange;

    for (let i = 0; i < this.enemies.length; i++) {
      const enemy = this.enemies[i];
      if (!enemy.alive) continue;
      const dSq = distanceSq(x, y, enemy.x, enemy.y);
      if (dSq <= bestDistSq) {
        bestDistSq = dSq;
        best = enemy;
      }
    }
    // See findNearestEnemy: a modular boss's parts live outside `enemies`.
    for (const proxy of this.getCompositeTargets()) {
      const dSq = distanceSq(x, y, proxy.x, proxy.y);
      if (dSq <= bestDistSq) {
        bestDistSq = dSq;
        best = proxy;
      }
    }
    return best;
  }

  /**
   * Highest-HP living enemy in range — the Nanite Swarm's target rule.
   *
   * CURRENT hp, not max: a Bio-Goliath the player has already worked down
   * should stop soaking the salvo once something fresher is the bigger
   * problem. Ties go to the nearest, so a wall of identical chaff does not
   * make the missiles pick an arbitrary far-away one.
   *
   * @param {number} maxRange - Acquisition range in px
   * @returns {Object|null}
   */
  findHighestHpEnemy(maxRange) {
    const player = this.state.player;
    const maxRangeSq = maxRange * maxRange;
    let best = null;
    let bestHp = -Infinity;
    let bestDistSq = Infinity;

    for (let i = 0; i < this.enemies.length; i++) {
      const enemy = this.enemies[i];
      if (!enemy.alive) continue;
      const dSq = distanceSq(player.x, player.y, enemy.x, enemy.y);
      if (dSq > maxRangeSq) continue;

      if (enemy.hp > bestHp || (enemy.hp === bestHp && dSq < bestDistSq)) {
        bestHp = enemy.hp;
        bestDistSq = dSq;
        best = enemy;
      }
    }
    // See findNearestEnemy: a modular boss's parts live outside `enemies`.
    for (const proxy of this.getCompositeTargets()) {
      const dSq = distanceSq(player.x, player.y, proxy.x, proxy.y);
      if (dSq > maxRangeSq) continue;
      if (proxy.hp > bestHp || (proxy.hp === bestHp && dSq < bestDistSq)) {
        bestHp = proxy.hp;
        bestDistSq = dSq;
        best = proxy;
      }
    }
    return best;
  }

  /** Level stats for the starter weapon, kept for HUD/debug convenience. */
  getWeaponStats() {
    return this.cards.getStats(STARTER_CARD_ID);
  }

  /* ------------------------------------------------------------------ */
  /* Collisions & rewards                                                */
  /* ------------------------------------------------------------------ */

  resolveCollisions() {
    const player = this.state.player;

    // Projectile collisions using Spatial Hash Grid candidate lookup
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      const candidates = this.spatialGrid.queryRadius(p.x, p.y, p.radius);
      for (const enemy of candidates) {
        if (!enemy.alive) continue;
        // Do not re-hit the enemy this shot just passed through.
        if (enemy.id === p.lastHitId) continue;
        const hitRadius = p.radius + enemy.radius;
        if (distanceSq(p.x, p.y, enemy.x, enemy.y) > hitRadius * hitRadius) continue;

        p.lastHitId = enemy.id;
        this.damageEnemy(enemy, p.damage, p.vx, p.vy);

        /*
         * THE BIO-GOLIATH'S ARMOUR.
         *
         * A guardian does not merely absorb the shot it was hit by — it strips
         * the round's remaining pierce, so a fully-levelled Phase Repeater
         * needle that would have carried on through the three larvae sheltering
         * behind it stops dead in the armour instead. That is what makes the
         * species a WALL rather than just a large target, and it is why it
         * unlocks late: before the player owns pierce there is nothing to take
         * away.
         */
        if (enemy.breaksPierce) p.pierce = 0;

        if (p.pierce > 0) {
          p.pierce -= 1;
        } else {
          p.alive = false;
        }
        break;
      }
    }

    /*
     * MODULAR BOSSES ARE CHECKED SEPARATELY, AND AFTER THE SWARM.
     *
     * After, so a pierced round spends its pierce on the chaff in front of the
     * boss before it reaches the hull — the boss is the thing the player is
     * trying to shoot past everything else, and a bolt that hit it first would
     * make its escorts free. Separately, because `damageAt` resolves WHICH
     * component was hit, which a single-radius grid entry cannot express.
     */
    for (const boss of this.compositeBosses) {
      if (!boss.alive) continue;
      for (const p of this.projectiles) {
        if (!p.alive) continue;
        const result = boss.damageAt(p.x, p.y, p.damage, this.behaviorCtx, p.radius);
        if (result.kind === null) continue;

        if (result.destroyed && result.partId) {
          this.onCompositeBossPartDown(boss, boss.getPart(result.partId));
        }

        /*
         * A deflected round dies too. It has to: leaving it alive means it
         * re-tests against the armoured hull every frame it overlaps, and the
         * player gets a stream of deflection events off a single shot.
         */
        p.alive = false;
      }
    }

    if (this.invulnTimer > 0) return;

    // Player contact collision using Spatial Hash Grid query
    const nearbyEnemies = this.spatialGrid.queryRadius(player.x, player.y, PLAYER_CFG.RADIUS);
    for (const enemy of nearbyEnemies) {
      if (!enemy.alive) continue;
      const touchRadius = PLAYER_CFG.RADIUS + enemy.radius;
      if (distanceSq(player.x, player.y, enemy.x, enemy.y) > touchRadius * touchRadius) continue;

      this.damagePlayer(enemy.contactDamage);
      break;
    }
  }

  /**
   * Apply damage to the Dewling, letting Bloomshield absorb it first.
   * Invulnerability frames start whether or not the shield ate the hit.
   * @param {number} amount
   */
  damagePlayer(amount) {
    // Phase Shift's i-frames are checked before the barrier, so a blink never
    // spends a shield charge it did not need to.
    if (this.activeSkills.invulnerable) return;
    const remaining = this.cards.absorb(amount);
    if (remaining > 0) this.state.damagePlayer(remaining);
    this.invulnTimer = PLAYER_CFG.INVULN_SEC;
  }

  /**
   * @param {Object} enemy
   * @param {number} amount - Damage points
   * @param {number} [sourceVx] - Velocity of whatever landed the hit, for the
   *   kinetic knock. Omitted by AoE and blades, which have no direction.
   * @param {number} [sourceVy]
   */
  damageEnemy(enemy, amount, sourceVx = 0, sourceVy = 0) {
    /*
     * A CARD'S TARGET MAY BE A COMPOSITE BOSS PROXY, NOT A REAL ENTITY.
     *
     * findNearestEnemy/findHighestHpEnemy/findNearestEnemyTo can now hand back
     * one of CompositeBoss.getTargetProxies()'s throwaway objects (see those
     * functions). A card that damages its target directly — the Tesla Arc's
     * chain, the Graviton pulse — calls straight into damageEnemy with
     * whatever it got back, so the redirect belongs here, in the one place
     * every direct-damage path already funnels through. Everything below this
     * (the flash refractory gate, the knockback impulse) assumes a pooled
     * enemy with those fields and would just write them onto a proxy that is
     * discarded before the next frame — redirecting first skips work that
     * could not do anything anyway.
     */
    if (enemy.isCompositeTarget) {
      this.damageCompositeTarget(enemy, amount);
      return;
    }

    if (enemy.isBoss && amount < enemy.hp) {
      // Phase Gating: Boss HP cannot cross phase thresholds until required attack cycles are completed
      if (enemy.phase === 1 && (enemy.radialCountExecuted ?? 0) < 2) {
        const floorHp = enemy.maxHp * BOSS_PHASES.escort;
        if (enemy.hp - amount < floorHp) {
          amount = Math.max(0, enemy.hp - floorHp);
        }
      } else if (enemy.phase === 2 && (enemy.escortCountExecuted ?? 0) < 1) {
        const floorHp = enemy.maxHp * BOSS_PHASES.ray;
        if (enemy.hp - amount < floorHp) {
          amount = Math.max(0, enemy.hp - floorHp);
        }
      }
    }
    enemy.hp -= amount;

    /*
     * THE FLASH HAS A REFRACTORY PERIOD, AND IT IS LOAD-BEARING.
     *
     * The damage flash is pure white — the only tint that makes a near-black
     * carapace go bright, because a Pixi tint multiplies and cannot add light.
     * Which also means a flashing enemy is showing its UNTINTED source frame,
     * and the Kenney hulls are white with red and yellow accents.
     *
     * A late-game build lands several hits a second on everything in reach
     * (satellites, lance, repeater, drones). Without this gate the flash never
     * expired, so the whole swarm sat permanently white-and-red — the palette's
     * darkness contract silently switched off exactly when the screen is at its
     * busiest, which is when it matters most. Gated, the same build produces a
     * crisp blink per enemy and the swarm stays dark between them.
     */
    if (this.elapsed - enemy.lastHitTime >= FLASH_REFRACTORY_SEC) {
      enemy.hitFlash = HIT_FLASH_SEC;
      enemy.lastHitTime = this.elapsed;
    }

    /*
     * KINETIC IMPACT. A shot shoves what it hits backward along its own line
     * of travel. Without it the only feedback a hit gives is a one-frame
     * colour change, and against a wall of enemies the player cannot tell
     * which one they connected with.
     *
     * Bosses are exempt — a station does not flinch — and the impulse is
     * inversely scaled by radius so a Bio-Goliath barely rocks where a larva
     * is thrown clear.
     */
    if (!enemy.isBoss && (sourceVx !== 0 || sourceVy !== 0)) {
      const speed = Math.hypot(sourceVx, sourceVy);
      if (speed > 0) {
        const mass = Math.max(1, enemy.radius / 12);
        const impulse = HIT_KICK_IMPULSE / mass;
        enemy.knockVx += (sourceVx / speed) * impulse;
        enemy.knockVy += (sourceVy / speed) * impulse;
      }
    }
    // Position travels with the event so the renderer can place hit particles
    // without reaching back into simulation entities.
    this.bus.emit('enemy:damaged', {
      id: enemy.id,
      damage: amount,
      remainingHp: enemy.hp,
      x: enemy.x,
      y: enemy.y,
    });

    if (enemy.hp <= 0) this.killEnemy(enemy);
  }

  killEnemy(enemy) {
    enemy.alive = false;
    enemy.deathTime = this.elapsed;
    this.state.registerKill(enemy.scoreValue);
    this.spawnOrb(enemy.x, enemy.y, enemy.xpValue);
    // deathTime travels with the event: the entity is recycled within the tick,
    // so the renderer cannot read it back off the enemy to time its dissolve.
    this.bus.emit('enemy:death', {
      id: enemy.id,
      typeId: enemy.typeId,
      x: enemy.x,
      y: enemy.y,
      radius: enemy.radius,
      isBoss: Boolean(enemy.isBoss),
      deathTime: enemy.deathTime,
      phaseOffset: enemy.phaseOffset,
    });

    /*
     * THE BROOD SPORE BURSTS.
     *
     * Four larvae thrown out from where it died. Read from the data table
     * rather than hardcoded so the count and spread are tunable, and spawned
     * BEFORE the boss check so a spore killed on a boss wave still bursts.
     *
     * Note this deliberately ignores the spawn window: these are not arrivals,
     * they came out of something the player chose to shoot. A spore left alive
     * into the clear-out tail is a decision with a cost.
     */
    const def = ENEMIES[enemy.typeId];
    if (def?.broodCount > 0) {
      for (let i = 0; i < def.broodCount; i++) {
        const angle = (i / def.broodCount) * Math.PI * 2 + this.rng() * 0.5;
        this.spawnEnemy(def.broodType ?? ENEMY_TYPES.TARLING, {
          x: enemy.x + Math.cos(angle) * def.broodSpread,
          y: enemy.y + Math.sin(angle) * def.broodSpread,
        });
      }
      this.bus.emit('enemy:brood_burst', {
        x: enemy.x,
        y: enemy.y,
        count: def.broodCount,
      });
    }

    // If boss is killed, stop any active death ray
    if (enemy.isBoss) {
      this.deathRay.active = false;
      this.deathRay.firing = false;
      if (isBossWave(this.state.wave)) {
        this.state.completeWave();
      }
    }
  }

  /**
   * Redirect damage aimed at a CompositeBoss.getTargetProxies() proxy back
   * onto the boss it actually came from.
   *
   * Mirrors what the projectile path already does through
   * CompositeBoss.damageAt (see resolveCollisions) — same score/orb payout via
   * onCompositeBossPartDown/onCompositeBossDown — but resolves against the
   * SPECIFIC part or chassis the proxy named rather than re-running a hit
   * test, because a direct-damage card has no projectile position to test
   * against, only the target it was handed.
   *
   * @param {Object} proxy - A proxy from CompositeBoss.getTargetProxies()
   * @param {number} amount
   */
  damageCompositeTarget(proxy, amount) {
    const boss = this.compositeBosses.find((b) => b.id === proxy.bossId && b.alive);
    if (!boss) return;

    if (proxy.partId) {
      const part = boss.getPart(proxy.partId);
      if (!part || !part.alive) return;
      boss.damagePart(proxy.partId, amount, this.behaviorCtx);
      if (!part.alive) this.onCompositeBossPartDown(boss, part);
      return;
    }

    if (!boss.isChassisVulnerable()) return;
    boss.damageChassis(amount, this.behaviorCtx);
    if (!boss.alive) this.onCompositeBossDown(boss);
  }

  spawnOrb(x, y, value) {
    this.orbs.push({
      id: this.nextEntityId++,
      x,
      y,
      value,
      radius: ORB_CFG.RADIUS,
      life: ORB_CFG.LIFETIME_SEC,
      alive: true,
    });
  }

  updateOrbs(dt) {
    const player = this.state.player;
    const pickupPx = player.pickupRadius * UNIT_PX + PLAYER_CFG.RADIUS;
    const pickupSq = pickupPx * pickupPx;
    const attractSq = ORB_CFG.ATTRACT_RADIUS * ORB_CFG.ATTRACT_RADIUS;

    for (const orb of this.orbs) {
      if (!orb.alive) continue;
      const dSq = distanceSq(player.x, player.y, orb.x, orb.y);

      if (dSq <= pickupSq) {
        orb.alive = false;
        this.state.addXp(orb.value);
        this.bus.emit('orb:collected', { value: orb.value });
        continue;
      }

      if (dSq <= attractSq) {
        const dir = normalize(player.x - orb.x, player.y - orb.y);
        orb.x += dir.x * ORB_CFG.MAGNET_SPEED * dt;
        orb.y += dir.y * ORB_CFG.MAGNET_SPEED * dt;
      }

      orb.life -= dt;
      if (orb.life <= 0) orb.alive = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Wave flow                                                           */
  /* ------------------------------------------------------------------ */

  /** Enemies recede at wave end, leaving a short breather to collect orbs. */
  onWaveComplete() {
    for (const enemy of this.enemies) this.enemyPool.release(enemy);
    this.enemies.length = 0;
    for (const p of this.projectiles) this.projectilePool.release(p);
    this.projectiles.length = 0;
    for (const b of this.enemyBullets) this.enemyBulletPool.release(b);
    this.enemyBullets.length = 0;
    this.sporePools.length = 0;
    this.bossTelegraph.active = false;
    this.deathRay.active = false;
    this.deathRay.firing = false;
    this.waveBreakTimer = PHASE1.WAVE_BREAK_SEC;
  }

  /** Read-only snapshot for the renderer/HUD. */
  getSnapshot() {
    return {
      ...this.state.getStateSummary(),
      enemyCount: this.enemies.length,
      orbCount: this.orbs.length,
      projectileCount: this.projectiles.length,
      enemyBulletCount: this.enemyBullets.length,
      sporePoolCount: this.sporePools.length,
      bossTelegraph: { ...this.bossTelegraph },
      deathRay: { ...this.deathRay },
      waveBreakTimer: this.waveBreakTimer,
      invulnerable: this.invulnTimer > 0,
      shieldCharge: this.cards.shieldCharge,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Module constants                                                    */
/* ------------------------------------------------------------------ */

/**
 * Dart Ravager charge states. Read by the renderer to decide whether to paint
 * the lock-on warning, so they are exported rather than being local strings.
 */
export const CHARGE_STATE = {
  IDLE: 'idle',
  WINDUP: 'windup',
  DASHING: 'dashing',
};

/**
 * Damage-flash window in seconds — two frames at 60Hz.
 *
 * Short and hard on purpose. The flash is a rigid white blink, not a wobble;
 * anything longer starts to read as the enemy changing colour rather than
 * being struck.
 */
export const HIT_FLASH_SEC = 0.033;

/**
 * Minimum gap between damage flashes on one enemy, in seconds.
 *
 * Roughly five blinks a second at most. Long enough that the swarm is dark for
 * the large majority of every second even under a maxed build, short enough
 * that individual hits still read. See the note in damageEnemy.
 */
export const FLASH_REFRACTORY_SEC = 0.18;

/** Backward impulse in px/s applied to a struck enemy of reference size. */
export const HIT_KICK_IMPULSE = 260;

/**
 * Per-60Hz-frame decay of that impulse.
 *
 * 0.80 gives a ~55ms half-life: the enemy jolts and is back on course inside
 * four frames. Higher values turn a kinetic hit into a shove, which is the
 * Graviton EMP's job, not a bullet's.
 */
export const HIT_KICK_DECAY = 0.8;

/**
 * Shared facing vector returned by getFacing().
 *
 * Module-level and mutated in place: getFacing is called by every owned card
 * every frame, and a fresh literal per call would be several allocations a
 * frame for two numbers. Callers must read it immediately, never store it.
 */
const FACING = { x: 1, y: 0 };

/* Pool factories — blank entities, filled in on acquire. */

/**
 * Every field an enemy will ever hold is declared here, including the boss-only
 * telegraphTimer and the Rustbloom-only sporeTimer. One shape for all enemy
 * types keeps the objects monomorphic, so the hot loops in updateEnemies and
 * resolveCollisions stay on a single inline cache instead of going megamorphic
 * as the roster mixes.
 *
 * The last four are Tier B procedural-animation state (Phase 7). They are plain
 * numbers on the entity the pool already owns — there is deliberately no
 * per-entity animator object, because at a 200-enemy cap that would be 200
 * allocations to track four numbers.
 */
function makeEnemy() {
  return {
    id: 0,
    typeId: '',
    behavior: 'DIRECT',
    isBoss: false,
    x: 0,
    y: 0,
    radius: 0,
    hp: 0,
    maxHp: 0,
    speed: 0,
    contactDamage: 0,
    xpValue: 0,
    scoreValue: 0,
    hitFlash: 0,
    orbitCooldown: 0,
    /**
     * Point-Defense Overdrive's re-hit clock. Its OWN field rather than
     * sharing orbitCooldown with the Aegis Satellites: they are two separate
     * weapons and one must not consume the other's hit window.
     */
    pdCooldown: 0,
    /** Afterburner ram clock, so one burn cannot juggle the same enemy. */
    rammedTimer: 0,
    timeAlive: 0,
    sporeTimer: 0,
    telegraphTimer: 0,
    alive: false,
    /** Undisturbed travel speed, before a stun or a charge multiplier. */
    baseSpeed: 0,
    /* ---- Crowd control and impact ---- */
    stunTimer: 0,
    knockVx: 0,
    knockVy: 0,
    /** Bio-Goliath only: strips pierce off anything that hits it. */
    breaksPierce: false,
    /* ---- Dart Ravager charge cycle ---- */
    chargeState: 'idle',
    chargeTimer: 0,
    chargeDirX: 0,
    chargeDirY: 0,
    /* ---- Phantom Stalker camouflage. 1 = fully visible. ---- */
    visibility: 1,
    cloaked: false,
    /* ----------------------------------------------------------------
     * Roster-config state (src/core/enemy-system.js).
     *
     * Declared here with everything else rather than attached by
     * applyArchetype, for the reason the whole shape exists: an entity that
     * grows fields after construction goes polymorphic, and the 200-enemy
     * loops that read it fall off their inline caches. `archetypeId` empty
     * means "legacy roster", which is what updateEnemies dispatches on.
     * ---------------------------------------------------------------- */
    archetypeId: '',
    spriteKey: '',
    mass: 1,
    scrapValue: 0,
    /** Kiting: strafe sense (-1 or 1) and its reversal clock. */
    strafeSign: 1,
    strafeTimer: 0,
    /** True while a kiter is inside its standoff band and allowed to fire. */
    inStandoffBand: false,
    /** Weapon clock, for archetypes that carry a gun. */
    fireTimer: 0,
    /* ---- Rammer cycle: cruise -> telegraph -> dash -> recover ---- */
    rammerState: 'cruise',
    rammerTimer: 0,
    lockDirX: 0,
    lockDirY: 0,
    /* ---- Dreadnought Station attack clocks ---- */
    radialTimer: 0,
    escortTimer: 0,
    rayTimer: 0,
    phase: 1,
    radialCountExecuted: 0,
    escortCountExecuted: 0,
    rayCountExecuted: 0,
    /**
     * Velocity in px/s. Recorded by updateEnemies rather than integrated from,
     * because the behaviour branches move entities directly. Tier B's
     * facingRotation reads it so a sine-wave Ashfish banks into its curve
     * instead of always pointing flatly at the Dewling.
     */
    vx: 0,
    vy: 0,
    // Tier B procedural animation
    phaseOffset: 0,
    spawnTime: 0,
    lastHitTime: -Infinity,
    deathTime: -Infinity,
  };
}

function makeProjectile() {
  return {
    id: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    damage: 0,
    radius: 0,
    life: 0,
    alive: false,
    /** 'bolt' | 'missile' | 'drone_bolt' — the renderer picks a frame from it. */
    kind: 'bolt',
    /** Extra enemies this may pass through before stopping. */
    pierce: 0,
    lastHitId: 0,
    /* Guided rounds only. turnRate 0 means "flies straight". */
    targetId: 0,
    turnRate: 0,
  };
}

/**
 * The boss's radial ordnance. A separate shape from the player's projectiles
 * because it carries none of the pierce/homing state and is checked against a
 * completely different collider — keeping them one type would put six unused
 * fields on every bullet in a 100-bullet ring.
 */
function makeEnemyBullet() {
  return { id: 0, x: 0, y: 0, vx: 0, vy: 0, damage: 0, radius: 0, life: 0, alive: false };
}

function makeBlade() {
  return { x: 0, y: 0, radius: 0, alive: false };
}

function makeEffect() {
  return { x: 0, y: 0, radius: 0, kind: 'pulse', life: 0, maxLife: 1, alive: false };
}
