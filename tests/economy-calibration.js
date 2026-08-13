/**
 * BloomWake — Economy Calibration (Phase 5, Step C)
 *
 * Standalone Node script. It does not assert, it TUNES: it searches for the
 * Petal reward multiplier that puts the one-time 2000-Petal "4th Card Slot"
 * roughly 15-20 runs away, then writes the tuned ranges back into
 * src/data/rewards.js.
 *
 * Run:
 *   node tests/economy-calibration.js                  # report only
 *   node tests/economy-calibration.js --write          # also rewrite rewards.js
 *   node tests/economy-calibration.js --runs 400       # bigger sample
 *   node tests/economy-calibration.js --profile bot    # calibrate on the bot
 *
 * ---------------------------------------------------------------------------
 * METHOD
 * ---------------------------------------------------------------------------
 * Scenario: the player banks every Petal and buys nothing else until the 4th
 * Card Slot. That is the idealised upper bound; anyone who picks up cheap
 * upgrades on the way takes longer.
 *
 * CALIBRATION ANCHOR: the MID-SKILLED player (mean wave 8), not the bot.
 *
 * The first pass anchored on the bot, which dies around wave 4.4 and never once
 * reached wave 10 across 200 runs. That made the reward curve far too generous
 * for anyone competent: holding the pool fixed, a mid player hit 2000 Petals in
 * ~10 runs and a strong one in ~6, collapsing a 3-day retention hook into a
 * single session. Skill compounds in this economy — deeper runs pay more small
 * capsules AND draw from a better large-capsule band — so the anchor has to be
 * a player who actually reaches the mid bands.
 *
 * The bot profile is still simulated and reported alongside for comparison; it
 * lands slower than the mid player by design, and the Daily Bloom is what
 * closes that gap for weaker players.
 *
 * Run profiles are computed ONCE. In-run play cannot see the reward tables —
 * Petal payouts are meta, resolved after a wave or a run ends — so the same
 * profiles are valid for every multiplier the search tries. That turns the
 * search into arithmetic over a fixed sample instead of thousands of
 * re-simulated runs.
 *
 * Capsule resolution calls the PRODUCTION functions in src/core/rewards.js with
 * a scaled pool injected, so pity, weights and band lookup behave exactly as
 * they will in the game. Nothing about the reward logic is reimplemented here.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Simulation } from '../src/core/simulation.js';
import { GameState, GAME_STATES } from '../src/core/game-state.js';
import { EventBus } from '../src/core/event-bus.js';
import { mulberry32 } from '../src/core/math.js';
import { PHASE1 } from '../src/core/constants.js';
import { resolveSmallCapsule, resolveLargeCapsule } from '../src/core/rewards.js';
import { REWARD_POOL } from '../src/data/rewards.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REWARDS_PATH = join(HERE, '..', 'src', 'data', 'rewards.js');

const STEP = 1 / 60;
const GOAL_PETALS = 2000;
const TARGET_MIN_RUNS = 15;
const TARGET_MAX_RUNS = 20;
const TARGET_MID_RUNS = (TARGET_MIN_RUNS + TARGET_MAX_RUNS) / 2;

/** Multiplier bounds. Needing to leave this range is a design signal, not a
 *  tuning problem — see the report at the end. */
const MULTIPLIER_MIN = 0.05;
const MULTIPLIER_MAX = 20;
const MAX_ITERATIONS = 40;

/* ==========================================================================
 * Bot harness — same policy as the Phase 1/3/4 reports
 * ======================================================================== */

/**
 * Play one run to completion and report how much capsule-earning it did.
 *
 * Policy: flee the nearest threat, take the first card the draft offers. This
 * is the same bot the earlier phases were measured with, kept identical so the
 * economy is calibrated against a known reference player rather than a new one.
 *
 * @param {number} seed
 * @returns {{seed: number, waveReached: number, wavesCleared: number, won: boolean}}
 */
export function playRun(seed) {
  const bus = new EventBus();
  const state = new GameState(bus, { maxWaves: PHASE1.MAX_WAVES });
  const sim = new Simulation({ bus, state, seed });

  let wavesCleared = 0;
  bus.on('wave:complete', () => {
    wavesCleared++;
  });

  sim.startRun();

  for (let i = 0; i < 60 * 2000; i++) {
    const status = state.currentState;
    if (status === GAME_STATES.VICTORY || status === GAME_STATES.GAME_OVER) break;
    if (status === GAME_STATES.LEVEL_UP) {
      state.chooseCard(state.pendingDraft[0]);
      continue;
    }
    const p = state.player;
    const threat = sim.findNearestEnemy(400);
    sim.update(STEP, threat ? { x: p.x - threat.x, y: p.y - threat.y } : { x: 0, y: 0 });
  }

  return {
    seed,
    waveReached: state.wave,
    wavesCleared,
    won: state.currentState === GAME_STATES.VICTORY,
  };
}

/**
 * @param {number} runs
 * @returns {Array<Object>} One profile per run
 */
export function sampleRuns(runs) {
  const profiles = [];
  for (let seed = 1; seed <= runs; seed++) profiles.push(playRun(seed));
  return profiles;
}

/* ==========================================================================
 * Mid-skilled player profile (the calibration anchor)
 * ======================================================================== */

/**
 * Depth distribution for a mid-skilled player: waves 5-11, weighted to a mean
 * of exactly wave 8.
 *
 * Deliberately a spread rather than a constant wave 8. A constant would sit
 * entirely inside the 5-9 reward band and never sample the 10+ band — the same
 * blind spot that made the bot anchor misleading. This spread exercises both.
 */
export const MID_SKILL_DISTRIBUTION = [
  { wave: 5, weight: 1 },
  { wave: 6, weight: 3 },
  { wave: 7, weight: 4 },
  { wave: 8, weight: 4 },
  { wave: 9, weight: 4 },
  { wave: 10, weight: 3 },
  { wave: 11, weight: 1 },
];

/**
 * Synthesise mid-skilled run profiles.
 *
 * A player who dies on wave N cleared the N-1 waves before it, so that is the
 * number of small capsules the run pays out.
 *
 * @param {number} runs
 * @param {number} [seed]
 * @returns {Array<Object>}
 */
export function sampleMidSkillRuns(runs, seed = 90210) {
  const rng = mulberry32(seed);
  const total = MID_SKILL_DISTRIBUTION.reduce((sum, row) => sum + row.weight, 0);
  const profiles = [];

  for (let i = 0; i < runs; i++) {
    let roll = rng() * total;
    let waveReached = MID_SKILL_DISTRIBUTION[MID_SKILL_DISTRIBUTION.length - 1].wave;
    for (const row of MID_SKILL_DISTRIBUTION) {
      roll -= row.weight;
      if (roll <= 0) {
        waveReached = row.wave;
        break;
      }
    }
    profiles.push({ seed: i, waveReached, wavesCleared: waveReached - 1, won: false });
  }

  return profiles;
}

/** Named profile generators. */
export const PROFILES = {
  mid: { label: 'Mid-skilled player (mean wave 8)', sample: sampleMidSkillRuns },
  bot: { label: 'Reference bot (flee-nearest policy)', sample: sampleRuns },
};

/* ==========================================================================
 * Economy model
 * ======================================================================== */

/**
 * Scale every Petal range in a pool, keeping tiers ordered and integral.
 *
 * Non-Petal entries (the Legendary cosmetic) pass through untouched — the
 * prestige skin is not a quantity that can be scaled.
 *
 * @param {number} multiplier
 * @param {Object} [basePool]
 * @returns {Object}
 */
export function scalePool(multiplier, basePool = REWARD_POOL) {
  const scaled = {};
  for (const [tier, entries] of Object.entries(basePool)) {
    scaled[tier] = entries.map((entry) => {
      if (entry.type !== 'petal') return { ...entry };
      const min = Math.max(1, Math.round(entry.amount[0] * multiplier));
      const max = Math.max(min, Math.round(entry.amount[1] * multiplier));
      return { ...entry, amount: [min, max] };
    });
  }
  return scaled;
}

/**
 * Total Petals a sequence of runs would earn under a given pool.
 *
 * Pity persists across runs, exactly as it does in a save file.
 *
 * @param {Array<Object>} profiles
 * @param {Object} pool
 * @param {number} [seed] - Capsule RNG seed
 * @returns {{totalPetals: number, avgPerRun: number, runsToGoal: number, tierCounts: Object}}
 */
export function simulateEconomy(profiles, pool, seed = 20250413) {
  const rng = mulberry32(seed);
  let pity = { runsSinceRareOrBetter: 0 };
  let totalPetals = 0;
  let pityTriggers = 0;
  const tierCounts = { common: 0, uncommon: 0, rare: 0, legendary: 0 };
  let cosmeticDrops = 0;

  for (const profile of profiles) {
    // One small capsule per wave actually cleared.
    for (let w = 0; w < profile.wavesCleared; w++) {
      const small = resolveSmallCapsule(rng, pool);
      totalPetals += small.petals;
      tierCounts[small.tier]++;
    }

    // One large capsule at run end, banded by how deep the run got.
    const { reward, updatedPity, pityApplied } = resolveLargeCapsule(
      profile.waveReached,
      pity,
      rng,
      pool
    );
    totalPetals += reward.petals;
    tierCounts[reward.tier]++;
    cosmeticDrops += reward.cosmetics.length;
    if (pityApplied) pityTriggers++;
    pity = updatedPity;
  }

  const avgPerRun = totalPetals / profiles.length;
  return {
    totalPetals,
    avgPerRun,
    runsToGoal: avgPerRun > 0 ? GOAL_PETALS / avgPerRun : Infinity,
    tierCounts,
    pityTriggers,
    cosmeticDrops,
  };
}

/**
 * Search for a multiplier landing inside the target run band.
 *
 * Seeded with an analytic guess — Petals scale close to linearly with the
 * multiplier, so runsToGoal * (current / target) is nearly right — then binary
 * searched to absorb the integer rounding in scalePool, which makes the
 * response a step function rather than a smooth line.
 *
 * @param {Array<Object>} profiles
 * @returns {{multiplier: number, result: Object, iterations: number, history: Array, inBand: boolean}}
 */
export function calibrate(profiles) {
  const history = [];
  let iterations = 0;

  const baseline = simulateEconomy(profiles, scalePool(1));
  history.push({ multiplier: 1, runsToGoal: baseline.runsToGoal, note: 'baseline' });

  // Analytic first guess.
  let guess = baseline.runsToGoal / TARGET_MID_RUNS;
  guess = Math.min(MULTIPLIER_MAX, Math.max(MULTIPLIER_MIN, guess));

  let lo = MULTIPLIER_MIN;
  let hi = MULTIPLIER_MAX;
  let best = { multiplier: guess, result: simulateEconomy(profiles, scalePool(guess)) };
  iterations++;
  history.push({ multiplier: guess, runsToGoal: best.result.runsToGoal, note: 'analytic guess' });

  const distance = (runs) => {
    if (runs >= TARGET_MIN_RUNS && runs <= TARGET_MAX_RUNS) return 0;
    return runs < TARGET_MIN_RUNS ? TARGET_MIN_RUNS - runs : runs - TARGET_MAX_RUNS;
  };

  let current = guess;
  while (iterations < MAX_ITERATIONS && distance(best.result.runsToGoal) > 0) {
    const result = simulateEconomy(profiles, scalePool(current));
    if (distance(result.runsToGoal) < distance(best.result.runsToGoal)) {
      best = { multiplier: current, result };
    }

    if (result.runsToGoal > TARGET_MAX_RUNS) {
      // Too slow to reach the goal: pay more.
      lo = current;
    } else if (result.runsToGoal < TARGET_MIN_RUNS) {
      // Too fast: pay less.
      hi = current;
    } else {
      best = { multiplier: current, result };
      break;
    }

    current = (lo + hi) / 2;
    iterations++;
    history.push({ multiplier: current, runsToGoal: result.runsToGoal, note: 'bisect' });
  }

  return {
    multiplier: best.multiplier,
    result: best.result,
    iterations,
    history,
    inBand: distance(best.result.runsToGoal) === 0,
  };
}

/* ==========================================================================
 * Write-back
 * ======================================================================== */

/**
 * Render a REWARD_POOL literal matching the file's existing formatting.
 * @param {Object} pool
 * @returns {string}
 */
export function formatPool(pool) {
  const lines = ['export const REWARD_POOL = {'];

  for (const [tier, entries] of Object.entries(pool)) {
    const rendered = entries.map((entry) =>
      entry.type === 'petal'
        ? `{ type: 'petal', amount: [${entry.amount[0]}, ${entry.amount[1]}] }`
        : `{ type: 'cosmetic', id: '${entry.id}' }`
    );

    if (entries.length === 1) {
      lines.push(`  ${tier}: [${rendered[0]}],`);
    } else {
      lines.push(`  ${tier}: [`);
      for (const item of rendered) lines.push(`    ${item},`);
      lines.push('  ],');
    }
  }

  lines.push('};');
  return lines.join('\n');
}

/**
 * Replace the pool between the calibration markers in src/data/rewards.js.
 * @param {Object} pool
 */
export function writePool(pool) {
  const source = readFileSync(REWARDS_PATH, 'utf8');
  const startMarker = '/* CALIBRATED_POOL_START';
  const endMarker = '/* CALIBRATED_POOL_END */';

  const startIndex = source.indexOf(startMarker);
  const endIndex = source.indexOf(endMarker);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error('Calibration markers not found in src/data/rewards.js');
  }

  const startLineEnd = source.indexOf('\n', startIndex) + 1;
  const updated =
    source.slice(0, startLineEnd) + formatPool(pool) + '\n' + source.slice(endIndex);

  writeFileSync(REWARDS_PATH, updated);
}

/* ==========================================================================
 * CLI
 * ======================================================================== */

/**
 * Summarise a profile set for the report.
 * @param {Array<Object>} profiles
 */
function describeProfiles(profiles) {
  const avgWave = profiles.reduce((s, p) => s + p.waveReached, 0) / profiles.length;
  const avgCleared = profiles.reduce((s, p) => s + p.wavesCleared, 0) / profiles.length;
  const bands = { '1-4': 0, '5-9': 0, '10+': 0 };
  for (const p of profiles) {
    if (p.waveReached <= 4) bands['1-4']++;
    else if (p.waveReached <= 9) bands['5-9']++;
    else bands['10+']++;
  }
  return { avgWave, avgCleared, bands };
}

function main() {
  const args = process.argv.slice(2);
  const runsArg = args.indexOf('--runs');
  const runs = runsArg !== -1 ? Number(args[runsArg + 1]) : 200;
  const profileArg = args.indexOf('--profile');
  const profileKey = profileArg !== -1 ? args[profileArg + 1] : 'mid';
  const shouldWrite = args.includes('--write');

  const profileDef = PROFILES[profileKey];
  if (!profileDef) {
    console.error(`Unknown profile "${profileKey}". Use one of: ${Object.keys(PROFILES).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log('BLOOMWAKE — ECONOMY CALIBRATION (Phase 5, Step C)');
  console.log(
    `Goal: ${GOAL_PETALS} Petals (4th Card Slot) in ${TARGET_MIN_RUNS}-${TARGET_MAX_RUNS} runs, ` +
      `save-everything scenario`
  );
  console.log(`Anchor profile: ${profileDef.label}`);
  console.log(`Sampling ${runs} runs...`);

  const started = Date.now();
  const profiles = profileDef.sample(runs);
  const summary = describeProfiles(profiles);

  console.log(
    `  ${runs} runs in ${Date.now() - started}ms | avg wave reached ${summary.avgWave.toFixed(2)} | ` +
      `avg waves cleared ${summary.avgCleared.toFixed(2)}`
  );
  console.log(
    `  large-capsule bands: 1-4 x${summary.bands['1-4']}  5-9 x${summary.bands['5-9']}  ` +
      `10+ x${summary.bands['10+']}`
  );

  console.log('\nCalibrating...');
  const { multiplier, result, iterations, history, inBand } = calibrate(profiles);

  for (const step of history) {
    console.log(
      `  x${step.multiplier.toFixed(4).padStart(8)} -> ${step.runsToGoal.toFixed(2).padStart(7)} runs   (${step.note})`
    );
  }

  const finalPool = scalePool(multiplier);

  console.log('\n' + '='.repeat(72));
  console.log(`RESULT ${inBand ? '✅ inside target band' : '⚠️  OUTSIDE target band'}`);
  console.log('='.repeat(72));
  console.log(`  multiplier          : x${multiplier.toFixed(4)}`);
  console.log(`  iterations          : ${iterations}`);
  console.log(`  avg Petals per run  : ${result.avgPerRun.toFixed(2)}`);
  console.log(`  runs to ${GOAL_PETALS} Petals : ${result.runsToGoal.toFixed(2)}`);
  console.log(`  pity triggers       : ${result.pityTriggers} over ${runs} runs`);
  console.log(`  cosmetic drops      : ${result.cosmeticDrops}`);
  console.log(
    `  capsule tiers       : ` +
      Object.entries(result.tierCounts)
        .map(([t, n]) => `${t} ${n}`)
        .join('  ')
  );
  console.log('\n  Final Petal ranges:');
  for (const [tier, entries] of Object.entries(finalPool)) {
    const petal = entries.find((e) => e.type === 'petal');
    const extra = entries.some((e) => e.type === 'cosmetic') ? '  + prestij-skin' : '';
    console.log(`    ${tier.padEnd(10)} ${petal.amount[0]}-${petal.amount[1]} Petal${extra}`);
  }

  // Cross-check every profile against the tuned pool, so the pace for players
  // either side of the anchor is visible rather than assumed.
  console.log('\n  Pace across player profiles at this pool:');
  for (const [key, def] of Object.entries(PROFILES)) {
    const sample = def.sample(runs);
    const outcome = simulateEconomy(sample, finalPool);
    const marker = key === profileKey ? ' <- anchor' : '';
    console.log(
      `    ${def.label.padEnd(38)} ${outcome.avgPerRun.toFixed(1).padStart(7)} Petal/run  ` +
        `${outcome.runsToGoal.toFixed(1).padStart(5)} runs${marker}`
    );
  }

  if (shouldWrite) {
    writePool(finalPool);
    console.log('\n  ✍  Written back to src/data/rewards.js');
  } else {
    console.log('\n  (dry run — pass --write to update src/data/rewards.js)');
  }
}

// Only run the CLI when invoked directly, so tests can import this module.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tests/economy-calibration.js')) {
  main();
}
