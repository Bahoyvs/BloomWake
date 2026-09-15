import { describe, it, expect } from 'vitest';
import { Camera, CAMERA_CFG, computeZoom, isMobileViewport } from '../src/render/camera.js';
import { WORLD } from '../src/core/constants.js';

/** The two mobile landscape viewports the rework was specified against. */
const MOBILE_VIEWPORTS = [
  [852, 393],
  [915, 412],
];

const DESKTOP_VIEWPORTS = [
  [1920, 1080],
  [1600, 900],
  [1366, 768],
];

describe('camera zoom rule', () => {
  it('never zooms in past 1:1 on any viewport', () => {
    // MAX_ZOOM is the whole point of the rework: the camera may widen the view
    // and may never narrow it. A zoom above 1 would magnify sprites past their
    // authored resolution AND re-create the tunnel vision on tall monitors.
    for (const [w, h] of [...DESKTOP_VIEWPORTS, ...MOBILE_VIEWPORTS, [3840, 2160], [640, 480]]) {
      expect(computeZoom(w, h, { mobile: false })).toBeLessThanOrEqual(1);
      expect(computeZoom(w, h, { mobile: true })).toBeLessThanOrEqual(1);
    }
  });

  it('shows at least the designed vertical world span on every landscape viewport', () => {
    for (const [w, h] of [...DESKTOP_VIEWPORTS, ...MOBILE_VIEWPORTS]) {
      for (const mobile of [false, true]) {
        const zoom = computeZoom(w, h, { mobile });
        const worldHeight = h / zoom;
        expect(worldHeight, `${w}x${h} mobile=${mobile}`).toBeGreaterThanOrEqual(850);
      }
    }
  });

  it('lands the mobile landscape viewports inside the 850-920 design band', () => {
    // These are the screens the feedback came from. The width ceiling is what
    // sets the zoom here, and this is the assertion that catches a change to
    // MAX_VIEW_WIDTH quietly pushing them out of band.
    for (const [w, h] of MOBILE_VIEWPORTS) {
      const zoom = computeZoom(w, h, { mobile: true });
      const worldHeight = h / zoom;
      expect(worldHeight, `${w}x${h}`).toBeGreaterThanOrEqual(850);
      expect(worldHeight, `${w}x${h}`).toBeLessThanOrEqual(920);
    }
  });

  it('gives mobile a 0.70x-0.75x zoom scale relative to the desktop fit', () => {
    // Compared on the vertical rule alone — the width ceiling is a separate
    // constraint and applies identically to both, so including it would compare
    // the ceiling with itself and always report a ratio of 1.
    const ratio = CAMERA_CFG.TARGET_VIEW_HEIGHT / CAMERA_CFG.TARGET_VIEW_HEIGHT_MOBILE;
    expect(ratio).toBeGreaterThanOrEqual(0.7);
    expect(ratio).toBeLessThanOrEqual(0.75);
  });

  it('never lets the visible world width exceed the ceiling the spawner depends on', () => {
    // Load-bearing: SPAWN_CFG's edge mirroring caps spawn distance at half the
    // arena's short side, and the spawn ring has to clear the view. If the view
    // could grow past MAX_VIEW_WIDTH, off-screen spawning would silently stop
    // being off-screen. See tests/arena.test.js for the other half of this.
    for (const [w, h] of [...DESKTOP_VIEWPORTS, ...MOBILE_VIEWPORTS, [2560, 400]]) {
      for (const mobile of [false, true]) {
        const worldWidth = w / computeZoom(w, h, { mobile });
        // A viewport wider than the ceiling at zoom 1 cannot be narrowed
        // further, because the camera refuses to zoom in — that case is capped
        // by the raw viewport width instead.
        expect(worldWidth, `${w}x${h} mobile=${mobile}`).toBeLessThanOrEqual(
          Math.max(CAMERA_CFG.MAX_VIEW_WIDTH, w) + 1e-6
        );
      }
    }
  });

  it('treats short landscape viewports as mobile whether or not touch is reported', () => {
    // DevTools device emulation and several Android WebViews under-report
    // touch, so height alone has to be enough to trigger the wide view.
    expect(isMobileViewport(393, false)).toBe(true);
    expect(isMobileViewport(412, false)).toBe(true);
    expect(isMobileViewport(1080, false)).toBe(false);
    // ...and a landscape tablet is tall but still thumb-driven.
    expect(isMobileViewport(800, true)).toBe(true);
  });

  it('clamps absurd viewports to the zoom floor instead of vanishing the ship', () => {
    expect(computeZoom(200, 120, { mobile: true })).toBeGreaterThanOrEqual(CAMERA_CFG.MIN_ZOOM);
  });
});

describe('camera follow', () => {
  const centre = () => ({ x: WORLD.WIDTH / 2, y: WORLD.HEIGHT / 2 });

  it('snaps onto the ship with no interpolation', () => {
    const cam = new Camera();
    cam.resize(1920, 1080);
    cam.snap(centre());

    const view = cam.worldToScreen(WORLD.WIDTH / 2, WORLD.HEIGHT / 2);
    expect(view.x).toBeCloseTo(cam.viewWidth / 2, 6);
    expect(view.y).toBeCloseTo(cam.viewHeight / 2, 6);
  });

  it('approaches the target smoothly rather than jumping to it', () => {
    const cam = new Camera();
    cam.resize(1920, 1080);
    cam.snap(centre());
    const startX = cam.x;

    const moved = { x: WORLD.WIDTH / 2 + 400, y: WORLD.HEIGHT / 2 };
    cam.update(1 / 60, moved);

    expect(cam.x).toBeGreaterThan(startX);
    // One frame must cover only a fraction of the gap; a camera that arrives in
    // one frame is not a smooth camera, it is an assignment with extra steps.
    expect(cam.x - startX).toBeLessThan(400 * 0.5);
  });

  it('settles at the same rate regardless of frame rate', () => {
    // The dt re-basing is the only thing standing between a 144Hz player and a
    // camera that follows more than twice as tightly as a 60Hz player's.
    const fast = new Camera();
    const slow = new Camera();
    fast.resize(1920, 1080);
    slow.resize(1920, 1080);
    fast.snap(centre());
    slow.snap(centre());

    const moved = { x: WORLD.WIDTH / 2 + 500, y: WORLD.HEIGHT / 2 };
    for (let i = 0; i < 12; i++) fast.update(1 / 120, moved);
    for (let i = 0; i < 6; i++) slow.update(1 / 60, moved);

    expect(fast.x).toBeCloseTo(slow.x, 4);
  });

  it('leads the ship along its velocity vector', () => {
    const cam = new Camera();
    cam.resize(1920, 1080);
    const player = centre();

    const still = cam.focusPoint(player, 0, 0);
    const moving = cam.focusPoint(player, 154, 0);

    expect(still.x).toBe(player.x);
    const lead = moving.x - player.x;
    expect(lead).toBeGreaterThanOrEqual(40);
    expect(lead).toBeLessThanOrEqual(60);
  });

  it('scales look-ahead down as the ship slows, so the focus returns to it', () => {
    const cam = new Camera();
    const player = centre();
    const half = cam.focusPoint(player, CAMERA_CFG.LOOK_AHEAD_REF_SPEED / 2, 0);
    const full = cam.focusPoint(player, CAMERA_CFG.LOOK_AHEAD_REF_SPEED, 0);

    expect(half.x - player.x).toBeCloseTo((full.x - player.x) / 2, 6);
  });

  it('caps look-ahead at full throttle however fast the ship is boosted', () => {
    const cam = new Camera();
    const player = centre();
    const overspeed = cam.focusPoint(player, CAMERA_CFG.LOOK_AHEAD_REF_SPEED * 8, 0);
    expect(overspeed.x - player.x).toBeCloseTo(CAMERA_CFG.LOOK_AHEAD, 6);
  });

  it('never shows anything outside the arena, at any corner or viewport', () => {
    for (const [w, h] of [...DESKTOP_VIEWPORTS, ...MOBILE_VIEWPORTS]) {
      const cam = new Camera({ isTouch: h <= CAMERA_CFG.MOBILE_MAX_HEIGHT });
      cam.resize(w, h);

      for (const player of [
        { x: 0, y: 0 },
        { x: WORLD.WIDTH, y: 0 },
        { x: 0, y: WORLD.HEIGHT },
        { x: WORLD.WIDTH, y: WORLD.HEIGHT },
        { x: WORLD.WIDTH / 2, y: WORLD.HEIGHT / 2 },
      ]) {
        cam.snap(player, 200, 200);
        for (let i = 0; i < 60; i++) cam.update(1 / 60, player, 200, 200);

        const label = `${w}x${h} @ ${player.x},${player.y}`;
        expect(cam.x, label).toBeGreaterThanOrEqual(-1e-6);
        expect(cam.y, label).toBeGreaterThanOrEqual(-1e-6);
        expect(cam.x + cam.worldViewWidth, label).toBeLessThanOrEqual(WORLD.WIDTH + 1e-6);
        expect(cam.y + cam.worldViewHeight, label).toBeLessThanOrEqual(WORLD.HEIGHT + 1e-6);
      }
    }
  });

  it('centres a view wider than the arena instead of clamping it lopsided', () => {
    const cam = new Camera();
    cam.resize(1920, 1080);
    // Force a view wider than the arena by pretending the zoom is tiny.
    cam.zoom = 0.3;
    const pos = cam.clampToArena(0, 0);
    expect(pos.x).toBeCloseTo((WORLD.WIDTH - cam.worldViewWidth) / 2, 6);
  });
});

describe('screen/world transform', () => {
  it('round-trips through the zoom on every viewport', () => {
    // The contract every aim, tap and floating-number caller depends on. If
    // this drifts, skill targeting misses by a factor of the zoom and nothing
    // in the simulation is wrong — which makes it the hardest bug to find.
    for (const [w, h] of [...DESKTOP_VIEWPORTS, ...MOBILE_VIEWPORTS]) {
      const cam = new Camera({ isTouch: true });
      cam.resize(w, h);
      cam.snap({ x: WORLD.WIDTH / 2, y: WORLD.HEIGHT / 2 });

      for (const [sx, sy] of [[0, 0], [w, h], [w / 2, h / 2], [17, 233]]) {
        const world = cam.screenToWorld(sx, sy);
        const back = cam.worldToScreen(world.x, world.y);
        expect(back.x, `${w}x${h}`).toBeCloseTo(sx, 6);
        expect(back.y, `${w}x${h}`).toBeCloseTo(sy, 6);
      }
    }
  });

  it('maps the canvas corners to the visible world rectangle', () => {
    const cam = new Camera({ isTouch: true });
    cam.resize(852, 393);
    cam.snap({ x: WORLD.WIDTH / 2, y: WORLD.HEIGHT / 2 });

    const topLeft = cam.screenToWorld(0, 0);
    const bottomRight = cam.screenToWorld(852, 393);

    expect(topLeft.x).toBeCloseTo(cam.x, 6);
    expect(topLeft.y).toBeCloseTo(cam.y, 6);
    expect(bottomRight.x - topLeft.x).toBeCloseTo(cam.worldViewWidth, 6);
    expect(bottomRight.y - topLeft.y).toBeCloseTo(cam.worldViewHeight, 6);
  });

  it('reports half-extents that match the visible world rectangle', () => {
    const cam = new Camera();
    cam.resize(1600, 900);
    const extent = cam.halfExtent;
    expect(extent.x).toBeCloseTo(cam.worldViewWidth / 2, 6);
    expect(extent.y).toBeCloseTo(cam.worldViewHeight / 2, 6);
  });
});
