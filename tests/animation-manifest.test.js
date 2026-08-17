/**
 * Step A2 — THE highest-priority test in Phase 7.
 *
 * The Black Tide telegraph duration is a fairness calibration:
 *
 *     telegraph_ms = (AoE_radius / dewling_speed) * 1000 + 300
 *
 * A Dewling standing at the centre of the AoE must be able to walk clear before
 * it lands, with 300ms of reaction margin. The telegraph ANIMATION is the only
 * warning the player gets, so if the animation finishes early the player dodges
 * into a hit that has not happened yet, and if it finishes late they are struck
 * by an attack that still looks like it is winding up. Either way a fully
 * deterministic boss reads as a cheap one.
 *
 * The guarantee under test: for ANY frame count and ANY combination of AoE
 * radius and Dewling speed, the animation's playback duration equals the
 * gameplay telegraph duration to within 1ms.
 *
 * Also covered: frame counts are derived from real image dimensions and never
 * hardcoded, and a missing sheet degrades instead of throwing.
 */

import { describe, it, expect } from 'vitest';
import {
  ANIMATION_MANIFEST,
  SHEET_LAYOUT,
  SWARM_CYCLE_MANIFEST,
  clipDurationMs,
  deriveFrameCount,
  deriveFrameWidth,
  listMissingSheets,
  listSheetEntries,
  resolveAnimationManifest,
  telegraphFps,
  telegraphFpsFor,
} from '../src/data/animations.js';
import { ENEMIES, ENEMY_TYPES, calculateTelegraphMs } from '../src/data/enemies.js';
import { UNIT_PX } from '../src/core/constants.js';
import { DEFAULT_PLAYER_STATS } from '../src/core/game-state.js';

const TOLERANCE_MS = 1;

describe('Step A2 — telegraph animation duration matches the fairness formula', () => {
  it('matches for the shipped Rustwhale radius and default Dewling speed', () => {
    const radius = ENEMIES[ENEMY_TYPES.RUSTWHALE].telegraphRadius;
    const speedPx = DEFAULT_PLAYER_STATS.moveSpeed * UNIT_PX;
    const telegraphMs = calculateTelegraphMs(radius, speedPx);

    const frameCount = 8;
    const fps = telegraphFps(frameCount, telegraphMs);

    expect(clipDurationMs(frameCount, fps)).toBeCloseTo(telegraphMs, 3);
    expect(Math.abs(clipDurationMs(frameCount, fps) - telegraphMs)).toBeLessThan(TOLERANCE_MS);
  });

  it('matches across many AoE radius / Dewling speed combinations', () => {
    // Explicitly NOT just the default: the whole point is that the animation
    // tracks the formula when either input is retuned.
    const radii = [60, 90, 130, 180, 240, 320, 500];
    const speedsUnits = [2.0, 2.6, 3.2, 4.0, 5.5, 8.0];
    const frameCounts = [2, 3, 4, 6, 8, 12, 24, 40];

    let combinations = 0;
    for (const radius of radii) {
      for (const speedUnits of speedsUnits) {
        const speedPx = speedUnits * UNIT_PX;
        const telegraphMs = calculateTelegraphMs(radius, speedPx);

        for (const frameCount of frameCounts) {
          const fps = telegraphFps(frameCount, telegraphMs);
          const durationMs = clipDurationMs(frameCount, fps);

          expect(Math.abs(durationMs - telegraphMs)).toBeLessThan(TOLERANCE_MS);
          combinations++;
        }
      }
    }

    expect(combinations).toBe(radii.length * speedsUnits.length * frameCounts.length);
  });

  it('gives the same answer through the convenience wrapper', () => {
    for (const radius of [80, 130, 260]) {
      for (const speedUnits of [2.4, 3.2, 6.0]) {
        const speedPx = speedUnits * UNIT_PX;
        const frameCount = 10;

        const viaWrapper = telegraphFpsFor(frameCount, radius, speedPx);
        const viaFormula = telegraphFps(frameCount, calculateTelegraphMs(radius, speedPx));

        expect(viaWrapper).toBeCloseTo(viaFormula, 10);
      }
    }
  });

  it('honours a non-default safety margin', () => {
    const radius = 130;
    const speedPx = 3.2 * UNIT_PX;
    const margin = 500;
    const telegraphMs = calculateTelegraphMs(radius, speedPx, margin);
    const frameCount = 7;

    const duration = clipDurationMs(frameCount, telegraphFpsFor(frameCount, radius, speedPx, margin));
    expect(Math.abs(duration - telegraphMs)).toBeLessThan(TOLERANCE_MS);
  });

  it('stretches playback rather than dropping or repeating frames', () => {
    // Same fairness window, different art: fps absorbs the frame count so the
    // artist is free to draw 3 frames or 30.
    const telegraphMs = calculateTelegraphMs(130, 3.2 * UNIT_PX);

    const slow = telegraphFps(3, telegraphMs);
    const fast = telegraphFps(30, telegraphMs);

    expect(fast).toBeCloseTo(slow * 10, 6);
    expect(clipDurationMs(3, slow)).toBeCloseTo(clipDurationMs(30, fast), 6);
  });

  it('a fixed fps would drift — this is what the derivation prevents', () => {
    // Regression guard on the reasoning, not just the arithmetic. At a fixed
    // 12fps an 8-frame clip always lasts 667ms, which only coincidentally
    // matches any given fairness window.
    const fixedFpsDuration = clipDurationMs(8, 12);
    const slowDewling = calculateTelegraphMs(130, 2.0 * UNIT_PX);
    const fastDewling = calculateTelegraphMs(130, 8.0 * UNIT_PX);

    expect(Math.abs(fixedFpsDuration - slowDewling)).toBeGreaterThan(TOLERANCE_MS);
    expect(Math.abs(fixedFpsDuration - fastDewling)).toBeGreaterThan(TOLERANCE_MS);

    // The derived fps matches both.
    for (const telegraphMs of [slowDewling, fastDewling]) {
      const derived = clipDurationMs(8, telegraphFps(8, telegraphMs));
      expect(Math.abs(derived - telegraphMs)).toBeLessThan(TOLERANCE_MS);
    }
  });

  it('degrades safely on nonsense input instead of returning Infinity', () => {
    expect(telegraphFps(0, 1500)).toBe(0);
    expect(telegraphFps(8, 0)).toBe(0);
    expect(telegraphFps(8, -100)).toBe(0);
    expect(clipDurationMs(8, 0)).toBe(0);
  });

  it('reuses the Phase 4 formula rather than restating it', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/data/animations.js', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // The duration formula must appear exactly once in the codebase, in
    // src/data/enemies.js. A literal 300 safety margin or a division by a speed
    // in this file would mean it had been copied.
    expect(code).toContain('calculateTelegraphMs');
    expect(code).not.toMatch(/\*\s*1000\s*\+\s*300/);
  });
});

describe('Step A3 — frame counts come from the asset, never the table', () => {
  it('ships no hardcoded frame counts', () => {
    for (const clips of Object.values(ANIMATION_MANIFEST)) {
      for (const clip of Object.values(clips)) {
        expect(clip.frames).toBeNull();
      }
    }
    for (const clip of Object.values(SWARM_CYCLE_MANIFEST)) {
      expect(clip.frames).toBeNull();
    }
  });

  it('derives the count from a horizontal strip of square frames', () => {
    expect(deriveFrameCount({ width: 384, height: 64 })).toBe(6);
    expect(deriveFrameCount({ width: 128, height: 128 })).toBe(1);
    expect(deriveFrameCount({ width: 1024, height: 128 })).toBe(8);
  });

  it('lets a companion .json override the convention', () => {
    expect(deriveFrameCount({ width: 384, height: 64 }, { frameWidth: 96 })).toBe(4);
    expect(deriveFrameCount({ width: 384, height: 64 }, { frameCount: 5 })).toBe(5);
  });

  it('handles a grid layout', () => {
    const dims = { width: 256, height: 128 };
    const meta = { layout: SHEET_LAYOUT.GRID, frameWidth: 64, frameHeight: 64 };
    expect(deriveFrameCount(dims, meta)).toBe(8); // 4 cols x 2 rows
  });

  it('never returns a count below 1', () => {
    expect(deriveFrameCount({ width: 0, height: 0 })).toBe(1);
    expect(deriveFrameCount({ width: 32, height: 64 })).toBe(1);
    expect(deriveFrameCount(null)).toBe(1);
  });

  it('derives frame width consistently with the count', () => {
    expect(deriveFrameWidth({ width: 384, height: 64 }, 6)).toBe(64);
    expect(deriveFrameWidth({ width: 384, height: 64 }, 4, { frameWidth: 96 })).toBe(96);
  });

  it('resolves a manifest against measured sheets', () => {
    const measure = (sheet) =>
      sheet === 'dewling_idle.png' ? { width: 384, height: 64, meta: null } : null;

    const resolved = resolveAnimationManifest(ANIMATION_MANIFEST, measure);

    expect(resolved.dewling.idle).toMatchObject({
      frames: 6,
      frameWidth: 64,
      frameHeight: 64,
      fps: 6,
      loop: true,
      available: true,
    });
    expect(resolved.dewling.move.available).toBe(false);
    expect(resolved.dewling.move.frames).toBe(0);
  });

  it('resolves the telegraph clip with fps still null, for runtime derivation', () => {
    const measure = () => ({ width: 480, height: 96, meta: null });
    const resolved = resolveAnimationManifest(ANIMATION_MANIFEST, measure);

    expect(resolved.rustwhale.telegraph.frames).toBe(5);
    expect(resolved.rustwhale.telegraph.fps).toBeNull();

    // ...and the derived rate makes that measured frame count fit the window.
    const telegraphMs = calculateTelegraphMs(130, 3.2 * UNIT_PX);
    const fps = telegraphFps(resolved.rustwhale.telegraph.frames, telegraphMs);
    expect(
      Math.abs(clipDurationMs(resolved.rustwhale.telegraph.frames, fps) - telegraphMs)
    ).toBeLessThan(TOLERANCE_MS);
  });

  it('resolves with zero sheets present without throwing', () => {
    const resolved = resolveAnimationManifest(ANIMATION_MANIFEST, () => null);

    for (const clips of Object.values(resolved)) {
      for (const clip of Object.values(clips)) {
        expect(clip.available).toBe(false);
      }
    }
    expect(listMissingSheets(resolved)).toHaveLength(11);
  });

  it('reports exactly which sheets are missing', () => {
    const present = new Set(['dewling_idle.png', 'dewling_move.png']);
    const measure = (sheet) => (present.has(sheet) ? { width: 256, height: 64 } : null);

    const missing = listMissingSheets(resolveAnimationManifest(ANIMATION_MANIFEST, measure));

    expect(missing).not.toContain('dewling_idle.png');
    expect(missing).toContain('dewling_death.png');
    expect(missing).toContain('rustwhale_telegraph.png');
  });

  it('lists every referenced sheet exactly once', () => {
    const entries = listSheetEntries();
    const sheets = entries.map((e) => e.sheet);

    expect(new Set(sheets).size).toBe(sheets.length);
    expect(sheets).toContain('rustwhale_phaseup.png');
    expect(sheets).toContain('ashfish_swim.png');
    for (const entry of entries) expect(entry.url).toMatch(/^assets\/sprites\//);
  });

  it('keeps Tier B swarm types out of the Tier A table', () => {
    // Tier A is Dewling + Rustwhale only. A swarm type appearing here would be
    // a per-instance animator multiplied by the 200-enemy cap.
    expect(Object.keys(ANIMATION_MANIFEST).sort()).toEqual(['dewling', 'rustwhale']);
  });
});
