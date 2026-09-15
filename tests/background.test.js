import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  Background,
  BLEND,
  DUST_ALPHA,
  GRID,
  NEBULA_BASE,
  NEBULA_BASE_RGB,
  NEBULA_HUES,
  NEBULA_IMAGE_CANDIDATES,
  NEBULA_PATH,
  NEBULA_PUFF,
  NEBULA_RIFT,
  NEBULA_WORLD_MARGIN,
  PARALLAX,
  STARFIELD,
  VOID_BASE,
  makeDustTexture,
  makeGridTexture,
  makeNebulaCanvas,
  makeStarfieldTexture,
  makeVoidTileTexture,
  tryLoadNebulaImage,
} from '../src/render/background.js';
import { THEME, contrastRatio, MIN_HERO_CONTRAST } from '../src/render/theme.js';
import { WORLD } from '../src/core/constants.js';
import { ASSET_MANIFEST } from '../src/core/assets.js';

beforeAll(() => {
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          globalAlpha: 1,
          fillRect: () => {},
          clearRect: () => {},
          beginPath: () => {},
          arc: () => {},
          fill: () => {},
          stroke: () => {},
          strokeRect: () => {},
          moveTo: () => {},
          lineTo: () => {},
          ellipse: () => {},
          save: () => {},
          restore: () => {},
          translate: () => {},
          rotate: () => {},
          scale: () => {},
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: () => {},
          createLinearGradient: () => ({ addColorStop: () => {} }),
          createRadialGradient: () => ({ addColorStop: () => {} }),
          bezierCurveTo: () => {},
          quadraticCurveTo: () => {},
          closePath: () => {},
        }),
      }),
    };
  }
});

describe('boot diagnostic', () => {
  it('logs the hard sanity-check banner so a stale build is never mistaken for a bad fix', () => {
    // The one thing a screenshot cannot tell you: whether this code even ran.
    // If a future report ever again says "looks identical to before", this
    // line's absence from the console is the first thing to check, before
    // touching a single pixel value.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let calls;
    try {
      new Background(null);
      // Read the recorded calls BEFORE mockRestore() — restoring a spy also
      // resets its call history, so asserting after the finally block below
      // would always see zero calls regardless of what actually happened.
      calls = [...spy.mock.calls];
    } finally {
      spy.mockRestore();
    }

    expect(calls).toContainEqual([
      expect.stringContaining('[BloomWake Background]'),
      expect.any(String),
      expect.any(String),
    ]);
    const [message] = calls.find((c) => String(c[0]).includes('[BloomWake Background]'));
    expect(message).toContain('Single Non-Tiling Mode');
    expect(message).toContain('Caustics DISABLED');
  });
});

describe('Background layer stack', () => {
  it('builds the nebula sprite plus the tactical grid, star and dust layers', () => {
    const bg = new Background(null);
    expect(bg.container).toBeDefined();
    expect(bg.nebulaSprite).toBeDefined();
    expect(bg.gridLayer).toBeDefined();
    expect(bg.starLayer).toBeDefined();
    expect(bg.dustLayer).toBeDefined();
  });

  it('mounts the nebula as a plain Sprite, never a TilingSprite', () => {
    // THE ARCHITECTURAL POINT OF THIS PASS. A TilingSprite repeats its texture
    // by definition; a plain Sprite is drawn exactly once, so there is no
    // second copy anywhere for the eye to recognise as a repeat. Checked by
    // absence of the tiling-only API rather than a constructor-name string,
    // which would not survive a bundler renaming the class.
    const bg = new Background(null);
    expect(bg.nebulaSprite.tilePosition).toBeUndefined();
    expect(bg.nebulaSprite.tileScale).toBeUndefined();
  });

  it('stacks the display list back-to-front, with the void at the bottom', () => {
    // Exactly five children, nothing more: no caustics mesh, no fourth overlay
    // of any kind. See the "eliminates the caustics mesh" describe block below
    // for the direct assertion this is a regression guard for.
    const bg = new Background(null);
    expect(bg.container.children).toEqual([
      bg.baseGfx,
      bg.nebulaSprite,
      bg.gridLayer,
      bg.starLayer,
      bg.dustLayer,
    ]);
  });

  it('uses only hardware blend modes, so the backdrop costs no extra passes', () => {
    const hardware = ['normal', 'add', 'multiply', 'screen', 'min', 'max'];
    for (const mode of Object.values(BLEND)) expect(hardware).toContain(mode);
  });

  it('blends the sparse tiled layers additively, and the self-contained nebula normally', () => {
    /*
     * EIGHTH PASS: the nebula moved from `screen` to `normal` — see BLEND's
     * own doc comment for why `screen` was what turned a richer palette into
     * a wash (no ceiling short of white, and it keeps compounding wherever
     * puffs overlap). Stars and dust are still additive: they are sparse,
     * mostly-transparent speckle, not a self-contained opaque composite.
     */
    const bg = new Background(null);
    expect(bg.nebulaSprite.blendMode).toBe(BLEND.NEBULA);
    expect(bg.starLayer.blendMode).toBe(BLEND.STARS);
    expect(bg.dustLayer.blendMode).toBe(BLEND.DUST);

    expect(BLEND.NEBULA).toBe('normal');
    for (const mode of [BLEND.STARS, BLEND.DUST]) {
      expect(['add', 'screen']).toContain(mode);
    }
  });
});

describe('the single arena-pinned nebula Sprite', () => {
  it('sizes the sprite to the arena, scaled up by NEBULA_WORLD_MARGIN and by zoom', () => {
    const bg = new Background(null);
    bg.resize(1920, 1080, 1);

    expect(bg.nebulaSprite.width).toBeCloseTo(WORLD.WIDTH * NEBULA_WORLD_MARGIN, 6);
    expect(bg.nebulaSprite.height).toBeCloseTo(WORLD.HEIGHT * NEBULA_WORLD_MARGIN, 6);

    bg.resize(852, 393, 0.45);
    expect(bg.nebulaSprite.width).toBeCloseTo(WORLD.WIDTH * NEBULA_WORLD_MARGIN * 0.45, 6);
    expect(bg.nebulaSprite.height).toBeCloseTo(WORLD.HEIGHT * NEBULA_WORLD_MARGIN * 0.45, 6);
  });

  it('margins the sprite comfortably larger than any legal viewport', () => {
    // The clamp in positionNebula only has room to work with because of this.
    // Checked at zoom 1 (the least favourable case: the smallest possible
    // sprite-to-viewport ratio) against the widest/tallest viewports the
    // camera module actually produces.
    const bg = new Background(null);
    bg.resize(1920, 1080, 1);
    expect(bg.nebulaSprite.width).toBeGreaterThan(1920);
    expect(bg.nebulaSprite.height).toBeGreaterThan(1080);
  });

  it('centres the sprite under the viewport when the camera sits at the arena centre', () => {
    const bg = new Background(null);
    bg.resize(1920, 1080, 1);
    bg.update(1 / 60, WORLD.WIDTH / 2, WORLD.HEIGHT / 2, 1920, 1080, 1);

    expect(bg.nebulaSprite.x).toBeCloseTo((1920 - bg.nebulaSprite.width) / 2, 6);
    expect(bg.nebulaSprite.y).toBeCloseTo((1080 - bg.nebulaSprite.height) / 2, 6);
  });

  it('drifts by a small, non-zero fraction of camera travel', () => {
    const bg = new Background(null);
    bg.resize(1920, 1080, 1);
    bg.update(1 / 60, WORLD.WIDTH / 2, WORLD.HEIGHT / 2, 1920, 1080, 1);
    const centred = bg.nebulaSprite.x;

    bg.update(1 / 60, WORLD.WIDTH / 2 + 400, WORLD.HEIGHT / 2, 1920, 1080, 1);
    const drifted = bg.nebulaSprite.x;

    expect(drifted).not.toBe(centred);
    // Moves the OPPOSITE way from a full-parallax foreground object would (a
    // world object's screen position moves left as the camera moves right) —
    // less far than that, which is what "distant" means here.
    const fullParallaxShift = -400 * 1; // for a fully-pinned world object
    const shift = drifted - centred;
    expect(Math.sign(shift)).toBe(Math.sign(fullParallaxShift));
    expect(Math.abs(shift)).toBeLessThan(Math.abs(fullParallaxShift));
    expect(Math.abs(shift)).toBeCloseTo(400 * PARALLAX.NEBULA_WORLD * 1, 6);
  });

  it('never lets the sprite edge enter the viewport, at any camera position', () => {
    const bg = new Background(null);
    bg.resize(1920, 1080, 1);

    // Sweep across the whole legal camera range plus some margin, since the
    // clamp exists precisely for the extremes.
    for (let x = -2000; x <= WORLD.WIDTH + 2000; x += 250) {
      for (let y = -1000; y <= WORLD.HEIGHT + 1000; y += 250) {
        bg.update(1 / 60, x, y, 1920, 1080, 1);
        expect(bg.nebulaSprite.x, `x=${x}`).toBeLessThanOrEqual(0);
        expect(bg.nebulaSprite.x + bg.nebulaSprite.width, `x=${x}`).toBeGreaterThanOrEqual(1920);
        expect(bg.nebulaSprite.y, `y=${y}`).toBeLessThanOrEqual(0);
        expect(bg.nebulaSprite.y + bg.nebulaSprite.height, `y=${y}`).toBeGreaterThanOrEqual(1080);
      }
    }
  });

  it('centres a sprite smaller than the viewport instead of leaving an inverted clamp', () => {
    // The degenerate case: an ultra-wide/tall monitor at a low zoom could, in
    // principle, have a wider viewport than NEBULA_WORLD_MARGIN's headroom
    // buys. This must degrade to "centred, edges visible" rather than NaN or
    // a clamp that picks the wrong bound.
    const bg = new Background(null);
    bg.resize(20000, 20000, 1);
    bg.update(1 / 60, WORLD.WIDTH / 2, WORLD.HEIGHT / 2, 20000, 20000, 1);

    expect(Number.isFinite(bg.nebulaSprite.x)).toBe(true);
    expect(Number.isFinite(bg.nebulaSprite.y)).toBe(true);
    expect(bg.nebulaSprite.x).toBeCloseTo((20000 - bg.nebulaSprite.width) / 2, 6);
  });

  it('is already correctly positioned after resize alone, before the first update', () => {
    // A resize can happen (a window resize event) before the next render
    // frame calls update(). The sprite must not show a stale/wrong position
    // for that gap.
    const bg = new Background(null);
    bg.resize(1920, 1080, 1);
    expect(bg.nebulaSprite.x).toBeCloseTo((1920 - bg.nebulaSprite.width) / 2, 6);
    expect(bg.nebulaSprite.y).toBeCloseTo((1080 - bg.nebulaSprite.height) / 2, 6);
  });
});

describe('nebula/starfield tiled-layer parallax (grid, stars, dust)', () => {
  it('gives the tiled layers distinct parallax rates', () => {
    expect(PARALLAX.STARS).toBeLessThan(PARALLAX.DUST);
    expect(PARALLAX.DUST).toBeLessThan(1);
    expect(PARALLAX.GRID).toBeGreaterThan(0);
  });

  it('offsets each tiled layer by its own rate times the camera travel', () => {
    const bg = new Background(null);
    bg.update(1 / 60, 1000, 400, 800, 600, 1);

    expect(bg.starLayer.tilePosition.x).toBeCloseTo(-1000 * PARALLAX.STARS, 6);
    expect(bg.gridLayer.tilePosition.x).toBeCloseTo(-1000 * PARALLAX.GRID, 6);
    // The dust carries a velocity kick on top of its parallax; on the first
    // update the previous camera position defaults to the arena centre, so a
    // camera call starting away from centre still has a well-defined (if
    // large) instantaneous velocity rather than an undefined one.
    expect(bg.dustLayer.tilePosition.x).toBeDefined();
  });

  it('scales every tiled rate by the zoom so depth survives a zoomed-out view', () => {
    // Without this the foreground dust (rate 0.45) tracks the arena exactly at
    // the mobile zoom of ~0.45 — the fastest parallax layer would sit
    // perfectly still relative to the ground and the depth would collapse on
    // the very devices this backdrop was built for.
    const bg = new Background(null);
    bg.update(1 / 60, 1000, 0, 852, 393, 0.45);

    expect(bg.dustLayer.tilePosition.x).toBeCloseTo(-1000 * PARALLAX.DUST * 0.45, 6);
    expect(bg.starLayer.tilePosition.x).toBeCloseTo(-1000 * PARALLAX.STARS * 0.45, 6);
  });

  it('throws the dust against the direction of travel as the camera accelerates', () => {
    const bg = new Background(null);
    bg.update(1 / 60, WORLD.WIDTH / 2, WORLD.HEIGHT / 2, 800, 600, 1);
    const settled = bg.dustLayer.tilePosition.x;

    bg.update(1 / 60, WORLD.WIDTH / 2 + 200, WORLD.HEIGHT / 2, 800, 600, 1);

    expect(bg.driftX).toBeGreaterThan(0);
    // The kick pushes it further negative than the pure-parallax term alone.
    const pureParallax = settled - 200 * PARALLAX.DUST;
    expect(bg.dustLayer.tilePosition.x).toBeLessThan(pureParallax);
  });

  it('holds the tactical grid at a constant world spacing across zoom levels', () => {
    const bg = new Background(null);

    bg.resize(1920, 1080, 1);
    expect(bg.gridLayer.tileScale.x).toBeCloseTo(GRID.SPACING / GRID.CELL_PX, 6);

    bg.resize(852, 393, 0.45);
    expect(bg.gridLayer.tileScale.x).toBeCloseTo((GRID.SPACING * 0.45) / GRID.CELL_PX, 6);
  });

  it('keeps the grid subliminal — visible, but at or below the design ceiling', () => {
    const bg = new Background(null);
    expect(GRID.ALPHA).toBeGreaterThan(0);
    expect(GRID.ALPHA).toBeLessThanOrEqual(0.05);
    expect(bg.gridLayer.alpha).toBe(GRID.ALPHA);
  });

  it('caps the dust layer to its design band', () => {
    const bg = new Background(null);
    expect(DUST_ALPHA).toBeGreaterThanOrEqual(0.12);
    expect(DUST_ALPHA).toBeLessThanOrEqual(0.2);
    expect(bg.dustLayer.alpha).toBe(DUST_ALPHA);
  });

  it('keeps the starfield layer at full object alpha — its dimming lives in the texture', () => {
    const bg = new Background(null);
    expect(bg.starLayer.alpha).toBe(1);
  });

  it('resizes the tiled layers to the new viewport', () => {
    const bg = new Background(null);
    bg.resize(1920, 1080);
    for (const layer of [bg.gridLayer, bg.starLayer, bg.dustLayer]) {
      expect(layer.width).toBe(1920);
      expect(layer.height).toBe(1080);
    }
  });
});

describe('starfield population (one flat, low-contrast band)', () => {
  it('keeps the star count within the 250-350 design band', () => {
    expect(STARFIELD.COUNT).toBeGreaterThanOrEqual(250);
    expect(STARFIELD.COUNT).toBeLessThanOrEqual(350);
  });

  it('makes the jittered grid exact — COUNT must be a perfect square', () => {
    const side = Math.sqrt(STARFIELD.COUNT);
    expect(Number.isInteger(side)).toBe(true);
  });

  it('keeps every star inside a single low-contrast radius/alpha band', () => {
    const [radiusMin, radiusMax] = STARFIELD.RADIUS;
    expect(radiusMin).toBeGreaterThanOrEqual(0.6);
    expect(radiusMax).toBeLessThanOrEqual(1.4);

    const [alphaMin, alphaMax] = STARFIELD.ALPHA;
    expect(alphaMin).toBeGreaterThanOrEqual(0.15);
    expect(alphaMax).toBeLessThanOrEqual(0.4);
  });

  it('mixes three colour temperatures in shares that sum to 1', () => {
    const { WHITE, CYAN, AMBER } = STARFIELD.COLOR_MIX;
    expect(WHITE + CYAN + AMBER).toBeCloseTo(1, 6);
    // Cool white dominant, cyan a minority, amber the smallest minority — per
    // the brief's 75/15/10 split.
    expect(WHITE).toBeGreaterThan(CYAN);
    expect(CYAN).toBeGreaterThan(AMBER);
  });

  it('bakes exactly the three named star colours into the texture', () => {
    // Captured the same way the nebula's colour-content tests are: intercept
    // fillStyle assignments on a canvas stub and check what was actually
    // painted, rather than trusting the generator's internals.
    const fills = new Set();
    const fakeCtx = {
      clearRect() {},
      beginPath() {},
      arc() {},
      fill() {},
      set fillStyle(v) {
        fills.add(v);
      },
    };
    const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx };
    const realCreateElement = globalThis.document.createElement;
    globalThis.document.createElement = () => fakeCanvas;
    try {
      makeStarfieldTexture();
    } finally {
      globalThis.document.createElement = realCreateElement;
    }

    const rgbUsed = (rgb) => [...fills].some((f) => typeof f === 'string' && f.includes(rgb));
    expect(rgbUsed('230, 240, 250')).toBe(true); // #e6f0fa
    expect(rgbUsed('136, 221, 255')).toBe(true); // #88ddff
    expect(rgbUsed('255, 210, 136')).toBe(true); // #ffd288
  });
});

/**
 * A canvas 2D context stub that additionally RECORDS enough of the transform
 * calls (`translate`/`rotate`/`scale`) to reconstruct each painted shape's
 * effective centre, angle and scale from outside `makeNebulaCanvas` — the
 * puffs and rifts are drawn via `ctx.translate/rotate/scale` followed by a
 * gradient centred on the local origin, so a stub that only watched
 * `createRadialGradient`'s own arguments (as earlier passes' stubs did) would
 * see `(0, 0, 0, 0, 0, r)` for every single shape and learn nothing about
 * where or how large it actually ended up on the canvas.
 *
 * @returns {{ctx: Object, shapes: Array<{cx: number, cy: number, angle: number, along: number, across: number, r: number, stops: Array}>}}
 */
function makeNebulaCtxStub() {
  const shapes = [];
  let pending = null;

  const ctx = {
    fillRect() {},
    set fillStyle(_v) {},
    save() {},
    restore() {
      pending = null;
    },
    translate(x, y) {
      pending = { cx: x, cy: y, angle: 0, along: 1, across: 1, stops: [] };
    },
    rotate(a) {
      if (pending) pending.angle = a;
    },
    scale(along, across) {
      if (pending) {
        pending.along = along;
        pending.across = across;
      }
    },
    createRadialGradient(x0, y0, r0, x1, y1, r) {
      if (pending) {
        pending.r = r;
        shapes.push(pending);
      }
      return {
        addColorStop: (offset, color) => pending?.stops.push({ offset, color }),
      };
    },
  };

  return { ctx, shapes };
}

/**
 * Runs `makeNebulaCanvas` against a stub, returning the puffs recorded (the
 * first NEBULA_PUFF.COUNT shapes) and the rifts (everything after).
 * @returns {{puffs: Array, rifts: Array}}
 */
function runNebulaCanvas() {
  const { ctx, shapes } = makeNebulaCtxStub();
  const fakeCanvas = { width: 0, height: 0, getContext: () => ctx };
  const realCreateElement = globalThis.document.createElement;
  globalThis.document.createElement = () => fakeCanvas;
  try {
    makeNebulaCanvas();
  } finally {
    globalThis.document.createElement = realCreateElement;
  }
  return {
    puffs: shapes.slice(0, NEBULA_PUFF.COUNT),
    rifts: shapes.slice(NEBULA_PUFF.COUNT),
  };
}

describe('the single nebula canvas', () => {
  it('fills the base with the specified deep-space colour', () => {
    const calls = [];
    const fakeCtx = {
      set fillStyle(v) {
        calls.push(v);
      },
      fillRect() {},
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      scale() {},
      createRadialGradient: () => ({ addColorStop: () => {} }),
    };
    const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx };
    const realCreateElement = globalThis.document.createElement;
    globalThis.document.createElement = () => fakeCanvas;
    try {
      makeNebulaCanvas();
    } finally {
      globalThis.document.createElement = realCreateElement;
    }

    // The FIRST fillStyle assignment paints the opaque base rect; every
    // later one belongs to a gradient (an object, not a string) and would
    // not match `toBe(NEBULA_BASE)` regardless.
    expect(calls[0]).toBe(NEBULA_BASE);
    expect(NEBULA_BASE).toBe('#020307');
  });

  it('names the three cosmic hues at their specified alphas, per the brief', () => {
    // Deep Cosmic Orchid/Violet core, Electric Indigo core, Bioluminescent
    // Cyan/Teal fringe — matching #32104d, #121b52, #093d42 and their alpha
    // bands exactly.
    expect(NEBULA_HUES.ORCHID).toEqual({ rgb: '50, 16, 77', alpha: [0.18, 0.24] });
    expect(NEBULA_HUES.INDIGO).toEqual({ rgb: '18, 27, 82', alpha: [0.16, 0.22] });
    expect(NEBULA_HUES.TEAL).toEqual({ rgb: '9, 61, 66', alpha: [0.1, 0.15] });
  });

  it('keeps every hue inside the brief\'s general 0.08-0.22 puff-alpha guardrail, or explains why not', () => {
    // ORCHID's upper bound (0.24) is the one deliberate exception: the brief
    // gives it a named, more specific band that runs slightly past the
    // general guardrail, and the more specific instruction wins. Every other
    // hue's band sits entirely inside the general range.
    for (const [name, hue] of Object.entries(NEBULA_HUES)) {
      const [min, max] = hue.alpha;
      expect(min, name).toBeGreaterThanOrEqual(0.08);
      if (name === 'ORCHID') {
        expect(max, name).toBeLessThanOrEqual(0.24);
      } else {
        expect(max, name).toBeLessThanOrEqual(0.22);
      }
    }
  });

  it('paints NEBULA_PUFF.COUNT puffs (30-50) at radii within NEBULA_PUFF.RADIUS (100-350px)', () => {
    expect(NEBULA_PUFF.COUNT).toBeGreaterThanOrEqual(30);
    expect(NEBULA_PUFF.COUNT).toBeLessThanOrEqual(50);

    const { puffs } = runNebulaCanvas();
    expect(puffs).toHaveLength(NEBULA_PUFF.COUNT);
    for (const p of puffs) {
      expect(p.r).toBeGreaterThanOrEqual(NEBULA_PUFF.RADIUS[0]);
      expect(p.r).toBeLessThanOrEqual(NEBULA_PUFF.RADIUS[1]);
    }
  });

  it('elongates puffs along their own filament-tangent direction, not uniformly', () => {
    const { puffs } = runNebulaCanvas();
    // Every puff scales MORE along its tangent than across it — that
    // asymmetry is what turns a scaled circle into a wisp rather than a
    // uniformly-larger circle.
    for (const p of puffs) {
      expect(p.along).toBeGreaterThan(p.across);
      expect(p.along).toBeGreaterThanOrEqual(NEBULA_PUFF.ALONG_SCALE[0]);
      expect(p.along).toBeLessThanOrEqual(NEBULA_PUFF.ALONG_SCALE[1]);
      expect(p.across).toBeGreaterThanOrEqual(NEBULA_PUFF.ACROSS_SCALE[0]);
      expect(p.across).toBeLessThanOrEqual(NEBULA_PUFF.ACROSS_SCALE[1]);
    }
  });

  it('places puffs along the curving backbone, spanning upper-left toward centre-right', () => {
    const { puffs } = runNebulaCanvas();
    const xs = puffs.map((p) => p.cx);
    const ys = puffs.map((p) => p.cy);

    // The path runs from ~8% to ~62% of the canvas width, and the puffs'
    // perpendicular jitter is narrow (NEBULA_PUFF.PERP_SPREAD) — so the whole
    // cluster should sit left-of-centre, not spread across the full canvas.
    expect(Math.min(...xs)).toBeLessThan(Math.max(...xs) * 0.5);
    expect(Math.max(...xs)).toBeLessThan(2048 * 0.85);

    // Sorted by x, y trends downward-right overall — the hallmark of the
    // upper-left to centre-right backbone rather than a scatter with no
    // overall direction.
    const sorted = puffs.map((p) => ({ x: p.cx, y: p.cy })).sort((a, b) => a.x - b.x);
    expect(sorted[0].y).toBeLessThan(sorted[sorted.length - 1].y);
  });

  it('keeps the puff cluster confined to a narrow corridor, not the full canvas', () => {
    /*
     * "70%+ void" is a claim about rendered PIXELS — falloff, overlap and how
     * often puffs actually reach their own worst-case extent all bear on it —
     * which this suite cannot render to confirm directly (no canvas rasteriser
     * here; see the module docstring). What it CAN confirm is the mechanism
     * the design relies on to make that true: a narrow perpendicular corridor
     * (not a wide scatter), a backbone that stops well short of the canvas's
     * own far corners, and puffs capped well below the canvas's own
     * dimensions. Each is a necessary condition for 70%+ void; none alone is
     * sufficient, which is why this checks all three rather than trying to
     * derive one pixel-accurate number from geometry alone.
     */
    // The corridor's PERP_SPREAD is a fraction of canvas height — comfortably
    // under half, so the cluster cannot fill the canvas top-to-bottom.
    expect(NEBULA_PUFF.PERP_SPREAD).toBeLessThan(0.3);

    // The backbone's own control points stay inside roughly the canvas's
    // left two-thirds and central band — real margin on the right and at
    // top/bottom remains untouched by the path itself.
    for (const p of Object.values(NEBULA_PATH)) {
      expect(p.x).toBeLessThan(0.7);
      expect(p.y).toBeLessThan(0.7);
    }

    // No single puff can be a large fraction of the canvas's own dimensions —
    // capped well under a third of the shorter canvas edge (1365px).
    const [, radiusMax] = NEBULA_PUFF.RADIUS;
    const [, alongMax] = NEBULA_PUFF.ALONG_SCALE;
    expect(radiusMax * alongMax).toBeLessThan(1365 / 2);
  });

  it('carves NEBULA_RIFT.COUNT dark absorption rifts (4-8) after the gas, in NEBULA_BASE', () => {
    expect(NEBULA_RIFT.COUNT).toBeGreaterThanOrEqual(4);
    expect(NEBULA_RIFT.COUNT).toBeLessThanOrEqual(8);

    const { rifts } = runNebulaCanvas();
    expect(rifts).toHaveLength(NEBULA_RIFT.COUNT);
    for (const rift of rifts) {
      expect(rift.r).toBeGreaterThanOrEqual(NEBULA_RIFT.RADIUS[0]);
      expect(rift.r).toBeLessThanOrEqual(NEBULA_RIFT.RADIUS[1]);
      // Rifts read as absorption, not fainter gas: their alpha sits well
      // above any puff's, matching the brief's 0.40-0.70 band.
      const coreAlpha = Number(rift.stops[0].color.slice(0, -1).split(',').pop().trim());
      expect(coreAlpha).toBeGreaterThanOrEqual(NEBULA_RIFT.ALPHA[0]);
      expect(coreAlpha).toBeLessThanOrEqual(NEBULA_RIFT.ALPHA[1]);
      // Painted in the void's own colour, not a gas hue — an absorption lane
      // has to be dark, not a differently-coloured cloud.
      expect(rift.stops[0].color).toContain(NEBULA_BASE_RGB);
    }
  });

  it('is not seamless at its own edges, and does not need to be', () => {
    // The nebula is mounted once as a plain Sprite (see the "mounts the
    // nebula as a plain Sprite" test) — there is no second tile for an edge
    // seam to be visible against, so makeNebulaCanvas has no drawWrapped-style
    // edge patching, unlike every OTHER generator in this file.
    expect(makeNebulaCanvas.toString()).not.toMatch(/drawWrapped/);
  });

  it('feathers every puff and rift with the brief\'s exact falloff: full, 40%, transparent', () => {
    const { puffs, rifts } = runNebulaCanvas();
    for (const shape of [...puffs, ...rifts]) {
      expect(shape.stops).toHaveLength(3);
      expect(shape.stops[0].offset).toBe(0);
      expect(shape.stops[1].offset).toBe(0.4);
      expect(shape.stops[2].offset).toBe(1);

      const alphaOf = (color) => Number(color.slice(0, -1).split(',').pop().trim());
      const coreAlpha = alphaOf(shape.stops[0].color);
      const midAlpha = alphaOf(shape.stops[1].color);
      expect(midAlpha).toBeCloseTo(coreAlpha * 0.4, 6);
      expect(alphaOf(shape.stops[2].color)).toBe(0);
    }
  });
});

describe('no silent asset override for the starfield (regression)', () => {
  /*
   * THE ACTUAL BUG BEHIND EVERY "still looks the same" REPORT.
   *
   * Background used to accept a `voidTile` option and use it as
   * `voidTile ?? makeStarfieldTexture()`. In production that option was fed
   * from `this.assets.get(ASSET_KEYS.BG_VOID)`, which resolved to a REAL,
   * successfully-loading 512x512 PNG — legacy nebula-cloud art, blue/purple
   * blobs included, left over from before this backdrop became procedural.
   * A real asset always wins a `??` fallback, so every rework of
   * makeStarfieldTexture() across several sessions was correct in isolation
   * and never once reached the screen: the starfield TilingSprite was always
   * tiling that old PNG instead. Removing the caustics shader (a real, but
   * different, bug) understandably did nothing for this.
   *
   * Background must not accept ANY option that lets an externally-supplied
   * texture silently replace the starfield. The nebula's drop-in bridge
   * (`nebulaImage`, tested below) is fine specifically because it goes
   * through `tryLoadNebulaImage`, a deliberate, reviewed, self-contained
   * probe — not an asset-manifest key that happens to resolve.
   */
  it('takes no option that can override the starfield texture', () => {
    const bg = new Background(null, {
      voidTile: { width: 4, height: 4, stub: 'legacy-bg-void' },
      starTile: { width: 4, height: 4, stub: 'legacy-bg-void' },
      stars: { width: 4, height: 4, stub: 'legacy-bg-void' },
    });
    expect(bg.textures.stars.stub).not.toBe('legacy-bg-void');
  });

  it('never ships a bg_void.png for a future voidTile option to accidentally find again', () => {
    expect(existsSync(resolve(process.cwd(), 'public/assets/ui/bg_void.png'))).toBe(false);
  });

  it('has no manifest entry that could feed a texture into the starfield unreviewed', () => {
    for (const entry of ASSET_MANIFEST) {
      expect(entry.url, entry.key).not.toMatch(/bg_void/);
    }
  });
});

describe('drop-in nebula image bridge', () => {
  it('never throws when neither candidate file exists', async () => {
    // The default, shipped state: no Assets global at all in this test
    // environment, which is a harsher case than a real 404.
    await expect(tryLoadNebulaImage()).resolves.toBeNull();
  });

  it('names both requested extensions, under assets/ui/', () => {
    expect(NEBULA_IMAGE_CANDIDATES).toHaveLength(2);
    expect(NEBULA_IMAGE_CANDIDATES[0]).toMatch(/assets\/ui\/bg_space\.webp$/);
    expect(NEBULA_IMAGE_CANDIDATES[1]).toMatch(/assets\/ui\/bg_space\.png$/);
  });

  it('is honoured by Background when supplied, bypassing the procedural canvas', () => {
    // Asserted against `bg.textures.nebula` — the value the constructor
    // actually chose between the drop-in image and the procedural fallback —
    // rather than `nebulaSprite.texture`, which Pixi's Sprite may coerce a
    // non-Texture stub through before this test can compare it.
    const stubTexture = { width: 4, height: 4, stub: true };
    const bg = new Background(null, { nebulaImage: stubTexture });
    expect(bg.textures.nebula).toBe(stubTexture);
  });

  it('falls back to the procedural canvas when no image is supplied', () => {
    const bg = new Background(null);
    expect(bg.textures.nebula).not.toBeNull();
    expect(bg.textures.nebula.stub).not.toBe(true);
  });
});

describe('the caustics mesh is eliminated, not merely dimmed', () => {
  /*
   * THE ACTUAL BUG THIS PASS FIXES. The caustics shader ran a full-screen
   * cellular/honeycomb sine-lattice EVERY FRAME, with a camera term scaled by
   * 0.00007 — so a thousand-world-unit flight moved it by a fraction of a
   * screen pixel. It read as static and "identical at every position"
   * regardless of what the nebula or starfield beneath it were doing, which is
   * why three separate passes at retuning THOSE layers never fixed the
   * reported repetition: the thing actually repeating was never one of them.
   */
  it('never constructs a fourth overlay child, in any configuration', () => {
    for (const opts of [{}, { nebulaImage: { width: 4, height: 4 } }]) {
      const bg = new Background(null, opts);
      expect(bg.container.children).toHaveLength(5);
    }
  });

  it('carries no caustics state on the instance at all', () => {
    const bg = new Background(null);
    expect(bg.causticsMesh).toBeUndefined();
    expect(bg.causticsUniforms).toBeUndefined();
    expect(bg.usingShader).toBeUndefined();
  });

  it('exposes no shader-toggle API to accidentally re-enable it', () => {
    const bg = new Background(null);
    expect(bg.setShaderEnabled).toBeUndefined();
    expect(bg.applyMode).toBeUndefined();
  });

  it('no longer imports caustics-shader.js', () => {
    /*
     * A source-level guard, since none of the runtime checks above can
     * distinguish "eliminated" from "imported and simply never wired up" —
     * both look identical from the outside once the toggle methods are gone.
     *
     * Checked against an actual `import ... from '...caustics-shader.js'`
     * statement specifically, not a bare textual mention — this file's own
     * module header legitimately DISCUSSES the removed shader by name (see
     * the FIFTH-PASS section), and that prose mentioning it is not a
     * regression.
     */
    const src = readFileSync(resolve(process.cwd(), 'src/render/background.js'), 'utf8');
    expect(src).not.toMatch(/import\s*\{[^}]*\}\s*from\s*['"].*caustics-shader\.js['"]/);
  });
});

describe('contrast and palette guarantees', () => {
  it('keeps the void base dark enough for the hero to stay the brightest thing', () => {
    const hex = `#${VOID_BASE.toString(16).padStart(6, '0')}`;
    expect(contrastRatio(THEME.hero.core, hex)).toBeGreaterThanOrEqual(MIN_HERO_CONTRAST);
  });

  it('preserves hero contrast ratio floor against background palette entries', () => {
    const heroCore = THEME.hero.core;
    for (const [key, color] of Object.entries(THEME.background)) {
      const contrast = contrastRatio(heroCore, color);
      expect(contrast, `Background ${key} (${color})`).toBeGreaterThanOrEqual(MIN_HERO_CONTRAST);
    }
  });

  it('creates every texture procedurally, with no asset file involved', () => {
    // The 0-KB rule. Each generator has to stand alone against an empty
    // /assets folder, which is also how CI runs.
    for (const make of [makeNebulaCanvas, makeGridTexture, makeStarfieldTexture, makeDustTexture, makeVoidTileTexture]) {
      expect(make(), make.name).toBeDefined();
    }
  });
});
