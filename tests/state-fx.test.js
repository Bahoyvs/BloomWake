/**
 * Phase 7b — procedural state FX, and the three defects that made Tier A
 * invisible without art.
 *
 * THE BUG THIS FILE EXISTS FOR
 * Core emits `hit` and `attack` for exactly one tick, which is correct: core
 * must not know about durations. But the renderer had no minimum display time,
 * so with no sheet on disk the animator flipped straight back and the player
 * saw a single 16ms frame — "one image in a very short time". These tests pin
 * the minimum display times, the state clock advancing in fallback, and the FX
 * actually changing shape over the life of a state.
 */

import { describe, it, expect } from 'vitest';
import {
  AFTERIMAGE,
  BOSS_FX,
  HERO_FX,
  MOVE_WAKE,
  attackRecoil,
  bossStateTransform,
  heroStateTransform,
  stateBurst,
  trailIntensity,
  wakeDue,
} from '../src/render/state-fx.js';
import { SpriteAnimator } from '../src/render/spriteAnimator.js';
import { createTransform, resetTransform } from '../src/render/juice.js';
import { ANIM_STATES, DEWLING_PRIORITY, RUSTWHALE_PRIORITY } from '../src/core/animation.js';
import { calculateTelegraphMs } from '../src/data/enemies.js';
import { UNIT_PX } from '../src/core/constants.js';

/**
 * @param {Object} table
 * @returns {Object}
 */
function toDurations(table) {
  const durations = {};
  for (const [state, config] of Object.entries(table)) durations[state] = config.duration;
  return durations;
}

/**
 * Sample a state's transform across its whole life.
 * @param {Function} fn
 * @param {string} state
 * @param {number} duration
 * @param {number} [samples]
 * @returns {Array<Object>}
 */
function sampleState(fn, state, duration, samples = 24) {
  const frames = [];
  for (let i = 0; i <= samples; i++) {
    const elapsed = (duration * i) / samples;
    const out = resetTransform(createTransform());
    fn(state, elapsed, elapsed, out, {});
    frames.push({ ...out });
  }
  return frames;
}

describe('minimum display time — the one-frame flicker fix', () => {
  it('gives every transient hero state a visible duration', () => {
    // Anything under ~6 frames at 60Hz is not perceivable as an animation.
    for (const state of [ANIM_STATES.ATTACK, ANIM_STATES.HIT, ANIM_STATES.DEATH]) {
      expect(HERO_FX[state].duration).toBeGreaterThanOrEqual(6 / 60);
    }
  });

  it('leaves continuous states unbounded', () => {
    expect(HERO_FX[ANIM_STATES.IDLE].duration).toBe(0);
    expect(HERO_FX[ANIM_STATES.MOVE].duration).toBe(0);
  });

  it('holds a one-tick hit for its full duration with no sheet present', () => {
    const animator = new SpriteAnimator(
      {},
      {
        priority: DEWLING_PRIORITY,
        initialState: ANIM_STATES.MOVE,
        fallbackDurations: toDurations(HERO_FX),
        warn: () => {},
      }
    );

    // Exactly what core does: hit for one tick, then straight back to move.
    animator.requestState(ANIM_STATES.HIT);
    animator.update(1 / 60);
    animator.requestState(ANIM_STATES.MOVE);

    // Before the fix this was already back to 'move' after a single tick.
    expect(animator.state).toBe(ANIM_STATES.HIT);

    // It stays put for the whole window...
    let elapsed = 1 / 60;
    while (elapsed < HERO_FX[ANIM_STATES.HIT].duration - 1 / 60) {
      animator.update(1 / 60);
      elapsed += 1 / 60;
      expect(animator.state).toBe(ANIM_STATES.HIT);
    }

    // ...and only then releases to the queued state.
    animator.update(2 / 60);
    expect(animator.state).toBe(ANIM_STATES.MOVE);
  });

  it('shows a hit for at least 12 frames at 60Hz', () => {
    const animator = new SpriteAnimator(
      {},
      {
        priority: DEWLING_PRIORITY,
        initialState: ANIM_STATES.MOVE,
        fallbackDurations: toDurations(HERO_FX),
        warn: () => {},
      }
    );

    animator.requestState(ANIM_STATES.HIT);
    animator.requestState(ANIM_STATES.MOVE);

    let framesVisible = 0;
    while (animator.state === ANIM_STATES.HIT && framesVisible < 200) {
      animator.update(1 / 60);
      framesVisible++;
    }

    expect(framesVisible).toBeGreaterThanOrEqual(12);
  });

  it('still lets death cut a hit short', () => {
    const animator = new SpriteAnimator(
      {},
      {
        priority: DEWLING_PRIORITY,
        initialState: ANIM_STATES.HIT,
        fallbackDurations: toDurations(HERO_FX),
        warn: () => {},
      }
    );

    animator.update(1 / 60);
    animator.requestState(ANIM_STATES.DEATH);
    expect(animator.state).toBe(ANIM_STATES.DEATH);
  });

  it('advances the state clock in fallback', () => {
    // The other half of the bug: update() used to return before touching
    // `elapsed` when no clip existed, so the FX were frozen at t=0 forever.
    const animator = new SpriteAnimator(
      {},
      { initialState: ANIM_STATES.IDLE, warn: () => {} }
    );

    animator.update(0.1);
    animator.update(0.1);

    expect(animator.elapsed).toBeCloseTo(0.2, 6);
  });
});

describe('single-image-per-state art is a pose, not a 1-frame animation', () => {
  /**
   * What the developer actually placed: one square PNG per state
   * (dewling_hit.png, 373x373), which the probe correctly measures as ONE
   * frame. Timing that as a 1-frame clip at its nominal fps gave `hit` a
   * lifetime of 1/16s — a flicker. A pose is held for its FX duration instead.
   *
   * @param {Object} [overrides]
   * @returns {Object}
   */
  function pose(overrides = {}) {
    return {
      sheet: 'dewling_hit.png',
      frames: 1,
      fps: 16,
      loop: false,
      frameWidth: 373,
      frameHeight: 373,
      available: true,
      ...overrides,
    };
  }

  /** @returns {SpriteAnimator} */
  function poseAnimator(initialState = ANIM_STATES.MOVE) {
    return new SpriteAnimator(
      {
        idle: pose({ sheet: 'dewling_idle.png', fps: 6, loop: true }),
        move: pose({ sheet: 'dewling_move.png', fps: 10, loop: true }),
        attack: pose({ sheet: 'dewling_attack.png', fps: 14 }),
        hit: pose(),
        death: pose({ sheet: 'dewling_death.png', fps: 10 }),
      },
      {
        priority: DEWLING_PRIORITY,
        initialState,
        fallbackDurations: toDurations(HERO_FX),
        slice: (sheet) => `tex:${sheet}`,
        warn: () => {},
      }
    );
  }

  it('recognises a one-frame clip as a pose', () => {
    const animator = poseAnimator(ANIM_STATES.HIT);
    expect(animator.isStaticPose()).toBe(true);
    // It still has real art, so it is NOT the missing-sheet fallback.
    expect(animator.isFallback).toBe(false);
  });

  it('holds a pose for its FX duration, not for 1/fps', () => {
    const animator = poseAnimator();
    animator.requestState(ANIM_STATES.HIT);
    animator.requestState(ANIM_STATES.MOVE);

    // 1 frame at 16fps would have released after 62ms — under 4 frames.
    let frames = 0;
    while (animator.state === ANIM_STATES.HIT && frames < 200) {
      animator.update(1 / 60);
      frames++;
    }

    expect(frames).toBeGreaterThanOrEqual(12);
    expect(frames * (1 / 60)).toBeCloseTo(HERO_FX[ANIM_STATES.HIT].duration, 1);
  });

  it('regression: a pose is not released after one frame period', () => {
    const animator = poseAnimator();
    animator.requestState(ANIM_STATES.HIT);
    animator.requestState(ANIM_STATES.MOVE);

    // Step past 1/16s, which is where the bug used to end the state.
    for (let i = 0; i < 5; i++) animator.update(1 / 60);

    expect(animator.elapsed).toBeGreaterThan(1 / 16);
    expect(animator.state).toBe(ANIM_STATES.HIT);
  });

  it('shows the state-specific artwork for each pose', () => {
    const animator = poseAnimator(ANIM_STATES.IDLE);
    animator.update(1 / 60);
    expect(animator.currentTexture()).toBe('tex:dewling_idle.png');

    animator.forceState(ANIM_STATES.ATTACK);
    animator.update(1 / 60);
    expect(animator.currentTexture()).toBe('tex:dewling_attack.png');
  });

  it('stays on frame 0 for a pose no matter how long it runs', () => {
    const animator = poseAnimator(ANIM_STATES.IDLE);
    for (let i = 0; i < 300; i++) animator.update(1 / 60);
    expect(animator.frameIndex).toBe(0);
  });

  it('still steps through a real multi-frame strip', () => {
    // The pose path must not have broken genuine sheet playback.
    const animator = new SpriteAnimator(
      { idle: pose({ frames: 6, fps: 10, loop: true }) },
      { initialState: ANIM_STATES.IDLE, slice: (s, i) => `f${i}`, warn: () => {} }
    );

    expect(animator.isStaticPose()).toBe(false);
    animator.update(0.1);
    expect(animator.frameIndex).toBe(1);
    animator.update(0.1);
    expect(animator.frameIndex).toBe(2);
  });

  it('lets a higher-priority state still interrupt a pose', () => {
    const animator = poseAnimator();
    animator.requestState(ANIM_STATES.HIT);
    animator.update(1 / 60);
    animator.requestState(ANIM_STATES.DEATH);
    expect(animator.state).toBe(ANIM_STATES.DEATH);
  });

  it('does not block on a looping pose like idle or move', () => {
    const animator = poseAnimator(ANIM_STATES.IDLE);
    animator.update(1 / 60);
    // idle/move have duration 0, so they yield immediately.
    animator.requestState(ANIM_STATES.MOVE);
    expect(animator.state).toBe(ANIM_STATES.MOVE);
  });
});

describe('boss telegraph keeps its fairness window in the FX path', () => {
  it('holds the procedural telegraph for exactly telegraph_ms', () => {
    const animator = new SpriteAnimator(
      {},
      {
        priority: RUSTWHALE_PRIORITY,
        fallbackDurations: toDurations(BOSS_FX),
        warn: () => {},
      }
    );

    const telegraphMs = calculateTelegraphMs(130, 3.2 * UNIT_PX);
    animator.playTelegraph(telegraphMs);

    expect(animator.fallbackDuration * 1000).toBeCloseTo(telegraphMs, 6);
    expect(animator.isBlocking()).toBe(true);
  });

  it('matches the window across radius and speed combinations', () => {
    for (const radius of [70, 130, 260]) {
      for (const speedUnits of [2.2, 3.2, 6.4]) {
        const animator = new SpriteAnimator(
          {},
          { priority: RUSTWHALE_PRIORITY, fallbackDurations: toDurations(BOSS_FX), warn: () => {} }
        );
        const telegraphMs = calculateTelegraphMs(radius, speedUnits * UNIT_PX);
        animator.playTelegraph(telegraphMs);

        expect(Math.abs(animator.fallbackDuration * 1000 - telegraphMs)).toBeLessThan(1);
      }
    }
  });

  it('releases the telegraph exactly when the window closes', () => {
    const animator = new SpriteAnimator(
      {},
      { priority: RUSTWHALE_PRIORITY, fallbackDurations: toDurations(BOSS_FX), warn: () => {} }
    );
    const telegraphMs = calculateTelegraphMs(130, 3.2 * UNIT_PX);
    animator.playTelegraph(telegraphMs);
    animator.requestState(ANIM_STATES.IDLE);

    let elapsedMs = 0;
    while (animator.state === ANIM_STATES.TELEGRAPH && elapsedMs < 5000) {
      animator.update(1 / 60);
      elapsedMs += 1000 / 60;
    }

    // Within one frame of the fairness window, never early.
    expect(elapsedMs).toBeGreaterThanOrEqual(telegraphMs - 0.01);
    expect(elapsedMs - telegraphMs).toBeLessThan(1000 / 60 + 0.01);
  });

  it('drops the telegraph override when it moves to another state', () => {
    const animator = new SpriteAnimator(
      {},
      { priority: RUSTWHALE_PRIORITY, fallbackDurations: toDurations(BOSS_FX), warn: () => {} }
    );
    animator.playTelegraph(1500);
    animator.forceState(ANIM_STATES.IDLE);

    expect(animator.fallbackOverride).toBe(0);
    expect(animator.fallbackDuration).toBe(0);
  });
});

describe('hero FX actually animate', () => {
  it('changes shape over the life of a hit', () => {
    const frames = sampleState(
      heroStateTransform,
      ANIM_STATES.HIT,
      HERO_FX[ANIM_STATES.HIT].duration
    );

    const scaleYs = new Set(frames.map((f) => f.scaleY.toFixed(4)));
    expect(scaleYs.size).toBeGreaterThan(8);
  });

  it('squashes volume-preservingly — as Y drops, X rises', () => {
    const frames = sampleState(
      heroStateTransform,
      ANIM_STATES.HIT,
      HERO_FX[ANIM_STATES.HIT].duration
    );

    for (const frame of frames) {
      if (frame.scaleY < 0.99) expect(frame.scaleX).toBeGreaterThan(1);
      if (frame.scaleY > 1.01) expect(frame.scaleX).toBeLessThan(1);
    }
  });

  it('flashes early in a hit, not throughout it', () => {
    const duration = HERO_FX[ANIM_STATES.HIT].duration;
    const early = resetTransform(createTransform());
    heroStateTransform(ANIM_STATES.HIT, 0.02, 0, early);
    const late = resetTransform(createTransform());
    heroStateTransform(ANIM_STATES.HIT, duration * 0.9, 0, late);

    expect(early.flash).toBe(true);
    expect(late.flash).toBe(false);
  });

  it('winds up before it releases on an attack', () => {
    const duration = HERO_FX[ANIM_STATES.ATTACK].duration;
    const anticipation = resetTransform(createTransform());
    heroStateTransform(ANIM_STATES.ATTACK, duration * 0.15, 0, anticipation);

    // Anticipation squashes down; the release overshoots the other way.
    expect(anticipation.scaleY).toBeLessThan(1);

    const frames = sampleState(heroStateTransform, ANIM_STATES.ATTACK, duration, 40);
    expect(Math.max(...frames.map((f) => f.scaleY))).toBeGreaterThan(1);
  });

  it('fades out over a death and never goes negative', () => {
    const duration = HERO_FX[ANIM_STATES.DEATH].duration;
    const frames = sampleState(heroStateTransform, ANIM_STATES.DEATH, duration, 40);

    expect(frames[0].alpha).toBeCloseTo(1, 3);
    expect(frames[frames.length - 1].alpha).toBe(0);

    let previous = Infinity;
    for (const frame of frames) {
      expect(frame.alpha).toBeGreaterThanOrEqual(0);
      expect(frame.alpha).toBeLessThanOrEqual(previous + 1e-9);
      expect(frame.scaleX).toBeGreaterThan(0);
      previous = frame.alpha;
    }
  });

  it('keeps idle and move alive rather than static', () => {
    for (const state of [ANIM_STATES.IDLE, ANIM_STATES.MOVE]) {
      const values = new Set();
      for (let t = 0; t < 2; t += 0.05) {
        const out = resetTransform(createTransform());
        heroStateTransform(state, t, t, out, { dx: 2 });
        values.add(out.scaleY.toFixed(4));
      }
      expect(values.size, `${state} is not animating`).toBeGreaterThan(10);
    }
  });

  it('leans into travel direction on move', () => {
    const right = resetTransform(createTransform());
    heroStateTransform(ANIM_STATES.MOVE, 0.5, 0.5, right, { dx: 8 });
    const left = resetTransform(createTransform());
    heroStateTransform(ANIM_STATES.MOVE, 0.5, 0.5, left, { dx: -8 });

    expect(Math.sign(right.rotation)).toBe(1);
    expect(Math.sign(left.rotation)).toBe(-1);
  });

  it('stays within sane bounds for every state', () => {
    for (const [state, config] of Object.entries(HERO_FX)) {
      const frames = sampleState(heroStateTransform, state, config.duration || 1, 40);
      for (const frame of frames) {
        expect(frame.scaleX, `${state} scaleX`).toBeGreaterThan(0);
        expect(frame.scaleX).toBeLessThan(2.5);
        expect(frame.scaleY).toBeGreaterThan(0);
        expect(frame.scaleY).toBeLessThan(2.5);
        expect(Number.isFinite(frame.rotation)).toBe(true);
      }
    }
  });
});

describe('boss FX', () => {
  it('builds urgency across the telegraph rather than staying flat', () => {
    const duration = 1.5;
    const early = [];
    const late = [];
    for (let i = 0; i <= 30; i++) {
      const elapsed = (duration * i) / 30;
      const out = resetTransform(createTransform());
      bossStateTransform(ANIM_STATES.TELEGRAPH, elapsed, elapsed, out, { duration });
      (i < 15 ? early : late).push(Math.abs(out.scaleX - 1));
    }

    // The swell amplitude grows as the window closes.
    expect(Math.max(...late)).toBeGreaterThan(Math.max(...early));
  });

  it('does not flash in the first half of the telegraph', () => {
    const duration = 1.5;
    for (let i = 0; i < 15; i++) {
      const elapsed = (duration * i) / 30;
      const out = resetTransform(createTransform());
      bossStateTransform(ANIM_STATES.TELEGRAPH, elapsed, elapsed, out, { duration });
      expect(out.flash).toBe(false);
    }
  });

  it('makes phaseUp bigger than a hit, so they cannot be confused', () => {
    const phase = sampleState(
      bossStateTransform,
      ANIM_STATES.PHASE_UP,
      BOSS_FX[ANIM_STATES.PHASE_UP].duration
    );
    const hit = sampleState(bossStateTransform, ANIM_STATES.HIT, BOSS_FX[ANIM_STATES.HIT].duration);

    const peak = (frames) => Math.max(...frames.map((f) => Math.abs(f.scaleX - 1)));
    expect(peak(phase)).toBeGreaterThan(peak(hit));
    expect(BOSS_FX[ANIM_STATES.PHASE_UP].duration).toBeGreaterThan(
      BOSS_FX[ANIM_STATES.HIT].duration
    );
  });

  it('stays within sane bounds for every state', () => {
    for (const [state, config] of Object.entries(BOSS_FX)) {
      const frames = sampleState(bossStateTransform, state, config.duration || 1.5, 40);
      for (const frame of frames) {
        expect(frame.scaleX, `${state} scaleX`).toBeGreaterThan(0);
        expect(frame.scaleX).toBeLessThan(2.5);
        expect(frame.alpha).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('attack recoil', () => {
  it('kicks back and springs home', () => {
    const duration = HERO_FX[ANIM_STATES.ATTACK].duration;

    expect(attackRecoil(0)).toBeCloseTo(0, 6);
    expect(attackRecoil(duration * 0.35)).toBeGreaterThan(2);
    expect(attackRecoil(duration)).toBeCloseTo(0, 6);
  });

  it('never pushes forward — the kick is one-directional', () => {
    const duration = HERO_FX[ANIM_STATES.ATTACK].duration;
    for (let t = 0; t <= duration; t += duration / 40) {
      expect(attackRecoil(t)).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('stays a nudge, not a teleport', () => {
    const duration = HERO_FX[ANIM_STATES.ATTACK].duration;
    let peak = 0;
    for (let t = 0; t <= duration; t += duration / 60) peak = Math.max(peak, attackRecoil(t));
    // Larger than the Dewling's own radius would look like it was knocked off
    // its hitbox rather than recoiling inside it.
    expect(peak).toBeLessThan(14);
    expect(peak).toBeGreaterThan(3);
  });

  it('is clamped once the attack is over', () => {
    expect(attackRecoil(99)).toBeCloseTo(0, 6);
  });
});

describe('move wake emission', () => {
  it('does not shed droplets when barely moving', () => {
    expect(wakeDue(10, 0)).toBe(false);
    expect(wakeDue(10, 0.02)).toBe(false);
  });

  it('sheds faster the quicker the Dewling travels', () => {
    // The accumulator needed to trigger falls as speed rises.
    const slowThreshold = MOVE_WAKE.interval / (0.4 + 0.2 * 0.6);
    const fastThreshold = MOVE_WAKE.interval / (0.4 + 1.0 * 0.6);
    expect(fastThreshold).toBeLessThan(slowThreshold);

    // At an accumulator between the two, only the fast mover emits.
    const between = (slowThreshold + fastThreshold) / 2;
    expect(wakeDue(between, 1.0)).toBe(true);
    expect(wakeDue(between, 0.2)).toBe(false);
  });

  it('emits at a sane cadence rather than every frame', () => {
    // At full speed, still slower than 60Hz — a droplet per frame would eat the
    // particle budget the swarm needs.
    const fullSpeedInterval = MOVE_WAKE.interval / (0.4 + 0.6);
    expect(fullSpeedInterval).toBeGreaterThan(1 / 60);
  });
});

describe('move reads as movement, not idling in place', () => {
  it('scales its bounce with speed', () => {
    const slow = [];
    const fast = [];
    for (let t = 0; t < 1; t += 0.02) {
      const a = resetTransform(createTransform());
      heroStateTransform(ANIM_STATES.MOVE, t, t, a, { dx: 0.2 });
      slow.push(a.scaleY);
      const b = resetTransform(createTransform());
      heroStateTransform(ANIM_STATES.MOVE, t, t, b, { dx: 3 });
      fast.push(b.scaleY);
    }

    const range = (xs) => Math.max(...xs) - Math.min(...xs);
    expect(range(fast)).toBeGreaterThan(range(slow));
  });

  it('stretches along travel when moving fast', () => {
    const still = resetTransform(createTransform());
    heroStateTransform(ANIM_STATES.MOVE, 0, 0, still, { dx: 0 });
    const fast = resetTransform(createTransform());
    heroStateTransform(ANIM_STATES.MOVE, 0, 0, fast, { dx: 3 });

    expect(fast.scaleX).toBeGreaterThan(still.scaleX);
    expect(fast.scaleY).toBeLessThan(still.scaleY);
  });

  it('leans harder the faster it goes', () => {
    const slow = resetTransform(createTransform());
    heroStateTransform(ANIM_STATES.MOVE, 0, 0, slow, { dx: 0.5 });
    const fast = resetTransform(createTransform());
    heroStateTransform(ANIM_STATES.MOVE, 0, 0, fast, { dx: 3 });

    expect(Math.abs(fast.rotation)).toBeGreaterThan(Math.abs(slow.rotation));
  });
});

describe('afterimage tuning', () => {
  it('keeps ghosts short-lived and bounded', () => {
    expect(AFTERIMAGE.poolSize).toBeGreaterThanOrEqual(4);
    expect(AFTERIMAGE.poolSize).toBeLessThanOrEqual(12);
    // Lifetime must not exceed what the pool can cover at the spawn interval,
    // or the oldest ghost gets recycled while still visible and the trace pops.
    expect(AFTERIMAGE.life).toBeLessThanOrEqual(AFTERIMAGE.interval * AFTERIMAGE.poolSize);
  });

  it('keeps ghosts subtle enough to stay behind the Dewling', () => {
    expect(AFTERIMAGE.alpha).toBeLessThan(0.6);
  });
});

describe('FX support layers', () => {
  it('boosts the trail on the states that matter', () => {
    expect(trailIntensity(ANIM_STATES.MOVE, 0)).toBeGreaterThan(1);
    expect(trailIntensity(ANIM_STATES.HIT, 0)).toBeGreaterThan(1);
    expect(trailIntensity(ANIM_STATES.IDLE, 0)).toBe(1);
  });

  it('decays the hit trail boost over the state', () => {
    const start = trailIntensity(ANIM_STATES.HIT, 0);
    const end = trailIntensity(ANIM_STATES.HIT, HERO_FX[ANIM_STATES.HIT].duration);
    expect(start).toBeGreaterThan(end);
  });

  it('describes bursts as data, with none for continuous states', () => {
    expect(stateBurst(ANIM_STATES.HIT)).toMatchObject({ kind: 'impact' });
    expect(stateBurst(ANIM_STATES.ATTACK)).toMatchObject({ kind: 'burst' });
    expect(stateBurst(ANIM_STATES.IDLE)).toBeNull();
    expect(stateBurst(ANIM_STATES.MOVE)).toBeNull();
  });

  it('touches no rendering API', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/render/state-fx.js', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]);

    expect(imports).toEqual(['../core/animation.js']);

    // Comments legitimately discuss sprite sheets; only code is under test.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/webgl|shader|new Graphics|new Sprite|\.texture\b/i);
  });

  it('is pure — same inputs give the same transform', () => {
    const a = resetTransform(createTransform());
    const b = resetTransform(createTransform());
    heroStateTransform(ANIM_STATES.HIT, 0.05, 1.2, a, { dx: 3 });
    heroStateTransform(ANIM_STATES.HIT, 0.05, 1.2, b, { dx: 3 });
    expect(a).toEqual(b);
  });
});
