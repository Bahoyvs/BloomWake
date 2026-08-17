/**
 * Tier B performance benchmark — 200-enemy frame cost.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT
 * This is a CPU-cost benchmark run in Node, not a browser FPS measurement. It
 * measures the per-frame cost of the work Phase 7 ADDED: the simulation step at
 * the 200-enemy cap plus the Tier B transform for every one of them. It cannot
 * measure GPU time, Pixi batching or compositing, so it does not prove a frame
 * rate on its own — it proves that the animation layer's share of the frame
 * budget is small, and it isolates which juice function costs what if it is not.
 *
 * There was no existing Phase 2 FPS harness to extend (the repository has
 * balance-sim.js and economy-calibration.js, both gameplay models), so this
 * establishes the CPU-side one. The visual/GPU half stays a manual check — see
 * the checklist in the Phase 7 report.
 *
 * Run: node tests/juice-bench.js [--enemies 200] [--frames 600] [--throttle 4]
 *
 * --throttle N reports the budget as if the CPU were N times slower than this
 * machine, which is the standard way to stand in for a mid-range mobile core.
 */

import { performance } from 'node:perf_hooks';
import { EventBus } from '../src/core/event-bus.js';
import { GameState } from '../src/core/game-state.js';
import { Simulation } from '../src/core/simulation.js';
import { PHASE1 } from '../src/core/constants.js';
import {
  applyJuice,
  createTransform,
  deathDissolve,
  facingRotation,
  flutter,
  hitFlash,
  idleBreathe,
  spawnGrow,
} from '../src/render/juice.js';

const FRAME_BUDGET_MS = 1000 / 60;

const args = process.argv.slice(2);
/**
 * @param {string} flag
 * @param {number} fallback
 * @returns {number}
 */
function arg(flag, fallback) {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : Number(args[index + 1]);
}

const ENEMY_COUNT = arg('--enemies', 200);
const FRAMES = arg('--frames', 600);
const THROTTLE = arg('--throttle', 4);

/**
 * A simulation held at the enemy cap, as a boss-wave-scale swarm.
 * @returns {Simulation}
 */
function makeLoadedSim() {
  const bus = new EventBus();
  const state = new GameState(bus, { maxWaves: PHASE1.MAX_WAVES });
  const sim = new Simulation({ bus, state, seed: 99 });
  sim.startRun();

  // Wave 32 is where getEnemyCount saturates at the 200 cap.
  sim.state.wave = 32;
  sim.spawner.beginWave(32);

  const types = ['tarling', 'ashfish', 'cracked_wisp', 'rustbloom', 'smogmoth'];
  while (sim.enemies.length < ENEMY_COUNT) {
    sim.spawnEnemy(types[sim.enemies.length % types.length]);
  }
  return sim;
}

/**
 * @param {() => void} fn
 * @param {number} iterations
 * @returns {{total: number, per: number}} Milliseconds
 */
function time(fn, iterations) {
  // Warm up so the JIT has compiled the hot path before measurement.
  for (let i = 0; i < Math.min(100, iterations); i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const total = performance.now() - start;
  return { total, per: total / iterations };
}

/**
 * @param {number} ms
 * @returns {string}
 */
function pct(ms) {
  return `${((ms / FRAME_BUDGET_MS) * 100).toFixed(2)}%`;
}

const sim = makeLoadedSim();
const enemies = sim.enemies;
const transform = createTransform();
let clock = 0;

console.log('BloomWake — Tier B animation cost');
console.log('='.repeat(64));
console.log(`Enemies:        ${enemies.length}`);
console.log(`Frames sampled: ${FRAMES}`);
console.log(`Frame budget:   ${FRAME_BUDGET_MS.toFixed(2)}ms (60 FPS)`);
console.log(`Throttle:       ${THROTTLE}x (simulated slower CPU)`);
console.log('');

/* ---- Whole Tier B layer, as the renderer calls it ---- */

const juiceAll = time(() => {
  clock += 1 / 60;
  for (let i = 0; i < enemies.length; i++) applyJuice(enemies[i], clock, transform);
}, FRAMES);

/* ---- Per-function breakdown, so a regression names its own cause ---- */

const breakdown = [];
/**
 * @param {string} name
 * @param {Function} fn
 */
function measureFn(name, fn) {
  const result = time(() => {
    clock += 1 / 60;
    for (let i = 0; i < enemies.length; i++) fn(enemies[i], clock, transform);
  }, FRAMES);
  breakdown.push({ name, per: result.per });
}

measureFn('flutter', flutter);
measureFn('spawnGrow', spawnGrow);
measureFn('hitFlash', hitFlash);
measureFn('deathDissolve', deathDissolve);
measureFn('idleBreathe', idleBreathe);
breakdown.push({
  name: 'facingRotation',
  per: time(() => {
    for (let i = 0; i < enemies.length; i++) facingRotation(enemies[i], transform);
  }, FRAMES).per,
});

/* ---- Simulation step at the same load, for context ---- */

const simStep = time(() => sim.update(1 / 60, { x: 1, y: 0 }), Math.min(FRAMES, 300));

console.log('Per-frame cost for the whole swarm');
console.log('-'.repeat(64));
console.log(
  `Tier B (applyJuice x${enemies.length})   ` +
    `${juiceAll.per.toFixed(4)}ms   ${pct(juiceAll.per)} of budget`
);
console.log(
  `Simulation step               ` +
    `${simStep.per.toFixed(4)}ms   ${pct(simStep.per)} of budget`
);
console.log('');

console.log('Tier B breakdown (cost driver first)');
console.log('-'.repeat(64));
breakdown.sort((a, b) => b.per - a.per);
for (const entry of breakdown) {
  const perEntity = (entry.per / enemies.length) * 1000;
  console.log(
    `  ${entry.name.padEnd(16)} ${entry.per.toFixed(4)}ms/frame   ` +
      `${perEntity.toFixed(3)}us/entity   ${pct(entry.per)}`
  );
}
console.log('');

/* ---- Verdict ---- */

const combined = juiceAll.per + simStep.per;
const throttled = combined * THROTTLE;

console.log('Verdict');
console.log('-'.repeat(64));
console.log(`CPU per frame (sim + Tier B):        ${combined.toFixed(4)}ms`);
console.log(`At ${THROTTLE}x throttle:                     ${throttled.toFixed(4)}ms`);
console.log(`Headroom left for render/GPU at ${THROTTLE}x: ${(FRAME_BUDGET_MS - throttled).toFixed(2)}ms`);
console.log('');

if (throttled > FRAME_BUDGET_MS) {
  console.log(`FAIL — CPU alone exceeds the 60 FPS budget at ${THROTTLE}x throttle.`);
  console.log(`Cost driver: ${breakdown[0].name} (${breakdown[0].per.toFixed(4)}ms/frame).`);
  process.exitCode = 1;
} else {
  console.log(`PASS — CPU work fits the 60 FPS budget at ${THROTTLE}x throttle.`);
  console.log(`Largest Tier B cost: ${breakdown[0].name} (${pct(breakdown[0].per)} of budget).`);
}
