/**
 * BloomWake Phase 1 simulation — the core survival loop.
 *
 * Owns every runtime entity (enemies, projectiles, XP orbs) and advances them
 * with a plain delta-time step. Strictly DOM-free: the renderer reads this
 * state, the simulation never knows a canvas exists.
 *
 * Phase 1 scope: one enemy type, one auto-attack, no cards, no boss.
 * Collision is naive O(n*m) — the spatial hash and object pooling land in Phase 2.
 */

import { EventBus } from './event-bus.js';
import { GameState, GAME_STATES } from './game-state.js';
import { WaveSpawner } from './spawner.js';
import {
  UNIT_PX,
  WORLD,
  PLAYER_CFG,
  PROJECTILE_CFG,
  ORB_CFG,
  PHASE1,
} from './constants.js';
import { clamp, distanceSq, mulberry32, normalize, removeDead } from './math.js';
import { getEnemyHpMultiplier, getEnemySpeedMultiplier } from './wave.js';
import { ENEMIES } from '../data/enemies.js';
import { getCardById } from '../data/cards.js';

const STARTER_CARD_ID = 'dewdrop_barrage';

export class Simulation {
  /**
   * @param {Object} [options]
   * @param {EventBus} [options.bus]
   * @param {GameState} [options.state]
   * @param {number} [options.seed] - Seed for deterministic spawning
   * @param {number} [options.maxWaves]
   */
  constructor({ bus, state, seed = 1337, maxWaves = PHASE1.MAX_WAVES } = {}) {
    this.bus = bus ?? new EventBus();
    this.state = state ?? new GameState(this.bus, { maxWaves });
    this.rng = mulberry32(seed);
    this.spawner = new WaveSpawner(this.rng);

    this.enemies = [];
    this.projectiles = [];
    this.orbs = [];

    this.nextEntityId = 1;
    this.attackCooldown = 0;
    this.invulnTimer = 0;
    this.waveBreakTimer = 0;
    this.elapsed = 0;

    this.bus.on('wave:start', (data) => this.spawner.beginWave(data.wave));
    this.bus.on('wave:complete', () => this.onWaveComplete());
    this.bus.on('player:level_up', () => this.onLevelUp());

    this.resetEntities();
  }

  /** Clear all entities and per-run timers (does not touch GameState). */
  resetEntities() {
    this.enemies.length = 0;
    this.projectiles.length = 0;
    this.orbs.length = 0;
    this.attackCooldown = 0;
    this.invulnTimer = 0;
    this.waveBreakTimer = 0;
    this.elapsed = 0;
  }

  /** Begin a fresh run: reset state, center the Dewling, open wave 1. */
  startRun() {
    this.resetEntities();
    this.state.startRun();
    this.state.player.x = WORLD.WIDTH / 2;
    this.state.player.y = WORLD.HEIGHT / 2;
  }

  /**
   * Advance the simulation one step.
   * @param {number} dt - Delta time in seconds
   * @param {{x: number, y: number}} [input] - Desired movement direction (unnormalized ok)
   */
  update(dt, input = { x: 0, y: 0 }) {
    const status = this.state.currentState;
    const running = status === GAME_STATES.RUNNING;
    const inBreak = status === GAME_STATES.WAVE_COMPLETE;
    if (!running && !inBreak) return;

    this.elapsed += dt;
    this.updatePlayer(dt, input);
    this.updateOrbs(dt);

    if (inBreak) {
      // Between waves the field is clear; only orb pickup and movement continue.
      removeDead(this.orbs);
      this.waveBreakTimer -= dt;
      if (this.waveBreakTimer <= 0) this.state.nextWave();
      return;
    }

    this.state.update(dt);
    // The wave timer may have ended the wave (or the run) inside state.update().
    if (this.state.currentState !== GAME_STATES.RUNNING) return;

    this.updateSpawning(dt);
    this.updateEnemies(dt);
    this.updateWeapon(dt);
    this.updateProjectiles(dt);
    this.resolveCollisions();

    removeDead(this.enemies);
    removeDead(this.projectiles);
    removeDead(this.orbs);
  }

  /* ------------------------------------------------------------------ */
  /* Player                                                              */
  /* ------------------------------------------------------------------ */

  updatePlayer(dt, input) {
    const player = this.state.player;
    const dir = normalize(input.x ?? 0, input.y ?? 0);
    const speed = player.moveSpeed * UNIT_PX;

    player.x = clamp(player.x + dir.x * speed * dt, PLAYER_CFG.RADIUS, WORLD.WIDTH - PLAYER_CFG.RADIUS);
    player.y = clamp(player.y + dir.y * speed * dt, PLAYER_CFG.RADIUS, WORLD.HEIGHT - PLAYER_CFG.RADIUS);

    if (this.invulnTimer > 0) this.invulnTimer -= dt;
  }

  /**
   * Phase 1 has no card draft, so every level-up upgrades the starter weapon.
   * Once Dewdrop Barrage is maxed, further levels grant durability instead —
   * the card selection screen replaces this in Phase 3.
   */
  onLevelUp() {
    const upgraded = this.state.selectCard(STARTER_CARD_ID);
    if (upgraded) return;

    this.state.player.maxHp += PHASE1.OVERFLOW_LEVEL_HP;
    this.state.player.hp = Math.min(
      this.state.player.maxHp,
      this.state.player.hp + PHASE1.OVERFLOW_LEVEL_HP
    );
  }

  /* ------------------------------------------------------------------ */
  /* Enemies                                                             */
  /* ------------------------------------------------------------------ */

  updateSpawning(dt) {
    const toSpawn = this.spawner.update(dt, this.enemies.length);
    for (let i = 0; i < toSpawn; i++) {
      this.spawnEnemy(PHASE1.ENEMY_TYPE);
    }
  }

  /**
   * @param {string} typeId - Key from the enemy data table
   * @returns {Object} The spawned enemy
   */
  spawnEnemy(typeId) {
    const def = ENEMIES[typeId];
    const wave = this.state.wave;
    const hp = def.baseHp * getEnemyHpMultiplier(wave);
    const pos = this.spawner.spawnPosition(this.state.player.x, this.state.player.y);

    const enemy = {
      id: this.nextEntityId++,
      typeId,
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
      alive: true,
    };

    this.enemies.push(enemy);
    return enemy;
  }

  updateEnemies(dt) {
    const player = this.state.player;

    for (const enemy of this.enemies) {
      // No pathfinding by design (GDD Section 5): straight vector toward the Dewling.
      const dir = normalize(player.x - enemy.x, player.y - enemy.y);
      enemy.x += dir.x * enemy.speed * dt;
      enemy.y += dir.y * enemy.speed * dt;
      if (enemy.hitFlash > 0) enemy.hitFlash -= dt;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Weapon: Dewdrop Barrage                                             */
  /* ------------------------------------------------------------------ */

  /** @returns {Object} Level stats for the active starter weapon */
  getWeaponStats() {
    const card = getCardById(STARTER_CARD_ID);
    const level = this.state.activeCards.get(STARTER_CARD_ID) || 1;
    return card.levels[level - 1];
  }

  updateWeapon(dt) {
    this.attackCooldown -= dt;
    if (this.attackCooldown > 0) return;

    const target = this.findNearestEnemy(PROJECTILE_CFG.TARGET_RANGE);
    if (!target) {
      // Nothing in range: stay ready so the next enemy is engaged immediately.
      this.attackCooldown = 0;
      return;
    }

    const stats = this.getWeaponStats();
    this.fireAt(target, stats);
    this.attackCooldown = stats.cooldown;
  }

  /**
   * @param {number} maxRange - Acquisition range in px
   * @returns {Object|null} Nearest living enemy within range
   */
  findNearestEnemy(maxRange) {
    const player = this.state.player;
    const maxRangeSq = maxRange * maxRange;
    let best = null;
    let bestDistSq = Infinity;

    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const dSq = distanceSq(player.x, player.y, enemy.x, enemy.y);
      if (dSq < bestDistSq && dSq <= maxRangeSq) {
        bestDistSq = dSq;
        best = enemy;
      }
    }
    return best;
  }

  fireAt(target, stats) {
    const player = this.state.player;
    const baseAngle = Math.atan2(target.y - player.y, target.x - player.x);
    const speed = stats.speed * PROJECTILE_CFG.SPEED_SCALE;
    const count = stats.count ?? 1;

    for (let i = 0; i < count; i++) {
      // Center the salvo on the target: -n/2 .. +n/2 spread.
      const angle = baseAngle + (i - (count - 1) / 2) * PROJECTILE_CFG.SPREAD_RAD;
      this.projectiles.push({
        id: this.nextEntityId++,
        x: player.x,
        y: player.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        damage: stats.damage,
        radius: PROJECTILE_CFG.RADIUS,
        life: PROJECTILE_CFG.LIFETIME_SEC,
        alive: true,
      });
    }

    this.bus.emit('weapon:fire', { cardId: STARTER_CARD_ID, count });
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

  /* ------------------------------------------------------------------ */
  /* Collisions & rewards                                                */
  /* ------------------------------------------------------------------ */

  resolveCollisions() {
    const player = this.state.player;

    for (const p of this.projectiles) {
      if (!p.alive) continue;
      for (const enemy of this.enemies) {
        if (!enemy.alive) continue;
        const hitRadius = p.radius + enemy.radius;
        if (distanceSq(p.x, p.y, enemy.x, enemy.y) > hitRadius * hitRadius) continue;

        p.alive = false;
        this.damageEnemy(enemy, p.damage);
        break;
      }
    }

    if (this.invulnTimer > 0) return;

    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const touchRadius = PLAYER_CFG.RADIUS + enemy.radius;
      if (distanceSq(player.x, player.y, enemy.x, enemy.y) > touchRadius * touchRadius) continue;

      this.state.damagePlayer(enemy.contactDamage);
      this.invulnTimer = PLAYER_CFG.INVULN_SEC;
      break;
    }
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
    // GDD Section 3: pickup radius is in movement units; the wider attract
    // radius is pure game feel and does not change the collection rule.
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
    this.projectiles.length = 0;
    this.waveBreakTimer = PHASE1.WAVE_BREAK_SEC;
  }

  /** Read-only snapshot for the renderer/HUD. */
  getSnapshot() {
    return {
      ...this.state.getStateSummary(),
      enemyCount: this.enemies.length,
      orbCount: this.orbs.length,
      projectileCount: this.projectiles.length,
      waveBreakTimer: this.waveBreakTimer,
      invulnerable: this.invulnTimer > 0,
    };
  }
}
