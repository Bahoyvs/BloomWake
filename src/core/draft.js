/**
 * Level-up card draft for BloomWake (GDD Section 7).
 *
 * Pure functions over the card table and the player's owned map — no DOM, no
 * simulation state, so the weighting is directly testable.
 *
 * Rules:
 *  - Cards already at max level are never offered.
 *  - Draw weight comes from rarity, multiplied for cards you already own, so a
 *    run grows around its build instead of scattering across all eight cards.
 *  - Offers are drawn without replacement: no duplicate cards in one draft.
 */

import { DRAFT_CFG } from './constants.js';
import { CARDS, getCardById } from '../data/cards.js';

/**
 * Check if Buddy Boost is unlocked for drafting.
 * Gating rule: Buddy Boost does not appear in the draft pool until the player
 * has upgraded at least one offensive card to Level 3, or the player reaches Level 5 overall.
 * @param {Map<string, number>} [activeCards] - Map of owned cards -> level
 * @param {number} [playerLevel=1] - Player overall level
 * @returns {boolean}
 */
export function isBuddyBoostUnlocked(activeCards, playerLevel = 1) {
  if (playerLevel >= 5) return true;
  if (!activeCards) return false;

  for (const [cardId, level] of activeCards.entries()) {
    if (level >= 3) {
      const card = getCardById(cardId);
      if (card && card.id !== 'buddy_boost' && card.id !== 'bloomshield') {
        return true;
      }
    }
  }
  return false;
}

/**
 * Draw weight for a single card.
 * @param {Object} card - Card definition
 * @param {number} [ownedLevel] - Current level, 0 or undefined if unowned
 * @param {Map<string, number>} [activeCards] - Player's active cards map
 * @param {number} [playerLevel=1] - Player level
 * @returns {number} Weight, or 0 if the card cannot be offered
 */
export function getCardWeight(card, ownedLevel = 0, activeCards = null, playerLevel = 1) {
  if (ownedLevel >= card.maxLevel) return 0;
  if (card.id === 'buddy_boost' && !isBuddyBoostUnlocked(activeCards, playerLevel)) {
    return 0;
  }

  const base = DRAFT_CFG.RARITY_WEIGHT[card.rarity] ?? 0;
  return ownedLevel > 0 ? base * DRAFT_CFG.OWNED_WEIGHT_MULTIPLIER : base;
}

/**
 * Every card that can still be offered, with its weight.
 * @param {Map<string, number>} activeCards - cardId -> level
 * @param {number} [playerLevel=1] - Player level
 * @returns {Array<{card: Object, weight: number}>}
 */
export function getDraftPool(activeCards, playerLevel = 1) {
  const pool = [];
  for (const card of CARDS) {
    const ownedLevel = activeCards ? activeCards.get(card.id) || 0 : 0;
    const weight = getCardWeight(card, ownedLevel, activeCards, playerLevel);
    if (weight > 0) pool.push({ card, weight });
  }
  return pool;
}

/**
 * Draw a level-up offer.
 *
 * @param {() => number} rng - RNG returning floats in [0, 1)
 * @param {Map<string, number>} activeCards - cardId -> level
 * @param {number} [count] - Cards to offer
 * @param {number} [playerLevel=1] - Player level
 * @returns {Array<string>} Card IDs, fewer than `count` only if the pool is small
 */
export function drawDraft(rng, activeCards, count = DRAFT_CFG.OFFER_COUNT, playerLevel = 1) {
  const pool = getDraftPool(activeCards, playerLevel);
  const picks = [];

  while (picks.length < count && pool.length > 0) {
    let total = 0;
    for (const entry of pool) total += entry.weight;

    let roll = rng() * total;
    let index = 0;
    for (let i = 0; i < pool.length; i++) {
      roll -= pool[i].weight;
      if (roll <= 0) {
        index = i;
        break;
      }
      // Falling through leaves index at the last entry, which is the correct
      // outcome for floating-point roll-off at the very top of the range.
      index = i;
    }

    picks.push(pool[index].card.id);
    pool.splice(index, 1); // without replacement
  }

  return picks;
}

/**
 * Presentation data for an offered card: what the player is choosing between.
 * @param {string} cardId
 * @param {Map<string, number>} activeCards
 * @returns {Object}
 */
export function describeOffer(cardId, activeCards) {
  const card = getCardById(cardId);
  const current = activeCards.get(cardId) || 0;
  const next = current + 1;

  return {
    id: card.id,
    name: card.name,
    type: card.type,
    rarity: card.rarity,
    description: card.description,
    currentLevel: current,
    nextLevel: next,
    isNew: current === 0,
    isMaxed: next >= card.maxLevel,
    stats: card.levels[next - 1],
  };
}
