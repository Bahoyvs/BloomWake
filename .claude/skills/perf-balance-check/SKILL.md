---
name: perf-balance-check
description: Run BloomWake's headless performance and balance contracts (200-enemy CPU benchmark, card balance thresholds, economy calibration) and report whether they still hold. Use after touching src/core/simulation.js, spawner.js, spatial.js, enemy-system.js, particles.js, src/data/cards.js, src/data/rewards.js, src/data/enemies.js, or src/core/pool.js — or whenever asked to check performance/balance/economy.
---

# Perf & balance check

BloomWake encodes several numeric contracts as headless Node scripts instead
of eyeballed tuning. Run the ones relevant to the change:

1. **CPU frame budget at the 200-enemy cap**
   ```bash
   node tests/juice-bench.js
   node tests/juice-bench.js --throttle 4   # simulate a slower mobile core
   ```
   Compare against the previous run's numbers (ask the user for a baseline,
   or run once on `git stash` / the pre-change commit if unsure). Flag any
   regression, and note this measures CPU only — not GPU/Pixi batching time.

2. **Card balance thresholds**
   ```bash
   node tests/balance-sim.js
   ```
   Enforces: no level-5 card exceeds 40% of the others' combined output, and
   no card is "dead" (near-zero contribution) at level 3. A failure here
   means the change shifted a card's numbers past a hard threshold, not a
   style issue — fix the data in `src/data/cards.js`, don't loosen the
   threshold.

3. **Economy calibration** (only if reward pacing may have shifted)
   ```bash
   node tests/economy-calibration.js
   ```
   Plays 200 bot runs and rewrites the calibrated reward block in
   `src/data/rewards.js` in place. Only run this deliberately — it mutates
   the file — and diff the result before committing.

4. Run `npm test` regardless; `tests/balance.test.js`, `tests/pool.test.js`,
   `tests/spatial.test.js`, and `tests/theme.test.js` cover related
   assertions (including WCAG contrast for the hero-vs-swarm legibility
   contract) that these scripts don't duplicate.

Report results as: which scripts ran, pass/fail per contract, and any number
that moved meaningfully from what the code comments/README describe as the
target (e.g. 15–20 run window for the 4th Card Slot unlock).
