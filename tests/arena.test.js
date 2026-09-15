import { describe, it, expect } from 'vitest';
import { WORLD, SPAWN_CFG, PLAYER_CFG } from '../src/core/constants.js';
import { CAMERA_CFG, Camera } from '../src/render/camera.js';
import { WaveSpawner } from '../src/core/spawner.js';
import { mulberry32, clamp, length } from '../src/core/math.js';

/** Arena dimensions before the 35% expansion, kept so the ratio is asserted. */
const PREVIOUS_WORLD = { WIDTH: 2400, HEIGHT: 1600 };

describe('arena dimensions', () => {
  it('expanded by 35% in both axes', () => {
    expect(WORLD.WIDTH / PREVIOUS_WORLD.WIDTH).toBeCloseTo(1.35, 3);
    expect(WORLD.HEIGHT / PREVIOUS_WORLD.HEIGHT).toBeCloseTo(1.35, 3);
  });

  it('kept its aspect ratio, so nothing tuned against it needs re-tuning per axis', () => {
    expect(WORLD.WIDTH / WORLD.HEIGHT).toBeCloseTo(
      PREVIOUS_WORLD.WIDTH / PREVIOUS_WORLD.HEIGHT,
      6
    );
  });

  it('holds the edge-mirroring invariant the spawner depends on', () => {
    // WaveSpawner.spawnPosition reflects an out-of-bounds offset back across
    // the player instead of clamping it, which preserves the ring distance
    // exactly. That reflection is only guaranteed to land inside the arena
    // while the radius is at most half the shorter dimension.
    expect(SPAWN_CFG.MAX_SAFE_RADIUS).toBe(Math.min(WORLD.WIDTH, WORLD.HEIGHT) / 2);
    expect(SPAWN_CFG.MAX_RADIUS).toBeLessThanOrEqual(SPAWN_CFG.MAX_SAFE_RADIUS);
    expect(SPAWN_CFG.MIN_RADIUS).toBeLessThan(SPAWN_CFG.MAX_RADIUS);
  });

  it('is big enough that the widest legal view still leaves room to spawn off-screen', () => {
    // THE CONSTRAINT THAT TIES THE CAMERA TO THE ARENA. Checked against the
    // corner of the widest legal view — the heading that needs the most room —
    // and against the elliptical mirroring bound along that same heading. If
    // the camera's width ceiling and the arena size ever move independently,
    // enemies start appearing inside the frame on wide viewports, and that
    // failure is invisible to every unit test that does not check this.
    const halfW = CAMERA_CFG.MAX_VIEW_WIDTH / 2;
    const halfH = CAMERA_CFG.TARGET_VIEW_HEIGHT / 2;
    const cornerDistance = Math.hypot(halfW, halfH);
    const cos = halfW / cornerDistance;
    const sin = halfH / cornerDistance;

    const needed = cornerDistance + SPAWN_CFG.VIEW_MARGIN;
    const available = Math.min(WORLD.WIDTH / 2 / cos, WORLD.HEIGHT / 2 / sin);

    expect(needed).toBeLessThanOrEqual(available);
  });

  it('keeps the spawn margin inside the 100-150 unit design band', () => {
    expect(SPAWN_CFG.VIEW_MARGIN).toBeGreaterThanOrEqual(100);
    expect(SPAWN_CFG.VIEW_MARGIN).toBeLessThanOrEqual(150);
  });
});

describe('boundary clamping at the widened perimeter', () => {
  /** The clamp the simulation applies to the player, mirrored here exactly. */
  const clampPlayer = (x, y) => ({
    x: clamp(x, PLAYER_CFG.RADIUS, WORLD.WIDTH - PLAYER_CFG.RADIUS),
    y: clamp(y, PLAYER_CFG.RADIUS, WORLD.HEIGHT - PLAYER_CFG.RADIUS),
  });

  it('holds the ship inside the new perimeter by its own radius', () => {
    for (const [x, y] of [
      [-9999, -9999],
      [9999, 9999],
      [WORLD.WIDTH + 1, WORLD.HEIGHT / 2],
      [WORLD.WIDTH / 2, -1],
    ]) {
      const p = clampPlayer(x, y);
      expect(p.x).toBeGreaterThanOrEqual(PLAYER_CFG.RADIUS);
      expect(p.y).toBeGreaterThanOrEqual(PLAYER_CFG.RADIUS);
      expect(p.x).toBeLessThanOrEqual(WORLD.WIDTH - PLAYER_CFG.RADIUS);
      expect(p.y).toBeLessThanOrEqual(WORLD.HEIGHT - PLAYER_CFG.RADIUS);
    }
  });

  it('leaves the old perimeter well inside the playable area', () => {
    // A regression guard with teeth: if WORLD were reverted, a ship parked at
    // the old edge would now be clamped, and this would fail.
    const atOldEdge = clampPlayer(PREVIOUS_WORLD.WIDTH, PREVIOUS_WORLD.HEIGHT);
    expect(atOldEdge.x).toBe(PREVIOUS_WORLD.WIDTH);
    expect(atOldEdge.y).toBe(PREVIOUS_WORLD.HEIGHT);
  });
});

describe('off-screen spawning against the live camera view', () => {
  /** Every viewport the rework targets, plus the widest desktop case. */
  const VIEWPORTS = [
    [852, 393, true],
    [915, 412, true],
    [1920, 1080, false],
    [1366, 768, false],
  ];

  it('never places an enemy inside the visible frame', () => {
    for (const [w, h, touch] of VIEWPORTS) {
      const cam = new Camera({ isTouch: touch });
      cam.resize(w, h);

      const spawner = new WaveSpawner(mulberry32(4242));
      spawner.setViewExtent(cam.halfExtent.x, cam.halfExtent.y);

      // The centre of the arena is the only place the player can be where the
      // clamp below never has to intervene, so it is where the off-screen
      // guarantee is actually testable.
      const px = WORLD.WIDTH / 2;
      const py = WORLD.HEIGHT / 2;

      for (let i = 0; i < 2000; i++) {
        const pos = spawner.spawnPosition(px, py);
        const dx = Math.abs(pos.x - px);
        const dy = Math.abs(pos.y - py);

        const outside = dx > cam.halfExtent.x || dy > cam.halfExtent.y;
        expect(outside, `${w}x${h} spawn at ${dx.toFixed(1)},${dy.toFixed(1)}`).toBe(true);
      }
    }
  });

  it('clears the frame edge by the design margin, not merely by a pixel', () => {
    for (const [w, h, touch] of VIEWPORTS) {
      const cam = new Camera({ isTouch: touch });
      cam.resize(w, h);

      const spawner = new WaveSpawner(mulberry32(77));
      spawner.setViewExtent(cam.halfExtent.x, cam.halfExtent.y);

      const px = WORLD.WIDTH / 2;
      const py = WORLD.HEIGHT / 2;

      for (let i = 0; i < 2000; i++) {
        const pos = spawner.spawnPosition(px, py);
        const dx = Math.abs(pos.x - px);
        const dy = Math.abs(pos.y - py);
        const dist = Math.hypot(dx, dy);

        /*
         * Clearance is measured ALONG THE SPAWN RAY, not per axis.
         *
         * `t` is how many view-rectangles out the spawn sits, so `dist / t` is
         * where that same ray crosses the frame edge and the difference is the
         * gap the player actually sees the enemy cross. Measuring per axis
         * instead reports `margin * cos(heading)` — which is smaller than the
         * margin for every diagonal and makes a correct spawner look broken.
         */
        const t = Math.max(dx / cam.halfExtent.x, dy / cam.halfExtent.y);
        const clearance = dist * (1 - 1 / t);

        expect(clearance, `${w}x${h}`).toBeGreaterThanOrEqual(SPAWN_CFG.VIEW_MARGIN - 1e-6);
      }
    }
  });

  it('still keeps every spawn inside the arena, including from the corners', () => {
    const cam = new Camera({ isTouch: true });
    cam.resize(852, 393);

    const spawner = new WaveSpawner(mulberry32(9));
    spawner.setViewExtent(cam.halfExtent.x, cam.halfExtent.y);

    for (const [px, py] of [
      [0, 0],
      [WORLD.WIDTH, WORLD.HEIGHT],
      [WORLD.WIDTH, 0],
      [0, WORLD.HEIGHT],
      [WORLD.WIDTH / 2, WORLD.HEIGHT / 2],
    ]) {
      for (let i = 0; i < 600; i++) {
        const pos = spawner.spawnPosition(px, py);
        expect(pos.x).toBeGreaterThanOrEqual(0);
        expect(pos.x).toBeLessThanOrEqual(WORLD.WIDTH);
        expect(pos.y).toBeGreaterThanOrEqual(0);
        expect(pos.y).toBeLessThanOrEqual(WORLD.HEIGHT);
      }
    }
  });

  it('mirrors rather than clamping, so spawns never bunch against the arena wall', () => {
    // The distance the spawner INTENDED is preserved by edge mirroring. If the
    // elliptical bound were wrong, the fallback clamp would fire and arrivals
    // would pile up on the perimeter — checked here by confirming every offset
    // component stays inside the half-dimension the mirroring proof needs.
    const cam = new Camera({ isTouch: true });
    cam.resize(852, 393);

    const spawner = new WaveSpawner(mulberry32(31337));
    spawner.setViewExtent(cam.halfExtent.x, cam.halfExtent.y);

    for (const [px, py] of [
      [WORLD.WIDTH / 2, WORLD.HEIGHT / 2],
      [SPAWN_CFG.MAX_SAFE_RADIUS, SPAWN_CFG.MAX_SAFE_RADIUS],
      [WORLD.WIDTH - 1, WORLD.HEIGHT - 1],
    ]) {
      for (let i = 0; i < 600; i++) {
        const pos = spawner.spawnPosition(px, py);
        const dist = length(pos.x - px, pos.y - py);
        expect(dist).toBeGreaterThanOrEqual(SPAWN_CFG.MIN_RADIUS - 1e-6);
        expect(Math.abs(pos.x - px)).toBeLessThanOrEqual(WORLD.WIDTH / 2 + 1e-6);
        expect(Math.abs(pos.y - py)).toBeLessThanOrEqual(WORLD.HEIGHT / 2 + 1e-6);
      }
    }
  });

  it('honours the elliptical mirroring bound along every heading', () => {
    const spawner = new WaveSpawner(mulberry32(1));
    // A horizontal heading gets half the arena WIDTH; a vertical one gets half
    // its HEIGHT. Collapsing the two into one circular cap is what broke the
    // off-screen guarantee on wide viewports.
    expect(spawner.safeRadius(1, 0)).toBeCloseTo(WORLD.WIDTH / 2, 6);
    expect(spawner.safeRadius(0, 1)).toBeCloseTo(WORLD.HEIGHT / 2, 6);
    expect(spawner.safeRadius(1, 0)).toBeGreaterThan(SPAWN_CFG.MAX_SAFE_RADIUS);
  });

  it('falls back to the fixed ring when no view has been reported', () => {
    // The spawner is pure logic and must stay usable with no renderer at all —
    // the balance sim and most tests run exactly that way.
    const spawner = new WaveSpawner(mulberry32(5));
    expect(spawner.viewHalfWidth).toBeNull();

    for (let i = 0; i < 500; i++) {
      const pos = spawner.spawnPosition(WORLD.WIDTH / 2, WORLD.HEIGHT / 2);
      const dist = length(pos.x - WORLD.WIDTH / 2, pos.y - WORLD.HEIGHT / 2);
      expect(dist).toBeGreaterThanOrEqual(SPAWN_CFG.MIN_RADIUS - 1e-6);
      expect(dist).toBeLessThanOrEqual(SPAWN_CFG.MAX_RADIUS + 1e-6);
    }
  });

  it('ignores a nonsense view extent rather than spawning at the origin', () => {
    const spawner = new WaveSpawner(mulberry32(5));
    spawner.setViewExtent(400, 300);
    expect(spawner.viewHalfWidth).toBe(400);

    for (const bad of [[NaN, 300], [0, 300], [-1, -1], [undefined, undefined]]) {
      spawner.setViewExtent(bad[0], bad[1]);
      expect(spawner.viewHalfWidth).toBeNull();
      expect(spawner.viewHalfHeight).toBeNull();
    }
  });
});
