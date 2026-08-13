import { describe, it, expect } from 'vitest';
import {
  rollRewardTier,
  rollAmount,
  resolveTierReward,
  resolveSmallCapsule,
  resolveLargeCapsule,
  isRareOrBetter,
  getOddsForWave,
} from '../src/core/rewards.js';
import {
  SMALL_CAPSULE_WEIGHTS,
  LARGE_CAPSULE_WEIGHTS_BY_PERFORMANCE,
  REWARD_POOL,
  REWARD_TIERS,
  getLargeCapsuleBand,
} from '../src/data/rewards.js';
import { PITY_THRESHOLD } from '../src/core/state.js';
import { mulberry32 } from '../src/core/math.js';

const TRIALS = 10000;
/** Distribution tolerance required by the Phase 5 spec. */
const TOLERANCE = 0.01;

/**
 * Empirical tier frequencies over many rolls.
 * @param {Function} draw - Takes rng, returns a tier string
 */
function measure(draw, trials = TRIALS, seed = 12345) {
  const rng = mulberry32(seed);
  const counts = Object.fromEntries(REWARD_TIERS.map((t) => [t, 0]));
  for (let i = 0; i < trials; i++) counts[draw(rng)]++;
  return Object.fromEntries(Object.entries(counts).map(([t, n]) => [t, n / trials]));
}

describe('Reward tier rolling', () => {
  it('matches the small-capsule weights within ±1%', () => {
    const observed = measure((rng) => rollRewardTier(SMALL_CAPSULE_WEIGHTS, rng));

    for (const tier of REWARD_TIERS) {
      expect(
        Math.abs(observed[tier] - SMALL_CAPSULE_WEIGHTS[tier]),
        `${tier}: expected ${SMALL_CAPSULE_WEIGHTS[tier]}, observed ${observed[tier].toFixed(4)}`
      ).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  it('never rolls a zero-weight tier', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < TRIALS; i++) {
      // Legendary is weight 0 on the small capsule.
      expect(rollRewardTier(SMALL_CAPSULE_WEIGHTS, rng)).not.toBe('legendary');
    }
  });

  it('returns null when every weight is zero', () => {
    expect(rollRewardTier({ common: 0, uncommon: 0, rare: 0, legendary: 0 }, mulberry32(1))).toBeNull();
  });

  it('always returns the only weighted tier', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 200; i++) {
      expect(rollRewardTier({ common: 0, uncommon: 0, rare: 1, legendary: 0 }, rng)).toBe('rare');
    }
  });

  it('is deterministic for a given seed', () => {
    const a = measure((rng) => rollRewardTier(SMALL_CAPSULE_WEIGHTS, rng), 500, 42);
    const b = measure((rng) => rollRewardTier(SMALL_CAPSULE_WEIGHTS, rng), 500, 42);
    expect(a).toEqual(b);
  });
});

describe('Large capsule distribution per performance band', () => {
  for (const band of LARGE_CAPSULE_WEIGHTS_BY_PERFORMANCE) {
    it(`matches band ${band.minWave}-${band.maxWave} weights within ±1%`, () => {
      // Pity off, so the raw weights are what is being measured.
      const noPity = { runsSinceRareOrBetter: 0 };
      const wave = band.minWave;
      const observed = measure(
        (rng) => resolveLargeCapsule(wave, noPity, rng).reward.tier,
        TRIALS,
        98765
      );

      for (const tier of REWARD_TIERS) {
        expect(
          Math.abs(observed[tier] - band.weights[tier]),
          `band ${band.minWave}-${band.maxWave} ${tier}: ` +
            `expected ${band.weights[tier]}, observed ${observed[tier].toFixed(4)}`
        ).toBeLessThanOrEqual(TOLERANCE);
      }
    });
  }

  it('selects the band from the wave reached', () => {
    expect(getLargeCapsuleBand(1).maxWave).toBe(4);
    expect(getLargeCapsuleBand(4).maxWave).toBe(4);
    expect(getLargeCapsuleBand(5).minWave).toBe(5);
    expect(getLargeCapsuleBand(9).minWave).toBe(5);
    expect(getLargeCapsuleBand(10).minWave).toBe(10);
    expect(getLargeCapsuleBand(15).minWave).toBe(10);
  });

  it('clamps absurd waves into the top band rather than failing', () => {
    expect(getLargeCapsuleBand(99999).minWave).toBe(10);
    expect(getLargeCapsuleBand(0).minWave).toBe(1);
  });

  it('reports the odds table for the transparency icon', () => {
    expect(getOddsForWave(7).weights).toEqual(
      LARGE_CAPSULE_WEIGHTS_BY_PERFORMANCE[1].weights
    );
  });
});

describe('Pity guarantee', () => {
  it('forces Rare-or-better on the 9th capsule, deterministically', () => {
    // Not a probabilistic check: at the threshold the guarantee must hold for
    // every possible RNG stream, so assert across many seeds rather than
    // sampling one and hoping.
    const atThreshold = { runsSinceRareOrBetter: PITY_THRESHOLD };

    for (let seed = 1; seed <= 2000; seed++) {
      for (const wave of [1, 5, 10]) {
        const { reward, pityApplied } = resolveLargeCapsule(wave, atThreshold, mulberry32(seed));
        expect(pityApplied).toBe(true);
        expect(
          isRareOrBetter(reward.tier),
          `seed ${seed} wave ${wave} gave ${reward.tier}`
        ).toBe(true);
      }
    }
  });

  it('counts exactly 8 non-rare pulls before the guarantee arms', () => {
    // Walk the counter the way a real save would: start clean, feed it
    // non-rare results, and confirm the 9th pull is the forced one.
    let pity = { runsSinceRareOrBetter: 0 };
    for (let pull = 1; pull <= PITY_THRESHOLD; pull++) {
      expect(pity.runsSinceRareOrBetter).toBe(pull - 1);
      // Band 1-4 with a stream that yields commons keeps the streak alive.
      const { updatedPity, pityApplied } = resolveLargeCapsule(1, pity, () => 0);
      expect(pityApplied).toBe(false);
      pity = updatedPity;
    }

    expect(pity.runsSinceRareOrBetter).toBe(PITY_THRESHOLD);
    const ninth = resolveLargeCapsule(1, pity, () => 0);
    expect(ninth.pityApplied).toBe(true);
    expect(isRareOrBetter(ninth.reward.tier)).toBe(true);
  });

  it('resolves pity to Rare in a band where Legendary has no weight', () => {
    const atThreshold = { runsSinceRareOrBetter: PITY_THRESHOLD };
    for (let seed = 1; seed <= 300; seed++) {
      // Band 1-4 has legendary weight 0.
      expect(resolveLargeCapsule(2, atThreshold, mulberry32(seed)).reward.tier).toBe('rare');
    }
  });

  it('resets the counter on a rare-or-better pull', () => {
    const pity = { runsSinceRareOrBetter: 5 };
    // Force a rare by rolling at the threshold.
    const { updatedPity } = resolveLargeCapsule(
      10,
      { runsSinceRareOrBetter: PITY_THRESHOLD },
      mulberry32(1)
    );
    expect(updatedPity.runsSinceRareOrBetter).toBe(0);

    // A common pull increments instead.
    const common = resolveLargeCapsule(1, pity, () => 0);
    expect(common.updatedPity.runsSinceRareOrBetter).toBe(6);
  });

  it('never mutates the pity object it was given', () => {
    const pity = { runsSinceRareOrBetter: 3 };
    resolveLargeCapsule(5, pity, mulberry32(9));
    expect(pity.runsSinceRareOrBetter).toBe(3);
  });

  it('keeps the streak bounded in a long unlucky session', () => {
    let pity = { runsSinceRareOrBetter: 0 };
    const rng = mulberry32(31337);
    let maxStreak = 0;

    for (let run = 0; run < 500; run++) {
      const { updatedPity } = resolveLargeCapsule(2, pity, rng);
      pity = updatedPity;
      maxStreak = Math.max(maxStreak, pity.runsSinceRareOrBetter);
    }
    // The counter can reach the threshold but must never exceed it, because
    // the very next pull is forced.
    expect(maxStreak).toBeLessThanOrEqual(PITY_THRESHOLD);
  });
});

describe('Reward payouts', () => {
  it('rolls amounts inside the configured inclusive range', () => {
    const rng = mulberry32(55);
    const [min, max] = REWARD_POOL.common[0].amount;

    for (let i = 0; i < 5000; i++) {
      const value = rollAmount([min, max], rng);
      expect(value).toBeGreaterThanOrEqual(min);
      expect(value).toBeLessThanOrEqual(max);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('reaches both ends of the range', () => {
    const rng = mulberry32(8);
    const [min, max] = REWARD_POOL.common[0].amount;
    const seen = new Set();
    for (let i = 0; i < 5000; i++) seen.add(rollAmount([min, max], rng));

    expect(seen.has(min)).toBe(true);
    expect(seen.has(max)).toBe(true);
  });

  it('grants both the skin and Petals on Legendary', () => {
    const reward = resolveTierReward('legendary', mulberry32(4));
    expect(reward.cosmetics).toEqual(['prestij-skin']);
    expect(reward.petals).toBeGreaterThan(0);
  });

  it('grants no cosmetic below Legendary', () => {
    for (const tier of ['common', 'uncommon', 'rare']) {
      expect(resolveTierReward(tier, mulberry32(4)).cosmetics).toEqual([]);
    }
  });

  it('pays more for rarer tiers', () => {
    const ranges = REWARD_TIERS.map(
      (tier) => REWARD_POOL[tier].find((e) => e.type === 'petal').amount
    );
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i][0], `tier ${REWARD_TIERS[i]} min`).toBeGreaterThan(ranges[i - 1][0]);
      expect(ranges[i][1], `tier ${REWARD_TIERS[i]} max`).toBeGreaterThan(ranges[i - 1][1]);
    }
  });

  it('resolves a small capsule to a payable reward', () => {
    const reward = resolveSmallCapsule(mulberry32(2));
    expect(REWARD_TIERS).toContain(reward.tier);
    expect(reward.petals).toBeGreaterThan(0);
  });

  it('honours an injected pool so calibration tunes the real logic', () => {
    const doubled = { ...REWARD_POOL, common: [{ type: 'petal', amount: [1000, 1000] }] };
    expect(resolveTierReward('common', mulberry32(1), doubled).petals).toBe(1000);
  });
});
