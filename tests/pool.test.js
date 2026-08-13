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
