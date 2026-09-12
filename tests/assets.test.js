/**
 * Asset pipeline tests (Phase 6b).
 *
 * The loader is injected, so these run in plain Node with no PixiJS, no canvas
 * and no files on disk. That is the point of the dependency-injection seam in
 * src/core/assets.js: the preload lifecycle is testable, while the PixiJS-bound
 * half lives in src/render/pixi-loader.js.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AssetStore,
  ASSET_MANIFEST,
  ASSET_KEYS,
  ASSET_ROOT,
  ASSET_SHEETS,
  UI_ASSETS,
  ENEMY_TEXTURE_KEY,
  getEnemyTextureKey,
  assets,
} from '../src/core/assets.js';
import { ENEMIES } from '../src/data/enemies.js';
import {
  scaleForRadius,
  SPRITE_FIT,
  hexToPixi,
  cosmeticTint,
  HERO_TINT,
  NO_TINT,
} from '../src/render/sprites.js';

/** Stand-in texture. */
const fakeTexture = (key) => ({ key, width: 128, height: 128 });

/** Loader that resolves everything. */
const okLoader = () => vi.fn(async (entry) => fakeTexture(entry.key));

/** Loader that rejects for the listed keys. */
const partialLoader = (failKeys) =>
  vi.fn(async (entry) => {
    if (failKeys.includes(entry.key)) throw new Error('404');
    return fakeTexture(entry.key);
  });

// Several tests deliberately fail loads, which the store warns about. Silence
// the expected noise so a genuinely unexpected warning still stands out.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Asset manifest', () => {
  it('covers every enemy in the roster', () => {
    for (const id of Object.keys(ENEMIES)) {
      const key = getEnemyTextureKey(id);
      expect(key, id).toBeDefined();
      expect(ASSET_MANIFEST.some((entry) => entry.key === key), `${id} -> ${key}`).toBe(true);
    }
  });

  it('has a manifest entry for every declared key', () => {
    const manifestKeys = new Set(ASSET_MANIFEST.map((e) => e.key));
    for (const key of Object.values(ASSET_KEYS)) {
      expect(manifestKeys.has(key), key).toBe(true);
    }
  });

  it('uses unique keys', () => {
    const keys = ASSET_MANIFEST.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('points at the agreed folder layout', () => {
    const roots = Object.values(ASSET_ROOT);
    for (const entry of ASSET_MANIFEST) {
      expect(
        roots.some((root) => entry.url.startsWith(root)),
        entry.url
      ).toBe(true);
    }
  });

  it('names a frame for every atlas-backed entry, and only those', () => {
    const sheets = new Set(Object.values(ASSET_SHEETS));
    for (const entry of ASSET_MANIFEST) {
      // A `frame` on a standalone image would be silently ignored by the
      // loader; a sheet entry WITHOUT one would hand the renderer a whole
      // Spritesheet where it expects a Texture.
      expect(Boolean(entry.frame), entry.key).toBe(sheets.has(entry.url));
    }
  });

  it('names a frame that actually exists in the staged atlas', () => {
    /*
     * The one failure this whole pipeline cannot catch any other way.
     *
     * A frame name is a string that nothing resolves until a browser asks the
     * Spritesheet for it, at which point the loader throws, the key lands in
     * `missing`, and the enemy silently renders as a generated placeholder
     * blob. Every other test here passes while the game looks broken.
     *
     * So this reads the real generated atlases off disk. It couples the suite
     * to `npm run assets` having been run, which is the correct coupling:
     * committing a manifest that points at a frame the build does not produce
     * should fail here rather than in a screenshot.
     */
    const sheets = new Map();
    for (const url of Object.values(ASSET_SHEETS)) {
      const path = resolve(process.cwd(), 'public', url);
      sheets.set(url, JSON.parse(readFileSync(path, 'utf8')));
    }

    for (const entry of ASSET_MANIFEST) {
      if (!entry.frame) continue;
      const sheet = sheets.get(entry.url);
      expect(sheet, `${entry.key}: no atlas at ${entry.url}`).toBeDefined();
      expect(
        Object.hasOwn(sheet.frames, entry.frame),
        `${entry.key} -> "${entry.frame}" is not in ${entry.url}`
      ).toBe(true);
    }
  });

  it('ships a standalone file for every non-atlas entry', () => {
    for (const entry of ASSET_MANIFEST) {
      if (entry.frame) continue;
      const path = resolve(process.cwd(), 'public', entry.url);
      expect(existsSync(path), `${entry.key}: ${entry.url} is not staged`).toBe(true);
    }
  });

  it('stages every DOM-side UI plate the HUD references', () => {
    for (const [name, url] of Object.entries(UI_ASSETS)) {
      expect(existsSync(resolve(process.cwd(), 'public', url)), name).toBe(true);
    }
  });

  it('exposes the DOM-side UI plates from the same manifest module', () => {
    // The level-up panel's art is referenced from CSS, but a missing badge
    // should still be findable here rather than only by reading a stylesheet.
    for (const [name, url] of Object.entries(UI_ASSETS)) {
      expect(url.startsWith(ASSET_ROOT.UI), name).toBe(true);
      expect(url.endsWith('.png'), name).toBe(true);
    }
  });

  it('marks the hero and every enemy as critical', () => {
    const critical = new Set(
      ASSET_MANIFEST.filter((e) => e.critical).map((e) => e.key)
    );
    expect(critical.has(ASSET_KEYS.DRIFTER)).toBe(true);
    for (const key of Object.values(ENEMY_TEXTURE_KEY)) {
      expect(critical.has(key), key).toBe(true);
    }
  });

  it('falls back to the Xeno Larva texture for an unknown enemy id', () => {
    expect(getEnemyTextureKey('not_a_real_enemy')).toBe(ASSET_KEYS.XENO_LARVA);
  });
});

describe('AssetStore preload', () => {
  it('loads every manifest entry', async () => {
    const store = new AssetStore();
    const loader = okLoader();

    const result = await store.load(loader);

    expect(loader).toHaveBeenCalledTimes(ASSET_MANIFEST.length);
    expect(result.loaded).toBe(ASSET_MANIFEST.length);
    expect(result.missing).toEqual([]);
    expect(store.complete).toBe(true);
    expect(store.get(ASSET_KEYS.DRIFTER)).toBeDefined();
  });

  it('reports progress monotonically', async () => {
    const store = new AssetStore();
    const seen = [];

    await store.load(okLoader(), { onProgress: (loaded, total) => seen.push([loaded, total]) });

    expect(seen).toHaveLength(ASSET_MANIFEST.length);
    expect(seen[0][0]).toBe(1);
    expect(seen[seen.length - 1][0]).toBe(ASSET_MANIFEST.length);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i][0]).toBeGreaterThan(seen[i - 1][0]);
    }
  });

  it('does not reject when a file is missing', async () => {
    const store = new AssetStore();

    // The state the repo is in right now: no art dropped yet.
    const result = await store.load(
      partialLoader(ASSET_MANIFEST.map((e) => e.key))
    );

    expect(result.loaded).toBe(0);
    expect(result.missing).toHaveLength(ASSET_MANIFEST.length);
    expect(store.ready).toBe(true);
    expect(store.complete).toBe(false);
  });

  it('keeps the assets that did load when others fail', async () => {
    const store = new AssetStore();

    const result = await store.load(partialLoader([ASSET_KEYS.PHANTOM_STALKER, ASSET_KEYS.BG_VOID]));

    expect(result.missing).toEqual([ASSET_KEYS.PHANTOM_STALKER, ASSET_KEYS.BG_VOID]);
    expect(store.has(ASSET_KEYS.DRIFTER)).toBe(true);
    expect(store.has(ASSET_KEYS.PHANTOM_STALKER)).toBe(false);
  });

  it('treats a loader returning nothing as a miss', async () => {
    const store = new AssetStore();
    await store.load(async () => undefined, {
      manifest: [{ key: 'x', url: 'x.png' }],
    });
    expect(store.missing).toEqual(['x']);
  });

  it('accepts a directly installed texture, which is how placeholders land', async () => {
    const store = new AssetStore();
    await store.load(partialLoader([ASSET_KEYS.XENO_LARVA]));
    expect(store.has(ASSET_KEYS.XENO_LARVA)).toBe(false);

    store.set(ASSET_KEYS.XENO_LARVA, fakeTexture('placeholder'));

    expect(store.has(ASSET_KEYS.XENO_LARVA)).toBe(true);
    // Still honestly reported as missing from disk.
    expect(store.missing).toContain(ASSET_KEYS.XENO_LARVA);
  });

  it('clears previous results on reload', async () => {
    const store = new AssetStore();
    await store.load(partialLoader([ASSET_KEYS.XENO_LARVA]));
    expect(store.missing).toHaveLength(1);

    await store.load(okLoader());

    expect(store.missing).toHaveLength(0);
    expect(store.complete).toBe(true);
  });

  it('exposes a shared store for the renderer', () => {
    expect(assets).toBeInstanceOf(AssetStore);
  });
});

describe('Sprite sizing', () => {
  it('scales a texture to the entity collision diameter', () => {
    // 128px art on a 12px-radius enemy: 24px diameter * fit / 128.
    const scale = scaleForRadius(fakeTexture('t'), 12, 1);
    expect(scale).toBeCloseTo(24 / 128, 6);
  });

  it('applies the fit allowance for soft edges', () => {
    const tight = scaleForRadius(fakeTexture('t'), 12, 1);
    const fitted = scaleForRadius(fakeTexture('t'), 12, SPRITE_FIT);
    expect(fitted).toBeGreaterThan(tight);
    expect(fitted / tight).toBeCloseTo(SPRITE_FIT, 6);
  });

  it('is resolution independent, so art can ship at any size', () => {
    const small = scaleForRadius({ width: 64, height: 64 }, 20);
    const large = scaleForRadius({ width: 512, height: 512 }, 20);
    // Rendered diameter is identical despite an 8x source difference.
    expect(small * 64).toBeCloseTo(large * 512, 6);
  });

  it('survives a missing texture without dividing by zero', () => {
    expect(Number.isFinite(scaleForRadius(undefined, 12))).toBe(true);
    expect(Number.isFinite(scaleForRadius({ width: 0 }, 12))).toBe(true);
  });
});

describe('Tinting', () => {
  it('converts hex strings to Pixi ints', () => {
    expect(hexToPixi('#ff8000')).toBe(0xff8000);
    expect(hexToPixi('000000')).toBe(0x000000);
  });

  it('gives the hero its default livery with no cosmetic equipped', () => {
    // NOT white: the atlas frame is untinted white geometry, so falling back to
    // NO_TINT would render a colourless ship rather than the Drifter.
    expect(cosmeticTint(null)).toBe(HERO_TINT);
    expect(cosmeticTint({})).toBe(HERO_TINT);
    expect(HERO_TINT).not.toBe(NO_TINT);
  });

  it('tints the hero sprite from the cosmetic palette', () => {
    expect(cosmeticTint({ tint: '#bcd8ff' })).toBe(0xbcd8ff);
  });
});
