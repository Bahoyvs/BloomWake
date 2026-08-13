import { describe, it, expect } from 'vitest';
import {
  getUpgradeCost,
  getUpgradeLevel,
  purchaseUpgrade,
  describeShop,
  applyMetaUpgradesToRunStart,
  getDraftOfferCount,
} from '../src/core/meta-shop.js';
import {
  purchaseCosmetic,
  equipCosmetic,
  grantCosmetics,
  describeCosmetics,
  getEquippedCosmetic,
} from '../src/core/cosmetics.js';
import { createDefaultState } from '../src/core/state.js';
import { META_UPGRADES } from '../src/data/meta-upgrades.js';
import { DEFAULT_PLAYER_STATS } from '../src/core/game-state.js';
import { UNIT_PX, DRAFT_CFG } from '../src/core/constants.js';

/** State with Petals to spend. */
const rich = (petals = 100000) => ({ ...createDefaultState(), petals });

describe('Upgrade costs', () => {
  it('charges the base cost for the first level', () => {
    expect(getUpgradeCost('startHp', 0)).toBe(50);
    expect(getUpgradeCost('pickupRadius', 0)).toBe(40);
    expect(getUpgradeCost('startSpeed', 0)).toBe(80);
    expect(getUpgradeCost('fourthCardSlot', 0)).toBe(2000);
  });

  it('applies the growth curve per level', () => {
    // 50 x 1.4^n
    expect(getUpgradeCost('startHp', 1)).toBe(70);
    expect(getUpgradeCost('startHp', 2)).toBe(98);
    expect(getUpgradeCost('startHp', 3)).toBe(137);
    expect(getUpgradeCost('startHp', 4)).toBe(192);
    // 80 x 1.5^n
    expect(getUpgradeCost('startSpeed', 1)).toBe(120);
    expect(getUpgradeCost('startSpeed', 2)).toBe(180);
  });

  it('returns null past the level cap', () => {
    expect(getUpgradeCost('startHp', 5)).toBeNull();
    expect(getUpgradeCost('startSpeed', 3)).toBeNull();
    expect(getUpgradeCost('fourthCardSlot', 1)).toBeNull();
  });

  it('returns null for an unknown upgrade', () => {
    expect(getUpgradeCost('nope', 0)).toBeNull();
  });

  it('reads the boolean unlock as a 0/1 level', () => {
    expect(getUpgradeLevel(createDefaultState(), 'fourthCardSlot')).toBe(0);
    const unlocked = { ...createDefaultState(), metaUpgrades: { fourthCardSlot: true } };
    expect(getUpgradeLevel(unlocked, 'fourthCardSlot')).toBe(1);
  });
});

describe('Purchasing upgrades', () => {
  it('deducts Petals and raises the level', () => {
    const result = purchaseUpgrade(rich(100), 'startHp');

    expect(result.ok).toBe(true);
    expect(result.cost).toBe(50);
    expect(result.state.petals).toBe(50);
    expect(result.state.metaUpgrades.startHp).toBe(1);
  });

  it('refuses when Petals are short', () => {
    const result = purchaseUpgrade(rich(49), 'startHp');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('INSUFFICIENT_PETALS');
    expect(result.state.petals).toBe(49);
    expect(result.state.metaUpgrades.startHp).toBe(0);
  });

  it('refuses at max level', () => {
    let state = rich();
    for (let i = 0; i < 5; i++) state = purchaseUpgrade(state, 'startHp').state;
    expect(state.metaUpgrades.startHp).toBe(5);

    const result = purchaseUpgrade(state, 'startHp');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('MAX_LEVEL');
  });

  it('refuses an unknown upgrade', () => {
    expect(purchaseUpgrade(rich(), 'nope').reason).toBe('UNKNOWN_UPGRADE');
  });

  it('sets the one-time unlock to true rather than a level count', () => {
    const result = purchaseUpgrade(rich(2000), 'fourthCardSlot');

    expect(result.ok).toBe(true);
    expect(result.state.metaUpgrades.fourthCardSlot).toBe(true);
    expect(result.state.petals).toBe(0);
    expect(purchaseUpgrade(result.state, 'fourthCardSlot').reason).toBe('MAX_LEVEL');
  });

  it('charges the documented total to fully max a track', () => {
    let state = rich();
    let spent = 0;
    for (let i = 0; i < 5; i++) {
      const result = purchaseUpgrade(state, 'startHp');
      spent += result.cost;
      state = result.state;
    }
    // 50 + 70 + 98 + 137 + 192
    expect(spent).toBe(547);
  });

  it('never mutates the state it was given', () => {
    const state = rich(100);
    purchaseUpgrade(state, 'startHp');

    expect(state.petals).toBe(100);
    expect(state.metaUpgrades.startHp).toBe(0);
  });

  it('describes the shop with affordability', () => {
    const rows = describeShop(rich(60));
    const hp = rows.find((r) => r.id === 'startHp');
    const slot = rows.find((r) => r.id === 'fourthCardSlot');

    expect(hp.affordable).toBe(true);
    expect(hp.cost).toBe(50);
    expect(slot.affordable).toBe(false);
    expect(rows).toHaveLength(Object.keys(META_UPGRADES).length);
  });
});

describe('applyMetaUpgradesToRunStart', () => {
  it('leaves base stats untouched with nothing purchased', () => {
    const result = applyMetaUpgradesToRunStart(createDefaultState(), DEFAULT_PLAYER_STATS);

    expect(result.maxHp).toBe(DEFAULT_PLAYER_STATS.maxHp);
    expect(result.moveSpeed).toBe(DEFAULT_PLAYER_STATS.moveSpeed);
    expect(result.pickupRadius).toBe(DEFAULT_PLAYER_STATS.pickupRadius);
  });

  it('adds 10 HP per startHp level and starts the run at full', () => {
    let state = rich();
    for (let i = 0; i < 3; i++) state = purchaseUpgrade(state, 'startHp').state;

    const result = applyMetaUpgradesToRunStart(state, DEFAULT_PLAYER_STATS);
    expect(result.maxHp).toBe(130);
    expect(result.hp).toBe(130);
  });

  it('changes the value returned once startSpeed reaches level 3', () => {
    let state = rich();
    const before = applyMetaUpgradesToRunStart(state, DEFAULT_PLAYER_STATS).moveSpeed;

    for (let i = 0; i < 3; i++) state = purchaseUpgrade(state, 'startSpeed').state;
    expect(state.metaUpgrades.startSpeed).toBe(3);

    const after = applyMetaUpgradesToRunStart(state, DEFAULT_PLAYER_STATS).moveSpeed;
    expect(after).toBeGreaterThan(before);
    // +4% per level, three levels.
    expect(after).toBeCloseTo(DEFAULT_PLAYER_STATS.moveSpeed * 1.12, 6);
  });

  it('adds 12px of pickup radius per level, converted into movement units', () => {
    let state = rich();
    for (let i = 0; i < 2; i++) state = purchaseUpgrade(state, 'pickupRadius').state;

    const result = applyMetaUpgradesToRunStart(state, DEFAULT_PLAYER_STATS);
    const addedPx = (result.pickupRadius - DEFAULT_PLAYER_STATS.pickupRadius) * UNIT_PX;
    expect(addedPx).toBeCloseTo(24, 6);
  });

  it('stacks all three tracks at once', () => {
    let state = rich();
    for (let i = 0; i < 5; i++) state = purchaseUpgrade(state, 'startHp').state;
    for (let i = 0; i < 5; i++) state = purchaseUpgrade(state, 'pickupRadius').state;
    for (let i = 0; i < 3; i++) state = purchaseUpgrade(state, 'startSpeed').state;

    const result = applyMetaUpgradesToRunStart(state, DEFAULT_PLAYER_STATS);
    expect(result.maxHp).toBe(150);
    expect(result.moveSpeed).toBeCloseTo(3.2 * 1.12, 6);
    expect((result.pickupRadius - 0.8) * UNIT_PX).toBeCloseTo(60, 6);
  });

  it('does not mutate the stats it was handed', () => {
    let state = rich();
    state = purchaseUpgrade(state, 'startHp').state;
    const base = { ...DEFAULT_PLAYER_STATS };
    applyMetaUpgradesToRunStart(state, base);

    expect(base).toEqual(DEFAULT_PLAYER_STATS);
  });
});

describe('Fourth card slot', () => {
  it('offers three cards until purchased, four after', () => {
    const state = createDefaultState();
    expect(getDraftOfferCount(state, DRAFT_CFG.OFFER_COUNT)).toBe(3);

    const unlocked = purchaseUpgrade(rich(2000), 'fourthCardSlot').state;
    expect(getDraftOfferCount(unlocked, DRAFT_CFG.OFFER_COUNT)).toBe(4);
  });
});

describe('Cosmetics', () => {
  it('buys a purchasable cosmetic', () => {
    const result = purchaseCosmetic(rich(200), 'dew-tint');

    expect(result.ok).toBe(true);
    expect(result.state.petals).toBe(50);
    expect(result.state.cosmetics.owned).toContain('dew-tint');
  });

  it('does not auto-equip a purchase', () => {
    const result = purchaseCosmetic(rich(200), 'dew-tint');
    expect(result.state.cosmetics.equipped).toBe('default');
  });

  it('refuses the prestige skin at any price', () => {
    const result = purchaseCosmetic(rich(999999), 'prestij-skin');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NOT_PURCHASABLE');
    expect(result.state.cosmetics.owned).not.toContain('prestij-skin');
  });

  it('refuses when short on Petals or already owned', () => {
    expect(purchaseCosmetic(rich(10), 'dew-tint').reason).toBe('INSUFFICIENT_PETALS');
    expect(purchaseCosmetic(rich(), 'default').reason).toBe('ALREADY_OWNED');
    expect(purchaseCosmetic(rich(), 'nope').reason).toBe('UNKNOWN_COSMETIC');
  });

  it('equips only what is owned', () => {
    const owned = purchaseCosmetic(rich(200), 'dew-tint').state;
    const equipped = equipCosmetic(owned, 'dew-tint');

    expect(equipped.ok).toBe(true);
    expect(equipped.state.cosmetics.equipped).toBe('dew-tint');
    expect(equipCosmetic(createDefaultState(), 'deep-water').reason).toBe('NOT_OWNED');
  });

  it('adds a capsule drop to the collection without equipping it', () => {
    const state = createDefaultState();
    const { state: next, added } = grantCosmetics(state, ['prestij-skin']);

    expect(added).toEqual(['prestij-skin']);
    expect(next.cosmetics.owned).toContain('prestij-skin');
    // The player chooses when to wear it.
    expect(next.cosmetics.equipped).toBe('default');
  });

  it('ignores a duplicate drop', () => {
    const first = grantCosmetics(createDefaultState(), ['prestij-skin']).state;
    const second = grantCosmetics(first, ['prestij-skin']);

    expect(second.added).toEqual([]);
    expect(second.state.cosmetics.owned.filter((id) => id === 'prestij-skin')).toHaveLength(1);
  });

  it('marks an undropped prestige skin locked rather than for sale', () => {
    const rows = describeCosmetics(rich());
    const prestige = rows.find((r) => r.id === 'prestij-skin');

    expect(prestige.locked).toBe(true);
    expect(prestige.affordable).toBe(false);
  });

  it('resolves the equipped cosmetic for the renderer', () => {
    expect(getEquippedCosmetic(createDefaultState()).id).toBe('default');
  });
});
