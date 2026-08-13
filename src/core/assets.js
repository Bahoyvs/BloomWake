/**
 * Asset manifest and preload store (Phase 6b).
 *
 * The game must not start until textures are resolved, so this module owns the
 * manifest and the load lifecycle.
 *
 * ARCHITECTURE NOTE
 * src/core/ is DOM-free and Node-testable, and that rule is not relaxed here.
 * The actual texture fetch is INJECTED as a `loader` function, so this module
 * never imports PixiJS or touches the network itself. The real loader lives in
 * src/render/pixi-loader.js; tests pass a mock. Same dependency-injection
 * pattern the RNG uses across the rest of core.
 *
 * ROBUSTNESS
 * A missing or broken file never rejects the load. It is recorded in
 * `missing` and the store hands back whatever fallback the loader produced, so
 * a half-populated /assets folder still yields a running, playable game. Drop
 * the real PNGs in and the same code path picks them up with no edits.
 */

/** Folder roots, matching the layout the art drop uses. */
export const ASSET_ROOT = {
  SPRITES: 'assets/sprites/',
  UI: 'assets/ui/',
};

/** Stable keys used everywhere in code; filenames stay an implementation detail. */
export const ASSET_KEYS = {
  // Hero and particles
  DEWLING: 'dewling',
  BUBBLE_PARTICLE: 'bubble_particle',
  LENS_FLARE: 'lens_flare',
  // Frutevil roster
  TARLING: 'tarling',
  ASHFISH: 'ashfish',
  CRACKED_WISP: 'cracked_wisp',
  RUSTBLOOM: 'rustbloom',
  SMOGMOTH: 'smogmoth',
  RUSTWHALE_BOSS: 'rustwhale_boss',
  // Environment
  BG_AQUA: 'bg_aqua',
};

/**
 * Everything preloaded before the first frame.
 * `critical: true` means the game is visually broken without it and the loader
 * should log loudly; non-critical assets degrade quietly.
 */
export const ASSET_MANIFEST = [
  { key: ASSET_KEYS.DEWLING, url: `${ASSET_ROOT.SPRITES}dewling.png`, critical: true },
  { key: ASSET_KEYS.BUBBLE_PARTICLE, url: `${ASSET_ROOT.SPRITES}bubble_particle.png` },
  { key: ASSET_KEYS.LENS_FLARE, url: `${ASSET_ROOT.SPRITES}lens_flare.png` },

  { key: ASSET_KEYS.TARLING, url: `${ASSET_ROOT.SPRITES}tarling.png`, critical: true },
  { key: ASSET_KEYS.ASHFISH, url: `${ASSET_ROOT.SPRITES}ashfish.png`, critical: true },
  { key: ASSET_KEYS.CRACKED_WISP, url: `${ASSET_ROOT.SPRITES}cracked_wisp.png`, critical: true },
  { key: ASSET_KEYS.RUSTBLOOM, url: `${ASSET_ROOT.SPRITES}rustbloom.png`, critical: true },
  { key: ASSET_KEYS.SMOGMOTH, url: `${ASSET_ROOT.SPRITES}smogmoth.png`, critical: true },
  { key: ASSET_KEYS.RUSTWHALE_BOSS, url: `${ASSET_ROOT.SPRITES}rustwhale_boss.png`, critical: true },

  { key: ASSET_KEYS.BG_AQUA, url: `${ASSET_ROOT.UI}bg_aqua.jpg` },
];

/**
 * Enemy data-table id -> texture key. Keeping this beside the manifest means a
 * new enemy needs one row here and one file, not a renderer change.
 */
export const ENEMY_TEXTURE_KEY = {
  tarling: ASSET_KEYS.TARLING,
  ashfish: ASSET_KEYS.ASHFISH,
  cracked_wisp: ASSET_KEYS.CRACKED_WISP,
  rustbloom: ASSET_KEYS.RUSTBLOOM,
  smogmoth: ASSET_KEYS.SMOGMOTH,
  rustwhale: ASSET_KEYS.RUSTWHALE_BOSS,
};

/**
 * @param {string} typeId - Enemy id from src/data/enemies.js
 * @returns {string} Texture key, falling back to the Tarling silhouette
 */
export function getEnemyTextureKey(typeId) {
  return ENEMY_TEXTURE_KEY[typeId] ?? ASSET_KEYS.TARLING;
}

export class AssetStore {
  constructor() {
    /** key -> texture (or fallback) */
    this.textures = new Map();
    /** Keys whose file could not be loaded. */
    this.missing = [];
    this.ready = false;
  }

  /**
   * Preload the manifest.
   *
   * @param {(entry: {key: string, url: string, critical?: boolean}) => Promise<*>} loader
   *   Resolves to a texture. May reject; rejection is caught and recorded.
   * @param {Object} [options]
   * @param {(loaded: number, total: number, key: string) => void} [options.onProgress]
   * @param {Array} [options.manifest] - Override, for tests
   * @returns {Promise<{loaded: number, missing: Array<string>}>}
   */
  async load(loader, { onProgress, manifest = ASSET_MANIFEST } = {}) {
    this.textures.clear();
    this.missing.length = 0;

    let done = 0;
    // Sequential rather than parallel: the manifest is small, and this keeps
    // progress reporting monotonic for a loading bar.
    for (const entry of manifest) {
      try {
        const texture = await loader(entry);
        if (!texture) throw new Error('loader returned nothing');
        this.textures.set(entry.key, texture);
      } catch (error) {
        this.missing.push(entry.key);
        if (entry.critical) {
          console.warn(`[BloomWake] Missing critical asset "${entry.key}" (${entry.url}).`, error);
        }
      }
      done++;
      onProgress?.(done, manifest.length, entry.key);
    }

    this.ready = true;
    return { loaded: this.textures.size, missing: [...this.missing] };
  }

  /**
   * @param {string} key
   * @returns {*} Texture, or undefined when absent
   */
  get(key) {
    return this.textures.get(key);
  }

  /**
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.textures.has(key);
  }

  /**
   * Register a texture directly. Used by the loader to install generated
   * placeholders, and by tests.
   * @param {string} key
   * @param {*} texture
   */
  set(key, texture) {
    this.textures.set(key, texture);
  }

  /** True when every manifest entry resolved to a real file. */
  get complete() {
    return this.ready && this.missing.length === 0;
  }
}

/** Process-wide store; the renderer reads from this. */
export const assets = new AssetStore();
