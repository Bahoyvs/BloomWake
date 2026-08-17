/**
 * Tier B juice functions — purity, determinism and allocation behaviour.
 *
 * The property that matters most here is that no state leaks between entities.
 * The renderer deliberately reuses ONE transform object for all 200 enemies in
 * a frame (allocating per enemy would be exactly the GC churn Phase 2 removed),
 * which means a function that forgot to write a field would silently show the
 * previous enemy's value. These tests pin that down.
 */

import { describe, it, expect } from 'vitest';
import {
  DEATH_DISSOLVE_SEC,
  HIT_FLASH_SEC,
  SPAWN_GROW_SEC,
  applyJuice,
  createTransform,
  deathDissolve,
  facingRotation,
  flutter,
  getJuiceProfile,
  hitFlash,
  idleBreathe,
  resetTransform,
  sharedCycleFrame,
  spawnGrow,
} from '../src/render/juice.js';

/**
 * @param {Object} [overrides]
 * @returns {Object} A pooled-entity-shaped stand-in
 */
function makeEntity(overrides = {}) {
  return {
    typeId: 'ashfish',
    x: 100,
    y: 100,
    vx: 30,
    vy: 40,
    phaseOffset: 1.234,
    spawnTime: 0,
    lastHitTime: -Infinity,
    deathTime: -Infinity,
    ...overrides,
  };
}

describe('juice functions are pure', () => {
  it('flutter gives the same output for the same input', () => {
    const entity = makeEntity();
    const a = flutter(entity, 3.5);
    const b = flutter(entity, 3.5);
    expect(a.scaleY).toBe(b.scaleY);
  });

  it('flutter does not mutate the entity', () => {
    const entity = makeEntity();
    const snapshot = { ...entity };
    flutter(entity, 2.2);
    expect(entity).toEqual(snapshot);
  });

  it('every function leaves its entity untouched', () => {
    const t = 4.2;
    for (const fn of [flutter, spawnGrow, hitFlash, deathDissolve, idleBreathe]) {
      const entity = makeEntity({ deathTime: 3.0, lastHitTime: 4.19 });
      const snapshot = { ...entity };
      fn(entity, t);
      expect(entity, `${fn.name} mutated its entity`).toEqual(snapshot);
    }

    const entity = makeEntity();
    const snapshot = { ...entity };
    facingRotation(entity);
    expect(entity).toEqual(snapshot);
  });

  it('holds no module state — two entities never influence each other', () => {
    const first = makeEntity({ phaseOffset: 0 });
    const second = makeEntity({ phaseOffset: 3.0 });

    const firstAlone = flutter(first, 1.0).scaleY;

    // Interleave the two and re-measure the first.
    flutter(second, 1.0);
    flutter(second, 9.0);
    const firstAgain = flutter(first, 1.0).scaleY;

    expect(firstAgain).toBe(firstAlone);
  });

  it('gives different phases to entities with different phaseOffset', () => {
    // The reason phaseOffset exists: a swarm flickering in unison reads as one
    // organism rather than 150.
    const values = new Set();
    for (let i = 0; i < 20; i++) {
      values.add(flutter(makeEntity({ phaseOffset: i * 0.31 }), 1.0).scaleY);
    }
    expect(values.size).toBeGreaterThan(15);
  });

  it('applyJuice is deterministic across repeated calls', () => {
    const entity = makeEntity({ spawnTime: 0.5, lastHitTime: 1.0, deathTime: -Infinity });
    const a = applyJuice(entity, 2.0, createTransform());
    const b = applyJuice(entity, 2.0, createTransform());
    expect(a).toEqual(b);
  });
});

describe('juice functions do not leak between entities through a shared transform', () => {
  it('applyJuice resets the transform before writing', () => {
    const shared = createTransform();

    const dying = makeEntity({ deathTime: 1.0 });
    applyJuice(dying, 1.1, shared);
    expect(shared.alpha).toBeLessThan(1);
    expect(shared.flash).toBe(false);

    // A healthy entity reusing the same object must come back fully opaque.
    const healthy = makeEntity({ spawnTime: -10 });
    applyJuice(healthy, 1.1, shared);
    expect(shared.alpha).toBe(1);
  });

  it('does not carry a hit flash to the next entity', () => {
    const shared = createTransform();

    applyJuice(makeEntity({ lastHitTime: 2.0, spawnTime: -10 }), 2.0, shared);
    expect(shared.flash).toBe(true);

    applyJuice(makeEntity({ spawnTime: -10 }), 2.0, shared);
    expect(shared.flash).toBe(false);
  });

  it('does not carry rotation from a facing type to a stationary one', () => {
    const shared = createTransform();

    applyJuice(makeEntity({ typeId: 'ashfish', spawnTime: -10 }), 1.0, shared);
    expect(shared.rotation).not.toBe(0);

    applyJuice(makeEntity({ typeId: 'rustbloom', spawnTime: -10 }), 1.0, shared);
    expect(shared.rotation).toBe(0);
  });

  it('gives the same result whether or not the transform is reused', () => {
    const entity = makeEntity({ spawnTime: 0.1, lastHitTime: 0.9, deathTime: -Infinity });

    const shared = createTransform();
    applyJuice(makeEntity({ deathTime: 0.0, typeId: 'rustbloom' }), 1.0, shared);
    const reused = { ...applyJuice(entity, 1.0, shared) };

    const fresh = { ...applyJuice(entity, 1.0, createTransform()) };

    expect(reused).toEqual(fresh);
  });
});

describe('juice functions allocate nothing when given a transform', () => {
  it('returns the very object it was handed', () => {
    const out = createTransform();
    expect(flutter(makeEntity(), 1, out)).toBe(out);
    expect(facingRotation(makeEntity(), out)).toBe(out);
    expect(spawnGrow(makeEntity(), 1, out)).toBe(out);
    expect(hitFlash(makeEntity(), 1, out)).toBe(out);
    expect(deathDissolve(makeEntity(), 1, out)).toBe(out);
    expect(idleBreathe(makeEntity(), 1, out)).toBe(out);
    expect(applyJuice(makeEntity(), 1, out)).toBe(out);
  });

  it('holds one object across a simulated 200-enemy frame', () => {
    const out = createTransform();
    const swarm = [];
    for (let i = 0; i < 200; i++) {
      swarm.push(makeEntity({ phaseOffset: i * 0.05, spawnTime: i * 0.001 }));
    }

    for (const entity of swarm) {
      const result = applyJuice(entity, 5.0, out);
      expect(result).toBe(out);
    }
  });
});

describe('individual transforms behave as specified', () => {
  it('flutter squashes within +/- 8%', () => {
    for (let t = 0; t < 5; t += 0.05) {
      const { scaleY } = flutter(makeEntity(), t);
      expect(scaleY).toBeGreaterThanOrEqual(0.92 - 1e-9);
      expect(scaleY).toBeLessThanOrEqual(1.08 + 1e-9);
    }
  });

  it('facingRotation points along velocity, not at the origin', () => {
    expect(facingRotation({ vx: 1, vy: 0 }).rotation).toBeCloseTo(0, 10);
    expect(facingRotation({ vx: 0, vy: 1 }).rotation).toBeCloseTo(Math.PI / 2, 10);
    expect(facingRotation({ vx: -1, vy: 0 }).rotation).toBeCloseTo(Math.PI, 10);
  });

  it('facingRotation leaves a motionless entity unrotated', () => {
    expect(facingRotation({ vx: 0, vy: 0 }).rotation).toBe(0);
  });

  it('spawnGrow starts small and settles at full size', () => {
    const entity = makeEntity({ spawnTime: 10 });

    expect(spawnGrow(entity, 10).scaleX).toBeCloseTo(0, 6);
    expect(spawnGrow(entity, 10 + SPAWN_GROW_SEC).scaleX).toBe(1);
    expect(spawnGrow(entity, 10 + SPAWN_GROW_SEC * 5).scaleX).toBe(1);
  });

  it('spawnGrow reaches full size in well under a fifth of a second', () => {
    expect(SPAWN_GROW_SEC).toBeLessThanOrEqual(0.2);
  });

  it('hitFlash is on for a frame or two, then off', () => {
    const entity = makeEntity({ lastHitTime: 3.0 });

    expect(hitFlash(entity, 3.0).flash).toBe(true);
    expect(hitFlash(entity, 3.0 + HIT_FLASH_SEC / 2).flash).toBe(true);
    expect(hitFlash(entity, 3.0 + HIT_FLASH_SEC + 0.001).flash).toBe(false);
    expect(hitFlash(entity, 2.9).flash).toBe(false);
  });

  it('hitFlash is off for an entity that has never been hit', () => {
    expect(hitFlash(makeEntity(), 100).flash).toBe(false);
  });

  it('deathDissolve fades to fully transparent and shrinks', () => {
    const entity = makeEntity({ deathTime: 2.0 });

    expect(deathDissolve(entity, 2.0).alpha).toBe(1);
    expect(deathDissolve(entity, 2.0 + DEATH_DISSOLVE_SEC / 2).alpha).toBeCloseTo(0.5, 6);
    expect(deathDissolve(entity, 2.0 + DEATH_DISSOLVE_SEC).alpha).toBe(0);
    expect(deathDissolve(entity, 99).alpha).toBe(0);

    expect(deathDissolve(entity, 2.0 + DEATH_DISSOLVE_SEC).scaleX).toBeLessThan(1);
  });

  it('deathDissolve alpha falls monotonically', () => {
    const entity = makeEntity({ deathTime: 0 });
    let previous = Infinity;
    for (let t = 0; t <= DEATH_DISSOLVE_SEC; t += 0.01) {
      const { alpha } = deathDissolve(entity, t);
      expect(alpha).toBeLessThanOrEqual(previous + 1e-9);
      previous = alpha;
    }
  });

  it('idleBreathe stays within 1.4%', () => {
    for (let t = 0; t < 10; t += 0.05) {
      const { scaleX } = idleBreathe(makeEntity(), t);
      expect(Math.abs(scaleX - 1)).toBeLessThanOrEqual(0.014 + 1e-9);
    }
  });

  it('resetTransform restores the neutral pose', () => {
    const out = createTransform();
    out.scaleX = 3;
    out.rotation = 1;
    out.alpha = 0.1;
    out.flash = true;

    expect(resetTransform(out)).toEqual({
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      alpha: 1,
      flash: false,
    });
  });
});

describe('juice profiles', () => {
  it('gives stationary types breathing instead of flutter', () => {
    expect(getJuiceProfile('rustbloom').stationary).toBe(true);
    expect(getJuiceProfile('ashfish').stationary).toBeUndefined();
  });

  it('falls back to a sane default for an unknown future swarm type', () => {
    const profile = getJuiceProfile('some_future_enemy');
    expect(profile.flutter).toBe(true);
  });

  it('applies breathing, not flutter, to a stationary type', () => {
    const rustbloom = makeEntity({ typeId: 'rustbloom', spawnTime: -10 });
    const out = applyJuice(rustbloom, 1.0, createTransform());
    // Breathing amplitude is 1.4%; flutter would be up to 8%.
    expect(Math.abs(out.scaleY - 1)).toBeLessThanOrEqual(0.014 + 1e-9);
  });
});

describe('Step B3 — shared swim-cycle frame index', () => {
  it('cycles through frames', () => {
    expect(sharedCycleFrame(0, 0, 8, 3)).toBe(0);
    expect(sharedCycleFrame(0.125, 0, 8, 3)).toBe(1);
    expect(sharedCycleFrame(0.25, 0, 8, 3)).toBe(2);
    expect(sharedCycleFrame(0.375, 0, 8, 3)).toBe(0);
  });

  it('stays in range for any input', () => {
    for (let t = 0; t < 20; t += 0.13) {
      for (const phase of [0, 1.7, 5.9, 100]) {
        const index = sharedCycleFrame(t, phase, 12, 5);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(5);
      }
    }
  });

  it('desynchronises instances by phase alone', () => {
    // One sheet, one fps, one frame count — the only per-instance input is a
    // single number, which is the whole point of the Tier B cycle layer.
    const frames = new Set();
    for (let i = 0; i < 3; i++) frames.add(sharedCycleFrame(0, i * 0.125, 8, 3));
    expect(frames.size).toBe(3);
  });

  it('returns frame 0 for a single-frame or absent sheet', () => {
    expect(sharedCycleFrame(5, 1, 8, 1)).toBe(0);
    expect(sharedCycleFrame(5, 1, 8, 0)).toBe(0);
    expect(sharedCycleFrame(5, 1, 0, 6)).toBe(0);
  });
});

describe('Step B4 — Tier B stays out of shader territory', () => {
  it('juice.js contains no WebGL, shader, spring or metaball code', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(new URL('../src/render/juice.js', import.meta.url), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    for (const pattern of [/webgl/i, /shader/i, /uniform/i, /metaball/i, /softbody/i, /\bspring\b/i]) {
      expect(code).not.toMatch(pattern);
    }
  });

  it('imports nothing at all — no pixi, no DOM', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/render/juice.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import /m);
  });
});
