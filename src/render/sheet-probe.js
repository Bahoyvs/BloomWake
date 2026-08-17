/**
 * Sprite-sheet probing and frame slicing (Phase 7) — the only file that knows
 * both PixiJS and the on-disk sheet layout.
 *
 * WHY PROBE AT LOAD TIME RATHER THAN HARDCODE
 * Frame counts live in the image, not in a table. The art is hand-placed and
 * re-exported as it evolves, so a number typed into src/data/animations.js
 * would be wrong the first time a sheet gains a frame — and wrong silently,
 * showing a sliver of the next frame or a blank one. Measuring the file makes
 * the art authoritative: the developer drops a new export in and the animation
 * adapts with no code change.
 *
 * A companion .json beside a sheet overrides the measurement (see
 * src/data/README.md). Both the image and the .json are optional; a sheet that
 * is not on disk is simply reported as unavailable and the entity keeps its
 * static sprite.
 */

import { Assets, Rectangle, Texture } from 'pixi.js';
import {
  ANIMATION_MANIFEST,
  SHEET_ROOT,
  SWARM_CYCLE_MANIFEST,
  listMissingSheets,
  listSheetEntries,
  resolveAnimationManifest,
} from '../data/animations.js';

/**
 * Load a sheet's companion .json, if the artist supplied one.
 * @param {string} sheet - e.g. 'dewling_idle.png'
 * @returns {Promise<Object|null>}
 */
async function loadSheetMeta(sheet) {
  const url = `${SHEET_ROOT}${sheet.replace(/\.png$/i, '.json')}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    // No sidecar is the normal case, not an error.
    return null;
  }
}

/**
 * Measure every sheet the manifests reference.
 *
 * Never rejects: a missing sheet resolves to no entry, which
 * resolveAnimationManifest turns into `available: false`.
 *
 * @param {Object} [options]
 * @param {Array} [options.entries] - Override, for tests
 * @returns {Promise<Map<string, {width: number, height: number, meta: Object|null, texture: *}>>}
 */
export async function probeSheets({ entries = listSheetEntries() } = {}) {
  const measured = new Map();

  for (const entry of entries) {
    try {
      const texture = await Assets.load(entry.url);
      if (!texture?.width || !texture?.height) continue;
      measured.set(entry.sheet, {
        width: texture.width,
        height: texture.height,
        meta: await loadSheetMeta(entry.sheet),
        texture,
      });
    } catch {
      // Absent sheet: expected while art is being placed incrementally.
    }
  }

  return measured;
}

/**
 * Probe the disk and resolve both manifests against what is actually there.
 *
 * @param {Object} [options]
 * @returns {Promise<{tierA: Object, swarm: Object, sheets: Map, missing: Array<string>}>}
 */
export async function loadAnimationManifests(options = {}) {
  const sheets = await probeSheets(options);
  const measure = (sheet) => sheets.get(sheet) ?? null;

  const tierA = resolveAnimationManifest(ANIMATION_MANIFEST, measure);
  const swarm = resolveAnimationManifest(SWARM_CYCLE_MANIFEST, measure, { flat: true });

  return {
    tierA,
    swarm,
    sheets,
    missing: [...listMissingSheets(tierA), ...listMissingSheets(swarm, true)],
  };
}

/**
 * Build a frame-slicing function bound to a probe result.
 *
 * This is the source-rect slicing step: every frame shares the sheet's single
 * GPU texture and differs only by its frame rectangle, so an N-frame animation
 * costs one upload and stays inside Pixi's batcher.
 *
 * @param {Map<string, {texture: *, width: number, height: number}>} sheets
 * @returns {(sheet: string, frameIndex: number, clip: Object) => Texture|null}
 */
export function createSlicer(sheets) {
  return (sheet, frameIndex, clip) => {
    const measured = sheets.get(sheet);
    if (!measured?.texture) return null;

    const frameWidth = clip.frameWidth > 0 ? clip.frameWidth : measured.height;
    const frameHeight = clip.frameHeight > 0 ? clip.frameHeight : measured.height;
    const perRow = Math.max(1, Math.floor(measured.width / frameWidth));

    const column = frameIndex % perRow;
    const row = Math.floor(frameIndex / perRow);

    // Clamp so a frame count that overshoots the image (a stale sidecar .json)
    // yields the last valid frame instead of an out-of-bounds texture.
    const x = Math.min(column * frameWidth, Math.max(0, measured.width - frameWidth));
    const y = Math.min(row * frameHeight, Math.max(0, measured.height - frameHeight));

    return new Texture({
      source: measured.texture.source,
      frame: new Rectangle(x, y, frameWidth, frameHeight),
    });
  };
}

/**
 * Human-readable report of which sheets are still absent.
 * Logged once at boot so the developer knows exactly what to place next.
 *
 * @param {Array<string>} missing
 * @returns {string}
 */
export function formatMissingSheetReport(missing) {
  if (missing.length === 0) return '[BloomWake] All animation sheets present.';
  return (
    `[BloomWake] ${missing.length} animation sheet(s) not found — ` +
    `those entities render their static sprite:\n  ${missing.join('\n  ')}`
  );
}
