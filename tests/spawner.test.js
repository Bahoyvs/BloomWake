import { describe, it, expect } from 'vitest';
import { WaveSpawner } from '../src/core/spawner.js';
import { WORLD, SPAWN_CFG } from '../src/core/constants.js';
import { mulberry32, length } from '../src/core/math.js';
import { getEnemyCount } from '../src/core/wave.js';

describe('WaveSpawner (Phase 1 spawn scheduling)', () => {
  it('adopts the wave enemy cap from the GDD wave formula', () => {
    const spawner = new WaveSpawner(mulberry32(1));

    spawner.beginWave(1);
    expect(spawner.cap).toBe(getEnemyCount(1)); // 14

    spawner.beginWave(5);
    expect(spawner.cap).toBe(getEnemyCount(5)); // 38
  });

  it('spawns immediately on the first step so a wave never opens empty', () => {
    const spawner = new WaveSpawner(mulberry32(1));
    spawner.beginWave(1);

    expect(spawner.update(1 / 60, 0)).toBe(1);
  });

  it('spaces spawns by the computed interval', () => {
    const spawner = new WaveSpawner(mulberry32(1));
    spawner.beginWave(1);
    // 35s wave * 0.4 fill / 14 cap = 1.0s interval
    expect(spawner.interval).toBeCloseTo(1.0);

    spawner.update(1 / 60, 0); // consumes the opening spawn
    expect(spawner.update(0.5, 1)).toBe(0);
    expect(spawner.update(0.6, 1)).toBe(1);
  });

  it('never exceeds the concurrent cap', () => {
    const spawner = new WaveSpawner(mulberry32(1));
    spawner.beginWave(1);
    const cap = getEnemyCount(1);

    // Far more elapsed time than the cap's worth of intervals.
    expect(spawner.update(cap * spawner.interval * 4, 0)).toBe(cap);
    expect(spawner.update(60, cap)).toBe(0);
    expect(spawner.update(60, cap - 2)).toBe(2);
  });

  it('refills promptly once a slot frees up', () => {
    const spawner = new WaveSpawner(mulberry32(1));
    spawner.beginWave(1);
    const cap = getEnemyCount(1);

    spawner.update(10, 0);
    spawner.update(1, cap); // full field
    expect(spawner.update(1 / 60, cap - 1)).toBe(1);
  });

  it('keeps every spawn inside the arena and off-screen, even in corners', () => {
    const spawner = new WaveSpawner(mulberry32(99));
    const positions = [
      [0, 0],
      [WORLD.WIDTH, WORLD.HEIGHT],
      [WORLD.WIDTH, 0],
      [0, WORLD.HEIGHT],
      [WORLD.WIDTH / 2, WORLD.HEIGHT / 2],
    ];

    for (const [px, py] of positions) {
      for (let i = 0; i < 400; i++) {
        const pos = spawner.spawnPosition(px, py);

        expect(pos.x).toBeGreaterThanOrEqual(0);
        expect(pos.x).toBeLessThanOrEqual(WORLD.WIDTH);
        expect(pos.y).toBeGreaterThanOrEqual(0);
        expect(pos.y).toBeLessThanOrEqual(WORLD.HEIGHT);

        // Edge mirroring preserves the ring distance exactly.
        const dist = length(pos.x - px, pos.y - py);
        expect(dist).toBeGreaterThanOrEqual(SPAWN_CFG.MIN_RADIUS - 1e-6);
        expect(dist).toBeLessThanOrEqual(SPAWN_CFG.MAX_RADIUS + 1e-6);
      }
    }
  });

  it('holds the arena invariant the mirroring depends on', () => {
    expect(Math.min(WORLD.WIDTH, WORLD.HEIGHT)).toBeGreaterThan(SPAWN_CFG.MAX_RADIUS * 2);
  });
});
