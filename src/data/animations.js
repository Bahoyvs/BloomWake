/**
 * Animation manifest (Phase 7, Tier A) — data table, same shape and spirit as
 * src/data/enemies.js and src/data/rewards.js.
 *
 * FRAME COUNTS ARE NOT WRITTEN HERE ON PURPOSE.
 * Every clip declares `frames: null`, meaning "measure the file". The art is
 * hand-placed by the developer and re-exported as it evolves; a number typed in
 * this table would be a second source of truth that silently rots the first
 * time a sheet gains or loses a frame. resolveAnimationManifest() fills them in
 * from real image dimensions at load time.
 *
 * fps IS written here, because playback speed is a design decision rather than
 * a property of the file — with one exception. The Rustwhale telegraph carries
 * `fps: null`: its speed is DERIVED at runtime from the Black Tide fairness
 * formula so the wind-up animation finishes exactly when the AoE lands. See
 * telegraphFps() below.
 *
 * SHEET FORMAT: see src/data/README.md. The default assumption is a single
 * horizontal strip of square frames; a companion .json overrides it.
 */

import { calculateTelegraphMs } from './enemies.js';

/** Where sprite sheets live, matching the existing art-drop convention. */
export const SHEET_ROOT = 'assets/sprites/';

/**
 * Sheet layout conventions.
 *
 * HORIZONTAL_STRIP is the default because it needs no metadata at all: a strip
 * of N square frames is N*H wide and H tall, so the frame count falls out of
 * the image dimensions alone. Anything else needs a companion .json.
 */
export const SHEET_LAYOUT = {
  HORIZONTAL_STRIP: 'horizontal-strip',
  GRID: 'grid',
};

/**
 * The Tier A animation table. Tier A is Dewling + Rustwhale ONLY — they are the
 * two entities that exist exactly once on screen, which is what makes
 * per-instance frame animation affordable. Swarm enemies are Tier B and are
 * deliberately absent from this table (see src/render/juice.js).
 */
export const ANIMATION_MANIFEST = {
  dewling: {
    idle: { sheet: 'dewling_idle.png', frames: null, fps: 6, loop: true },
    move: { sheet: 'dewling_move.png', frames: null, fps: 10, loop: true },
    attack: { sheet: 'dewling_attack.png', frames: null, fps: 14, loop: false },
    hit: { sheet: 'dewling_hit.png', frames: null, fps: 16, loop: false },
    death: { sheet: 'dewling_death.png', frames: null, fps: 10, loop: false },
  },
  rustwhale: {
    idle: { sheet: 'rustwhale_idle.png', frames: null, fps: 4, loop: true },
    // fps null => computed per-playback from the telegraph duration (Step A2).
    telegraph: { sheet: 'rustwhale_telegraph.png', frames: null, fps: null, loop: false },
    attack: { sheet: 'rustwhale_attack.png', frames: null, fps: 12, loop: false },
    hit: { sheet: 'rustwhale_hit.png', frames: null, fps: 16, loop: false },
    phaseUp: { sheet: 'rustwhale_phaseup.png', frames: null, fps: 10, loop: false },
    death: { sheet: 'rustwhale_death.png', frames: null, fps: 8, loop: false },
  },
};

/**
 * OPTIONAL Tier B shared swim-cycle sheets (Step B3).
 *
 * These are a cheap extra layer on top of the procedural transforms, never a
 * replacement. One sheet is shared by every instance of a type; per-instance
 * variation is the entity's phaseOffset number, not a per-entity animator.
 * A type absent from this table — or present but with no file on disk — simply
 * renders its static sprite with Tier B transforms, which is the expected state
 * until swarm art beyond static PNGs exists.
 */
export const SWARM_CYCLE_MANIFEST = {
  ashfish: { sheet: 'ashfish_swim.png', frames: null, fps: 8, loop: true },
  smogmoth: { sheet: 'smogmoth_flap.png', frames: null, fps: 12, loop: true },
};

/**
 * Every sheet filename the two manifests reference, deduplicated.
 * Used by the loader to probe the disk and by the report that tells the
 * developer which files are still missing.
 * @returns {Array<{key: string, sheet: string, url: string}>}
 */
export function listSheetEntries() {
  const entries = [];
  const push = (key, sheet) => {
    if (entries.some((entry) => entry.sheet === sheet)) return;
    entries.push({ key, sheet, url: `${SHEET_ROOT}${sheet}` });
  };

  for (const [entityId, clips] of Object.entries(ANIMATION_MANIFEST)) {
    for (const [state, clip] of Object.entries(clips)) push(`${entityId}:${state}`, clip.sheet);
  }
  for (const [typeId, clip] of Object.entries(SWARM_CYCLE_MANIFEST)) {
    push(`${typeId}:cycle`, clip.sheet);
  }
  return entries;
}

/**
 * Derive a frame count from real image dimensions.
 *
 * Explicit metadata always wins: if a companion .json declared frameCount or
 * frameWidth, that is authoritative and the dimensions are only a cross-check.
 * Otherwise the horizontal-strip convention applies — frame width equals sheet
 * height, so the count is width / height.
 *
 * @param {{width: number, height: number}} dimensions
 * @param {Object} [meta] - Companion .json contents, if any
 * @param {number} [meta.frameCount]
 * @param {number} [meta.frameWidth]
 * @param {number} [meta.frameHeight]
 * @param {string} [meta.layout]
 * @returns {number} Frame count, never below 1
 */
export function deriveFrameCount(dimensions, meta = null) {
  const width = Math.max(0, Math.round(dimensions?.width ?? 0));
  const height = Math.max(0, Math.round(dimensions?.height ?? 0));
  if (width <= 0 || height <= 0) return 1;

  if (meta?.frameCount > 0) return Math.floor(meta.frameCount);

  const frameWidth = meta?.frameWidth > 0 ? meta.frameWidth : height;
  const frameHeight = meta?.frameHeight > 0 ? meta.frameHeight : height;

  if (meta?.layout === SHEET_LAYOUT.GRID) {
    const cols = Math.floor(width / frameWidth);
    const rows = Math.floor(height / frameHeight);
    return Math.max(1, cols * rows);
  }

  return Math.max(1, Math.floor(width / frameWidth));
}

/**
 * Frame width in px for a resolved clip — what the animator slices with.
 * @param {{width: number, height: number}} dimensions
 * @param {number} frameCount
 * @param {Object} [meta]
 * @returns {number}
 */
export function deriveFrameWidth(dimensions, frameCount, meta = null) {
  if (meta?.frameWidth > 0) return meta.frameWidth;
  const width = dimensions?.width ?? 0;
  if (meta?.layout === SHEET_LAYOUT.GRID) return dimensions?.height ?? width;
  return frameCount > 0 ? width / frameCount : width;
}

/**
 * Fill a manifest's null frame counts from measured sheets.
 *
 * Pure: takes a lookup, returns a new resolved table, touches no globals and no
 * filesystem. The caller supplies the measurements — src/render/sheet-probe.js
 * in the browser, a fixture in tests. Same dependency-injection shape the asset
 * store uses for its loader.
 *
 * @param {Object} manifest - ANIMATION_MANIFEST or SWARM_CYCLE_MANIFEST shape
 * @param {(sheet: string) => ({width: number, height: number, meta?: Object}|null)} measure
 *   Returns null for a sheet that is not on disk.
 * @param {Object} [options]
 * @param {boolean} [options.flat] - True for the single-clip SWARM shape
 * @returns {Object} Resolved manifest; each clip gains frames, frameWidth,
 *   frameHeight and available
 */
export function resolveAnimationManifest(manifest, measure, { flat = false } = {}) {
  const resolveClip = (clip) => {
    const measured = measure(clip.sheet);
    if (!measured || !(measured.width > 0) || !(measured.height > 0)) {
      // Missing sheet: keep the row so the renderer can report it precisely,
      // but mark it unavailable so nothing tries to slice a texture that is not
      // there. The fallback to a static sprite is driven off this flag.
      return { ...clip, frames: 0, frameWidth: 0, frameHeight: 0, available: false };
    }

    const meta = measured.meta ?? null;
    const frames = deriveFrameCount(measured, meta);
    return {
      ...clip,
      frames,
      frameWidth: deriveFrameWidth(measured, frames, meta),
      frameHeight: meta?.frameHeight > 0 ? meta.frameHeight : measured.height,
      sheetWidth: measured.width,
      sheetHeight: measured.height,
      available: true,
    };
  };

  if (flat) {
    const resolved = {};
    for (const [key, clip] of Object.entries(manifest)) resolved[key] = resolveClip(clip);
    return resolved;
  }

  const resolved = {};
  for (const [entityId, clips] of Object.entries(manifest)) {
    resolved[entityId] = {};
    for (const [state, clip] of Object.entries(clips)) {
      resolved[entityId][state] = resolveClip(clip);
    }
  }
  return resolved;
}

/**
 * Sheets referenced by a resolved manifest that were not found on disk.
 * @param {Object} resolved
 * @param {boolean} [flat]
 * @returns {Array<string>} Sheet filenames
 */
export function listMissingSheets(resolved, flat = false) {
  const missing = [];
  const check = (clip) => {
    if (!clip.available && !missing.includes(clip.sheet)) missing.push(clip.sheet);
  };

  for (const value of Object.values(resolved)) {
    if (flat) check(value);
    else for (const clip of Object.values(value)) check(clip);
  }
  return missing;
}

/* ------------------------------------------------------------------ */
/* Step A2 — telegraph playback speed                                  */
/* ------------------------------------------------------------------ */

/**
 * fps that makes a fixed-length clip last exactly `durationMs`.
 *
 * THE POINT OF THIS FUNCTION: the Black Tide telegraph duration is a fairness
 * calibration, not an art decision. It is
 *
 *     telegraph_ms = (AoE_radius / dewling_speed) * 1000 + 300
 *
 * i.e. long enough for a Dewling standing at the centre to walk clear, plus a
 * 300ms reaction margin. That number already exists as calculateTelegraphMs in
 * src/data/enemies.js and is computed once per cast in Simulation —
 * it is NEVER recomputed here.
 *
 * The animation must therefore stretch to the duration, not the other way
 * round. Frame count is whatever the artist drew; fps absorbs the difference.
 * A fixed fps would mean the visual warning and the real hit window drift apart
 * the moment either the AoE radius or the Dewling's speed is tuned — and a
 * telegraph that finishes early or late is exactly the bug that makes a
 * deterministic boss feel cheap.
 *
 * @param {number} frameCount - Frames in the telegraph clip
 * @param {number} durationMs - Must come from calculateTelegraphMs
 * @returns {number} Frames per second
 */
export function telegraphFps(frameCount, durationMs) {
  if (!(frameCount > 0) || !(durationMs > 0)) return 0;
  return frameCount / (durationMs / 1000);
}

/**
 * Convenience wrapper: telegraph fps straight from the gameplay inputs.
 * Delegates the duration to the Phase 4 formula rather than restating it.
 *
 * @param {number} frameCount
 * @param {number} aoeRadius - px
 * @param {number} dewlingSpeedPxPerSec - px/s
 * @param {number} [safetyMarginMs]
 * @returns {number}
 */
export function telegraphFpsFor(frameCount, aoeRadius, dewlingSpeedPxPerSec, safetyMarginMs = 300) {
  return telegraphFps(
    frameCount,
    calculateTelegraphMs(aoeRadius, dewlingSpeedPxPerSec, safetyMarginMs)
  );
}

/**
 * How long a clip takes to play once, in ms. The inverse of telegraphFps, used
 * by the renderer and asserted against telegraph_ms in the test suite.
 *
 * @param {number} frameCount
 * @param {number} fps
 * @returns {number} Milliseconds
 */
export function clipDurationMs(frameCount, fps) {
  if (!(fps > 0) || !(frameCount > 0)) return 0;
  return (frameCount / fps) * 1000;
}
