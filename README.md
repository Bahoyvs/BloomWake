# BloomWake

A browser-native survivor-arena roguelite — *Void Drifter vs. The Chitin Swarm* — that holds 200 concurrent enemies on screen at 60 FPS, with the swarm-legibility problem solved numerically rather than by eye.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| **Language** | JavaScript (ES modules, ~17,400 LOC) |
| **Rendering** | PixiJS 8 (WebGL) — sprite batching, GPU tint, pooled particle sprites |
| **Build** | Vite 5 |
| **Testing** | Vitest 2 — 27 unit-test suites + 3 headless simulation/benchmark harnesses |
| **Persistence** | `localStorage` with backward-compatible deep-merge loading |
| **Target** | CrazyGames (web) |

**Architecture patterns:** DOM-free simulation core, dependency injection, object pooling, spatial hashing, event bus, data-driven tuning tables.

---

## Core Mechanics & Features

- **Sustains a 200-enemy swarm** through a 64px spatial hash grid that collapses broadphase collision from O(n²) to ~O(n), an object pool for burst-spawned card entities, and a particle system whose sprites are parked (`visible = false`) rather than destroyed — a full-wave wipe must not allocate or restructure the display list.
- **Drafts builds from 8 stacking cards** with weighted level-up offers and Tactical Wingman gating, backed by a balance simulation that enforces two hard thresholds: no level-5 card may exceed 40% of the others' combined output, and no card may be "dead" at level 3.
- **Escalates through a 15-wave roster** of five Chitin Swarm archetypes in three weight classes — 0.6x light fighters up to a 1.5x armoured cruiser, each on a distinct hull silhouette — plus the Dreadnought Station, a four-sprite composite boss (cross keel, mirrored turret platforms, seated reactor) whose Bio-Acid Bloom AoE runs on a deterministic, formula-driven telegraph, readable and reproducible under test rather than random.
- **Persists meta-progression** across runs via salvage capsules (weighted by run performance, with an 8-run pity guarantee), a scrap currency, 4 meta-upgrades, 4 hull liveries, and a local-day-scoped daily shipment bonus.

---

## Technical Architecture & Problem Solving

Two hard problems define this codebase, and both were solved by making a subjective quality measurable.

**The performance ceiling.** A survivor-arena lives or dies on how many entities it can move, collide and draw per frame, in a browser, on a mid-range machine. Naïve pairwise collision at a 200-enemy cap is 20,000 checks per frame before any rendering; the spatial hash grid partitions world space into 64px cells and reduces that to near-linear. Allocation pressure is attacked separately — card effects that burst (a 16-petal storm, a rebuilt blade ring on every level-up) recycle through an `ObjectPool` that tracks `created` vs `reused`, on the principle that a pool which keeps growing is a leak. On the render side, damage flashes are a GPU `tint` rather than a second sprite, and sprite scale is derived from collision radius (`scaleForRadius`) so art can ship at any resolution without touching code. Because the whole simulation is DOM-free, a headless benchmark (`tests/juice-bench.js`) measures per-frame CPU cost at the 200-enemy cap in Node, with a `--throttle N` flag that reports the budget as if the CPU were N times slower — a standing-in for a mid-range mobile core. That harness is explicit about its limits: it measures CPU, not GPU time or Pixi batching, so it proves the animation layer's share of the frame budget is small without pretending to prove a frame rate.

**The legibility ceiling — "visual soup."** At 200 enemies, the player's own ship routinely disappears into the swarm, and the usual fix is to nudge colors until it "looks fine." Here the fix is a contract: the hero side is the only very-bright element on screen, and the entire Swarm palette is dark across just six carapace hues, so average screen brightness cannot drift into the hero's band no matter how many enemies spawn. Draw order is pinned by an explicit `Z_ORDER` table. Crucially, `tests/theme.test.js` asserts these rules using WCAG contrast ratios, so a palette change that breaks legibility fails in CI instead of in playtesting.

The art pipeline makes that contract *stronger* rather than weaker. Every faction colour is a GPU `tint` applied from one table (`src/render/sprite-factory.js`) over detailed Kenney hulls. Because a tint multiplies, the frame's own shading survives it — so colour is a number a test can read instead of a pixel nobody can check, the swarm still batches per atlas, and re-skinning a species is a one-line diff. Because a unit test cannot see a PNG, `src/render/asset-audit.js` closes the gap in dev by sampling each sprite's real pixels — cropped to its atlas *frame*, and multiplied through its *tint*, so what it measures is what actually reaches the screen. Species are told apart by silhouette and size rather than hue, on the grounds that five dark hulls differ by outline long before they differ by colour.

The same evidence-over-intuition discipline extends to the economy. Reward amounts were not estimated — `tests/economy-calibration.js` plays 200 bot runs, computes each run's capsule income through production logic, and rescales the reward bands until time-to-unlock for the 4th Card Slot (2000 Petal) lands in a 15–20 run window, rewriting the calibrated block in `src/data/rewards.js` in place.

Underpinning all of it: **`src/core/` is pure JavaScript with zero `window`/`document`/DOM references.** The entire simulation, economy and progression layer runs and is tested under Node; even the asset loader is injected (`src/core/assets.js` never imports PixiJS — the real loader lives in `src/render/pixi-loader.js`), and a missing sprite file degrades to a generated placeholder rather than halting boot.

---

## Installation / How to Play

**Requirements:** Node.js 18+.

```bash
git clone https://github.com/Bahoyvs/BloomWake.git
cd BloomWake
npm install
npm run dev          # Vite dev server
```

```bash
npm run build        # production bundle
npm test             # Vitest unit suites
npm run assets       # restage public/assets/ from the Kenney vendor packs
node tests/balance-sim.js      # card balance thresholds
node tests/juice-bench.js      # 200-enemy frame-cost benchmark
```

*Live build: **[link pending]***

### Controls

| Input | Effect |
| --- | --- |
| `WASD` / arrow keys | Move (the Drifter fires automatically) |
| `1` – `4` | Pick a card from the level-up draft (mouse click also works) |
| `Enter` / `Space` | Start / restart run |
| `Esc` / `P` | Pause / resume |

---

## Repository Layout

```
src/core/      pure simulation — no DOM, fully testable under Node
  spatial.js     64px spatial hash grid (broadphase collision)
  pool.js        object pool with created/reused leak accounting
  simulation.js  entities, enemy behaviours, boss telegraph, collision
  wave.js        wave formulas · spawner.js  pacing & concurrent cap
  cards.js/draft.js   card effect handlers + weighted draft
  game-state.js  run state, XP/levels, wave flow
  rewards.js/meta-shop.js/meta-progression.js   capsules, scrap economy
  assets.js      asset manifest + preload (loader is injected)
src/render/    PixiJS layer
  theme.js       palette + WCAG contrast & Z_ORDER contract
  sprite-factory.js  species tints/scales, thrusters, boss composite
  sprites.js     radius-derived scale, per-frame sprite sync
  background.js  parallax void + energy-lattice shader
  particles.js   pooled PIXI sprite particles · screen-shake.js  trauma-based shake
  asset-audit.js real-texture brightness audit, through the tint (dev)
src/data/      enemy, card, reward, upgrade and cosmetic tables
src/ui/        DOM HUD, draft screen, meta screens (storage.js is the only DOM-touching persistence)
tests/         Vitest suites + balance-sim, economy-calibration, juice-bench
tools/         build-assets.mjs — Kenney vendor packs -> public/assets/
public/assets/ staged, committed art: ships/ (two atlases) + ui/
```

**Ship feel.** The Drifter carries momentum rather than being teleported by input: velocity closes on the input direction on an exponential curve, coasts on drag when the keys are released, and the hull interpolates toward its travel heading instead of snapping to it (`PLAYER_CFG.ACCEL` / `DRAG`, `HERO_TURN_LERP`). Top speed is unchanged, so the balance envelope the economy and wave pacing were calibrated against still holds — what changed is how long the ship takes to get there. The tests state that distinction directly: terminal speed is asserted after the ramp, and the ramp, the coast, the reversal drift and the wall-momentum case each have their own case.

**Design documentation:** [`Bloomwake_GDD_v1.md`](Bloomwake_GDD_v1.md) · [`Bloomwake_Development_Plan_v1.md`](Bloomwake_Development_Plan_v1.md) · [`assets/README.md`](assets/README.md) (art pipeline & drop-in guide)
