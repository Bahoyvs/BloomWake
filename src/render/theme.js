/**
 * BloomWake visual theme — Void Drifter vs. The Chitin Swarm.
 *
 * ---------------------------------------------------------------------------
 * THE VISUAL SOUP RULE
 * ---------------------------------------------------------------------------
 * The headline risk is the player losing track of the Drifter in a 200-enemy
 * swarm. The mitigation is not "add more glow" — it is a luminance split
 * enforced by the palette itself:
 *
 *   - The HERO side (Drifter hull, its ion trail, its shield) is the only very
 *     LIGHT thing on screen. Nothing else is allowed near its luminance.
 *   - The SWARM side is uniformly DARK, drawn from a deliberately small hue
 *     set. Adding a 200th enemy cannot raise the average screen luminance into
 *     the Drifter's band, because no enemy colour is anywhere near it.
 *   - The BACKGROUND is deep-space black. No busy detail, no competing brights.
 *
 * Because the split is numeric, it is testable: tests/theme.test.js asserts a
 * minimum contrast ratio between the Drifter and every enemy colour, every
 * projectile colour and the background. A future palette tweak that would
 * reintroduce visual soup fails CI instead of shipping.
 *
 * TWO GROUPS SIT OUTSIDE THE DARK BAND ON PURPOSE — `bio` and `danger`.
 * Bio-acid green and telegraph red are high-salience SIGNALS (a corpse burst, a
 * one-second warning before an AoE lands), not enemy bodies. They are painted
 * as short-lived particles and rings, never as a silhouette the player has to
 * separate the hero from, so holding them to the swarm's darkness ceiling would
 * make the warnings unreadable without buying any hero legibility. They get
 * their own test instead: they must out-contrast the BACKDROP, and must not
 * collide with the hero's hue.
 */

/**
 * The seven colours the theme brief pins exactly, as PixiJS ints.
 *
 * THEME below is the working palette — rims, shades and variants derived
 * around these. This object is the contract: it is what a designer hands over
 * and what tests assert against, so it is written once, verbatim, here rather
 * than being scattered as literals through the render layer.
 */
export const PALETTE = {
  /** Deep-space black. */
  background: 0x05070f,
  /** Neon cyan — the Drifter's hull light. */
  heroPrimary: 0x00f0ff,
  /** Ion blue — engine wash and Phase Repeater bolts. */
  heroSecondary: 0x3b82f6,
  /** Chitin obsidian — the Swarm's base carapace. */
  alienObsidian: 0x1a1c23,
  /** Bio-acid green — ruptured hive matter. */
  alienAcid: 0x00ff88,
  /** Hive parasite magenta. */
  alienMagenta: 0xff007f,
  /** Danger and telegraph. */
  dangerRed: 0xff2a55,
};

/**
 * Draw order. Higher paints later, i.e. on top.
 * The Drifter and its trail are last by rule — see above.
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

/** Minimum contrast ratio the Drifter must keep against anything behind it. */
export const MIN_HERO_CONTRAST = 4.5;

/** Ceiling on Swarm luminance, so no enemy can approach the hero band. */
export const MAX_ENEMY_LUMINANCE = 0.25;

/** Floor on hero luminance. */
export const MIN_HERO_LUMINANCE = 0.6;

export const THEME = {
  /* --- The Void Drifter. The only bright things on screen. --- */
  hero: {
    core: '#eafdff',
    body: '#00f0ff',
    rim: '#7df9ff',
    halo: '#38e6ff',
    trail: '#5ce8ff',
    shield: '#9deaff',
    specular: '#ffffff',
    /**
     * Ion blue sits BELOW the hero luminance floor on purpose: it is the
     * engine wash and bolt trail, read against the hull rather than instead of
     * it, so it is deliberately not one of the three tested hero colours.
     */
    ion: '#3b82f6',
  },

  /* --- Player-side offence: bright, but cooler/warmer than the hull so a
         bolt is never mistaken for the ship. --- */
  offence: {
    /** Phase Repeater — ion laser bolts. */
    ion: '#8fd8ff',
    /** Nova Flak — radial plasma bursts. */
    nova: '#ffe0f4',
    /**
     * Singularity Lance core. The lance reads as a crimson-sheathed blue beam:
     * this is the hot inner strip, `beamSheath` the dark red outer one.
     */
    beam: '#e6f0ff',
    /** Aegis Satellites — defensive drones orbiting the Drifter. */
    aegis: '#bfe9ff',
    /** Hyperion Shield bubble. */
    pulse: '#9fdcff',
    /** Graviton EMP shockwave ring. */
    graviton: '#7fe8d2',
  },

  /**
   * The Chitin Swarm: a deliberately small, dark hue set.
   * Seven carapaces — one per roster entry, six classes plus the boss — so no
   * enemy introduces a colour of its own. `rim` is the thin edge light.
   */
  swarm: {
    /**
     * PALETTE.alienObsidian — the Swarm's base carapace, and the shade its
     * chrome is painted in. Every hull's shadowed plating multiplies down
     * toward this, and the enemy health-bar track is painted with it outright
     * so the UI reads as part of the same material as the ships.
     */
    chitin: '#1a1c23',
    /** Xeno Larva — faceted diamond chaff, deep hive indigo. */
    larva: '#1b1464',
    larvaRim: '#3a30a0',
    /** Dart Ravager — light striker, hive parasite purple. */
    ravager: '#833471',
    ravagerRim: '#a8438f',
    /** Phantom Stalker — medium, cold slate. */
    stalker: '#2c3a47',
    stalkerRim: '#4d6479',
    /** Mantis Strider — medium, bio-mechanical teal. */
    strider: '#006266',
    striderRim: '#097074',
    /** Brood Spore — the carrier, slate violet. */
    spore: '#3b3b98',
    sporeRim: '#6b64cf',
    /** Bio-Goliath — heavy guardian, deep armour violet. */
    goliath: '#4a148c',
    goliathRim: '#7033ad',
    /**
     * The Dreadnought Station.
     *
     * Gunmetal rather than the obsidian the swarm wears: the brief calls for a
     * heavy grey station, and a boss that reads as the same material as the
     * chaff around it reads as a big piece of chaff. It is still held to the
     * swarm's darkness ceiling — a lighter grey would have been easier to
     * paint and would have started the visual-soup problem over at boss scale.
     */
    dreadnought: '#646b78',
    /**
     * Reactor spill on the plating, not a lighter grey.
     *
     * A rim is normally a brighter version of its fill, but there is no grey
     * brighter than gunmetal that still clears the swarm's darkness ceiling.
     * Lighting the station's edges with the colour of its own core is both
     * inside the contract and a better read: the boss looks lit from within.
     */
    dreadnoughtRim: '#7a3a4e',
  },

  /**
   * Bioluminescence. Signal colours, not bodies — see the header note.
   * These are the only Swarm-side colours allowed above the darkness ceiling.
   */
  bio: {
    /** PALETTE.alienAcid — corpse spray, Dreadnought core glow. */
    acid: '#00ff88',
    /** PALETTE.alienMagenta — hive parasite spray. */
    magenta: '#ff007f',
  },

  /** Telegraphs and hazards share one warning hue. */
  danger: {
    /** PALETTE.dangerRed — the Bio-Acid Bloom telegraph ring. */
    telegraph: '#ff2a55',
    /**
     * The Dreadnought's reactor warning light. Deliberately offset from
     * `telegraph`: a charging AoE and a boss's exposed core are two different
     * events, and painting them the same red would merge them into one.
     */
    reactor: '#ff3d7a',
    /** Lingering acid pools left by a Bio-Goliath. */
    hazard: '#d055a6',
    hazardRim: '#ff6ec7',
  },

  /* --- Background: deep space, two dark stops plus a faint nebula. --- */
  background: {
    top: '#05070f',
    bottom: '#02030a',
    grid: '#101a2e',
    border: '#123a55',
    nebula: '#0d1030',
    ray: '#0a1a2c',
  },

  /* --- XP and pickups: harvested bio-mass. --- */
  pickup: {
    orb: '#78ffc2',
    orbCore: '#e8fff5',
  },
};

/**
 * Every Swarm colour that gets painted as a large filled shape.
 * Rim colours are thin outlines and are checked separately.
 */
export const SWARM_FILL_COLORS = [
  THEME.swarm.larva,
  THEME.swarm.ravager,
  THEME.swarm.stalker,
  THEME.swarm.strider,
  THEME.swarm.spore,
  THEME.swarm.goliath,
  THEME.swarm.dreadnought,
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
 * Hue angle in degrees, 0-360.
 *
 * The signal colours (bio-acid, telegraph red) are deliberately BRIGHTER than
 * the Swarm's luminance ceiling, so luminance cannot be what keeps them from
 * being mistaken for the Drifter. Hue distance is. This is the measurement that
 * rule is asserted with — see tests/theme.test.js.
 *
 * @param {string} hex
 * @returns {number} Degrees; 0 for a grey, which has no meaningful hue
 */
export function hue(hex) {
  const { r, g, b } = parseHex(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;

  let h;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;

  return (h * 60 + 360) % 360;
}

/**
 * Smallest angle between two hues, 0-180.
 * @param {string} a
 * @param {string} b
 * @returns {number} Degrees
 */
export function hueDistance(a, b) {
  const diff = Math.abs(hue(a) - hue(b)) % 360;
  return diff > 180 ? 360 - diff : diff;
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
 * `rgba()` string from a hex plus alpha — used constantly for glass panels and
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
 *
 * The `id`s are the original roster ids and stay that way: they are save-game
 * and simulation-dispatch keys owned by src/core/. The Chitin Swarm identity
 * lives in the display names (src/data/enemies.js) and in this palette.
 *
 * @param {string} typeId
 * @returns {{fill: string, rim: string}}
 */
export function getEnemyPalette(typeId) {
  const s = THEME.swarm;
  switch (typeId) {
    case 'ashfish': // Mantis Strider
      return { fill: s.strider, rim: s.striderRim };
    case 'cracked_wisp': // Dart Ravager
      return { fill: s.ravager, rim: s.ravagerRim };
    case 'rustbloom': // Brood Spore
      return { fill: s.spore, rim: s.sporeRim };
    case 'smogmoth': // Phantom Stalker
      return { fill: s.stalker, rim: s.stalkerRim };
    case 'bio_goliath': // Bio-Goliath
      return { fill: s.goliath, rim: s.goliathRim };
    case 'rustwhale': // Dreadnought Station
      return { fill: s.dreadnought, rim: s.dreadnoughtRim };
    case 'tarling': // Xeno Larva
    default:
      return { fill: s.larva, rim: s.larvaRim };
  }
}
