/**
 * Asset contrast audit.
 *
 * WHY THIS EXISTS
 * The palette guarantees the Void Drifter stays findable in a 200-enemy swarm
 * by pinning a luminance split, verified by tests/theme.test.js. Those tests
 * check hex strings. This module checks PIXELS, because a texture's real
 * contents are not the hex values in theme.js and an enemy delivered too bright
 * would sail past a green test suite straight back into visual soup.
 *
 * It runs in dev after preload and reports rather than throws — art direction
 * is a conversation, not a build failure.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS THIS HAS TO GET RIGHT, AND BOTH ARE EASY TO GET WRONG
 * ---------------------------------------------------------------------------
 *
 * 1. IT MEASURES THE FRAME, NOT THE FILE. Every hull now comes off one shared
 *    atlas. Reading `texture.source` and averaging it would measure all 48
 *    frames plus the transparent gutters between them, and report the same
 *    number for every species — an audit that cannot fail is worse than none.
 *
 * 2. IT MEASURES THE TINT, NOT THE TEXTURE. The atlas hulls are pure white by
 *    design; the species colour is a `.tint` applied at render time. Audited
 *    raw, every enemy in the game reads as luminance ~0.95 and the audit
 *    reports six violations on art that is in fact perfectly in-palette.
 *    Pixi tints multiply, so the effective colour is `texel * tint` per
 *    channel — which is what gets measured here.
 *
 * Together these mean the audit checks what actually reaches the screen. It
 * still earns its keep: it catches a hull frame that ships with baked-in
 * colour, a tint table that drifts from the palette, and art dropped in at the
 * wrong brightness.
 */

import { ASSET_KEYS, ENEMY_TEXTURE_KEY } from '../core/assets.js';
import { enemyTint, NO_TINT } from './sprite-factory.js';
import {
  MAX_ENEMY_LUMINANCE,
  MIN_HERO_LUMINANCE,
  MIN_HERO_CONTRAST,
} from './theme.js';

/** Alpha below this is treated as background and excluded from the average. */
const ALPHA_FLOOR = 24;
/** Sample stride; full-resolution scans are wasteful for an average. */
const STRIDE = 4;

/**
 * The sub-rectangle a texture occupies within its source image.
 *
 * Pixi 8 exposes this as `texture.frame`. A standalone (non-atlas) texture
 * still has one, covering the whole image, so there is no special case.
 *
 * @param {*} texture
 * @param {number} width - Source image width
 * @param {number} height - Source image height
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function frameRect(texture, width, height) {
  const frame = texture?.frame;
  if (frame && frame.width > 0 && frame.height > 0) {
    return {
      x: frame.x ?? 0,
      y: frame.y ?? 0,
      width: Math.min(frame.width, width),
      height: Math.min(frame.height, height),
    };
  }
  return { x: 0, y: 0, width, height };
}

/**
 * Mean WCAG relative luminance of a texture frame's opaque pixels, after the
 * tint the renderer will apply to it.
 *
 * @param {*} texture - Pixi texture with an accessible source image
 * @param {number} [tint] - Pixi tint the sprite is drawn with; white = untinted
 * @returns {number|null} null when the pixels cannot be read
 */
export function measureTextureLuminance(texture, tint = NO_TINT) {
  const source = texture?.source?.resource ?? texture?.baseTexture?.resource?.source;
  if (!source) return null;

  const sourceWidth = source.width || source.videoWidth;
  const sourceHeight = source.height || source.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;

  const rect = frameRect(texture, sourceWidth, sourceHeight);
  if (!(rect.width > 0) || !(rect.height > 0)) return null;

  const canvas = document.createElement('canvas');
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  try {
    // Draw only this frame's region, so an atlas is measured per-sprite.
    ctx.drawImage(
      source,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height
    );
  } catch {
    // Tainted canvas (cross-origin art) — cannot audit, do not guess.
    return null;
  }

  let data;
  try {
    data = ctx.getImageData(0, 0, rect.width, rect.height).data;
  } catch {
    return null;
  }

  const channel = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };

  // Pixi tints multiply in 0..1 space.
  const tintR = ((tint >> 16) & 0xff) / 255;
  const tintG = ((tint >> 8) & 0xff) / 255;
  const tintB = (tint & 0xff) / 255;

  let total = 0;
  let counted = 0;
  for (let i = 0; i < data.length; i += 4 * STRIDE) {
    if (data[i + 3] < ALPHA_FLOOR) continue;
    total +=
      0.2126 * channel(data[i] * tintR) +
      0.7152 * channel(data[i + 1] * tintG) +
      0.0722 * channel(data[i + 2] * tintB);
    counted++;
  }

  return counted > 0 ? total / counted : null;
}

/**
 * Check loaded art against the luminance contract.
 *
 * @param {import('../core/assets.js').AssetStore} store
 * @param {Object} [options]
 * @param {number} [options.heroTint] - Equipped cosmetic tint, if any
 * @returns {{hero: number|null, enemies: Array, violations: Array, skipped: Array}}
 */
export function auditAssetContrast(store, { heroTint = NO_TINT } = {}) {
  const violations = [];
  const skipped = [];

  const heroLuminance = measureTextureLuminance(store.get(ASSET_KEYS.DRIFTER), heroTint);
  if (heroLuminance === null) {
    skipped.push(ASSET_KEYS.DRIFTER);
  } else if (heroLuminance < MIN_HERO_LUMINANCE) {
    violations.push({
      kind: 'HERO_TOO_DARK',
      key: ASSET_KEYS.DRIFTER,
      detail:
        `Drifter mean luminance ${heroLuminance.toFixed(3)} is below the ` +
        `${MIN_HERO_LUMINANCE} floor — it will not read against the swarm.`,
    });
  }

  const enemies = [];
  for (const [typeId, key] of Object.entries(ENEMY_TEXTURE_KEY)) {
    const tint = enemyTint(typeId);
    const luminance = measureTextureLuminance(store.get(key), tint);
    if (luminance === null) {
      skipped.push(key);
      continue;
    }
    enemies.push({ typeId, key, luminance, tint });

    if (luminance > MAX_ENEMY_LUMINANCE) {
      violations.push({
        kind: 'ENEMY_TOO_BRIGHT',
        key,
        detail:
          `${typeId} mean tinted luminance ${luminance.toFixed(3)} exceeds the ` +
          `${MAX_ENEMY_LUMINANCE} ceiling — it competes with the Drifter.`,
      });
    }

    if (heroLuminance !== null) {
      const ratio = (heroLuminance + 0.05) / (luminance + 0.05);
      if (ratio < MIN_HERO_CONTRAST) {
        violations.push({
          kind: 'LOW_CONTRAST',
          key,
          detail:
            `Drifter vs ${typeId} contrast ${ratio.toFixed(2)}:1 is under the ` +
            `${MIN_HERO_CONTRAST}:1 floor.`,
        });
      }
    }
  }

  return { hero: heroLuminance, enemies, violations, skipped };
}

/**
 * Run the audit and print a readable report. Dev-only.
 * @param {import('../core/assets.js').AssetStore} store
 * @param {Object} [options]
 * @returns {Object} The audit result
 */
export function reportAssetContrast(store, options) {
  const result = auditAssetContrast(store, options);

  if (result.violations.length === 0) {
    console.info(
      `[BloomWake] Asset contrast audit passed` +
        (result.skipped.length ? ` (${result.skipped.length} unreadable, skipped)` : '')
    );
    return result;
  }

  console.warn(
    `[BloomWake] Asset contrast audit found ${result.violations.length} issue(s) — ` +
      `these will cause the Visual Soup problem the palette was designed to prevent:`
  );
  for (const violation of result.violations) {
    console.warn(`  [${violation.kind}] ${violation.detail}`);
  }
  return result;
}
