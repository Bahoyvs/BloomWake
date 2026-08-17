/**
 * Tier A sprite-sheet animator (Phase 7) — browser layer.
 *
 * Drives frame animation for the Dewling and the Rustwhale, and ONLY those two.
 * They are the entities that exist exactly once on screen, so this class is
 * allowed to be expensive per instance: it keeps a state machine, a frame
 * clock, a queued clip and a per-frame texture cache. Multiplying any of that
 * by the 200-enemy swarm cap is precisely what Tier B exists to avoid.
 *
 * RENDER-API NOTE
 * The Phase 7 brief specifies drawImage() with source-rect slicing and
 * ctx.scale(-1, 1) for the flip. That describes the Phase 6 immediate-mode
 * Canvas 2D renderer, which Phase 6b replaced with PixiJS (see
 * src/render/renderer.js). The semantics are carried over exactly, in the
 * form the current renderer can actually use:
 *
 *   source-rect slicing  ->  one sub-texture per frame, sharing the sheet's
 *                            base texture and differing only in frame rect.
 *                            Cut once at load, not per draw.
 *   ctx.scale(-1, 1)     ->  sprite.scale.x = -abs(scale.x)
 *
 * The flip is still the point: it halves the asset count for any directional
 * animation, because left-facing frames are never authored.
 *
 * This module imports nothing from pixi.js. Frame textures are produced by an
 * injected `slice` function, the same dependency-injection shape the asset
 * store uses for its loader — so the frame maths below is plain Node-testable
 * arithmetic and the Pixi coupling lives in one small adapter.
 */

import { ANIM_STATES, statePriority } from '../core/animation.js';
import { clipDurationMs, telegraphFps } from '../data/animations.js';

/**
 * Frame index for a clip at a given elapsed time.
 *
 * Pure arithmetic, deliberately: this is the one piece of Tier A that has to be
 * right and it is testable without a canvas, a texture or a browser.
 *
 * @param {number} elapsedSec - Seconds since the clip started
 * @param {number} fps
 * @param {number} frameCount
 * @param {boolean} loop
 * @returns {number} Frame index; the last frame is held for a finished non-loop
 */
export function computeFrameIndex(elapsedSec, fps, frameCount, loop) {
  if (!(frameCount > 1) || !(fps > 0)) return 0;
  const raw = Math.floor(Math.max(0, elapsedSec) * fps);
  if (loop) return raw % frameCount;
  return raw >= frameCount ? frameCount - 1 : raw;
}

/**
 * Has a non-looping clip played all the way through?
 * @param {number} elapsedSec
 * @param {number} fps
 * @param {number} frameCount
 * @returns {boolean}
 */
export function isClipFinished(elapsedSec, fps, frameCount) {
  if (!(fps > 0) || !(frameCount > 0)) return true;
  return elapsedSec * fps >= frameCount;
}

/**
 * One Tier A entity's animation playback.
 *
 * Non-looping clips are played to completion rather than being cut off by the
 * next state, unless the incoming state outranks the playing one in the core
 * priority list. That policy lives here and not in core because it is about
 * playback timing, which core has no concept of — core only ever says "this
 * entity is now attacking".
 */
export class SpriteAnimator {
  /**
   * @param {Object} clips - Resolved manifest for ONE entity, state -> clip
   * @param {Object} [options]
   * @param {Array<string>} [options.priority] - Core's ordering for this entity
   * @param {string} [options.initialState]
   * @param {(sheet: string, frameIndex: number, clip: Object) => *} [options.slice]
   *   Returns a per-frame texture. Omitted in tests.
   * @param {(message: string) => void} [options.warn]
   */
  constructor(
    clips,
    {
      priority = [],
      initialState = ANIM_STATES.IDLE,
      slice = null,
      warn = null,
      fallbackDurations = null,
    } = {}
  ) {
    this.clips = clips ?? {};
    this.priority = priority;
    this.slice = slice;
    this.warn = warn ?? ((message) => console.warn(message));
    /**
     * How long each state is held when it has NO sheet, in seconds.
     *
     * Without this a transient state lasts one simulation tick — core emits
     * `hit` for exactly one tick by design, so with no clip to play the
     * animator flipped straight back and the player saw a 16ms flicker. The
     * procedural FX in state-fx.js need a state to still be current when they
     * are drawn, so the minimum display time lives here.
     *
     * `{ state: seconds }`; 0 or absent means "hold until core changes it".
     */
    this.fallbackDurations = fallbackDurations ?? {};
    /** Runtime override of a fallback duration — the boss telegraph uses it. */
    this.fallbackOverride = 0;

    this.state = initialState;
    this.elapsed = 0;
    this.frameIndex = 0;
    /** Overrides clip.fps for the current playback; used by the telegraph. */
    this.fpsOverride = 0;
    /** Latest state core asked for while a non-interruptible clip was playing. */
    this.queuedState = null;
    /** Sheets already warned about, so a missing file logs once, not per frame. */
    this.warnedSheets = new Set();
    /** sheet -> [frame textures], cut once. */
    this.frameCache = new Map();
    this.flipX = false;
  }

  /**
   * The clip for a state, or null when the state has no row or no file.
   * @param {string} state
   * @returns {Object|null}
   */
  getClip(state) {
    const clip = this.clips[state];
    if (!clip || !clip.available || !(clip.frames > 0)) return null;
    return clip;
  }

  /** True when the current state has no usable sheet — render the static sprite. */
  get isFallback() {
    return this.getClip(this.state) === null;
  }

  /**
   * True when the current state's art is a SINGLE image rather than a strip.
   *
   * This is a first-class authoring mode, not a degraded one. One drawing per
   * state ("dewling_hit.png" as a single 373x373 pose) is far less work than a
   * frame sequence, and combined with the procedural FX in state-fx.js it reads
   * as animation: the artwork supplies the shape, the squash-stretch, flash,
   * particles and trail supply the motion.
   *
   * It matters here because a pose has no intrinsic duration. Timing it as a
   * 1-frame clip at its nominal fps gave `hit` a lifetime of 1/16s — the state
   * was technically correct and visually a flicker. A pose is held for its FX
   * duration instead.
   *
   * @param {string} [state]
   * @returns {boolean}
   */
  isStaticPose(state = this.state) {
    const clip = this.getClip(state);
    return clip !== null && clip.frames <= 1;
  }

  /**
   * Effective playback rate for the current clip.
   * @returns {number}
   */
  get fps() {
    if (this.fpsOverride > 0) return this.fpsOverride;
    const clip = this.getClip(this.state);
    return clip?.fps > 0 ? clip.fps : 0;
  }

  /**
   * Step A2 — bind the telegraph clip's playback to the fairness window.
   *
   * `durationMs` MUST be the value the simulation already computed via
   * calculateTelegraphMs (it travels on the boss:telegraph_start payload). The
   * formula is not restated here and must not be: a second copy would drift
   * from the gameplay one the first time the AoE radius or the Dewling's speed
   * is tuned, and the visual warning would stop matching the real hit window.
   *
   * @param {number} durationMs - From boss:telegraph_start
   */
  playTelegraph(durationMs) {
    const clip = this.getClip(ANIM_STATES.TELEGRAPH);
    this.fpsOverride = clip ? telegraphFps(clip.frames, durationMs) : 0;
    this.forceState(ANIM_STATES.TELEGRAPH);
    // With no sheet the procedural swell must still last exactly the fairness
    // window, so the same durationMs drives it. The A2 guarantee holds on both
    // paths: sprite frames stretch to the window, and so does the FX.
    this.fallbackOverride = durationMs / 1000;
  }

  /** How long the current clip lasts at its current rate, in ms. */
  get currentDurationMs() {
    const clip = this.getClip(this.state);
    return clip ? clipDurationMs(clip.frames, this.fps) : 0;
  }

  /**
   * Ask for a state. Honoured immediately unless a non-looping clip is still
   * playing and the request does not outrank it, in which case it is queued and
   * applied the moment the clip lands.
   *
   * @param {string} state
   */
  requestState(state) {
    if (state === this.state) return;

    if (this.isBlocking() && !this.outranksCurrent(state)) {
      this.queuedState = state;
      return;
    }
    this.forceState(state);
  }

  /**
   * Start a state now, resetting the frame clock.
   * @param {string} state
   */
  forceState(state) {
    if (state !== ANIM_STATES.TELEGRAPH) {
      this.fpsOverride = 0;
      this.fallbackOverride = 0;
    }
    this.state = state;
    this.elapsed = 0;
    this.frameIndex = 0;
    this.queuedState = null;
    this.warnIfMissing(state);
  }

  /**
   * How long the current state is held when there is no sheet for it.
   * @returns {number} Seconds; 0 means "until core says otherwise"
   */
  get fallbackDuration() {
    if (this.fallbackOverride > 0) return this.fallbackOverride;
    return this.fallbackDurations[this.state] ?? 0;
  }

  /**
   * True while the current state must not be replaced by a lower-priority one.
   *
   * Covers both paths: a non-looping CLIP still playing, and — when no sheet
   * exists — a procedural state still inside its minimum display time. The
   * second case is what stops a one-tick `hit` from vanishing before it is seen.
   */
  isBlocking() {
    const clip = this.getClip(this.state);

    // No sheet at all, or a single-image pose: there are no frames to time
    // against, so the FX duration is the authority on how long it is shown.
    if (!clip || clip.frames <= 1) {
      const duration = this.fallbackDuration;
      return duration > 0 && this.elapsed < duration;
    }

    if (clip.loop) return false;
    return !isClipFinished(this.elapsed, this.fps, clip.frames);
  }

  /**
   * Does an incoming state outrank the one playing? Uses core's priority list
   * so playback policy and state resolution cannot disagree — in practice this
   * is what lets a death, or a telegraph, cut a hit reaction short.
   * @param {string} state
   * @returns {boolean}
   */
  outranksCurrent(state) {
    if (this.priority.length === 0) return true;
    return statePriority(state, this.priority) < statePriority(this.state, this.priority);
  }

  /**
   * Step A5 — one warning per missing sheet, ever. Per-frame warnings would
   * flood the console at 60Hz and make the developer's own logs unusable while
   * they are placing art incrementally.
   * @param {string} state
   */
  warnIfMissing(state) {
    const clip = this.clips[state];
    if (!clip || clip.available) return;
    if (this.warnedSheets.has(clip.sheet)) return;
    this.warnedSheets.add(clip.sheet);
    this.warn(
      `[BloomWake] Animation sheet "${clip.sheet}" not found — ` +
        `falling back to the static sprite for state "${state}".`
    );
  }

  /**
   * Advance the frame clock.
   *
   * @param {number} dt - Seconds
   * @returns {number} Current frame index
   */
  update(dt) {
    // The clock advances in EVERY path, including fallback. It used to return
    // before this line when no sheet existed, which left the procedural FX with
    // a permanently-zero time-in-state — they would draw their first instant
    // forever and never progress.
    this.elapsed += dt;

    const clip = this.getClip(this.state);
    // Only a real strip has frames to step through. A single-image pose and a
    // missing sheet both sit on index 0 and let the FX layer do the animating.
    this.frameIndex =
      clip && clip.frames > 1
        ? computeFrameIndex(this.elapsed, this.fps, clip.frames, clip.loop)
        : 0;

    // ONE release rule for every path — strip, pose, or no art at all. Whatever
    // isBlocking() treats as "still playing" is what holds a queued state back,
    // so the three cases cannot disagree about when a state ends.
    if (this.queuedState && !this.isBlocking()) this.forceState(this.queuedState);

    return this.frameIndex;
  }

  /**
   * Texture for the current frame, cut on first use and cached per sheet.
   * @returns {*|null} null when the sheet is absent or no slicer was injected
   */
  currentTexture() {
    const clip = this.getClip(this.state);
    if (!clip || !this.slice) return null;

    let frames = this.frameCache.get(clip.sheet);
    if (!frames) {
      frames = [];
      for (let i = 0; i < clip.frames; i++) frames.push(this.slice(clip.sheet, i, clip));
      this.frameCache.set(clip.sheet, frames);
    }
    return frames[this.frameIndex] ?? frames[0] ?? null;
  }

  /**
   * Horizontal flip, replacing mirrored frames in the sheet.
   *
   * Halves the asset count for every directional animation: art is authored
   * facing +X only (the convention assets/README.md already states) and the
   * left-facing pose is the same frames drawn with a negated x scale.
   *
   * @param {number} vx - Facing velocity; negative means facing left
   */
  setFacing(vx) {
    if (vx < 0) this.flipX = true;
    else if (vx > 0) this.flipX = false;
  }

  /**
   * Apply the current frame to a sprite-like object.
   *
   * Duck-typed on purpose — anything with `texture` and a `scale` pair works,
   * which keeps pixi.js out of this module's imports and lets the frame logic
   * be tested against a plain object.
   *
   * @param {{texture: *, scale: {x: number, y: number}}} sprite
   * @param {number} baseScale
   */
  applyTo(sprite, baseScale) {
    const texture = this.currentTexture();
    if (texture) sprite.texture = texture;

    const magnitude = Math.abs(baseScale);
    sprite.scale.x = this.flipX ? -magnitude : magnitude;
    sprite.scale.y = magnitude;
  }

  /** Drop cached frame textures, e.g. after a re-load of the art. */
  clearCache() {
    this.frameCache.clear();
  }
}
