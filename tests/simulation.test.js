import { describe, it, expect, vi } from 'vitest';
import { Simulation } from '../src/core/simulation.js';
import { GameState, GAME_STATES } from '../src/core/game-state.js';
import { EventBus } from '../src/core/event-bus.js';
import { UNIT_PX, WORLD, PLAYER_CFG, PHASE1, ORB_CFG } from '../src/core/constants.js';
import { getEnemyCount, getWaveDuration } from '../src/core/wave.js';
import { getCardById } from '../src/data/cards.js';

const STEP = 1 / 60;

/** Build a running Phase 1 simulation with a deterministic seed. */
function makeSim({ maxWaves = PHASE1.MAX_WAVES, seed = 42 } = {}) {
  const bus = new EventBus();
  const state = new GameState(bus, { maxWaves });
  const sim = new Simulation({ bus, state, seed });
  sim.startRun();
  return sim;
}

/**
 * Advance the simulation by a duration in fixed steps.
 * @param {Simulation} sim
 * @param {number} seconds
 * @param {{x: number, y: number}} [input]
 */
function advance(sim, seconds, input = { x: 0, y: 0 }) {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) sim.update(STEP, input);
}

/**
 * Step until a condition holds, so tests never depend on float-exact timing.
 * @param {Simulation} sim
 * @param {(sim: Simulation) => boolean} predicate
 * @param {number} [maxSeconds] - Give-up budget
 * @returns {boolean} Whether the condition was reached
 */
function advanceUntil(sim, predicate, maxSeconds = 60) {
  const steps = Math.ceil(maxSeconds / STEP);
  for (let i = 0; i < steps; i++) {
    if (predicate(sim)) return true;
    sim.update(STEP, { x: 0, y: 0 });
  }
  return predicate(sim);
}

describe('Simulation — Phase 1 core survival loop', () => {
  describe('Movement', () => {
    it('starts the Dewling centred in the arena', () => {
      const sim = makeSim();
      expect(sim.state.player.x).toBe(WORLD.WIDTH / 2);
      expect(sim.state.player.y).toBe(WORLD.HEIGHT / 2);
    });

    it('moves at the GDD speed of 3.2 units/sec', () => {
      const sim = makeSim();
      const startX = sim.state.player.x;

      advance(sim, 1.0, { x: 1, y: 0 });

      // 3.2 units/s * 32 px/unit = 102.4 px/s
      expect(sim.state.player.x - startX).toBeCloseTo(3.2 * UNIT_PX, 0);
    });

    it('normalizes diagonal input so it is no faster than cardinal', () => {
      const cardinal = makeSim();
      const diagonal = makeSim();

      advance(cardinal, 1.0, { x: 1, y: 0 });
      advance(diagonal, 1.0, { x: 1, y: 1 });

      const cardinalDist = Math.abs(cardinal.state.player.x - WORLD.WIDTH / 2);
      const diagonalDist = Math.hypot(
        diagonal.state.player.x - WORLD.WIDTH / 2,
        diagonal.state.player.y - WORLD.HEIGHT / 2
      );
      expect(diagonalDist).toBeCloseTo(cardinalDist, 4);
    });

    it('clamps the Dewling inside the arena bounds', () => {
      const sim = makeSim();
      advance(sim, 40, { x: -1, y: -1 });

      expect(sim.state.player.x).toBe(PLAYER_CFG.RADIUS);
      expect(sim.state.player.y).toBe(PLAYER_CFG.RADIUS);
    });
  });

  describe('Spawning', () => {
    it('populates the field and respects the wave enemy cap', () => {
      const sim = makeSim();
      advance(sim, 2);
      expect(sim.enemies.length).toBeGreaterThan(0);

      // Far more time than needed to fill; the cap must still hold.
      for (let i = 0; i < 2000; i++) {
        sim.update(STEP, { x: 0, y: 0 });
        expect(sim.enemies.length).toBeLessThanOrEqual(getEnemyCount(sim.state.wave));
      }
    });

    it('spawns only the Phase 1 enemy type', () => {
      const sim = makeSim();
      advance(sim, 10);

      expect(sim.enemies.length).toBeGreaterThan(0);
      for (const enemy of sim.enemies) {
        expect(enemy.typeId).toBe(PHASE1.ENEMY_TYPE);
      }
    });

    it('scales enemy HP with the wave multiplier', () => {
      const sim = makeSim();
      const waveOne = sim.spawnEnemy(PHASE1.ENEMY_TYPE);
      expect(waveOne.maxHp).toBeCloseTo(10);

      sim.state.wave = 5;
      const waveFive = sim.spawnEnemy(PHASE1.ENEMY_TYPE);
      expect(waveFive.maxHp).toBeCloseTo(10 * 1.48); // 1 + 4 * 0.12
    });
  });

  describe('Auto-attack (Dewdrop Barrage)', () => {
    it('fires without player input once an enemy is in range', () => {
      const sim = makeSim();
      const fired = vi.fn();
      sim.bus.on('weapon:fire', fired);

      sim.enemies.push(makeEnemyAt(sim, sim.state.player.x + 120, sim.state.player.y));
      sim.update(STEP);

      expect(fired).toHaveBeenCalledTimes(1);
      expect(sim.projectiles.length).toBe(1);
    });

    it('holds fire when no enemy is within acquisition range', () => {
      const sim = makeSim();
      sim.update(STEP);
      expect(sim.projectiles.length).toBe(0);
    });

    it('respects the card cooldown between volleys', () => {
      const sim = makeSim();
      const stats = getCardById('dewdrop_barrage').levels[0];
      sim.enemies.push(makeEnemyAt(sim, sim.state.player.x + 400, sim.state.player.y));

      sim.update(STEP);
      expect(sim.projectiles.length).toBe(1);

      advance(sim, stats.cooldown * 0.5);
      const midway = sim.projectiles.filter((p) => p.alive).length;
      expect(midway).toBeLessThanOrEqual(1);
    });

    it('kills an enemy and drops an XP orb at its position', () => {
      const sim = makeSim();
      const killed = vi.fn();
      sim.bus.on('enemy:killed', killed);

      // Placed beyond the orb attract radius so the drop stays where it fell.
      const enemy = makeEnemyAt(sim, sim.state.player.x + 200, sim.state.player.y);
      sim.enemies.push(enemy);

      // Level 1 barrage deals 12 vs Tarling's 10 HP: one hit is lethal.
      advance(sim, 0.6);

      expect(enemy.alive).toBe(false);
      expect(sim.state.kills).toBe(1);
      expect(sim.state.score).toBe(10);
      expect(killed).toHaveBeenCalledTimes(1);
      expect(sim.orbs.length).toBe(1);
      expect(sim.orbs[0].value).toBe(4);
    });
  });

  describe('XP orbs and levelling', () => {
    it('collects an orb on contact and awards XP', () => {
      const sim = makeSim();
      const player = sim.state.player;
      sim.spawnOrb(player.x + 5, player.y, 7);

      sim.update(STEP);

      expect(sim.orbs.length).toBe(0);
      expect(sim.state.player.xp).toBe(7);
    });

    it('pulls nearby orbs toward the Dewling', () => {
      const sim = makeSim();
      const player = sim.state.player;
      const orbX = player.x + ORB_CFG.ATTRACT_RADIUS - 10;
      sim.spawnOrb(orbX, player.y, 1);

      sim.update(STEP);

      expect(sim.orbs[0].x).toBeLessThan(orbX);
    });

    it('leaves distant orbs where they fell', () => {
      const sim = makeSim();
      const player = sim.state.player;
      const orbX = player.x + ORB_CFG.ATTRACT_RADIUS + 50;
      sim.spawnOrb(orbX, player.y, 1);

      sim.update(STEP);

      expect(sim.orbs[0].x).toBe(orbX);
    });

    it('upgrades the starter weapon on level up (Phase 1 stand-in for cards)', () => {
      const sim = makeSim();
      expect(sim.state.activeCards.get('dewdrop_barrage')).toBe(1);

      sim.state.addXp(20); // level 2

      expect(sim.state.player.level).toBe(2);
      expect(sim.state.activeCards.get('dewdrop_barrage')).toBe(2);
      expect(sim.getWeaponStats().damage).toBe(16);
    });

    it('grants max HP once the starter weapon is fully upgraded', () => {
      const sim = makeSim();
      const baseMaxHp = sim.state.player.maxHp;

      // Four level-ups take Dewdrop Barrage from 1 to its max of 5.
      for (let i = 0; i < 4; i++) sim.state.addXp(sim.state.player.xpToNextLevel);
      expect(sim.state.activeCards.get('dewdrop_barrage')).toBe(5);
      expect(sim.state.player.maxHp).toBe(baseMaxHp);

      sim.state.addXp(sim.state.player.xpToNextLevel);
      expect(sim.state.player.maxHp).toBe(baseMaxHp + PHASE1.OVERFLOW_LEVEL_HP);
    });
  });

  describe('Contact damage', () => {
    it('damages the Dewling on touch, then grants invulnerability frames', () => {
      const sim = makeSim();
      const player = sim.state.player;
      const enemy = makeEnemyAt(sim, player.x, player.y);
      enemy.speed = 0;
      // Tanky enough to survive the auto-attack and keep applying contact damage.
      enemy.hp = 10000;
      enemy.maxHp = 10000;
      sim.enemies.push(enemy);

      sim.update(STEP);
      expect(player.hp).toBe(92); // 100 - 8 contact damage
      expect(sim.invulnTimer).toBeCloseTo(PLAYER_CFG.INVULN_SEC);

      // Still overlapping, but protected for the duration of the i-frames.
      advance(sim, PLAYER_CFG.INVULN_SEC * 0.5);
      expect(player.hp).toBe(92);

      advance(sim, PLAYER_CFG.INVULN_SEC);
      expect(player.hp).toBeLessThan(92);
    });

    it('ends the run when HP is exhausted', () => {
      const sim = makeSim();
      const gameOver = vi.fn();
      sim.bus.on('game:over', gameOver);

      sim.state.damagePlayer(100);

      expect(sim.state.currentState).toBe(GAME_STATES.GAME_OVER);
      expect(gameOver).toHaveBeenCalledTimes(1);

      // A finished run must not keep simulating.
      const before = sim.state.player.x;
      advance(sim, 1, { x: 1, y: 0 });
      expect(sim.state.player.x).toBe(before);
    });
  });

  describe('Run flow (fixed 5 waves)', () => {
    it('clears the field and advances after the wave break', () => {
      const sim = makeSim();
      const reached = advanceUntil(sim, (s) => s.state.currentState === GAME_STATES.WAVE_COMPLETE);

      expect(reached).toBe(true);
      expect(sim.state.waveTimeRemaining).toBe(0);
      expect(sim.enemies.length).toBe(0);

      advance(sim, PHASE1.WAVE_BREAK_SEC + STEP);
      expect(sim.state.currentState).toBe(GAME_STATES.RUNNING);
      expect(sim.state.wave).toBe(2);
      expect(sim.state.waveTimeRemaining).toBe(getWaveDuration(2));
    });

    it('still lets the player collect orbs during the wave break', () => {
      const sim = makeSim();
      advanceUntil(sim, (s) => s.state.currentState === GAME_STATES.WAVE_COMPLETE);

      const player = sim.state.player;
      const xpBefore = player.xp;
      sim.spawnOrb(player.x + 5, player.y, 3);
      sim.update(STEP);

      expect(sim.state.currentState).toBe(GAME_STATES.WAVE_COMPLETE);
      expect(sim.state.player.xp).toBe(xpBefore + 3);
    });

    it('wins the run after surviving all 5 waves', () => {
      const sim = makeSim();
      const victory = vi.fn();
      sim.bus.on('game:victory', victory);

      // This test covers wave *flow*, not survival: make the Dewling unkillable
      // so contact damage cannot end the run early.
      sim.state.player.maxHp = 1e6;
      sim.state.player.hp = 1e6;

      const budget = PHASE1.MAX_WAVES * (getWaveDuration(1) + PHASE1.WAVE_BREAK_SEC) + 10;
      const won = advanceUntil(sim, (s) => s.state.currentState === GAME_STATES.VICTORY, budget);

      expect(won).toBe(true);
      expect(sim.state.wave).toBe(PHASE1.MAX_WAVES);
      expect(victory).toHaveBeenCalledTimes(1);
    });

    it('does not advance past the final wave', () => {
      const sim = makeSim();
      sim.state.wave = PHASE1.MAX_WAVES;
      sim.state.completeWave();

      expect(sim.state.currentState).toBe(GAME_STATES.VICTORY);

      advance(sim, PHASE1.WAVE_BREAK_SEC * 2);
      expect(sim.state.wave).toBe(PHASE1.MAX_WAVES);
      expect(sim.state.currentState).toBe(GAME_STATES.VICTORY);
    });

    it('runs endlessly when no wave limit is configured', () => {
      const sim = makeSim({ maxWaves: Infinity });
      sim.state.player.maxHp = 1e6;
      sim.state.player.hp = 1e6;

      const advanced = advanceUntil(sim, (s) => s.state.wave === 2, 60);

      expect(advanced).toBe(true);
      expect(sim.state.currentState).toBe(GAME_STATES.RUNNING);
    });

    it('resets entities and stats when a new run starts', () => {
      const sim = makeSim();
      advance(sim, 5);
      expect(sim.enemies.length).toBeGreaterThan(0);

      sim.startRun();

      expect(sim.enemies.length).toBe(0);
      expect(sim.projectiles.length).toBe(0);
      expect(sim.orbs.length).toBe(0);
      expect(sim.state.wave).toBe(1);
      expect(sim.state.kills).toBe(0);
      expect(sim.state.player.hp).toBe(100);
      expect(sim.state.activeCards.get('dewdrop_barrage')).toBe(1);
    });
  });

  describe('Playability sanity (Phase 1 acceptance)', () => {
    it('is winnable by a competent player and survives a full playthrough', () => {
      const sim = makeSim();

      // Naive "good player" policy: run from the nearest threat.
      for (let step = 0; step < 60 * 60 * 5; step++) {
        const status = sim.state.currentState;
        if (status === GAME_STATES.VICTORY || status === GAME_STATES.GAME_OVER) break;

        const player = sim.state.player;
        const threat = sim.findNearestEnemy(400);
        const input = threat
          ? { x: player.x - threat.x, y: player.y - threat.y }
          : { x: 0, y: 0 };
        sim.update(STEP, input);
      }

      expect(sim.state.currentState).toBe(GAME_STATES.VICTORY);
      expect(sim.state.kills).toBeGreaterThan(50);
      expect(sim.state.player.level).toBeGreaterThan(1);
    });
  });
});

/**
 * Build (but do not register) a Tarling at a fixed position.
 * @param {Simulation} sim
 */
function makeEnemyAt(sim, x, y) {
  const enemy = sim.spawnEnemy(PHASE1.ENEMY_TYPE);
  sim.enemies.pop();
  enemy.x = x;
  enemy.y = y;
  return enemy;
}
