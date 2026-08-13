/**
 * Cosmetic ownership and equipping (Phase 5 Step E).
 *
 * Pure functions returning {ok, reason, state}, same action pattern as the
 * meta-shop. No DOM.
 */

import { COSMETIC_IDS, getCosmeticById, COSMETIC_ORDER } from '../data/cosmetics.js';

/**
 * @param {Object} state
 * @param {string} cosmeticId
 * @returns {boolean}
 */
export function ownsCosmetic(state, cosmeticId) {
  return state.cosmetics.owned.includes(cosmeticId);
}

/**
 * Buy a cosmetic with Petals.
 *
 * The prestige skin is drop-only and is refused here at any Petal balance —
 * being unbuyable is the whole point of it.
 *
 * @param {Object} state
 * @param {string} cosmeticId
 * @returns {{ok: boolean, reason?: string, cost?: number, state: Object}}
 */
export function purchaseCosmetic(state, cosmeticId) {
  const cosmetic = getCosmeticById(cosmeticId);
  if (!cosmetic) return { ok: false, reason: 'UNKNOWN_COSMETIC', state };
  if (!cosmetic.purchasable) return { ok: false, reason: 'NOT_PURCHASABLE', state };
  if (ownsCosmetic(state, cosmeticId)) return { ok: false, reason: 'ALREADY_OWNED', state };
  if (state.petals < cosmetic.cost) {
    return { ok: false, reason: 'INSUFFICIENT_PETALS', cost: cosmetic.cost, state };
  }

  return {
    ok: true,
    cost: cosmetic.cost,
    state: {
      ...state,
      petals: state.petals - cosmetic.cost,
      cosmetics: {
        ...state.cosmetics,
        owned: [...state.cosmetics.owned, cosmeticId],
      },
    },
  };
}

/**
 * Equip an owned cosmetic.
 * @param {Object} state
 * @param {string} cosmeticId
 * @returns {{ok: boolean, reason?: string, state: Object}}
 */
export function equipCosmetic(state, cosmeticId) {
  if (!getCosmeticById(cosmeticId)) return { ok: false, reason: 'UNKNOWN_COSMETIC', state };
  if (!ownsCosmetic(state, cosmeticId)) return { ok: false, reason: 'NOT_OWNED', state };

  return {
    ok: true,
    state: { ...state, cosmetics: { ...state.cosmetics, equipped: cosmeticId } },
  };
}

/**
 * Add cosmetics dropped by a capsule to the player's collection.
 *
 * Deliberately does NOT auto-equip: a skin appearing mid-results-screen and
 * silently replacing the player's chosen look would be taking a decision away
 * from them. They pick it up in the shop when they want it.
 *
 * @param {Object} state
 * @param {Array<string>} cosmeticIds
 * @returns {{state: Object, added: Array<string>}} `added` excludes duplicates
 */
export function grantCosmetics(state, cosmeticIds = []) {
  const added = [];
  for (const id of cosmeticIds) {
    if (getCosmeticById(id) && !ownsCosmetic(state, id) && !added.includes(id)) {
      added.push(id);
    }
  }
  if (added.length === 0) return { state, added };

  return {
    state: {
      ...state,
      cosmetics: { ...state.cosmetics, owned: [...state.cosmetics.owned, ...added] },
    },
    added,
  };
}

/**
 * Shop rows for the cosmetics list.
 * @param {Object} state
 * @returns {Array<Object>}
 */
export function describeCosmetics(state) {
  return COSMETIC_ORDER.map((id) => {
    const cosmetic = getCosmeticById(id);
    const isOwned = ownsCosmetic(state, id);

    return {
      id,
      name: cosmetic.name,
      description: cosmetic.description,
      cost: cosmetic.cost,
      purchasable: cosmetic.purchasable,
      owned: isOwned,
      equipped: state.cosmetics.equipped === id,
      affordable: cosmetic.purchasable && !isOwned && state.petals >= cosmetic.cost,
      /** Drop-only and not yet found: shown locked rather than for sale. */
      locked: !cosmetic.purchasable && !isOwned,
    };
  });
}

/** The visual the renderer should draw the Dewling with. */
export function getEquippedCosmetic(state) {
  return getCosmeticById(state.cosmetics.equipped) ?? getCosmeticById(COSMETIC_IDS.DEFAULT);
}
