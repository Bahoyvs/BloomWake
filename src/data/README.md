# Data tables

Plain data, no logic beyond pure lookups. `enemies.js`, `cards.js`, `rewards.js`,
`cosmetics.js`, `meta-upgrades.js`, `animations.js`.

---

## Two ways to author a state's art

**`src/data/animations.js` never hardcodes frame counts** — it measures the real
image at load time and adapts. Both of the modes below are fully supported, and
you can mix them freely: one state can be a single drawing while another is a
multi-frame strip.

### Mode 1 — one image per state (what is in `assets/sprites/` today)

A single square PNG per state, e.g. `dewling_hit.png` at 373x373. The loader
measures it as **one frame** and the animator treats it as a **pose**, not a
one-frame animation.

This is a first-class mode, not a degraded one. The artwork supplies the shape;
the motion comes from `src/render/state-fx.js` — squash-and-stretch, a damage
flash, a particle burst and a trail boost, all procedural. A hit reads as a real
reaction with a single drawing behind it.

> **Why this needed a fix.** A pose has no intrinsic duration. It was originally
> timed as a 1-frame clip at the state's nominal fps, which gave `hit` a
> lifetime of 1/16s — one image, gone in four frames. Poses are now held for
> their FX duration (`HERO_FX` / `BOSS_FX` in `state-fx.js`) instead: 220ms for
> a hit, 170ms for an attack, 750ms for a death. **Those tables are where you
> tune how long a reaction is felt.**

### Mode 2 — a multi-frame strip

If you do want frame-by-frame animation, use the strip format below. The FX layer
still applies on top, so frames and squash-and-stretch compose rather than
compete.

**If your strips differ from this convention, say so and it is a one-line
change** — nothing else needs touching.

### Assumed default: horizontal strip of square frames

```
dewling_idle.png     ← 6 frames, 64px each
┌────┬────┬────┬────┬────┬────┐
│ 0  │ 1  │ 2  │ 3  │ 4  │ 5  │   384 x 64
└────┴────┴────┴────┴────┴────┘
```

- All frames in **one horizontal row**, left to right, no padding, no margin.
- Each frame is **square**: frame width == sheet height.
- Frame count is then just `sheetWidth / sheetHeight` — 384/64 = 6.
- Frames may be any size, as long as they are square and uniform.

This convention is the default precisely because it needs **no metadata file**.
Export a strip and the game counts the frames itself.

### If your frames are not square, or you use a grid

Drop a companion `.json` next to the sheet with the same basename. It wins over
the convention above, and the dimensions are then only a cross-check:

```jsonc
// assets/sprites/dewling_idle.json
{
  "frameWidth": 96,     // required if frames are not square
  "frameHeight": 64,    // optional, defaults to sheet height
  "frameCount": 6,      // optional, overrides the computed count outright
  "layout": "grid"      // optional, "horizontal-strip" (default) or "grid"
}
```

A TexturePacker-style atlas is fine too — export the JSON, then tell me and the
probe reads `frames` from it instead.

### Which files the game is currently looking for

`ANIMATION_MANIFEST` (Tier A, sprite-sheet animated — **Dewling and Rustwhale
only**):

| Entity    | State       | File                        | Playback           |
| --------- | ----------- | --------------------------- | ------------------ |
| dewling   | `idle`      | `dewling_idle.png`          | 6 fps, loops       |
| dewling   | `move`      | `dewling_move.png`          | 10 fps, loops      |
| dewling   | `attack`    | `dewling_attack.png`        | 14 fps, once       |
| dewling   | `hit`       | `dewling_hit.png`           | 16 fps, once       |
| dewling   | `death`     | `dewling_death.png`         | 10 fps, once       |
| rustwhale | `idle`      | `rustwhale_idle.png`        | 4 fps, loops       |
| rustwhale | `telegraph` | `rustwhale_telegraph.png`   | **derived**, once  |
| rustwhale | `attack`    | `rustwhale_attack.png`      | 12 fps, once       |
| rustwhale | `hit`       | `rustwhale_hit.png`         | 16 fps, once       |
| rustwhale | `phaseUp`   | `rustwhale_phaseup.png`     | 10 fps, once       |
| rustwhale | `death`     | `rustwhale_death.png`       | 8 fps, once        |

`SWARM_CYCLE_MANIFEST` (Tier B optional extra layer — swarm enemies):

| Type     | File                | Playback      |
| -------- | ------------------- | ------------- |
| ashfish  | `ashfish_swim.png`  | 8 fps, loops  |
| smogmoth | `smogmoth_flap.png` | 12 fps, loops |

**Every one of these is optional.** A missing file logs one warning and falls
back to the static sprite — the game runs unchanged. Place them one at a time in
any order, as single poses or as strips.

Currently present: the five `dewling_*` poses. Still absent: all six
`rustwhale_*` states and both optional swarm cycles. Note that `dewling.png`
(the plain static hero texture in `src/core/assets.js`) has been **removed** in
favour of the per-state poses — the animator covers every hero state, so this
only matters if a state's file is ever deleted, in which case that state would
fall back to a generated placeholder.

### The telegraph sheet is the special one

`rustwhale_telegraph.png` has **no fps of its own**. Its playback speed is
computed per cast so the animation finishes exactly when the Black Tide AoE
lands:

```
telegraph_ms = (AoE_radius / dewling_speed) * 1000 + 300     ← Phase 4 formula
fps          = frame_count / (telegraph_ms / 1000)
```

Draw **whatever number of frames reads best** — 4 or 40, it does not matter.
The speed stretches to fit the fairness window. What you must not do is assume a
playback rate: if you animate it to look right at 12 fps and the AoE radius is
later tuned, the visual warning and the real hit window drift apart.

### Other authoring rules

Everything in [`assets/README.md`](../../assets/README.md) still applies to each
individual frame — centre the subject, face right, keep Frutevil art at or below
0.25 mean luminance, and do **not** author a hit-flash variant (it is a tint).
