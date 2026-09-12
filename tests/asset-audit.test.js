/**
 * Asset contrast audit.
 *
 * These pin the two things the audit has to get right now that the whole
 * roster is white hulls on one shared atlas, both of which produce a
 * confidently wrong answer rather than an error when broken:
 *
 *   - it must measure the sprite's FRAME, not the whole atlas page;
 *   - it must measure the TINT the renderer applies, not the raw white texel.
 *
 * Canvas is faked. Nothing here needs a real rasteriser — the audit's job is
 * arithmetic over pixel bytes, and supplying those bytes directly is what makes
 * the expected luminance something the test can state exactly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { measureTextureLuminance, auditAssetContrast } from '../src/render/asset-audit.js';
import { AssetStore, ASSET_KEYS, ENEMY_TEXTURE_KEY } from '../src/core/assets.js';
import { enemyTint, NO_TINT } from '../src/render/sprite-factory.js';
import { MAX_ENEMY_LUMINANCE, relativeLuminance } from '../src/render/theme.js';

/** Records what was drawn, and serves back a flat colour as image data. */
let drawCalls = [];
let pixelColor = [255, 255, 255, 255];

function installFakeCanvas() {
  drawCalls = [];
  globalThis.document = {
    createElement: () => {
      const canvas = { width: 0, height: 0 };
      canvas.getContext = () => ({
        drawImage: (...args) => drawCalls.push(args),
        getImageData: (x, y, w, h) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < data.length; i += 4) {
            data[i] = pixelColor[0];
            data[i + 1] = pixelColor[1];
            data[i + 2] = pixelColor[2];
            data[i + 3] = pixelColor[3];
          }
          return { data };
        },
      });
      return canvas;
    },
  };
}

/** A texture that is one frame inside a larger atlas page. */
const atlasTexture = (frame) => ({
  frame,
  source: { resource: { width: 256, height: 512 } },
});

beforeEach(() => {
  installFakeCanvas();
  pixelColor = [255, 255, 255, 255];
});

afterEach(() => {
  delete globalThis.document;
  vi.restoreAllMocks();
});

describe('Measuring one frame out of a shared atlas', () => {
  it('crops to the frame rather than averaging the whole page', () => {
    measureTextureLuminance(atlasTexture({ x: 100, y: 140, width: 48, height: 48 }));

    // 9-argument drawImage: source, sx, sy, sw, sh, dx, dy, dw, dh.
    expect(drawCalls).toHaveLength(1);
    const [, sx, sy, sw, sh] = drawCalls[0];
    expect([sx, sy, sw, sh]).toEqual([100, 140, 48, 48]);
  });

  it('falls back to the whole image for a texture with no frame', () => {
    measureTextureLuminance({ source: { resource: { width: 64, height: 64 } } });
    const [, sx, sy, sw, sh] = drawCalls[0];
    expect([sx, sy, sw, sh]).toEqual([0, 0, 64, 64]);
  });

  it('returns null instead of guessing when the pixels are unreadable', () => {
    expect(measureTextureLuminance(null)).toBeNull();
    expect(measureTextureLuminance({})).toBeNull();
    expect(measureTextureLuminance({ source: { resource: { width: 0, height: 0 } } })).toBeNull();
  });

  it('returns null when every sampled pixel is transparent', () => {
    pixelColor = [255, 255, 255, 0];
    expect(
      measureTextureLuminance(atlasTexture({ x: 0, y: 0, width: 16, height: 16 }))
    ).toBeNull();
  });
});

describe('Measuring the tint, not the texel', () => {
  const frame = { x: 0, y: 0, width: 32, height: 32 };

  it('reports a white hull as bright when untinted', () => {
    expect(measureTextureLuminance(atlasTexture(frame), NO_TINT)).toBeCloseTo(1, 3);
  });

  it('reports the tint itself for a white hull, since a tint multiplies', () => {
    // This is the whole point: the atlas is white, so the effective colour of
    // every enemy IS its tint. Audited raw, all six would read ~1.0.
    for (const id of Object.keys(ENEMY_TEXTURE_KEY)) {
      const tint = enemyTint(id);
      const expected = relativeLuminance(`#${tint.toString(16).padStart(6, '0')}`);
      expect(measureTextureLuminance(atlasTexture(frame), tint), id).toBeCloseTo(expected, 3);
    }
  });

  it('halves toward black as the tint darkens', () => {
    const bright = measureTextureLuminance(atlasTexture(frame), 0xffffff);
    const dim = measureTextureLuminance(atlasTexture(frame), 0x808080);
    expect(dim).toBeLessThan(bright);
    expect(measureTextureLuminance(atlasTexture(frame), 0x000000)).toBeCloseTo(0, 5);
  });
});

describe('Auditing the shipped roster', () => {
  /** A store where every key resolves to a white 32px frame of the atlas. */
  function whiteAtlasStore() {
    const store = new AssetStore();
    for (const key of [ASSET_KEYS.DRIFTER, ...Object.values(ENEMY_TEXTURE_KEY)]) {
      store.set(key, atlasTexture({ x: 0, y: 0, width: 32, height: 32 }));
    }
    return store;
  }

  it('passes the real tint table against the real thresholds', () => {
    // The end-to-end check: white hulls plus the shipped tints must land inside
    // the palette contract. If a tint is nudged out of band, this fails.
    const result = auditAssetContrast(whiteAtlasStore());
    expect(result.violations).toEqual([]);
    expect(result.enemies).toHaveLength(Object.keys(ENEMY_TEXTURE_KEY).length);
    for (const enemy of result.enemies) {
      expect(enemy.luminance, enemy.typeId).toBeLessThanOrEqual(MAX_ENEMY_LUMINANCE);
    }
  });

  it('would flag the whole roster if the renderer ever stopped tinting it', () => {
    // The atlas hulls are white, so an untinted swarm is a screen full of
    // enemies as bright as the hero. Stating it here makes explicit that the
    // roster passes BECAUSE of the tint table, not because the art is dark.
    const frame = atlasTexture({ x: 0, y: 0, width: 32, height: 32 });
    expect(measureTextureLuminance(frame, NO_TINT)).toBeGreaterThan(MAX_ENEMY_LUMINANCE);
  });

  it('flags a Drifter that would be too dark to find', () => {
    const store = whiteAtlasStore();
    const result = auditAssetContrast(store, { heroTint: 0x102030 });
    expect(result.violations.some((v) => v.kind === 'HERO_TOO_DARK')).toBe(true);
  });

  it('flags low hero-vs-enemy contrast, not just the two ceilings separately', () => {
    // A hero and an enemy can each sit inside their own band and still be too
    // close to each other. This is the check that catches that.
    const store = whiteAtlasStore();
    const result = auditAssetContrast(store, { heroTint: 0x2a2f3a });
    expect(result.violations.some((v) => v.kind === 'LOW_CONTRAST')).toBe(true);
  });

  it('records unreadable textures as skipped rather than as violations', () => {
    const store = new AssetStore();
    const result = auditAssetContrast(store);
    expect(result.violations).toEqual([]);
    expect(result.skipped).toContain(ASSET_KEYS.DRIFTER);
    expect(result.hero).toBeNull();
  });
});
