/**
 * BloomWake visual theme (Phase 6) — Frutiger Aero/Aqua vs Frutevil.
 *
 * ---------------------------------------------------------------------------
 * THE VISUAL SOUP RULE
 * ---------------------------------------------------------------------------
 * The Development Plan's headline Phase 6 risk is the player losing track of
 * the Dewling in a 200-enemy swarm. The mitigation is not "add more glow" — it
 * is a luminance split enforced by the palette itself:
 *
 *   - The HERO side (Dewling, its trail, its shield) is the only very LIGHT
 *     thing on screen. Nothing else is allowed near its luminance.
 *   - The FRUTEVIL side is uniformly DARK and desaturated, drawn from a
 *     deliberately small hue set. Adding a 200th enemy cannot raise the average
 *     screen luminance into the Dewling's band, because no enemy colour is
 *     anywhere near it.
 *   - The BACKGROUND is a simple two-stop dark gradient. No busy detail, no
 *     competing brights.
 *
 * Because the split is numeric, it is testable: tests/theme.test.js asserts a
 * minimum contrast ratio between the Dewling and every enemy colour, every
 * projectile colour and the background. A future palette tweak that would
 * reintroduce visual soup fails CI instead of shipping.
 */

/**
 * Draw order. Higher paints later, i.e. on top.
 * The Dewling and its trail are last by rule — see above.
 */
export const Z_ORDER = {
  BACKGROUND: 0,
  ARENA: 10,
  HAZARD: 20,
  TELEGRAPH: 30,
  ORB: 40,
  ENEMY: 50,
  BOSS: 55,
  PROJECTILE: 60,
  CARD_EFFECT: 70,
  PARTICLE: 80,
  /** Nothing may be drawn above these two. */
  PLAYER_TRAIL: 90,
  PLAYER: 100,
};

/** Minimum contrast ratio the Dewling must keep against anything behind it. */
export const MIN_HERO_CONTRAST = 4.5;

/** Ceiling on Frutevil luminance, so no enemy can approach the hero band. */
export const MAX_ENEMY_LUMINANCE = 0.25;

/** Floor on hero luminance. */
export const MIN_HERO_LUMINANCE = 0.6;

export const THEME = {
  /* --- Frutiger Aqua: the hero. The only bright things on screen. --- */
  hero: {
    core: '#f2fdff',
    body: '#bfefff',
    rim: '#7fe6ff',
    halo: '#5ad6ff',
    trail: '#8fe9ff',
    shield: '#ffe9a8',
    specular: '#ffffff',
  },

  /* --- Player-side offence: bright, but cooler/warmer than the Dewling so
         a bullet is never mistaken for the character. --- */
  offence: {
    dewdrop: '#dff6ff',
    petal: '#ffe6f2',
    beam: '#fff4c2',
    blade: '#d8f2ff',
    pulse: '#9fdcff',
    tide: '#7fe8d2',
  },

  /* --- Frutevil: a deliberately small, dark, desaturated hue set.
         Four families only — tar, ash, rust, soot. --- */
  frutevil: {
    tar: '#191a22',
    tarRim: '#3d4152',
    ash: '#343d49',
    ashRim: '#5a6675',
    shard: '#2c3844',
    /**
     * The glassiest rim in the set — Cracked Wisp needs to read as a shard, so
     * it sits at the light end. Capped at #5d7182 (4.88:1 against the Dewling);
     * the previous #63788a scored 4.42 and failed the contrast floor.
     */
    shardRim: '#5d7182',
    rust: '#3d2418',
    rustRim: '#7a4a2c',
    soot: '#20242e',
    sootRim: '#474f60',
    whale: '#241417',
    whaleRim: '#6b3038',
    /** Hazards and the boss telegraph share one warning hue. */
    warning: '#a8402f',
  },

  /* --- Background: simplified two-stop gradient plus faint Aero motifs. --- */
  background: {
    top: '#071a24',
    bottom: '#03080f',
    grid: '#0d2531',
    border: '#16455a',
    bubble: '#0e3040',
    ray: '#0b2836',
  },

  /* --- XP and pickups. --- */
  pickup: {
    orb: '#9bf5c4',
    orbCore: '#e6fff2',
  },
};

/**
 * Every Frutevil colour that gets painted as a large filled shape.
 * Rim colours are thin outlines and are checked separately.
 */
export const ENEMY_FILL_COLORS = [
  THEME.frutevil.tar,
  THEME.frutevil.ash,
  THEME.frutevil.shard,
  THEME.frutevil.rust,
  THEME.frutevil.soot,
  THEME.frutevil.whale,
];

/**
 * Parse a #rrggbb string into 0-255 channels.
 * @param {string} hex
 * @returns {{r: number, g: number, b: number}}
 */
export function parseHex(hex) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

/**
 * WCAG relative luminance, 0 (black) to 1 (white).
 * @param {string} hex
 * @returns {number}
 */
export function relativeLuminance(hex) {
  const { r, g, b } = parseHex(hex);
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * WCAG contrast ratio between two colours, 1 (identical) to 21 (black/white).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Blend toward white/black for cheap tint variation without new palette entries.
 * @param {string} hex
 * @param {number} amount - -1 (black) .. 1 (white)
 * @returns {string}
 */
export function shade(hex, amount) {
  const { r, g, b } = parseHex(hex);
  const target = amount >= 0 ? 255 : 0;
  const t = Math.abs(amount);
  const mix = (c) => Math.round(c + (target - c) * t);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/**
 * `rgba()` string from a hex plus alpha — used constantly for Aero glass and
 * particle fades.
 * @param {string} hex
 * @param {number} alpha
 * @returns {string}
 */
export function withAlpha(hex, alpha) {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Palette entry for one enemy type, keyed by the data table's `id`.
 * @param {string} typeId
 * @returns {{fill: string, rim: string}}
 */
export function getEnemyPalette(typeId) {
  const f = THEME.frutevil;
  switch (typeId) {
    case 'ashfish':
      return { fill: f.ash, rim: f.ashRim };
    case 'cracked_wisp':
      return { fill: f.shard, rim: f.shardRim };
    case 'rustbloom':
      return { fill: f.rust, rim: f.rustRim };
    case 'smogmoth':
      return { fill: f.soot, rim: f.sootRim };
    case 'rustwhale':
      return { fill: f.whale, rim: f.whaleRim };
    case 'tarling':
    default:
      return { fill: f.tar, rim: f.tarRim };
  }
}
