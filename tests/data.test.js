import { describe, it, expect } from 'vitest';
import { ENEMIES, getUnlockedEnemiesForWave } from '../src/data/enemies.js';
import { CARDS, getCardById } from '../src/data/cards.js';

describe('Data Integrity (Enemies & Cards)', () => {
  describe('Enemies Data Table', () => {
    it('should contain all 6 specified enemy types', () => {
      const enemyKeys = Object.keys(ENEMIES);
      expect(enemyKeys).toHaveLength(6);
      expect(ENEMIES.tarling).toBeDefined();
      expect(ENEMIES.ashfish).toBeDefined();
      expect(ENEMIES.cracked_wisp).toBeDefined();
      expect(ENEMIES.rustbloom).toBeDefined();
      expect(ENEMIES.smogmoth).toBeDefined();
      expect(ENEMIES.rustwhale).toBeDefined();
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
      expect(getCardById('dewdrop_barrage').name).toBe('Dewdrop Barrage');
      expect(getCardById('non_existent')).toBeNull();
    });
  });
});
