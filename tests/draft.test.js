import { describe, it, expect } from 'vitest';
import { drawDraft, getCardWeight, getDraftPool, describeOffer, isBuddyBoostUnlocked } from '../src/core/draft.js';
import { DRAFT_CFG } from '../src/core/constants.js';
import { CARDS, getCardById } from '../src/data/cards.js';
import { mulberry32 } from '../src/core/math.js';

/** @param {Array<[string, number]>} entries */
const owned = (entries = []) => new Map(entries);

describe('Card draft (GDD Section 7)', () => {
  describe('Weighting', () => {
    it('weights unowned cards by rarity', () => {
      expect(getCardWeight(getCardById('dewdrop_barrage'), 0)).toBe(
        DRAFT_CFG.RARITY_WEIGHT.Common
      );
      expect(getCardWeight(getCardById('petal_storm'), 0)).toBe(
        DRAFT_CFG.RARITY_WEIGHT.Uncommon
      );
      expect(getCardWeight(getCardById('tidewave'), 0)).toBe(DRAFT_CFG.RARITY_WEIGHT.Rare);
    });

    it('favours rarer cards less often', () => {
      const common = getCardWeight(getCardById('dewdrop_barrage'), 0);
      const uncommon = getCardWeight(getCardById('petal_storm'), 0);
      const rare = getCardWeight(getCardById('tidewave'), 0);

      expect(common).toBeGreaterThan(uncommon);
      expect(uncommon).toBeGreaterThan(rare);
    });

    it('boosts cards the player already owns', () => {
      const card = getCardById('glasswing');
      const unownedWeight = getCardWeight(card, 0);
      const ownedWeight = getCardWeight(card, 2);

      expect(ownedWeight).toBe(unownedWeight * DRAFT_CFG.OWNED_WEIGHT_MULTIPLIER);
      expect(ownedWeight).toBeGreaterThan(unownedWeight);
    });

    it('gives maxed cards zero weight', () => {
      const card = getCardById('glasswing');
      expect(getCardWeight(card, card.maxLevel)).toBe(0);
    });
  });

  describe('Pool eligibility', () => {
    it('gates Buddy Boost on a fresh run (7 cards offered)', () => {
      const pool = getDraftPool(owned());
      expect(pool.map((e) => e.card.id)).not.toContain('buddy_boost');
      expect(pool).toHaveLength(CARDS.length - 1);
    });

    it('unlocks Buddy Boost when an offensive card reaches level 3', () => {
      const pool = getDraftPool(owned([['dewdrop_barrage', 3]]), 1);
      expect(pool.map((e) => e.card.id)).toContain('buddy_boost');
      expect(pool).toHaveLength(CARDS.length);
    });

    it('unlocks Buddy Boost when player reaches level 5 overall', () => {
      const pool = getDraftPool(owned([['dewdrop_barrage', 1]]), 5);
      expect(pool.map((e) => e.card.id)).toContain('buddy_boost');
      expect(pool).toHaveLength(CARDS.length);
    });

    it('keeps Buddy Boost locked if only Bloomshield (defensive) reaches level 3', () => {
      const pool = getDraftPool(owned([['bloomshield', 3]]), 1);
      expect(pool.map((e) => e.card.id)).not.toContain('buddy_boost');
    });

    it('drops cards that have hit max level', () => {
      const pool = getDraftPool(owned([['glasswing', 5]], 5));
      expect(pool.map((entry) => entry.card.id)).not.toContain('glasswing');
      expect(pool).toHaveLength(CARDS.length - 1);
    });

    it('empties once every card is maxed', () => {
      const all = owned(CARDS.map((card) => [card.id, card.maxLevel]));
      expect(getDraftPool(all, 5)).toHaveLength(0);
    });
  });

  describe('Drawing offers', () => {
    it('offers the configured number of cards', () => {
      const draft = drawDraft(mulberry32(1), owned());
      expect(draft).toHaveLength(DRAFT_CFG.OFFER_COUNT);
    });

    it('never repeats a card within one draft', () => {
      const rng = mulberry32(99);
      for (let i = 0; i < 500; i++) {
        const draft = drawDraft(rng, owned([['dewdrop_barrage', 1]]));
        expect(new Set(draft).size).toBe(draft.length);
      }
    });

    it('never offers a maxed card', () => {
      const rng = mulberry32(5);
      const cards = owned([
        ['glasswing', 5],
        ['tidewave', 5],
      ]);

      for (let i = 0; i < 500; i++) {
        const draft = drawDraft(rng, cards);
        expect(draft).not.toContain('glasswing');
        expect(draft).not.toContain('tidewave');
      }
    });

    it('shrinks the offer when the pool runs low', () => {
      const nearlyDone = owned(
        CARDS.slice(0, 6).map((card) => [card.id, card.maxLevel])
      );
      const draft = drawDraft(mulberry32(3), nearlyDone);
      expect(draft).toHaveLength(2);
    });

    it('returns nothing when every card is maxed', () => {
      const all = owned(CARDS.map((card) => [card.id, card.maxLevel]));
      expect(drawDraft(mulberry32(3), all)).toEqual([]);
    });

    it('is deterministic for a given seed', () => {
      const a = drawDraft(mulberry32(1234), owned());
      const b = drawDraft(mulberry32(1234), owned());
      expect(a).toEqual(b);
    });
  });

  describe('Build-around bias', () => {
    it('surfaces an owned card far more often than an equally rare unowned one', () => {
      // Glasswing and Sunbeam Lance are both Common, so rarity is controlled
      // for and the only difference is ownership.
      const rng = mulberry32(2024);
      const cards = owned([['glasswing', 1]]);
      let glasswing = 0;
      let sunbeam = 0;
      const runs = 20000;

      for (let i = 0; i < runs; i++) {
        const draft = drawDraft(rng, cards);
        if (draft.includes('glasswing')) glasswing++;
        if (draft.includes('sunbeam_lance')) sunbeam++;
      }

      expect(glasswing).toBeGreaterThan(sunbeam);
      // Owned weight is 2.5x; appearance rate lands well above parity without
      // pinning the test to the exact ratio, which the without-replacement draw
      // compresses.
      expect(glasswing / sunbeam).toBeGreaterThan(1.3);
    });

    it('keeps unowned cards reachable so builds are not locked in', () => {
      const rng = mulberry32(77);
      const cards = owned([
        ['dewdrop_barrage', 3],
        ['glasswing', 2],
      ]);
      const seen = new Set();

      for (let i = 0; i < 2000; i++) {
        for (const id of drawDraft(rng, cards)) seen.add(id);
      }

      expect(seen.size).toBe(CARDS.length);
    });
  });

  describe('Offer presentation', () => {
    it('describes a brand new card', () => {
      const offer = describeOffer('tidewave', owned());

      expect(offer.isNew).toBe(true);
      expect(offer.currentLevel).toBe(0);
      expect(offer.nextLevel).toBe(1);
      expect(offer.stats).toEqual(getCardById('tidewave').levels[0]);
    });

    it('describes an upgrade with the level it is heading to', () => {
      const offer = describeOffer('glasswing', owned([['glasswing', 3]]));

      expect(offer.isNew).toBe(false);
      expect(offer.currentLevel).toBe(3);
      expect(offer.nextLevel).toBe(4);
      expect(offer.stats).toEqual(getCardById('glasswing').levels[3]);
    });

    it('flags the final upgrade', () => {
      expect(describeOffer('glasswing', owned([['glasswing', 4]])).isMaxed).toBe(true);
      expect(describeOffer('glasswing', owned([['glasswing', 2]])).isMaxed).toBe(false);
    });
  });
});
