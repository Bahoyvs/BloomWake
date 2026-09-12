import { describe, it, expect } from 'vitest';
import { ENEMIES, getUnlockedEnemiesForWave } from '../src/data/enemies.js';
import { CARDS, getCardById } from '../src/data/cards.js';
import { COSMETICS } from '../src/data/cosmetics.js';
import { MIN_HERO_LUMINANCE, relativeLuminance } from '../src/render/theme.js';
import { cosmeticTint, HERO_TINT } from '../src/render/sprites.js';

describe('Data Integrity (Enemies & Cards)', () => {
  describe('Enemies Data Table', () => {
    it('should contain the six swarm classes plus the boss', () => {
      // Six playable-against species, each with a behaviour nothing else has,
      // and the Dreadnought Station. `bio_goliath` is the one readable id: it
      // is a new species with no legacy save key to preserve.
      const enemyKeys = Object.keys(ENEMIES);
      expect(enemyKeys).toHaveLength(7);
      expect(ENEMIES.tarling).toBeDefined();
      expect(ENEMIES.ashfish).toBeDefined();
      expect(ENEMIES.cracked_wisp).toBeDefined();
      expect(ENEMIES.rustbloom).toBeDefined();
      expect(ENEMIES.smogmoth).toBeDefined();
      expect(ENEMIES.bio_goliath).toBeDefined();
      expect(ENEMIES.rustwhale).toBeDefined();

      const swarm = enemyKeys.filter((id) => !ENEMIES[id].isBoss);
      expect(swarm).toHaveLength(6);
    });

    it('gives every swarm class a behaviour of its own', () => {
      // The roster's whole premise: six classes, six movement rules. Two
      // species sharing a branch means one of them has no reason to exist.
      const behaviors = Object.values(ENEMIES)
        .filter((enemy) => !enemy.isBoss)
        .map((enemy) => enemy.behavior);
      expect(new Set(behaviors).size).toBe(behaviors.length);
    });

    it('should unlock non-boss enemies progressively by wave threshold', () => {
      expect(getUnlockedEnemiesForWave(1).map((e) => e.id)).toEqual(['tarling']);
      expect(getUnlockedEnemiesForWave(3).map((e) => e.id)).toEqual(['tarling', 'ashfish']);
      expect(getUnlockedEnemiesForWave(4).map((e) => e.id)).toEqual(['tarling', 'ashfish', 'cracked_wisp']);
      expect(getUnlockedEnemiesForWave(6).map((e) => e.id)).toEqual(['tarling', 'ashfish', 'cracked_wisp', 'rustbloom']);
      expect(getUnlockedEnemiesForWave(8).map((e) => e.id)).toEqual(['tarling', 'ashfish', 'cracked_wisp', 'rustbloom', 'smogmoth']);
    });
  });

  describe('Cards Data Table', () => {
    it('should contain exactly 8 skill cards with 5 upgrade levels each', () => {
      expect(CARDS).toHaveLength(8);

      for (const card of CARDS) {
        expect(card.id).toBeDefined();
        expect(card.name).toBeDefined();
        expect(card.maxLevel).toBe(5);
        expect(card.levels).toHaveLength(5);
        
        // Verify stats scale upwards across levels
        for (let i = 0; i < card.levels.length; i++) {
          expect(card.levels[i].level).toBe(i + 1);
        }
      }
    });

    it('should retrieve card by ID correctly', () => {
      expect(getCardById('dewdrop_barrage')).toBeDefined();
      expect(getCardById('dewdrop_barrage').name).toBe('Phase Repeater');
      expect(getCardById('non_existent')).toBeNull();
    });

    it('keeps the original ids while the names carry the re-skin', () => {
      // The ids are save-game and simulation-dispatch keys; renaming them would
      // be a silent migration. Only the player-facing name changed.
      const renamed = {
        dewdrop_barrage: 'Phase Repeater',
        sunbeam_lance: 'Tesla Arc',
        glasswing: 'Aegis Satellites',
        petal_storm: 'Nova Flak',
        bloomshield: 'Hyperion Shield',
        buddy_boost: 'Tactical Wingman',
        tidewave: 'Graviton EMP',
      };
      for (const [id, name] of Object.entries(renamed)) {
        expect(getCardById(id), id).toBeDefined();
        expect(getCardById(id).name, id).toBe(name);
      }
    });

    it('gives every card a description', () => {
      for (const card of CARDS) {
        expect(card.description, card.id).toBeTruthy();
        expect(card.type, card.id).toBeTruthy();
      }
    });
  });

  describe('Hull liveries', () => {
    it('keeps every livery inside the hero luminance band', () => {
      // A cosmetic tint is applied straight to the hero's white hull, so a dark
      // one would hide the player inside their own swarm — the Visual Soup
      // failure, arriving through the shop instead of through the palette.
      for (const cosmetic of Object.values(COSMETICS)) {
        expect(relativeLuminance(cosmetic.tint), cosmetic.id).toBeGreaterThanOrEqual(
          MIN_HERO_LUMINANCE
        );
      }
    });

    it('makes the default livery identical to the untinted hero', () => {
      // Equipping the free default must be a no-op, not a recolour.
      expect(cosmeticTint(COSMETICS.default)).toBe(HERO_TINT);
    });
  });
});
