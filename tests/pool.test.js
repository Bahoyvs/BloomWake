import { describe, it, expect } from 'vitest';
import { ObjectPool, sweepToPool } from '../src/core/pool.js';
import { Simulation } from '../src/core/simulation.js';
import { GameState } from '../src/core/game-state.js';
import { EventBus } from '../src/core/event-bus.js';
import { PHASE1 } from '../src/core/constants.js';

const makeThing = () => ({ id: 0, alive: false });

describe('ObjectPool', () => {
  it('pre-allocates the requested number of objects', () => {
    const pool = new ObjectPool(makeThing, 10);
    expect(pool.available).toBe(10);
    expect(pool.created).toBe(10);
  });

  it('hands out pre-allocated objects before building new ones', () => {
    const pool = new ObjectPool(makeThing, 3);
    for (let i = 0; i < 3; i++) pool.acquire();

    expect(pool.created).toBe(3);
    expect(pool.reused).toBe(3);
    expect(pool.available).toBe(0);
  });

  it('grows only when the pool is exhausted', () => {
    const pool = new ObjectPool(makeThing, 1);
    pool.acquire();
    pool.acquire();

    expect(pool.created).toBe(2);
  });

  it('recycles released objects instead of allocating', () => {
    const pool = new ObjectPool(makeThing, 1);
    const first = pool.acquire();
    pool.release(first);
    const second = pool.acquire();

    expect(second).toBe(first);
    expect(pool.created).toBe(1);
  });

  it('marks released objects dead', () => {
    const pool = new ObjectPool(makeThing, 1);
    const obj = pool.acquire();
    obj.alive = true;
    pool.release(obj);

    expect(obj.alive).toBe(false);
  });
});

describe('sweepToPool', () => {
  it('keeps live entries and recycles dead ones', () => {
    const pool = new ObjectPool(makeThing, 0);
    const list = [
      { id: 1, alive: true },
      { id: 2, alive: false },
      { id: 3, alive: true },
      { id: 4, alive: false },
    ];

    sweepToPool(list, pool);

    expect(list.map((item) => item.id)).toEqual([1, 3]);
    expect(pool.available).toBe(2);
  });

  it('preserves order of the survivors', () => {
    const pool = new ObjectPool(makeThing, 0);
    const list = [
      { id: 1, alive: false },
      { id: 2, alive: true },
      { id: 3, alive: true },
    ];

    sweepToPool(list, pool);

    expect(list.map((item) => item.id)).toEqual([2, 3]);
  });

  it('empties a list of entirely dead entries', () => {
    const pool = new ObjectPool(makeThing, 0);
    const list = [
      { id: 1, alive: false },
      { id: 2, alive: false },
    ];

    sweepToPool(list, pool);

    expect(list).toHaveLength(0);
    expect(pool.available).toBe(2);
  });
});

describe('Card-spawned entities are pooled', () => {
  /** @returns {Simulation} */
  function makeSim(cardId, level) {
    const bus = new EventBus();
    const state = new GameState(bus, { maxWaves: PHASE1.MAX_WAVES });
    const sim = new Simulation({ bus, state, seed: 11 });
    sim.startRun();
    state.activeCards.clear();
    sim.cards.runtime.clear();
    for (let i = 0; i < level; i++) state.selectCard(cardId);
    sim.cards.onCardChanged(cardId);
    sim.updateSpawning = () => {};
    return sim;
  }

  it('reuses projectiles across Petal Storm bursts instead of allocating', () => {
    const sim = makeSim('petal_storm', 5); // 16 petals per burst
    const baseline = sim.projectilePool.created;

    // Several full bursts, each of which must fit inside the existing pool.
    for (let i = 0; i < 60 * 12; i++) sim.update(1 / 60, { x: 0, y: 0 });

    expect(sim.projectilePool.reused).toBeGreaterThan(16);
    expect(sim.projectilePool.created).toBe(baseline);
  });

  it('recycles Glasswing blades when the card levels up', () => {
    const sim = makeSim('glasswing', 1); // 2 blades
    sim.update(1 / 60, { x: 0, y: 0 });
    expect(sim.cards.blades).toHaveLength(2);

    const createdAtStart = sim.bladePool.created;
    for (let lv = 1; lv < 5; lv++) {
      sim.state.selectCard('glasswing');
      sim.update(1 / 60, { x: 0, y: 0 });
    }

    expect(sim.cards.blades).toHaveLength(6);
    // Growing from 2 to 6 blades needs at most 4 more objects, not a fresh ring
    // on every level-up.
    expect(sim.bladePool.created - createdAtStart).toBeLessThanOrEqual(4);
  });

  it('returns blades to the pool on reset', () => {
    const sim = makeSim('glasswing', 5);
    sim.update(1 / 60, { x: 0, y: 0 });
    expect(sim.cards.blades).toHaveLength(6);

    const availableBefore = sim.bladePool.available;
    sim.resetEntities();

    expect(sim.cards.blades).toHaveLength(0);
    expect(sim.bladePool.available).toBe(availableBefore + 6);
  });

  it('recycles AoE ring effects', () => {
    const sim = makeSim('aurora_pulse', 5);
    const baseline = sim.effectPool.created;

    for (let i = 0; i < 60 * 20; i++) sim.update(1 / 60, { x: 0, y: 0 });

    expect(sim.effectPool.reused).toBeGreaterThan(5);
    expect(sim.effectPool.created).toBe(baseline);
  });

  it('does not leak projectiles when a wave ends', () => {
    const sim = makeSim('petal_storm', 5);
    sim.update(1 / 60, { x: 0, y: 0 });
    expect(sim.projectiles.length).toBeGreaterThan(0);

    const availableBefore = sim.projectilePool.available;
    const live = sim.projectiles.length;
    sim.onWaveComplete();

    expect(sim.projectiles).toHaveLength(0);
    expect(sim.projectilePool.available).toBe(availableBefore + live);
  });
});

/**
 * PHASE 7 REGRESSION — Tier B added four fields (phaseOffset, spawnTime,
 * lastHitTime, deathTime) plus vx/vy to every enemy. The requirement is that
 * this costs nothing in the spawn/despawn hot path.
 *
 * A NOTE ON WHAT CHANGED: before Phase 7 enemies were NOT pooled at all — they
 * were fresh object literals dropped on the floor by removeDead(). Adding four
 * fields to that shape would have been strictly more garbage per spawn, at a
 * 200-enemy cap with continuous refill. So enemies were moved onto the same
 * ObjectPool the card-spawned entities use. These tests assert the identity
 * churn is now zero, not merely unchanged.
 */
describe('Enemy pooling with Tier B animation fields', () => {
  /** @returns {Simulation} */
  function runningSim(seed = 7) {
    const bus = new EventBus();
    const state = new GameState(bus, { maxWaves: PHASE1.MAX_WAVES });
    const sim = new Simulation({ bus, state, seed });
    sim.startRun();
    return sim;
  }

  it('gives every spawned enemy the four Tier B fields', () => {
    const sim = runningSim();
    const enemy = sim.spawnEnemy('ashfish');

    expect(typeof enemy.phaseOffset).toBe('number');
    expect(typeof enemy.spawnTime).toBe('number');
    expect(enemy.lastHitTime).toBe(-Infinity);
    expect(enemy.deathTime).toBe(-Infinity);
    expect(typeof enemy.vx).toBe('number');
    expect(typeof enemy.vy).toBe('number');
  });

  it('gives the boss the same fields', () => {
    const sim = runningSim();
    const boss = sim.spawnBoss();

    expect(typeof boss.phaseOffset).toBe('number');
    expect(boss.lastHitTime).toBe(-Infinity);
    expect(boss.deathTime).toBe(-Infinity);
  });

  it('spreads phaseOffset across a swarm so it does not flutter in unison', () => {
    const sim = runningSim();
    const offsets = new Set();
    for (let i = 0; i < 60; i++) offsets.add(sim.spawnEnemy('ashfish').phaseOffset);

    expect(offsets.size).toBeGreaterThan(55);
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(Math.PI * 2);
    }
  });

  it('recycles the same objects across a spawn/despawn cycle', () => {
    const sim = runningSim();

    const first = sim.spawnEnemy('tarling');
    const identity = first;
    sim.killEnemy(first);
    sweepToPool(sim.enemies, sim.enemyPool);

    const second = sim.spawnEnemy('tarling');
    expect(second).toBe(identity);
  });

  it('allocates no new enemy objects once the pool is warm', () => {
    const sim = runningSim();

    // Warm the pool to the concurrent load this scenario reaches.
    for (let i = 0; i < 40; i++) sim.spawnEnemy('tarling');
    for (const enemy of sim.enemies) sim.killEnemy(enemy);
    sweepToPool(sim.enemies, sim.enemyPool);

    const createdAfterWarmup = sim.enemyPool.created;
    const reusedAfterWarmup = sim.enemyPool.reused;

    // Many full spawn/despawn cycles inside that warm capacity.
    for (let cycle = 0; cycle < 50; cycle++) {
      for (let i = 0; i < 40; i++) sim.spawnEnemy('ashfish');
      for (const enemy of sim.enemies) sim.killEnemy(enemy);
      sweepToPool(sim.enemies, sim.enemyPool);
    }

    expect(sim.enemyPool.created).toBe(createdAfterWarmup);
    expect(sim.enemyPool.reused - reusedAfterWarmup).toBe(2000);
  });

  it('holds object identity steady across a long live run', () => {
    const sim = runningSim(21);
    // Wave 10's spawn rate, not wave 1's: at wave 1 the spawner is interval-
    // limited to roughly one enemy a second, which never exercises the pool.
    sim.state.wave = 10;
    sim.spawner.beginWave(10);

    /** Distinct OBJECTS handed out. */
    const identities = new Set();
    /** Distinct enemies that ever lived. */
    const lifetimes = new Set();
    let peakConcurrent = 0;

    for (let i = 0; i < 60 * 40; i++) {
      sim.update(1 / 60, { x: Math.sin(i / 30), y: Math.cos(i / 30) });
      peakConcurrent = Math.max(peakConcurrent, sim.enemies.length);
      for (const enemy of sim.enemies) {
        identities.add(enemy);
        lifetimes.add(enemy.id);
      }

      // Kill the front of the queue every few ticks so the spawner keeps
      // refilling. This is the churn the pool exists for; without kills the
      // field just fills to the cap and sits there.
      if (i % 3 === 0 && sim.enemies.length > 0) {
        const victim = sim.enemies[0];
        if (victim.alive) sim.damageEnemy(victim, victim.hp);
      }
    }

    // The real property: many enemies lived, but they shared a small, bounded
    // set of objects. Without pooling these two numbers would be equal, and
    // every spawn would be a fresh allocation carrying six more fields.
    expect(lifetimes.size).toBeGreaterThan(50);
    expect(identities.size).toBeLessThanOrEqual(peakConcurrent);
    expect(identities.size).toBeLessThan(lifetimes.size / 4);

    // The pool never had to grow past what it pre-allocated.
    expect(sim.enemyPool.created).toBe(64);
    expect(sim.enemyPool.reused).toBeGreaterThan(50);
  });

  it('returns wiped enemies to the pool when a wave ends', () => {
    const sim = runningSim();
    for (let i = 0; i < 12; i++) sim.spawnEnemy('tarling');

    const availableBefore = sim.enemyPool.available;
    const live = sim.enemies.length;
    sim.onWaveComplete();

    expect(sim.enemies).toHaveLength(0);
    expect(sim.enemyPool.available).toBe(availableBefore + live);
  });

  it('returns enemies to the pool on reset', () => {
    const sim = runningSim();
    for (let i = 0; i < 8; i++) sim.spawnEnemy('smogmoth');

    const availableBefore = sim.enemyPool.available;
    sim.resetEntities();

    expect(sim.enemies).toHaveLength(0);
    expect(sim.enemyPool.available).toBe(availableBefore + 8);
  });

  it('never hands out a recycled enemy carrying stale animation state', () => {
    const sim = runningSim();

    const first = sim.spawnEnemy('tarling');
    sim.elapsed = 5;
    sim.damageEnemy(first, 1);
    expect(first.lastHitTime).toBe(5);
    sim.killEnemy(first);
    expect(first.deathTime).toBe(5);
    sweepToPool(sim.enemies, sim.enemyPool);

    sim.elapsed = 9;
    const recycled = sim.spawnEnemy('tarling');
    expect(recycled).toBe(first);
    // A stale lastHitTime would flash a brand-new enemy on spawn; a stale
    // deathTime would dissolve it.
    expect(recycled.lastHitTime).toBe(-Infinity);
    expect(recycled.deathTime).toBe(-Infinity);
    expect(recycled.spawnTime).toBe(9);
    expect(recycled.alive).toBe(true);
  });

  it('re-rolls phaseOffset on reuse so the swarm does not re-synchronise', () => {
    const sim = runningSim();
    const offsets = [];

    for (let cycle = 0; cycle < 30; cycle++) {
      const enemy = sim.spawnEnemy('ashfish');
      offsets.push(enemy.phaseOffset);
      sim.killEnemy(enemy);
      sweepToPool(sim.enemies, sim.enemyPool);
    }

    // Same pooled object every time, but a fresh phase on each acquire.
    expect(new Set(offsets).size).toBeGreaterThan(28);
  });

  it('keeps one object shape, so the hot loops stay monomorphic', () => {
    const sim = runningSim();
    const tarling = sim.spawnEnemy('tarling');
    const rustbloom = sim.spawnEnemy('rustbloom');
    const boss = sim.spawnBoss();

    const shape = Object.keys(tarling).sort();
    expect(Object.keys(rustbloom).sort()).toEqual(shape);
    expect(Object.keys(boss).sort()).toEqual(shape);
  });
});
