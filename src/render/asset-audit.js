/**
 * Asset contrast audit (Phase 6b).
 *
 * WHY THIS EXISTS
 * Phase 6 guaranteed the Dewling stays findable in a 200-enemy swarm by pinning
 * a luminance split in the PALETTE, verified by tests/theme.test.js. Moving to
 * authored PNGs breaks that guarantee's reach: a texture's real pixels are not
 * the hex values in theme.js, so an enemy sprite delivered too bright would sail
 * past a green test suite and straight back into visual soup.
 *
 * This module closes the gap by measuring the ACTUAL loaded textures and
 * re-applying the same thresholds. It runs in dev after preload and reports
 * rather than throws — art direction is a conversation, not a build failure.
 *
 * Only meaningful once real assets land; generated placeholders trivially pass
 * because they are drawn from the palette in the first place.
 */

import { ASSET_KEYS, ENEMY_TEXTURE_KEY } from '../core/assets.js';
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
 * Mean WCAG relative luminance of a texture's opaque pixels, 0..1.
 *
 * @param {*} texture - Pixi texture with an accessible source image
 * @returns {number|null} null when the pixels cannot be read
 */
export function measureTextureLuminance(texture) {
  const source = texture?.source?.resource ?? texture?.baseTexture?.resource?.source;
  if (!source) return null;

  const width = source.width || source.videoWidth;
  const height = source.height || source.videoHeight;
  if (!width || !height) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  try {
    ctx.drawImage(source, 0, 0);
  } catch {
    // Tainted canvas (cross-origin art) — cannot audit, do not guess.
    return null;
  }

  let data;
  try {
    data = ctx.getImageData(0, 0, width, height).data;
  } catch {
    return null;
  }

  const channel = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };

  let total = 0;
  let counted = 0;
  for (let i = 0; i < data.length; i += 4 * STRIDE) {
    if (data[i + 3] < ALPHA_FLOOR) continue;
    total +=
      0.2126 * channel(data[i]) + 0.7152 * channel(data[i + 1]) + 0.0722 * channel(data[i + 2]);
    counted++;
  }

  return counted > 0 ? total / counted : null;
}

/**
 * Check loaded art against the Phase 6 luminance contract.
 *
 * @param {import('../core/assets.js').AssetStore} store
 * @returns {{hero: number|null, enemies: Array, violations: Array, skipped: Array}}
 */
export function auditAssetContrast(store) {
  const violations = [];
  const skipped = [];

  const heroLuminance = measureTextureLuminance(store.get(ASSET_KEYS.DEWLING));
  if (heroLuminance === null) {
    skipped.push(ASSET_KEYS.DEWLING);
  } else if (heroLuminance < MIN_HERO_LUMINANCE) {
    violations.push({
      kind: 'HERO_TOO_DARK',
      key: ASSET_KEYS.DEWLING,
      detail:
        `Dewling mean luminance ${heroLuminance.toFixed(3)} is below the ` +
        `${MIN_HERO_LUMINANCE} floor — it will not read against the swarm.`,
    });
  }

  const enemies = [];
  for (const [typeId, key] of Object.entries(ENEMY_TEXTURE_KEY)) {
    const luminance = measureTextureLuminance(store.get(key));
    if (luminance === null) {
      skipped.push(key);
      continue;
    }
    enemies.push({ typeId, key, luminance });

    if (luminance > MAX_ENEMY_LUMINANCE) {
      violations.push({
        kind: 'ENEMY_TOO_BRIGHT',
        key,
        detail:
          `${typeId} mean luminance ${luminance.toFixed(3)} exceeds the ` +
          `${MAX_ENEMY_LUMINANCE} ceiling — it competes with the Dewling.`,
      });
    }

    if (heroLuminance !== null) {
      const ratio = (heroLuminance + 0.05) / (luminance + 0.05);
      if (ratio < MIN_HERO_CONTRAST) {
        violations.push({
          kind: 'LOW_CONTRAST',
          key,
          detail:
            `Dewling vs ${typeId} contrast ${ratio.toFixed(2)}:1 is under the ` +
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
 * @returns {Object} The audit result
 */
export function reportAssetContrast(store) {
  const result = auditAssetContrast(store);

  if (result.violations.length === 0) {
    console.info(
      `[BloomWake] Asset contrast audit passed` +
        (result.skipped.length ? ` (${result.skipped.length} unreadable, skipped)` : '')
    );
    return result;
  }

  console.warn(
    `[BloomWake] Asset contrast audit found ${result.violations.length} issue(s) — ` +
      `these will cause the Visual Soup problem the Phase 6 palette was designed to prevent:`
  );
  for (const violation of result.violations) {
    console.warn(`  [${violation.kind}] ${violation.detail}`);
  }
  return result;
}
