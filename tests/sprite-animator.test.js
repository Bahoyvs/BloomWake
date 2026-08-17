/**
 * Tier A SpriteAnimator — frame advance, state interruption policy, horizontal
 * flip, and the missing-sheet fallback (Step A5).
 *
 * The animator is deliberately free of pixi.js imports: frame textures arrive
 * through an injected slicer, so all of this is testable in plain Node against
 * a duck-typed sprite.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SpriteAnimator,
  computeFrameIndex,
  isClipFinished,
} from '../src/render/spriteAnimator.js';
import { ANIM_STATES, RUSTWHALE_PRIORITY, DEWLING_PRIORITY } from '../src/core/animation.js';
import { calculateTelegraphMs } from '../src/data/enemies.js';
import { UNIT_PX } from '../src/core/constants.js';

/**
 * @param {Object} [overrides]
 * @returns {Object} A resolved clip
 */
function clip(overrides = {}) {
  return {
    sheet: 'test.png',
    frames: 4,
    fps: 10,
    loop: true,
    frameWidth: 64,
    frameHeight: 64,
    available: true,
    ...overrides,
  };
}

/** @returns {{texture: *, scale: {x: number, y: number}}} */
function fakeSprite() {
  return { texture: 'static', scale: { x: 1, y: 1 } };
}

describe('computeFrameIndex', () => {
  it('advances with elapsed time', () => {
    expect(computeFrameIndex(0, 10, 4, true)).toBe(0);
    expect(computeFrameIndex(0.1, 10, 4, true)).toBe(1);
    expect(computeFrameIndex(0.25, 10, 4, true)).toBe(2);
  });

  it('wraps a looping clip', () => {
    expect(computeFrameIndex(0.4, 10, 4, true)).toBe(0);
    expect(computeFrameIndex(0.5, 10, 4, true)).toBe(1);
  });

  it('holds the last frame of a finished non-looping clip', () => {
    expect(computeFrameIndex(0.4, 10, 4, false)).toBe(3);
    expect(computeFrameIndex(99, 10, 4, false)).toBe(3);
  });

  it('stays on frame 0 for a single-frame or rateless clip', () => {
    expect(computeFrameIndex(5, 10, 1, true)).toBe(0);
    expect(computeFrameIndex(5, 0, 4, true)).toBe(0);
  });

  it('never returns a negative index', () => {
    expect(computeFrameIndex(-5, 10, 4, true)).toBe(0);
  });
});

describe('isClipFinished', () => {
  it('is false mid-playback and true once every frame has shown', () => {
    expect(isClipFinished(0.2, 10, 4)).toBe(false);
    expect(isClipFinished(0.4, 10, 4)).toBe(true);
  });
});

describe('SpriteAnimator playback', () => {
  it('advances the frame index over time', () => {
    const animator = new SpriteAnimator({ idle: clip() }, { initialState: ANIM_STATES.IDLE });

    expect(animator.update(0)).toBe(0);
    expect(animator.update(0.1)).toBe(1);
    expect(animator.update(0.1)).toBe(2);
  });

  it('resets the frame clock on a state change', () => {
    const animator = new SpriteAnimator(
      { idle: clip(), move: clip({ sheet: 'move.png' }) },
      { initialState: ANIM_STATES.IDLE }
    );

    animator.update(0.25);
    expect(animator.frameIndex).toBe(2);

    animator.requestState(ANIM_STATES.MOVE);
    expect(animator.frameIndex).toBe(0);
    expect(animator.elapsed).toBe(0);
  });

  it('plays a non-looping clip to completion before a lower-priority state', () => {
    const animator = new SpriteAnimator(
      {
        idle: clip({ sheet: 'idle.png' }),
        hit: clip({ sheet: 'hit.png', loop: false, frames: 4, fps: 10 }),
      },
      { priority: DEWLING_PRIORITY, initialState: ANIM_STATES.IDLE }
    );

    animator.requestState(ANIM_STATES.HIT);
    animator.update(0.1);

    // Idle is lower priority than hit, so it waits its turn.
    animator.requestState(ANIM_STATES.IDLE);
    expect(animator.state).toBe(ANIM_STATES.HIT);
    expect(animator.queuedState).toBe(ANIM_STATES.IDLE);

    animator.update(0.4); // hit clip lands
    expect(animator.state).toBe(ANIM_STATES.IDLE);
  });

  it('lets a higher-priority state cut a non-looping clip short', () => {
    const animator = new SpriteAnimator(
      {
        hit: clip({ sheet: 'hit.png', loop: false }),
        death: clip({ sheet: 'death.png', loop: false }),
      },
      { priority: DEWLING_PRIORITY, initialState: ANIM_STATES.HIT }
    );

    animator.update(0.05);
    animator.requestState(ANIM_STATES.DEATH);
    expect(animator.state).toBe(ANIM_STATES.DEATH);
  });

  it('does not block on a looping clip', () => {
    const animator = new SpriteAnimator(
      { idle: clip({ loop: true }), move: clip({ sheet: 'move.png' }) },
      { priority: DEWLING_PRIORITY, initialState: ANIM_STATES.IDLE }
    );

    animator.update(0.05);
    animator.requestState(ANIM_STATES.MOVE);
    expect(animator.state).toBe(ANIM_STATES.MOVE);
  });

  it('ignores a request for the state already playing', () => {
    const animator = new SpriteAnimator({ idle: clip() }, { initialState: ANIM_STATES.IDLE });
    animator.update(0.25);
    animator.requestState(ANIM_STATES.IDLE);
    expect(animator.elapsed).toBeCloseTo(0.25, 10);
  });
});

describe('SpriteAnimator telegraph timing (Step A2)', () => {
  it('derives an fps that makes the clip last exactly telegraph_ms', () => {
    const frames = 6;
    const animator = new SpriteAnimator(
      { telegraph: clip({ sheet: 'tele.png', frames, fps: null, loop: false }) },
      { priority: RUSTWHALE_PRIORITY }
    );

    const telegraphMs = calculateTelegraphMs(130, 3.2 * UNIT_PX);
    animator.playTelegraph(telegraphMs);

    expect(animator.state).toBe(ANIM_STATES.TELEGRAPH);
    expect(Math.abs(animator.currentDurationMs - telegraphMs)).toBeLessThan(1);
  });

  it('matches the window for several radius / speed / frame-count combinations', () => {
    for (const radius of [70, 130, 260]) {
      for (const speedUnits of [2.2, 3.2, 6.4]) {
        for (const frames of [3, 8, 21]) {
          const animator = new SpriteAnimator(
            { telegraph: clip({ sheet: 'tele.png', frames, fps: null, loop: false }) },
            { priority: RUSTWHALE_PRIORITY }
          );
          const telegraphMs = calculateTelegraphMs(radius, speedUnits * UNIT_PX);
          animator.playTelegraph(telegraphMs);

          expect(Math.abs(animator.currentDurationMs - telegraphMs)).toBeLessThan(1);
        }
      }
    }
  });

  it('finishes the clip exactly as the window closes, not before', () => {
    const frames = 8;
    const animator = new SpriteAnimator(
      { telegraph: clip({ sheet: 'tele.png', frames, fps: null, loop: false }) },
      { priority: RUSTWHALE_PRIORITY }
    );
    const telegraphMs = calculateTelegraphMs(130, 3.2 * UNIT_PX);
    animator.playTelegraph(telegraphMs);

    const step = 1 / 60;
    let elapsedMs = 0;

    // Halfway through the fairness window the clip must be halfway through its
    // frames — the wind-up reads as progress, not as a jump at the end.
    while (elapsedMs + step * 1000 < telegraphMs / 2) {
      animator.update(step);
      elapsedMs += step * 1000;
    }
    expect(animator.frameIndex).toBeGreaterThanOrEqual(frames / 2 - 1);
    expect(animator.frameIndex).toBeLessThanOrEqual(frames / 2 + 1);
    expect(animator.isBlocking()).toBe(true);

    // Right up to the last moment the clip is still running.
    while (elapsedMs + step * 1000 < telegraphMs - 1) {
      animator.update(step);
      elapsedMs += step * 1000;
    }
    expect(animator.isBlocking()).toBe(true);

    // Crossing the window lands it on the final frame, neither early nor late.
    animator.update((telegraphMs - elapsedMs) / 1000);
    expect(animator.frameIndex).toBe(frames - 1);

    // And it reports finished within a frame of the window closing. The slack
    // is one 60Hz step because elapsed is accumulated in float steps, not
    // because the derivation is approximate — the duration test above pins that
    // to under 1ms.
    animator.update(step);
    expect(animator.isBlocking()).toBe(false);
  });

  it('drops the derived rate when it leaves the telegraph state', () => {
    const animator = new SpriteAnimator(
      {
        telegraph: clip({ sheet: 'tele.png', frames: 6, fps: null, loop: false }),
        idle: clip({ sheet: 'idle.png', fps: 4 }),
      },
      { priority: RUSTWHALE_PRIORITY }
    );

    animator.playTelegraph(1200);
    expect(animator.fps).toBeGreaterThan(0);

    animator.forceState(ANIM_STATES.IDLE);
    expect(animator.fpsOverride).toBe(0);
    expect(animator.fps).toBe(4);
  });

  it('falls back cleanly when the telegraph sheet is absent', () => {
    const warn = vi.fn();
    const animator = new SpriteAnimator(
      { telegraph: clip({ sheet: 'tele.png', available: false, frames: 0, fps: null }) },
      { priority: RUSTWHALE_PRIORITY, warn }
    );

    expect(() => animator.playTelegraph(1200)).not.toThrow();
    expect(animator.isFallback).toBe(true);
    expect(animator.currentDurationMs).toBe(0);
  });
});

describe('Step A5 — missing-sheet fallback', () => {
  it('reports fallback rather than throwing', () => {
    const animator = new SpriteAnimator(
      { idle: clip({ available: false, frames: 0 }) },
      { initialState: ANIM_STATES.IDLE, warn: () => {} }
    );

    expect(animator.isFallback).toBe(true);
    expect(() => animator.update(0.5)).not.toThrow();
    expect(animator.update(0.5)).toBe(0);
    expect(animator.currentTexture()).toBeNull();
  });

  it('warns once per sheet, not once per frame', () => {
    const warn = vi.fn();
    const animator = new SpriteAnimator(
      { idle: clip({ available: false, frames: 0 }), move: clip({ sheet: 'move.png' }) },
      { initialState: ANIM_STATES.MOVE, warn }
    );

    for (let i = 0; i < 300; i++) {
      animator.forceState(ANIM_STATES.IDLE);
      animator.update(1 / 60);
      animator.forceState(ANIM_STATES.MOVE);
      animator.update(1 / 60);
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('test.png');
  });

  it('names the file and the state in the warning', () => {
    const warn = vi.fn();
    const animator = new SpriteAnimator(
      { death: clip({ sheet: 'dewling_death.png', available: false, frames: 0 }) },
      { initialState: ANIM_STATES.IDLE, warn }
    );
    animator.forceState(ANIM_STATES.DEATH);

    expect(warn.mock.calls[0][0]).toContain('dewling_death.png');
    expect(warn.mock.calls[0][0]).toContain('death');
  });

  it('works with an entirely empty manifest', () => {
    const animator = new SpriteAnimator({}, { warn: () => {} });
    expect(animator.isFallback).toBe(true);
    expect(() => animator.update(1 / 60)).not.toThrow();
    expect(() => animator.applyTo(fakeSprite(), 1.5)).not.toThrow();
  });

  it('still honours a queued state while in fallback', () => {
    const animator = new SpriteAnimator(
      { idle: clip({ available: false, frames: 0 }) },
      { initialState: ANIM_STATES.IDLE, warn: () => {} }
    );
    animator.queuedState = ANIM_STATES.MOVE;
    animator.update(1 / 60);
    expect(animator.state).toBe(ANIM_STATES.MOVE);
  });
});

describe('horizontal flip replaces mirrored frames', () => {
  it('negates x scale when facing left, and only x', () => {
    const animator = new SpriteAnimator({ idle: clip() }, { initialState: ANIM_STATES.IDLE });
    const sprite = fakeSprite();

    animator.setFacing(-5);
    animator.applyTo(sprite, 2);
    expect(sprite.scale.x).toBe(-2);
    expect(sprite.scale.y).toBe(2);

    animator.setFacing(5);
    animator.applyTo(sprite, 2);
    expect(sprite.scale.x).toBe(2);
    expect(sprite.scale.y).toBe(2);
  });

  it('keeps the last facing when motion stops', () => {
    const animator = new SpriteAnimator({ idle: clip() });
    animator.setFacing(-3);
    animator.setFacing(0);
    expect(animator.flipX).toBe(true);
  });

  it('does not double-negate an already negative base scale', () => {
    const animator = new SpriteAnimator({ idle: clip() });
    const sprite = fakeSprite();
    animator.setFacing(-1);
    animator.applyTo(sprite, -3);
    expect(sprite.scale.x).toBe(-3);
  });
});

describe('frame slicing', () => {
  it('cuts each frame once and reuses it', () => {
    const slice = vi.fn((sheet, index) => `${sheet}#${index}`);
    const animator = new SpriteAnimator(
      { idle: clip({ frames: 4 }) },
      { initialState: ANIM_STATES.IDLE, slice }
    );

    animator.update(0);
    expect(animator.currentTexture()).toBe('test.png#0');
    animator.update(0.1);
    expect(animator.currentTexture()).toBe('test.png#1');

    // Four frames cut on first use, and never again.
    for (let i = 0; i < 50; i++) {
      animator.update(0.1);
      animator.currentTexture();
    }
    expect(slice).toHaveBeenCalledTimes(4);
  });

  it('applies the sliced texture to the sprite', () => {
    const animator = new SpriteAnimator(
      { idle: clip({ frames: 3 }) },
      { initialState: ANIM_STATES.IDLE, slice: (sheet, index) => `${sheet}#${index}` }
    );
    const sprite = fakeSprite();

    animator.update(0.1);
    animator.applyTo(sprite, 1);
    expect(sprite.texture).toBe('test.png#1');
  });

  it('leaves the static texture in place when no slicer is injected', () => {
    const animator = new SpriteAnimator({ idle: clip() }, { initialState: ANIM_STATES.IDLE });
    const sprite = fakeSprite();
    animator.applyTo(sprite, 1);
    expect(sprite.texture).toBe('static');
  });
});
