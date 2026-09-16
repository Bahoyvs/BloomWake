# BloomWake

Browser survivor-arena roguelite (Void Drifter vs. The Chitin Swarm) built with
PixiJS 8 + Vite, targeting CrazyGames. ~17,400 LOC. Full context: `README.md`,
`Bloomwake_GDD_v1.md`, `Bloomwake_Development_Plan_v1.md`.

## Hard architectural rules

- `src/core/**` is pure JavaScript with **zero** `window`/`document`/DOM/Pixi
  imports. It must run headless under Node. The asset loader is injected
  (`src/core/assets.js` never imports PixiJS — the real loader is
  `src/render/pixi-loader.js`). Never add a browser or Pixi import to `core/`.
- `src/render/**` owns all Pixi/canvas code. `src/services/crazygames.js` is
  the *only* module allowed to touch `window.CrazyGames` — route all portal
  SDK access through `CrazyGamesService`, never call `window.CrazyGames`
  elsewhere.
- Faction/enemy colour is a GPU `tint` applied from the table in
  `src/render/sprite-factory.js`, not a second sprite or a baked recolor.
  Species are told apart by silhouette/size first, hue second.
- Damage flashes and similar transient VFX reuse pooled objects
  (`src/core/pool.js`) rather than allocating — a pool whose `created` count
  keeps growing across a run is a bug, not a tuning choice.
- Draw order is pinned by the `Z_ORDER` table — don't reorder layers ad hoc.
- Reward/economy numbers in `src/data/rewards.js` are calibrated output from
  `tests/economy-calibration.js`, not hand-picked — regenerate them with that
  script rather than editing the numbers by hand.

## Commands

```bash
npm run dev            # Vite dev server (port 3000, host on LAN too)
npm run build           # production bundle -> dist/
npm test                 # Vitest unit suites (tests/**/*.test.js)
npm run test:watch
npm run assets           # restage public/assets/ from assets/ (Kenney vendor packs)
node tests/balance-sim.js        # card balance thresholds (level-5 cap, no dead cards at lvl3)
node tests/juice-bench.js        # 200-enemy CPU frame-cost benchmark; supports --throttle N
node tests/economy-calibration.js # 200 bot runs -> rewrites calibrated reward bands in rewards.js
```

No linter/formatter is configured — match surrounding style, keep diffs
minimal.

## Before calling a change done

- Run `npm test`. A change touching balance, rewards, theme colours, or the
  spatial/pool hot path should also run the relevant script above
  (`balance-sim.js`, `theme.test.js`, `juice-bench.js`) — these encode
  numeric contracts (WCAG contrast, level-5 output cap, pool reuse) that a
  unit test alone won't catch.
- A change to `src/render/sprite-factory.js`, sprite atlases, or
  `public/assets/` should be checked against `src/render/asset-audit.js`
  (`tests/asset-audit.test.js`), which samples real pixel/tint output rather
  than trusting the source PNG.
- A change touching `src/services/crazygames.js` should be checked against
  `tests/crazygames.test.js` and must keep working with `window.CrazyGames`
  undefined (off-portal / local dev) — the service must degrade to
  `environment: 'local'`/`'mock'`, never throw.
- For a UI/visual change, use the `run` skill to launch the dev server and
  look at it in the browser before reporting done — Vitest proves logic
  correctness, not what's on screen.

## Performance ceiling

Naive collision at the 200-enemy cap is designed against, not incidental:
spatial hash grid (`src/core/spatial.js`, 64px cells) keeps broadphase
near-linear. Don't reintroduce O(n²) pairwise loops over the full enemy set.
`tests/juice-bench.js --throttle N` reports frame budget as if the CPU were N
times slower — use it to sanity-check any change to the hot per-frame path
(`simulation.js`, `spawner.js`, `particles.js`, `enemy-system.js`).
