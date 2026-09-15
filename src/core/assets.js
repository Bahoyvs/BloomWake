/**
 * Asset manifest and preload store.
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
 * SHEETS VS SINGLE FILES
 * A manifest entry is `{ key, url }` for a standalone image, or
 * `{ key, url, frame }` where `url` names a PixiJS JSON spritesheet and `frame`
 * a texture inside it. Which of the two an entry is stays PURE DATA — resolving
 * a frame out of a loaded sheet is the loader's job, on the render side. That
 * keeps atlas handling out of core while still letting the whole roster ship as
 * two atlases rather than twenty loose PNGs.
 *
 * ROBUSTNESS
 * A missing or broken file never rejects the load. It is recorded in `missing`
 * and the store hands back whatever fallback the loader produced, so a
 * half-populated public/assets folder still yields a running, playable game.
 */

/** Folder roots under public/assets/, matching the staged art layout. */
export const ASSET_ROOT = {
  SHIPS: 'assets/ships/',
  UI: 'assets/ui/',
};

/**
 * The two ship atlases the game ships, each compiled whole from its Kenney
 * source pack by tools/build-assets.mjs. See assets/README.md.
 *
 * They are split by PACK, not by role, and that is deliberate: an atlas is one
 * PNG plus offsets into it, so slicing a pack across `ships/` and `combat/`
 * would either duplicate the image or leave two JSONs pointing at one file.
 * One atlas per pack means one texture upload per pack and no ambiguity about
 * which copy is live. Role lives in ASSET_KEYS below, where it belongs.
 */
export const ASSET_SHEETS = {
  /** Space Shooter Redux — detailed fighters, wings, cockpits, bolts, blasts. */
  RAIDER: `${ASSET_ROOT.SHIPS}raider.json`,
  /** Shooter Expansion (2X) — heavy hulls, station spines, reactors, thrusters. */
  ARMADA: `${ASSET_ROOT.SHIPS}armada.json`,
};

/** Stable keys used everywhere in code; filenames stay an implementation detail. */
export const ASSET_KEYS = {
  // Hero
  DRIFTER: 'drifter',
  /** Engine flame stamped behind the hull, one per exhaust. */
  THRUSTER: 'thruster',
  /** Tactical Wingman escort drone — a smaller hull than the Drifter's. */
  WINGMAN: 'wingman',
  /** Hyperion Shield circular energy arc hull. */
  SHIELD: 'shield',
  // Ordnance
  /** Phase Repeater needle. */
  ION_BOLT: 'ion_bolt',
  /** Nanite Swarm micro-missile. */
  NANITE_MISSILE: 'nanite_missile',
  /** Aegis Satellite — a real satellite body, not a soft blue pill. */
  AEGIS_SAT: 'aegis_sat',
  /** The Dreadnought's radial bullets. */
  ENEMY_BOLT: 'enemy_bolt',
  // Particles
  PLASMA_MOTE: 'plasma_mote',
  LENS_FLARE: 'lens_flare',
  /** Hard four-point spark for impacts and engine grit. */
  SPARK: 'spark',
  // Chitin Swarm roster — six classes
  XENO_LARVA: 'xeno_larva',
  MANTIS_STRIDER: 'mantis_strider',
  DART_RAVAGER: 'dart_ravager',
  BROOD_SPORE: 'brood_spore',
  PHANTOM_STALKER: 'phantom_stalker',
  BIO_GOLIATH: 'bio_goliath',
  // The Dreadnought Station is a five-sprite composite.
  DREADNOUGHT_SPINE: 'dreadnought_spine',
  DREADNOUGHT_BEAM: 'dreadnought_beam',
  DREADNOUGHT_TURRET: 'dreadnought_turret',
  DREADNOUGHT_REACTOR: 'dreadnought_reactor',
  /*
   * NO ENVIRONMENT KEY HERE, DELIBERATELY. This used to hold BG_VOID, a
   * shipped bg_void.png the starfield's TilingSprite preferred over its own
   * procedural texture (`voidTile ?? makeStarfieldTexture()` in
   * background.js). That file was legacy nebula-cloud art — soft purple and
   * blue blobs baked into a 512x512 PNG — left over from before this
   * background became procedural, and it silently won that fallback every
   * time: every rework of makeStarfieldTexture() across several sessions was
   * correct in isolation and never once reached the screen, because a real
   * asset always beats a `??` fallback. It was the actual "repeating
   * blue/purple cellular pattern" this game's background reports kept
   * describing, unrelated to the caustics shader, the nebula tiling, or
   * anything else that got tuned instead over multiple passes.
   *
   * Removed rather than fixed-in-place: the background is procedural by
   * design now (see background.js's own header), and re-introducing a
   * drop-in image for the STARFIELD specifically should go through the same
   * deliberate, reviewed bridge the nebula uses (`tryLoadNebulaImage` in
   * background.js) — never back through this manifest, where "the file
   * happens to exist" silently overrides tuned procedural art with no review
   * step in between.
   */
};

/**
 * Everything preloaded before the first frame.
 * `critical: true` means the game is visually broken without it and the loader
 * should log loudly; non-critical assets degrade quietly.
 *
 * FRAMES ARE PICKED FOR SILHOUETTE FIRST.
 * The Shooter Redux enemy set is five distinct hull shapes repeated in four
 * colourways; the colourway is irrelevant here because every faction colour is
 * a `.tint` applied at render time (src/render/sprite-factory.js). What the
 * player reads at speed is the outline, so each species takes a different one:
 * a broad V for the chaff, a pointed dart for the fast striker, an angular claw
 * for the phasing stalker, wide swept wings for the frigate, and — from the
 * heavier expansion pack — a legged cruiser hull for the tank.
 *
 * These frames carry real internal detail (canopies, wing plates, engine
 * blocks), which is what the flat silhouette pack they replaced could not
 * offer: a tint over a shaded hull keeps its shading, so a tinted enemy reads
 * as a lit object rather than as a coloured cut-out.
 *
 * All Kenney hulls are drawn pointing up, which HULL_ROTATION_OFFSET corrects.
 */
export const ASSET_MANIFEST = [
  { key: ASSET_KEYS.DRIFTER, url: ASSET_SHEETS.RAIDER, frame: 'playerShip2_blue', critical: true },
  /*
   * A TAPERING PLUME, not a bar.
   *
   * This was spaceEffects_001, which is a hard-edged rectangle: rendered behind
   * the hull it read as two blue planks bolted to the back of the ship rather
   * than as thrust. fire15 is wide at the nozzle and narrows to a point, which
   * is the shape the renderer's anchor assumes — pinned by its TOP edge and
   * grown astern (see drawThrusters).
   */
  { key: ASSET_KEYS.THRUSTER, url: ASSET_SHEETS.RAIDER, frame: 'fire15' },
  // A different, smaller hull than the Drifter's, so the escort never reads as
  // a second player ship.
  { key: ASSET_KEYS.WINGMAN, url: ASSET_SHEETS.RAIDER, frame: 'playerShip3_blue' },
  // Circular energy arc shield encompassing the Drifter.
  { key: ASSET_KEYS.SHIELD, url: ASSET_SHEETS.RAIDER, frame: 'shield2' },

  // Ordnance. Real frames, not Graphics primitives: a drawn ellipse is what
  // made the old satellites read as blue pills.
  { key: ASSET_KEYS.ION_BOLT, url: ASSET_SHEETS.RAIDER, frame: 'laserBlue01' },
  { key: ASSET_KEYS.NANITE_MISSILE, url: ASSET_SHEETS.ARMADA, frame: 'spaceMissiles_005' },
  { key: ASSET_KEYS.AEGIS_SAT, url: ASSET_SHEETS.ARMADA, frame: 'spaceBuilding_015' },
  { key: ASSET_KEYS.ENEMY_BOLT, url: ASSET_SHEETS.RAIDER, frame: 'laserRed01' },

  { key: ASSET_KEYS.PLASMA_MOTE, url: ASSET_SHEETS.RAIDER, frame: 'star1' },
  { key: ASSET_KEYS.LENS_FLARE, url: ASSET_SHEETS.RAIDER, frame: 'star3' },
  // Four-point star: a hard, high-frequency spark. Replaces the soft ghost
  // chain that used to trail the Drifter.
  { key: ASSET_KEYS.SPARK, url: ASSET_SHEETS.RAIDER, frame: 'laserBlue08' },

  /*
   * THE SIX SWARM CLASSES.
   *
   * One frame each, chosen so the outlines cannot be confused at speed:
   * a faceted diamond, a twin-mandible claw, a needle dart, a four-noded
   * satellite body, an angular two-tier shell, and a broad armoured mass.
   * Two of them come from the expansion pack precisely because the fighter
   * set has no shape like them.
   */
  // Xeno Larva — faceted diamond core, the smallest thing in the wave.
  { key: ASSET_KEYS.XENO_LARVA, url: ASSET_SHEETS.ARMADA, frame: 'spaceBuilding_018', critical: true },
  // Mantis Strider — twin mandibles either side of a pointed body.
  { key: ASSET_KEYS.MANTIS_STRIDER, url: ASSET_SHEETS.RAIDER, frame: 'enemyBlack1', critical: true },
  // Dart Ravager — the sharpest needle in the set, and the only one that dashes.
  { key: ASSET_KEYS.DART_RAVAGER, url: ASSET_SHEETS.RAIDER, frame: 'enemyBlack5', critical: true },
  // Brood Spore — four panel nodes around a core; nothing else on the field is
  // built out of repeated modules, which is what sells "polyp".
  { key: ASSET_KEYS.BROOD_SPORE, url: ASSET_SHEETS.ARMADA, frame: 'spaceStation_018', critical: true },
  // Phantom Stalker — angular two-tier shell, still readable at alpha 0.2.
  { key: ASSET_KEYS.PHANTOM_STALKER, url: ASSET_SHEETS.RAIDER, frame: 'enemyBlack3', critical: true },
  // Bio-Goliath — broad multi-plated armoured mass, the widest hull short of
  // the boss.
  { key: ASSET_KEYS.BIO_GOLIATH, url: ASSET_SHEETS.ARMADA, frame: 'spaceShips_009', critical: true },

  /*
   * The Dreadnought Station: a vertical keel, a WIDE horizontal cross-member,
   * two turret platforms at the beam tips, and a reactor at the hub.
   *
   * The cross-member is the new part. The previous keel frame on its own was a
   * tall thin cross that read as a single bar at any distance — exactly the
   * "ince tek çubuk" the brief asked to be rid of. Laying a wide slab across it
   * gives the station shoulders and somewhere to bolt the turrets.
   */
  /*
   * The keel must be UNPAINTED GREY.
   *
   * spaceStation_017 was tried here and rejected: it carries bright blue solar
   * panels, and because a Pixi tint MULTIPLIES, the station's gunmetal wash
   * cannot remove them — blue times grey is still blue. The boss came out as a
   * satellite with glowing blue plates, which breaks both the "heavy grey
   * station" brief and the palette's darkness ceiling. spaceStation_026 is bare
   * grey structure, so the tint fully owns its colour.
   */
  { key: ASSET_KEYS.DREADNOUGHT_SPINE, url: ASSET_SHEETS.ARMADA, frame: 'spaceStation_026', critical: true },
  { key: ASSET_KEYS.DREADNOUGHT_BEAM, url: ASSET_SHEETS.ARMADA, frame: 'spaceStation_001', critical: true },
  { key: ASSET_KEYS.DREADNOUGHT_TURRET, url: ASSET_SHEETS.ARMADA, frame: 'spaceBuilding_012', critical: true },
  { key: ASSET_KEYS.DREADNOUGHT_REACTOR, url: ASSET_SHEETS.ARMADA, frame: 'spaceBuilding_007', critical: true },
];

/**
 * DOM-side art, referenced from CSS rather than loaded into Pixi.
 *
 * Listed here so the level-up panel's plates have the same single source of
 * truth as everything the renderer loads — a missing badge should be findable
 * from the manifest, not only by reading a stylesheet.
 */
export const UI_ASSETS = {
  CARD_PANEL: `${ASSET_ROOT.UI}panel_card.png`,
  GLASS_PANEL: `${ASSET_ROOT.UI}panel_glass.png`,
  BUTTON_PANEL: `${ASSET_ROOT.UI}panel_button.png`,
  /*
   * Meta-UI console chrome: the riveted chassis the menu and the Salvage Depot
   * are built from, the lighter sub-console face its cards use, and the raised
   * key with the depth plinth its buttons use. All three 9-slice at 16px.
   */
  CONSOLE_PLATE: `${ASSET_ROOT.UI}console_plate.png`,
  CONSOLE_BAY: `${ASSET_ROOT.UI}console_bay.png`,
  CONSOLE_KEY: `${ASSET_ROOT.UI}console_key.png`,
  BADGE_COMMON: `${ASSET_ROOT.UI}badge_common.png`,
  BADGE_UNCOMMON: `${ASSET_ROOT.UI}badge_uncommon.png`,
  BADGE_RARE: `${ASSET_ROOT.UI}badge_rare.png`,
  BADGE_LEGENDARY: `${ASSET_ROOT.UI}badge_legendary.png`,
};

/**
 * Enemy data-table id -> texture key.
 *
 * The ids are the original roster ids and stay that way — they are save-game
 * and simulation-dispatch keys owned by src/core/, so the re-skin renames what
 * the player SEES (src/data/enemies.js) and leaves the wiring alone.
 * Keeping this map beside the manifest means a new enemy needs one row here and
 * one atlas frame, not a renderer change.
 */
export const ENEMY_TEXTURE_KEY = {
  tarling: ASSET_KEYS.XENO_LARVA,
  ashfish: ASSET_KEYS.MANTIS_STRIDER,
  cracked_wisp: ASSET_KEYS.DART_RAVAGER,
  rustbloom: ASSET_KEYS.BROOD_SPORE,
  smogmoth: ASSET_KEYS.PHANTOM_STALKER,
  bio_goliath: ASSET_KEYS.BIO_GOLIATH,
  rustwhale: ASSET_KEYS.DREADNOUGHT_SPINE,
};

/**
 * @param {string} typeId - Enemy id from src/data/enemies.js
 * @returns {string} Texture key, falling back to the Xeno Larva silhouette
 */
export function getEnemyTextureKey(typeId) {
  return ENEMY_TEXTURE_KEY[typeId] ?? ASSET_KEYS.XENO_LARVA;
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
   * @param {(entry: {key: string, url: string, frame?: string, critical?: boolean}) => Promise<*>} loader
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
    // progress reporting monotonic for a loading bar. Entries that share a
    // sheet cost one fetch in total — the loader caches by url.
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
