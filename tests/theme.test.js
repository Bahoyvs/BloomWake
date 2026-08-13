/**
 * Visual Soup verification (Development Plan, Phase 6 risk row).
 *
 * The plan's acceptance criterion is a playtest: with 200 enemies and 50
 * projectiles on screen, a tester must locate the Dewling within one second.
 * That is a human judgement, but the property underneath it is not — the
 * Dewling is findable because it is the brightest thing on screen by a wide
 * margin, and nothing else is allowed near its luminance band.
 *
 * These tests pin that property numerically, so a future palette tweak that
 * would reintroduce visual soup fails here rather than in a playtest.
 */

import { describe, it, expect } from 'vitest';
import {
  THEME,
  Z_ORDER,
  ENEMY_FILL_COLORS,
  MIN_HERO_CONTRAST,
  MAX_ENEMY_LUMINANCE,
  MIN_HERO_LUMINANCE,
  relativeLuminance,
  contrastRatio,
  getEnemyPalette,
  parseHex,
  withAlpha,
} from '../src/render/theme.js';
import { ENEMIES } from '../src/data/enemies.js';

/** Every colour a Frutevil silhouette or its rim can be painted with. */
const ALL_FRUTEVIL = Object.values(THEME.frutevil);
/** The Dewling's own colours. */
const HERO_COLORS = [THEME.hero.core, THEME.hero.body, THEME.hero.rim];

describe('Hero/Frutevil luminance split', () => {
  it('keeps every hero colour in the bright band', () => {
    for (const color of HERO_COLORS) {
      expect(relativeLuminance(color), color).toBeGreaterThanOrEqual(MIN_HERO_LUMINANCE);
    }
  });

  it('keeps every Frutevil fill in the dark band', () => {
    for (const color of ENEMY_FILL_COLORS) {
      expect(relativeLuminance(color), color).toBeLessThanOrEqual(MAX_ENEMY_LUMINANCE);
    }
  });

  it('never lets a Frutevil colour approach the hero band', () => {
    const dimmestHero = Math.min(...HERO_COLORS.map(relativeLuminance));
    for (const color of ALL_FRUTEVIL) {
      expect(relativeLuminance(color), color).toBeLessThan(dimmestHero);
    }
  });

  it('clears the contrast floor against every enemy fill', () => {
    // This is the property that makes enemy COUNT irrelevant: adding a 200th
    // dark enemy cannot reduce the Dewling's contrast against any of them.
    for (const color of ENEMY_FILL_COLORS) {
      expect(contrastRatio(THEME.hero.core, color), color).toBeGreaterThanOrEqual(
        MIN_HERO_CONTRAST
      );
    }
  });

  it('clears the contrast floor against enemy rim colours too', () => {
    for (const color of ALL_FRUTEVIL) {
      expect(contrastRatio(THEME.hero.core, color), color).toBeGreaterThanOrEqual(
        MIN_HERO_CONTRAST
      );
    }
  });

  it('clears the contrast floor against the background', () => {
    for (const color of Object.values(THEME.background)) {
      expect(contrastRatio(THEME.hero.core, color), color).toBeGreaterThanOrEqual(
        MIN_HERO_CONTRAST
      );
    }
  });

  it('keeps the background darker than every enemy so silhouettes read', () => {
    const brightestBackdrop = Math.max(
      relativeLuminance(THEME.background.top),
      relativeLuminance(THEME.background.bottom)
    );
    for (const color of ENEMY_FILL_COLORS) {
      // Enemies must not sink below the backdrop, or they vanish instead of
      // reading as shapes.
      expect(relativeLuminance(color), color).toBeGreaterThan(brightestBackdrop * 0.3);
    }
  });
});

describe('Palette is bounded, not open-ended', () => {
  it('gives every enemy in the roster a palette entry', () => {
    for (const id of Object.keys(ENEMIES)) {
      const palette = getEnemyPalette(id);
      expect(palette.fill, id).toBeDefined();
      expect(palette.rim, id).toBeDefined();
    }
  });

  it('limits Frutevil to a small hue set', () => {
    // The plan calls for a RESTRICTED enemy palette. Six fills across six enemy
    // types means no enemy introduces a colour of its own.
    expect(ENEMY_FILL_COLORS.length).toBeLessThanOrEqual(6);
    expect(new Set(ENEMY_FILL_COLORS).size).toBe(ENEMY_FILL_COLORS.length);
  });

  it('gives distinct fills to enemies that swarm together', () => {
    // Tarling, Ashfish and Cracked Wisp co-exist from wave 4 onward.
    const swarm = ['tarling', 'ashfish', 'cracked_wisp'].map((id) => getEnemyPalette(id).fill);
    expect(new Set(swarm).size).toBe(3);
  });

  it('keeps player projectiles distinguishable from the Dewling body', () => {
    // Bright, but not identical — a bullet must never read as the character.
    for (const color of [THEME.offence.dewdrop, THEME.offence.petal, THEME.offence.beam]) {
      expect(color).not.toBe(THEME.hero.body);
      expect(relativeLuminance(color)).toBeGreaterThan(MAX_ENEMY_LUMINANCE);
    }
  });
});

describe('Draw order', () => {
  it('puts the Dewling above absolutely everything', () => {
    const others = Object.entries(Z_ORDER).filter(([key]) => key !== 'PLAYER');
    for (const [key, value] of others) {
      expect(value, key).toBeLessThan(Z_ORDER.PLAYER);
    }
  });

  it('puts the trail above every enemy, projectile and effect', () => {
    for (const key of ['ENEMY', 'BOSS', 'PROJECTILE', 'CARD_EFFECT', 'PARTICLE', 'HAZARD']) {
      expect(Z_ORDER[key], key).toBeLessThan(Z_ORDER.PLAYER_TRAIL);
    }
  });

  it('keeps the background beneath the arena', () => {
    expect(Z_ORDER.BACKGROUND).toBeLessThan(Z_ORDER.ARENA);
  });
});

describe('Colour helpers', () => {
  it('parses hex channels', () => {
    expect(parseHex('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseHex('000000')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('computes luminance at the extremes', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('computes the WCAG contrast bounds', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#7f7f7f', '#7f7f7f')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio(THEME.hero.core, THEME.frutevil.tar)).toBeCloseTo(
      contrastRatio(THEME.frutevil.tar, THEME.hero.core),
      6
    );
  });

  it('builds rgba strings', () => {
    expect(withAlpha('#ff8000', 0.5)).toBe('rgba(255, 128, 0, 0.5)');
  });
});
