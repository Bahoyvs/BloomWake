import { describe, it, expect } from 'vitest';
import { ENEMIES, ENEMY_TYPES, calculateTelegraphMs, getUnlockedEnemiesForWave } from '../src/data/enemies.js';
import { Simulation } from '../src/core/simulation.js';

describe('Frutevil Enemy Roster & Boss Telegraph (Phase 4)', () => {
  it('calculates Rustwhale Boss telegraph duration deterministically', () => {
    // telegraph_ms = (AoE_radius / dewling_speed) * 1000 + 300ms_safety_margin
    // Example: radius 130px, dewling speed 3.2 * 32 = 102.4 px/s
    const ms = calculateTelegraphMs(130, 102.4, 300);
    expect(ms).toBeCloseTo(1569.53, 1);
  });

  it('unlocks enemy types progressively by wave threshold', () => {
    const wave1 = getUnlockedEnemiesForWave(1).map((e) => e.id);
    const wave3 = getUnlockedEnemiesForWave(3).map((e) => e.id);
    const wave4 = getUnlockedEnemiesForWave(4).map((e) => e.id);
    const wave6 = getUnlockedEnemiesForWave(6).map((e) => e.id);
    const wave8 = getUnlockedEnemiesForWave(8).map((e) => e.id);

    expect(wave1).toEqual(['tarling']);
    expect(wave3).toEqual(['tarling', 'ashfish']);
    expect(wave4).toEqual(['tarling', 'ashfish', 'cracked_wisp']);
    expect(wave6).toEqual(['tarling', 'ashfish', 'cracked_wisp', 'rustbloom']);
    expect(wave8).toEqual(['tarling', 'ashfish', 'cracked_wisp', 'rustbloom', 'smogmoth']);
  });

  it('spawns scaled Rustwhale Bosses on waves 5 (Boss 1), 10 (Boss 2), and 15 (Final Boss)', () => {
    const sim = new Simulation({ seed: 42 });
    sim.startRun();

    // Wave 5: Boss 1
    sim.state.wave = 5;
    sim.spawner.beginWave(5);
    sim.update(0.1);
    let boss = sim.enemies.find((e) => e.isBoss);
    expect(boss).toBeDefined();
    expect(boss.hp).toBe(650); // 400 + (5/5)*250

    // Reset enemies and check Wave 10: Boss 2
    sim.enemies.length = 0;
    sim.state.wave = 10;
    sim.spawner.beginWave(10);
    sim.update(0.1);
    boss = sim.enemies.find((e) => e.isBoss);
    expect(boss).toBeDefined();
    expect(boss.hp).toBe(900); // 400 + (10/5)*250

    // Reset enemies and check Wave 15: Final Boss
    sim.enemies.length = 0;
    sim.state.wave = 15;
    sim.spawner.beginWave(15);
    sim.update(0.1);
    boss = sim.enemies.find((e) => e.isBoss);
    expect(boss).toBeDefined();
    expect(boss.hp).toBe(1150); // 400 + (15/5)*250
  });

  it('triggers Rustwhale telegraph attack and eruption event', () => {
    const sim = new Simulation({ seed: 100 });
    sim.startRun();
    sim.state.wave = 5;
    sim.spawner.beginWave(5);

    let telegraphStarted = false;
    let telegraphErupted = false;

    sim.bus.on('boss:telegraph_start', () => { telegraphStarted = true; });
    sim.bus.on('boss:telegraph_erupt', () => { telegraphErupted = true; });

    // Step simulation to trigger boss telegraph
    for (let i = 0; i < 30; i++) {
      sim.update(0.1);
    }

    expect(telegraphStarted).toBe(true);

    // Advance time until telegraph erupts
    for (let i = 0; i < 30; i++) {
      sim.update(0.1);
    }

    expect(telegraphErupted).toBe(true);
  });

  it('spawns Rustbloom spore hazard pools', () => {
    const sim = new Simulation({ seed: 99 });
    sim.startRun();

    const rustbloom = sim.spawnEnemy(ENEMY_TYPES.RUSTBLOOM);
    rustbloom.sporeTimer = 0.05;

    sim.update(0.1);

    expect(sim.sporePools.length).toBeGreaterThan(0);
    expect(sim.sporePools[0].radius).toBe(35);
  });
});
