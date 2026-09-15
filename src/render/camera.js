/**
 * The tactical camera.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE
 * ---------------------------------------------------------------------------
 * The camera used to be four lines inside Renderer.updateCamera: a 1:1 pixel
 * scale and a clamp. That was fine while "the viewport" meant a desktop window,
 * and wrong the moment the game ran in mobile landscape, where a 393px-tall
 * viewport at 1:1 shows 393 world units of arena — barely three ship-lengths of
 * warning before a swarm arrives.
 *
 * Fixing that means the view now has a ZOOM, and a zoom is not a local detail:
 * every screen/world conversion in the codebase has to agree with it. Putting
 * the transform in one place, with no Pixi import and no DOM import, means it
 * can be tested in Node against exact numbers rather than eyeballed in a
 * browser — which is the only way "the aim reticle lines up with the
 * simulation" stays true after the next tuning pass.
 *
 * ---------------------------------------------------------------------------
 * THE ZOOM RULE, IN FULL
 * ---------------------------------------------------------------------------
 * Three constraints, resolved in one expression:
 *
 *   1. VERTICAL TARGET. The player must see ~860 world units of arena top to
 *      bottom (the design band is 850-920). That is the number the enemy
 *      approach speeds were balanced against: it buys roughly 2.8 seconds of
 *      sight-line on an incoming Tarling instead of 1.2.
 *
 *   2. MOBILE GETS MORE. On a touch device or a short landscape viewport the
 *      target opens to 1180 units — the same view at ~0.73x the desktop zoom
 *      scale. A thumb covers part of the screen and a phone is held further
 *      from the eye than a monitor; both cost situational awareness that has to
 *      be bought back with field of view.
 *
 *   3. WIDTH CEILING. Zooming out on a 21:9 phone would otherwise fit most of
 *      the arena on one screen, which kills the parallax, makes the boundary
 *      barrier permanently visible, and — the load-bearing reason — pushes the
 *      off-screen spawn ring past the half-arena radius the spawner's edge
 *      mirroring depends on (see spawner.js). So the visible world width is
 *      capped, and on wide-but-short viewports that cap, not the vertical
 *      target, is what sets the zoom.
 *
 * Resolved as `min(MAX_ZOOM, max(byHeight, byWidth))`: taking the LARGER of the
 * two candidate zooms is what makes the width ceiling a ceiling — a larger zoom
 * means a narrower view.
 *
 * MAX_ZOOM is 1 and is not a tuning knob. The camera may only ever widen the
 * view relative to the old 1:1 behaviour; a zoom above 1 would magnify the
 * sprites past the resolution they were authored at and would re-introduce, on
 * a tall desktop monitor, exactly the tunnel vision this module exists to
 * remove.
 */

import { clamp } from '../core/math.js';
import { WORLD } from '../core/constants.js';

export const CAMERA_CFG = {
  /** Desktop target: world units visible vertically. Design band is 850-920. */
  TARGET_VIEW_HEIGHT: 860,
  /**
   * Mobile/touch target. 860 / 1180 = 0.729, i.e. the mobile zoom scale sits in
   * the specified 0.70x-0.75x band relative to the desktop fit.
   */
  TARGET_VIEW_HEIGHT_MOBILE: 1180,
  /** A landscape viewport this short or shorter is a phone, touch or not. */
  MOBILE_MAX_HEIGHT: 520,
  /**
   * Ceiling on visible world width. Derived, not picked: the spawner may not
   * place an enemy further than half the arena's short side from the player
   * (its edge mirroring breaks above that), and the spawn ring has to clear the
   * view by SPAWN_CFG.VIEW_MARGIN. So
   *   MAX_VIEW_WIDTH / 2 + VIEW_MARGIN <= min(WORLD) / 2
   * must hold. tests/arena.test.js asserts it rather than trusting this note.
   */
  MAX_VIEW_WIDTH: 1900,
  /** The camera only ever zooms OUT. See the header. */
  MAX_ZOOM: 1,
  /** Floor for absurd viewports (a 120px-tall embed), so the ship never vanishes. */
  MIN_ZOOM: 0.28,
  /**
   * Follow stiffness, expressed per 1/60s frame and re-based on the real dt, so
   * a 144Hz display and a 30Hz one settle at the same rate. 0.10 sits mid-band:
   * high enough that the ship never trails the centre during a dash, low enough
   * that the starfield reads as drift rather than snapping.
   */
  LERP: 0.1,
  /**
   * How far ahead of the ship the camera looks, in world units, at full
   * throttle. The point is asymmetry: threats along the travel vector enter the
   * frame sooner than threats behind, which is the direction the player is
   * committing to and therefore the one they need the warning for.
   */
  LOOK_AHEAD: 52,
  /**
   * Speed at which look-ahead reaches its full extent (px/s). Matches the
   * Drifter's GDD top speed (4.8 units/s * UNIT_PX 32), so coasting slides the
   * focus back toward the ship instead of leaving it parked off-centre.
   */
  LOOK_AHEAD_REF_SPEED: 154,
};

/**
 * Whether this viewport should get the wider mobile field of view.
 *
 * Touch is checked as well as height because a tablet in landscape is 800px
 * tall — desktop by the height rule, a thumb-driven phone-sized experience by
 * every other measure.
 *
 * @param {number} viewHeight - Viewport height in CSS pixels
 * @param {boolean} [isTouch] - Whether the session is driven by a finger
 * @returns {boolean}
 */
export function isMobileViewport(viewHeight, isTouch = false) {
  return Boolean(isTouch) || viewHeight <= CAMERA_CFG.MOBILE_MAX_HEIGHT;
}

/**
 * The zoom rule. See the module header for why it has this shape.
 *
 * @param {number} viewWidth - Viewport width in CSS pixels
 * @param {number} viewHeight - Viewport height in CSS pixels
 * @param {Object} [options]
 * @param {boolean} [options.mobile] - Use the wider mobile target
 * @returns {number} World-units-to-screen-pixels scale
 */
export function computeZoom(viewWidth, viewHeight, { mobile = false } = {}) {
  const width = Math.max(1, viewWidth);
  const height = Math.max(1, viewHeight);

  const targetHeight = mobile
    ? CAMERA_CFG.TARGET_VIEW_HEIGHT_MOBILE
    : CAMERA_CFG.TARGET_VIEW_HEIGHT;

  const byHeight = height / targetHeight;
  const byWidth = width / CAMERA_CFG.MAX_VIEW_WIDTH;

  return clamp(
    Math.min(CAMERA_CFG.MAX_ZOOM, Math.max(byHeight, byWidth)),
    CAMERA_CFG.MIN_ZOOM,
    CAMERA_CFG.MAX_ZOOM
  );
}

/**
 * Camera state and the screen/world transform that goes with it.
 *
 * `x`/`y` are the WORLD coordinate drawn at the top-left pixel of the canvas,
 * which is the form the renderer needs for its container offset. Everything
 * that thinks in centres (follow target, look-ahead) converts on the way in.
 */
export class Camera {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.isTouch] - Whether the session is touch-driven
   */
  constructor({ isTouch = false } = {}) {
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.viewWidth = 0;
    this.viewHeight = 0;
    this.isTouch = Boolean(isTouch);
    this.mobile = false;
    this.resize(800, 600);
  }

  /**
   * @param {number} viewWidth - Viewport width in CSS pixels
   * @param {number} viewHeight - Viewport height in CSS pixels
   */
  resize(viewWidth, viewHeight) {
    this.viewWidth = Math.max(1, viewWidth);
    this.viewHeight = Math.max(1, viewHeight);
    this.mobile = isMobileViewport(this.viewHeight, this.isTouch);
    this.zoom = computeZoom(this.viewWidth, this.viewHeight, { mobile: this.mobile });
  }

  /** Visible arena width in world units. */
  get worldViewWidth() {
    return this.viewWidth / this.zoom;
  }

  /** Visible arena height in world units. */
  get worldViewHeight() {
    return this.viewHeight / this.zoom;
  }

  /** Half-extents of the view in world units — what the spawner needs. */
  get halfExtent() {
    return { x: this.worldViewWidth / 2, y: this.worldViewHeight / 2 };
  }

  /**
   * Where the camera WANTS to be centred: the ship, pushed along its velocity.
   *
   * @param {{x: number, y: number}} player
   * @param {number} [vx] - Player velocity, px/s
   * @param {number} [vy]
   * @returns {{x: number, y: number}} World-space focus point
   */
  focusPoint(player, vx = 0, vy = 0) {
    const speed = Math.hypot(vx, vy);
    if (speed <= 1e-6) return { x: player.x, y: player.y };

    const reach =
      CAMERA_CFG.LOOK_AHEAD * Math.min(1, speed / CAMERA_CFG.LOOK_AHEAD_REF_SPEED);
    return {
      x: player.x + (vx / speed) * reach,
      y: player.y + (vy / speed) * reach,
    };
  }

  /**
   * Convert a world-space centre into a clamped top-left camera position.
   *
   * A view wider than the arena is centred on the arena rather than clamped —
   * clamping would leave a lopsided band of void on one side.
   *
   * @param {number} centreX
   * @param {number} centreY
   * @returns {{x: number, y: number}}
   */
  clampToArena(centreX, centreY) {
    const vw = this.worldViewWidth;
    const vh = this.worldViewHeight;

    return {
      x:
        vw >= WORLD.WIDTH
          ? (WORLD.WIDTH - vw) / 2
          : clamp(centreX - vw / 2, 0, WORLD.WIDTH - vw),
      y:
        vh >= WORLD.HEIGHT
          ? (WORLD.HEIGHT - vh) / 2
          : clamp(centreY - vh / 2, 0, WORLD.HEIGHT - vh),
    };
  }

  /**
   * Jump the camera onto the ship with no interpolation.
   *
   * Called when a run starts. Without it the first second of every run is the
   * camera sliding in from wherever the last one left it, which reads as a
   * cutscene nobody asked for and hides the opening wave.
   *
   * @param {{x: number, y: number}} player
   * @param {number} [vx]
   * @param {number} [vy]
   */
  snap(player, vx = 0, vy = 0) {
    const focus = this.focusPoint(player, vx, vy);
    const next = this.clampToArena(focus.x, focus.y);
    this.x = next.x;
    this.y = next.y;
  }

  /**
   * Advance the smooth follow.
   *
   * The lerp weight is re-based on dt (`1 - (1 - LERP)^(dt*60)`) rather than
   * used raw, so the camera settles at the same rate on any refresh rate. A raw
   * weight makes a 144Hz display follow more than twice as tightly as a 60Hz
   * one, which is a feel difference the player cannot diagnose and cannot fix.
   *
   * @param {number} dt - Frame time in seconds
   * @param {{x: number, y: number}} player
   * @param {number} [vx] - Player velocity, px/s
   * @param {number} [vy]
   */
  update(dt, player, vx = 0, vy = 0) {
    const focus = this.focusPoint(player, vx, vy);
    const target = this.clampToArena(focus.x, focus.y);

    const weight = dt > 0 ? 1 - Math.pow(1 - CAMERA_CFG.LERP, dt * 60) : 0;
    const t = clamp(weight, 0, 1);

    this.x += (target.x - this.x) * t;
    this.y += (target.y - this.y) * t;

    // The clamp window moves with the zoom, and the zoom moves on resize. A
    // camera lerping toward a target that was legal last frame can otherwise
    // sit outside the arena for the frames it takes to catch up.
    const settled = this.clampToArena(
      this.x + this.worldViewWidth / 2,
      this.y + this.worldViewHeight / 2
    );
    this.x = settled.x;
    this.y = settled.y;
  }

  /**
   * Canvas pixel -> world unit.
   *
   * The canvas fills the window, so screen coordinates and client coordinates
   * are the same thing; a caller working from a `getBoundingClientRect` offset
   * should subtract it before calling. Screen shake is deliberately NOT
   * accounted for: it is a few pixels of transient noise, and folding it in
   * would make a tap land somewhere different depending on whether something
   * exploded that frame.
   *
   * @param {number} screenX
   * @param {number} screenY
   * @returns {{x: number, y: number}}
   */
  screenToWorld(screenX, screenY) {
    return {
      x: this.x + screenX / this.zoom,
      y: this.y + screenY / this.zoom,
    };
  }

  /**
   * World unit -> canvas pixel. The exact inverse of screenToWorld.
   *
   * @param {number} worldX
   * @param {number} worldY
   * @returns {{x: number, y: number}}
   */
  worldToScreen(worldX, worldY) {
    return {
      x: (worldX - this.x) * this.zoom,
      y: (worldY - this.y) * this.zoom,
    };
  }
}
