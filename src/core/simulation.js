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
import { GameState, GAME_STATES } from './game-state.js';
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
  ORB_CFG,
  CARD_MODEL,
  DRAFT_CFG,
  PHASE1,
} from './constants.js';
import { clamp, distanceSq, mulberry32, normalize, randomRange, removeDead } from './math.js';
import { getEnemyHpMultiplier, getEnemySpeedMultiplier, isBossWave, getBossHp } from './wave.js';
import { ENEMIES, ENEMY_TYPES, calculateTelegraphMs } from '../data/enemies.js';

const STARTER_CARD_ID = 'dewdrop_barrage';

export class Simulation {
  /**
   * @param {Object} [options]
   * @param {EventBus} [options.bus]
   * @param {GameState} [options.state]
   * @param {number} [options.seed] - Seed for deterministic spawning and drafts
   * @param {number} [options.maxWaves]
   */
  constructor({ bus, state, seed = 1337, maxWaves = PHASE1.MAX_WAVES } = {}) {
    this.bus = bus ?? new EventBus();
    this.state = state ?? new GameState(this.bus, { maxWaves });
    this.rng = mulberry32(seed);
    this.spawner = new WaveSpawner(this.rng);
    this.spatialGrid = new SpatialHashGrid(64);

    this.enemies = [];
    this.projectiles = [];
    this.orbs = [];
    /** Short-lived rings drawn for AoE cards. */
    this.effects = [];
    /** Rustbloom toxic spore pools on the ground. */
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

    // Card-spawned objects are recycled
    this.projectilePool = new ObjectPool(makeProjectile, 64);
    this.bladePool = new ObjectPool(makeBlade, 6);
    this.effectPool = new ObjectPool(makeEffect, 8);

    this.cards = new CardSystem(this);

    this.nextEntityId = 1;
    this.invulnTimer = 0;
    this.waveBreakTimer = 0;
    this.elapsed = 0;
    /** Level-ups waiting for a draft; several can arrive in one frame. */
    this.pendingLevelUps = 0;

    this.bus.on('wave:start', (data) => this.spawner.beginWave(data.wave));
    this.bus.on('wave:complete', () => this.onWaveComplete());
    this.bus.on('player:level_up', () => this.onLevelUp());
    this.bus.on('card:selected', ({ cardId }) => this.cards.onCardChanged(cardId));
    this.bus.on('draft:choice', () => this.onDraftResolved());

    this.resetEntities();
  }

  /** Clear all entities and per-run timers (does not touch GameState). */
  resetEntities() {
    for (const p of this.projectiles) this.projectilePool.release(p);
    for (const e of this.effects) this.effectPool.release(e);
    this.projectiles.length = 0;
    this.effects.length = 0;
    this.enemies.length = 0;
    this.orbs.length = 0;
    this.sporePools.length = 0;
    this.spatialGrid.clear();

    this.bossTelegraph.active = false;
    this.cards.reset();
    this.invulnTimer = 0;
    this.waveBreakTimer = 0;
    this.elapsed = 0;
    this.pendingLevelUps = 0;
  }

  /** Begin a fresh run: reset state, centre the Dewling, open wave 1. */
  startRun() {
    this.resetEntities();
    this.state.startRun();
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
      this.waveBreakTimer -= dt;
      if (this.waveBreakTimer <= 0) this.state.nextWave();
      return;
    }

    // On non-boss waves, state.update handles countdown. On boss wave, timer pauses until boss is dead.
    if (!isBossWave(this.state.wave)) {
      this.state.update(dt);
    }
    if (this.state.currentState !== GAME_STATES.RUNNING) return;

    this.updateSpawning(dt);
    this.updateEnemies(dt);
    this.updateSporePools(dt);
    this.updateBossTelegraph(dt);
    this.cards.update(dt);
    this.updateProjectiles(dt);

    // Populate Spatial Hash Grid for fast O(n) collision broadphase
    this.spatialGrid.clear();
    for (let i = 0; i < this.enemies.length; i++) {
      if (this.enemies[i].alive) {
        this.spatialGrid.insert(this.enemies[i]);
      }
    }

    this.resolveCollisions();

    removeDead(this.enemies);
    removeDead(this.orbs);
    removeDead(this.sporePools);
    sweepToPool(this.projectiles, this.projectilePool);
  }

  /* ------------------------------------------------------------------ */
  /* Player                                                              */
  /* ------------------------------------------------------------------ */

  updatePlayer(dt, input) {
    const player = this.state.player;
    const dir = normalize(input.x ?? 0, input.y ?? 0);
    const speed = player.moveSpeed * this.cards.moveSpeedMultiplier * UNIT_PX;

    player.x = clamp(player.x + dir.x * speed * dt, PLAYER_CFG.RADIUS, WORLD.WIDTH - PLAYER_CFG.RADIUS);
    player.y = clamp(player.y + dir.y * speed * dt, PLAYER_CFG.RADIUS, WORLD.HEIGHT - PLAYER_CFG.RADIUS);

    if (this.invulnTimer > 0) this.invulnTimer -= dt;
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
        DRAFT_CFG.OFFER_COUNT,
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

    // Spawn regular enemies up to concurrent cap
    const toSpawn = this.spawner.update(dt, this.enemies.length);
    for (let i = 0; i < toSpawn; i++) {
      const enemyDef = this.spawner.pickEnemyType();
      this.spawnEnemy(enemyDef.id);
    }
  }

  /**
   * @param {string} typeId - Key from the enemy data table
   * @returns {Object} The spawned enemy
   */
  spawnEnemy(typeId) {
    const def = ENEMIES[typeId] || ENEMIES[ENEMY_TYPES.TARLING];
    const wave = this.state.wave;
    const hp = def.baseHp * getEnemyHpMultiplier(wave);
    const pos = this.spawner.spawnPosition(this.state.player.x, this.state.player.y);

    const enemy = {
      id: this.nextEntityId++,
      typeId: def.id,
      behavior: def.behavior,
      isBoss: false,
      x: pos.x,
      y: pos.y,
      radius: def.radius,
      hp,
      maxHp: hp,
      speed: def.baseSpeed * UNIT_PX * getEnemySpeedMultiplier(wave),
      contactDamage: def.contactDamage,
      xpValue: def.xpValue,
      scoreValue: def.scoreValue,
      hitFlash: 0,
      orbitCooldown: 0,
      timeAlive: 0,
      sporeTimer: randomRange(this.rng, 1.0, 3.5),
      alive: true,
    };

    this.enemies.push(enemy);
    return enemy;
  }

  /**
   * Spawn Rustwhale Boss on boss wave
   */
  spawnBoss() {
    const def = ENEMIES[ENEMY_TYPES.RUSTWHALE];
    const wave = this.state.wave;
    const hp = getBossHp(wave);
    const pos = this.spawner.spawnPosition(this.state.player.x, this.state.player.y);

    const boss = {
      id: this.nextEntityId++,
      typeId: def.id,
      behavior: def.behavior,
      isBoss: true,
      x: pos.x,
      y: pos.y,
      radius: def.radius,
      hp,
      maxHp: hp,
      speed: def.baseSpeed * UNIT_PX,
      contactDamage: def.contactDamage,
      xpValue: def.xpValue,
      scoreValue: def.scoreValue,
      hitFlash: 0,
      orbitCooldown: 0,
      timeAlive: 0,
      telegraphTimer: 2.0,
      alive: true,
    };

    this.enemies.push(boss);
    this.bus.emit('boss:spawned', { wave, hp, id: boss.id });
    return boss;
  }

  updateEnemies(dt) {
    const player = this.state.player;

    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;

      enemy.timeAlive += dt;
      if (enemy.hitFlash > 0) enemy.hitFlash -= dt;
      if (enemy.orbitCooldown > 0) enemy.orbitCooldown -= dt;

      const dir = normalize(player.x - enemy.x, player.y - enemy.y);
      const perpX = -dir.y;
      const perpY = dir.x;

      switch (enemy.behavior) {
        case 'SINE_WAVE': {
          // Ashfish wave oscillation
          const waveOffset = Math.sin(enemy.timeAlive * 5.0) * 0.5;
          enemy.x += (dir.x + perpX * waveOffset) * enemy.speed * dt;
          enemy.y += (dir.y + perpY * waveOffset) * enemy.speed * dt;
          break;
        }
        case 'FAST_SWARM': {
          // Cracked Wisp straight fast charge
          enemy.x += dir.x * enemy.speed * dt;
          enemy.y += dir.y * enemy.speed * dt;
          break;
        }
        case 'STATIONARY_SPORE': {
          // Rustbloom slow approach + periodic spore drop
          enemy.x += dir.x * enemy.speed * dt;
          enemy.y += dir.y * enemy.speed * dt;

          enemy.sporeTimer -= dt;
          if (enemy.sporeTimer <= 0) {
            enemy.sporeTimer = 3.5;
            this.spawnSporePool(enemy.x, enemy.y);
          }
          break;
        }
        case 'ZIGZAG_FLYING': {
          // Smogmoth sharp zigzag flying trajectory
          const zigzag = Math.sin(enemy.timeAlive * 8.0) * 0.8;
          enemy.x += (dir.x + perpX * zigzag) * enemy.speed * dt;
          enemy.y += (dir.y + perpY * zigzag) * enemy.speed * dt;
          break;
        }
        case 'BOSS_TELEGRAPH_AOE': {
          // Rustwhale Boss movement & attack trigger
          enemy.x += dir.x * enemy.speed * dt;
          enemy.y += dir.y * enemy.speed * dt;

          enemy.telegraphTimer -= dt;
          if (enemy.telegraphTimer <= 0 && !this.bossTelegraph.active) {
            enemy.telegraphTimer = ENEMIES[ENEMY_TYPES.RUSTWHALE].telegraphCooldown;
            this.triggerBossTelegraph(player.x, player.y);
          }
          break;
        }
        case 'DIRECT':
        default: {
          // Tarling direct path
          enemy.x += dir.x * enemy.speed * dt;
          enemy.y += dir.y * enemy.speed * dt;
          break;
        }
      }

      // Clamp within world boundaries
      enemy.x = clamp(enemy.x, enemy.radius, WORLD.WIDTH - enemy.radius);
      enemy.y = clamp(enemy.y, enemy.radius, WORLD.HEIGHT - enemy.radius);
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
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;

      const outOfBounds = p.x < 0 || p.y < 0 || p.x > WORLD.WIDTH || p.y > WORLD.HEIGHT;
      if (p.life <= 0 || outOfBounds) p.alive = false;
    }
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
        const hitRadius = p.radius + enemy.radius;
        if (distanceSq(p.x, p.y, enemy.x, enemy.y) > hitRadius * hitRadius) continue;

        p.alive = false;
        this.damageEnemy(enemy, p.damage);
        break;
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
    const remaining = this.cards.absorb(amount);
    if (remaining > 0) this.state.damagePlayer(remaining);
    this.invulnTimer = PLAYER_CFG.INVULN_SEC;
  }

  /**
   * @param {Object} enemy
   * @param {number} amount - Damage points
   */
  damageEnemy(enemy, amount) {
    enemy.hp -= amount;
    enemy.hitFlash = 0.1;
    this.bus.emit('enemy:damaged', { id: enemy.id, damage: amount, remainingHp: enemy.hp });

    if (enemy.hp <= 0) this.killEnemy(enemy);
  }

  killEnemy(enemy) {
    enemy.alive = false;
    this.state.registerKill(enemy.scoreValue);
    this.spawnOrb(enemy.x, enemy.y, enemy.xpValue);

    // If boss is killed on boss wave, complete wave
    if (enemy.isBoss && isBossWave(this.state.wave)) {
      this.state.completeWave();
    }
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
    this.enemies.length = 0;
    for (const p of this.projectiles) this.projectilePool.release(p);
    this.projectiles.length = 0;
    this.sporePools.length = 0;
    this.bossTelegraph.active = false;
    this.waveBreakTimer = PHASE1.WAVE_BREAK_SEC;
  }

  /** Read-only snapshot for the renderer/HUD. */
  getSnapshot() {
    return {
      ...this.state.getStateSummary(),
      enemyCount: this.enemies.length,
      orbCount: this.orbs.length,
      projectileCount: this.projectiles.length,
      sporePoolCount: this.sporePools.length,
      bossTelegraph: { ...this.bossTelegraph },
      waveBreakTimer: this.waveBreakTimer,
      invulnerable: this.invulnTimer > 0,
      shieldCharge: this.cards.shieldCharge,
    };
  }
}

/* Pool factories — blank entities, filled in on acquire. */
function makeProjectile() {
  return { id: 0, x: 0, y: 0, vx: 0, vy: 0, damage: 0, radius: 0, life: 0, alive: false };
}

function makeBlade() {
  return { x: 0, y: 0, radius: 0, alive: false };
}

function makeEffect() {
  return { x: 0, y: 0, radius: 0, kind: 'pulse', life: 0, maxLife: 1, alive: false };
}
