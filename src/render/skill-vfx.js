/**
 * Active-skill visual effects.
 *
 * READS THE SIMULATION, NEVER WRITES IT.
 * Everything drawn here is derived from `sim.activeSkills` — the anomaly's
 * position, the blade angles, how much of the active window is left. Nothing
 * in this file decides anything: if the singularity is in the wrong place the
 * bug is in src/core/active-skills.js, and this module will faithfully draw it
 * in the wrong place. That is the point of the split, and it is why retuning
 * any of this is a zero-risk change to game state.
 *
 * IMMEDIATE MODE FOR SHAPES, POOLS FOR PARTICLES.
 * The per-frame geometry (accretion ring, vortex, blades) is cleared and
 * redrawn into two Graphics objects — a retained scene graph of a hundred
 * short-lived shapes would cost more to keep in sync than the redraw costs to
 * issue. What IS pooled is the particle RECORDS: sparks, shockwaves, streaks
 * and ghosts are plain objects recycled through free lists, so a skill fired
 * every nine seconds for a twenty-minute run allocates nothing after the first
 * cast. The two ghost SPRITES are allocated once for the module's lifetime and
 * parked invisible between blinks.
 *
 * Bursts and sparks are EVENTS, not state. They are spawned from bus events
 * rather than polled off `activeTimer`, because polling cannot tell a fresh
 * cast from the second frame of an old one without storing last frame's value
 * — and an instant skill has no frame to be caught on at all.
 */

import { Container, Graphics, Sprite } from 'pixi.js';
import { PIXI_TINT } from './sprites.js';
import { ACTIVE_SKILL_IDS } from '../data/active-skills.js';

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

/**
 * Effect colours, kept here rather than in the theme because they belong to
 * two specific skills rather than to the game's general palette.
 */
const VFX = {
  /** Event horizon. Not #000: pure black reads as a hole in the canvas. */
  voidCore: 0x050508,
  /** Accretion disc, electric violet. */
  accretionA: 0x8c7ae6,
  /** Accretion disc, neon cyan. */
  accretionB: 0x00f3ff,
  /** The vortex floor the influence radius is painted with. */
  vortexDeep: 0x140b2e,
  vortexRim: 0x2a1b5e,
  /** Phase Shift after-image, leading copy. */
  ghostCyan: 0x00f3ff,
  /** Phase Shift after-image, trailing copy — the chromatic split. */
  ghostMagenta: 0xe056fd,
};

/** Seconds a cast ripple takes to expand and fade out. */
const BURST_SEC = 0.45;

/* ---- Singularity ---- */

/** Seconds between the anomaly's outward shock rings. */
const SHOCK_INTERVAL = 0.42;
/** Seconds a shock ring takes to travel the influence radius. */
const SHOCK_SEC = 0.85;
/** Seconds between inward speed-line emissions. */
const SPARK_INTERVAL = 0.035;
/** Sparks emitted per emission. */
const SPARKS_PER_EMIT = 2;

/* ---- Phase Shift ---- */

/** Seconds the origin implosion takes to collapse inward. */
const IMPLODE_SEC = 0.15;
/** Seconds the after-images take to fade out. */
const GHOST_SEC = 0.35;
/** Seconds the arrival flash lasts. */
const FLASH_SEC = 0.08;
/** Seconds the jump streak between origin and destination lingers. */
const TEAR_SEC = 0.22;

/**
 * A free-list of plain records.
 *
 * Particles here are bounded by emission rate against a cooldown, so this is
 * not about capping memory — it is about not handing the collector a few
 * hundred short-lived literals per cast, which at a 60Hz fixed step is exactly
 * the allocation pattern that produces a visible hitch mid-fight.
 */
class RecordPool {
  /** @param {() => Object} factory */
  constructor(factory) {
    this.factory = factory;
    this.free = [];
    this.live = [];
  }

  /** @returns {Object} A record, already pushed onto `live`. */
  acquire() {
    const record = this.free.pop() ?? this.factory();
    this.live.push(record);
    return record;
  }

  /**
   * Move expired records back to the free list.
   * Iterates backwards so a swap-remove cannot skip the next element.
   */
  sweep() {
    for (let i = this.live.length - 1; i >= 0; i--) {
      if (this.live[i].life > 0) continue;
      const last = this.live.pop();
      if (i < this.live.length) this.live[i] = last;
      this.free.push(last);
    }
  }

  /** Retire everything, e.g. on a run reset. */
  clear() {
    for (const record of this.live) this.free.push(record);
    this.live.length = 0;
  }
}

export class SkillVfx {
  /**
   * @param {Object} sim - The Simulation to read from
   * @param {Object} [options]
   * @param {() => import('pixi.js').Sprite|null} [options.getHeroSprite] - Lazy
   *   handle on the Drifter's sprite. Lazy because the renderer builds this
   *   module before it builds the player, and the after-images need the hull's
   *   live texture, scale and rotation at the instant of the blink.
   */
  constructor(sim, { getHeroSprite = () => null } = {}) {
    this.sim = sim;
    this.getHeroSprite = getHeroSprite;
    this.time = 0;

    this.container = new Container();
    /** Under the ship: vortex, anomaly, plume, aura. */
    this.belowGfx = new Graphics();
    /** The after-image sprites sit between the two Graphics passes. */
    this.ghostLayer = new Container();
    /** Over the ship: blades, ripples, tears, flashes. */
    this.aboveGfx = new Graphics();
    this.container.addChild(this.belowGfx, this.ghostLayer, this.aboveGfx);

    /*
     * Two after-image sprites, allocated once and parked invisible. A blink is
     * over in 0.35s and the cooldown is 9s, so creating and destroying these
     * per cast would be two texture-bearing display objects churned every nine
     * seconds for the life of the run, to save nothing between blinks.
     */
    this.ghostSprites = [this.makeGhostSprite(), this.makeGhostSprite()];
    /**
     * Per-sprite fade state; parallel to ghostSprites. `baseScale` is captured
     * per blink so the dissipation grow-out is computed FROM it rather than
     * applied to the sprite cumulatively — compounding the sprite's own scale
     * each frame would leave it permanently larger after every jump.
     */
    this.ghostState = [
      { life: 0, tint: VFX.ghostCyan, peak: 0.6, baseScaleX: 1, baseScaleY: 1 },
      { life: 0, tint: VFX.ghostMagenta, peak: 0.4, baseScaleX: 1, baseScaleY: 1 },
    ];

    this.bursts = new RecordPool(() => ({
      x: 0, y: 0, radius: 0, color: 0, width: 0, life: 0, maxLife: BURST_SEC,
    }));
    /** Outward refraction rings from the anomaly. */
    this.shocks = new RecordPool(() => ({ x: 0, y: 0, radius: 0, life: 0 }));
    /** Inward comic speed lines spiralling into the well. */
    this.sparks = new RecordPool(() => ({
      angle: 0, dist: 0, spin: 0, life: 0, maxLife: 1, hue: 0,
    }));
    /** Origin-implosion sparks, travelling the other way. */
    this.implodes = new RecordPool(() => ({ x: 0, y: 0, angle: 0, dist: 0, life: 0 }));
    /** The jump streak and its parallel action lines. */
    this.tears = new RecordPool(() => ({
      x: 0, y: 0, toX: 0, toY: 0, life: 0, seed: 0,
    }));
    /** Arrival flash. */
    this.flashes = new RecordPool(() => ({ x: 0, y: 0, life: 0 }));

    /** Afterburner plume samples, newest last. */
    this.plume = [];
    /** Clock for the anomaly's periodic emissions. */
    this.shockTimer = 0;
    this.sparkTimer = 0;

    this.bindEvents();
  }

  /** @returns {import('pixi.js').Sprite} */
  makeGhostSprite() {
    const sprite = new Sprite();
    sprite.anchor.set(0.5);
    sprite.visible = false;
    // Additive would blow out to white over the bright arena; normal blending
    // keeps the chromatic split between the two copies readable.
    this.ghostLayer.addChild(sprite);
    return sprite;
  }

  bindEvents() {
    const bus = this.sim.bus;

    bus.on('skill:emp', ({ x, y, radius }) => {
      this.addBurst(x, y, radius, PIXI_TINT.graviton, 8);
      this.addBurst(x, y, radius * 0.55, 0xffffff, 4);
    });

    bus.on('skill:salvo', ({ x, y }) => this.addBurst(x, y, 90, PIXI_TINT.hazard, 4));
    bus.on('skill:overcharge', ({ x, y }) => this.addBurst(x, y, 70, PIXI_TINT.hazardRim, 5));
    bus.on('skill:point_defense', ({ x, y }) => this.addBurst(x, y, 64, PIXI_TINT.aegis, 4));
    bus.on('skill:intercept', ({ x, y }) => this.addBurst(x, y, 22, PIXI_TINT.aegis, 2));

    bus.on('skill:afterburner', ({ x, y }) => {
      this.plume.length = 0;
      this.addBurst(x, y, 54, PIXI_TINT.hazard, 3);
    });

    bus.on('skill:singularity', ({ x, y, radius }) => {
      // Two hard rings on the plant, so the well arrives with a bang rather
      // than fading up out of nothing.
      this.addBurst(x, y, radius, VFX.accretionA, 9);
      this.addBurst(x, y, radius * 0.5, VFX.accretionB, 5);
      this.shockTimer = 0;
      this.sparkTimer = 0;
    });

    bus.on('skill:phase_shift', (data) => this.onBlink(data));

    // A restart must not leave the previous run's effects on screen.
    bus.on('state:reset', () => this.reset());
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} radius - Final radius the ring expands to
   * @param {number} color
   * @param {number} width - Stroke width at full strength
   */
  addBurst(x, y, radius, color, width) {
    const b = this.bursts.acquire();
    b.x = x;
    b.y = y;
    b.radius = radius;
    b.color = color;
    b.width = width;
    b.life = BURST_SEC;
    b.maxLife = BURST_SEC;
  }

  reset() {
    this.bursts.clear();
    this.shocks.clear();
    this.sparks.clear();
    this.implodes.clear();
    this.tears.clear();
    this.flashes.clear();
    this.plume.length = 0;
    for (const state of this.ghostState) state.life = 0;
    for (const sprite of this.ghostSprites) sprite.visible = false;
  }

  /**
   * Advance timers and redraw.
   * @param {number} dt
   */
  update(dt) {
    this.time += dt;

    this.ageRecords(dt);
    this.trackPlume(dt);
    this.stepAnomaly(dt);
    this.stepGhosts(dt);

    this.belowGfx.clear();
    this.aboveGfx.clear();

    this.drawPlume();
    this.drawSingularity();
    this.drawOverchargeAura();
    this.drawBlades();
    this.drawTears();
    this.drawImplosion();
    this.drawFlashes();
    this.drawBursts();
  }

  /** Tick every pool's lifetimes and retire what expired. */
  ageRecords(dt) {
    for (const pool of [
      this.bursts, this.shocks, this.sparks, this.implodes, this.tears, this.flashes,
    ]) {
      for (const record of pool.live) record.life -= dt;
      pool.sweep();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Singularity Anchor                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Emit the anomaly's shock rings and inward speed lines.
   *
   * Emission is on its own clock rather than derived from `anchor.life`, so
   * the cadence is constant regardless of how long the skill's duration is
   * tuned to — a longer well should throw MORE rings, not slower ones.
   */
  stepAnomaly(dt) {
    const anchor = this.sim.activeSkills.anchor;
    if (!anchor.active) return;

    this.shockTimer -= dt;
    if (this.shockTimer <= 0) {
      this.shockTimer = SHOCK_INTERVAL;
      const shock = this.shocks.acquire();
      shock.x = anchor.x;
      shock.y = anchor.y;
      shock.radius = anchor.radius;
      shock.life = SHOCK_SEC;
    }

    this.sparkTimer -= dt;
    if (this.sparkTimer <= 0) {
      this.sparkTimer = SPARK_INTERVAL;
      for (let i = 0; i < SPARKS_PER_EMIT; i++) {
        const spark = this.sparks.acquire();
        spark.angle = Math.random() * Math.PI * 2;
        // Spawn on the rim, with a little scatter so the intake does not read
        // as a perfect circle of identical dashes.
        spark.dist = anchor.radius * (0.88 + Math.random() * 0.16);
        spark.spin = 2.6 + Math.random() * 2.2;
        spark.maxLife = 0.55 + Math.random() * 0.22;
        spark.life = spark.maxLife;
        spark.hue = Math.random() < 0.5 ? VFX.accretionA : VFX.accretionB;
      }
    }

    // Sparks accelerate as they fall, which is the entire read of "this thing
    // has mass". Linear travel looks like a conveyor belt.
    for (const spark of this.sparks.live) {
      const t = 1 - spark.life / spark.maxLife;
      const pull = 1 + t * t * 5;
      spark.dist -= anchor.radius * 0.55 * pull * dt;
      spark.angle += spark.spin * dt * (0.4 + t * 1.8);
      if (spark.dist <= 2) spark.life = 0;
    }
  }

  drawSingularity() {
    const anchor = this.sim.activeSkills.anchor;
    if (!anchor.active) {
      // Shock rings outlive the anomaly by design — the last one should finish
      // travelling rather than being cut off the instant the well closes.
      this.drawShocks();
      return;
    }

    const g = this.belowGfx;
    const { x, y, radius } = anchor;
    const t = Math.max(0, anchor.life / anchor.maxLife);
    // Opens fast, closes slow: the capture should read as the well "biting".
    const open = Math.min(1, (1 - t) * 7);
    const R = radius * open;

    this.drawVortexFloor(g, x, y, R, t);
    this.drawShocks();
    this.drawSpeedLines(g, x, y);
    this.drawAccretion(g, x, y, R, t);
    this.drawEventHorizon(g, x, y, R);
  }

  /**
   * The influence area, as a swirling gradient rather than an outline.
   *
   * Built from concentric bands instead of a real radial gradient: Pixi's
   * gradient fills mean a texture upload per parameter change, and this one
   * changes every frame as the well opens. Eight bands is indistinguishable
   * from a smooth ramp at this alpha and costs eight circles.
   */
  drawVortexFloor(g, x, y, R, t) {
    const BANDS = 8;
    for (let i = BANDS; i >= 1; i--) {
      const f = i / BANDS;
      g.circle(x, y, R * f);
      g.fill({
        // Darkest at the core: the well should look like it is swallowing the
        // starfield, not like a lamp sitting on top of it.
        color: i > BANDS * 0.6 ? VFX.vortexRim : VFX.vortexDeep,
        alpha: (0.1 + (1 - f) * 0.42) * (0.35 + t * 0.65),
      });
    }

    // Spiral arms. Three, counter-rotating in the middle so the group cannot
    // read as one rigid wheel.
    for (let arm = 0; arm < 3; arm++) {
      const dir = arm === 1 ? -1 : 1;
      const base = this.time * 1.25 * dir + (arm / 3) * Math.PI * 2;
      const STEPS = 14;

      for (let s = 0; s < STEPS; s++) {
        const f0 = s / STEPS;
        const f1 = (s + 1) / STEPS;
        // Logarithmic sweep: the arm winds tighter as it nears the core, which
        // is what makes the floor read as rotating INTO the hole.
        const a0 = base + Math.pow(1 - f0, 2) * 5.2;
        const a1 = base + Math.pow(1 - f1, 2) * 5.2;
        const r0 = R * (0.16 + f0 * 0.84);
        const r1 = R * (0.16 + f1 * 0.84);

        g.moveTo(x + Math.cos(a0) * r0, y + Math.sin(a0) * r0);
        g.lineTo(x + Math.cos(a1) * r1, y + Math.sin(a1) * r1);
        g.stroke({
          color: VFX.accretionA,
          width: 2 + (1 - f0) * 3,
          alpha: (0.05 + (1 - f0) * 0.22) * t,
        });
      }
    }
  }

  /** Outward refraction rings — the lensing tell. */
  drawShocks() {
    const g = this.belowGfx;

    for (const shock of this.shocks.live) {
      const p = 1 - shock.life / SHOCK_SEC;
      // Ease-out: fastest as it leaves the well, which is what sells it as a
      // pressure wave rather than a growing circle.
      const eased = 1 - Math.pow(1 - p, 2.2);
      const r = shock.radius * (0.18 + eased * 1.15);
      const fade = 1 - p;

      g.circle(shock.x, shock.y, r);
      g.stroke({ color: VFX.accretionB, width: 7 * fade, alpha: 0.42 * fade });
      g.circle(shock.x, shock.y, r * 0.965);
      g.stroke({ color: 0xffffff, width: 2.4 * fade, alpha: 0.3 * fade });
    }
  }

  /**
   * Inward comic speed lines.
   *
   * Drawn as tapered quads, not strokes: a stroke has one width along its
   * whole length, and a dash with a blunt leading end reads as a floating
   * object rather than as something being drawn in at speed. The taper — sharp
   * at the inner tip, wide at the trailing end — is the whole effect.
   */
  drawSpeedLines(g, cx, cy) {
    for (const spark of this.sparks.live) {
      const t = 1 - spark.life / spark.maxLife;
      const fade = Math.min(1, spark.life / 0.18);
      // Longer the faster it falls, like a motion-blurred streak.
      const len = 18 + t * 46;
      const tail = Math.min(spark.dist + len, spark.dist * 1.9 + len);
      const width = 1.4 + t * 3.6;

      const tipA = spark.angle;
      // The tail lags behind the tip on the spiral, so the streak curves with
      // the intake instead of pointing straight at the centre.
      const tailA = spark.angle - spark.spin * 0.085 * (0.4 + t * 1.8);

      const tipX = cx + Math.cos(tipA) * spark.dist;
      const tipY = cy + Math.sin(tipA) * spark.dist;
      const tailX = cx + Math.cos(tailA) * tail;
      const tailY = cy + Math.sin(tailA) * tail;

      const px = -(tailY - tipY);
      const py = tailX - tipX;
      const plen = Math.hypot(px, py) || 1;
      const ox = (px / plen) * width * 0.5;
      const oy = (py / plen) * width * 0.5;

      g.poly([tipX, tipY, tailX + ox, tailY + oy, tailX - ox, tailY - oy]);
      g.fill({ color: spark.hue, alpha: 0.85 * fade });
    }
  }

  /** The accretion disc: thick, fast, and the brightest thing on screen. */
  drawAccretion(g, x, y, R, t) {
    const inner = R * 0.17;
    const spin = this.time * 5.4;

    // Outer glow, built from three widening strokes at falling alpha. Pixi has
    // no per-shape blur, and a filter here would cost a render target for what
    // three strokes approximate closely enough at this size.
    for (let i = 3; i >= 1; i--) {
      g.circle(x, y, inner * 1.55);
      g.stroke({
        color: i === 1 ? 0xffffff : VFX.accretionB,
        width: 4 + i * 5,
        alpha: (0.08 + (4 - i) * 0.07) * t,
      });
    }

    // Two counter-spinning bands of arc segments, violet against cyan.
    for (let band = 0; band < 2; band++) {
      const color = band === 0 ? VFX.accretionA : VFX.accretionB;
      const dir = band === 0 ? 1 : -1;
      const bandR = inner * (1.32 + band * 0.42);
      const SEGMENTS = 6;

      for (let i = 0; i < SEGMENTS; i++) {
        const a = spin * dir + (i / SEGMENTS) * Math.PI * 2;
        // Uneven arc lengths keep the band from strobing into a solid ring at
        // speed, which is what a set of identical segments does.
        const sweep = 0.42 + (i % 3) * 0.12;
        /*
         * moveTo BEFORE the arc, every time.
         *
         * `arc` follows the Canvas rule: with an open subpath it draws a line
         * from the current point to the arc's start. Without this the first
         * segment of each band was joined to wherever the path happened to end
         * last, which drew a violet spar clean across the screen through the
         * middle of the anomaly.
         */
        g.moveTo(x + Math.cos(a) * bandR, y + Math.sin(a) * bandR);
        g.arc(x, y, bandR, a, a + sweep);
        g.stroke({ color, width: 7 - band * 2, alpha: 0.95 * t });
      }
    }

    // Hot inner lip, right on the horizon.
    g.circle(x, y, inner * 1.12);
    g.stroke({ color: 0xffffff, width: 2.5, alpha: 0.9 * t });
  }

  /**
   * The event horizon: a hole, not a disc.
   *
   * Drawn last of the below-ship pass so it punches through the vortex, the
   * arms and the inner accretion glow — everything the well is supposed to be
   * swallowing. The scale pulse is the gravitational "breath" the brief asks
   * for, at a rate slow enough to read as mass rather than as a flicker.
   */
  drawEventHorizon(g, x, y, R) {
    const pulse = 1 + Math.sin(this.time * 3.1) * 0.1;
    const core = R * 0.17 * pulse;

    g.circle(x, y, core);
    g.fill({ color: VFX.voidCore, alpha: 1 });
    // A single dark violet rim keeps the black from reading as a hole in the
    // canvas itself rather than as an object in the scene.
    g.circle(x, y, core);
    g.stroke({ color: VFX.accretionA, width: 1.5, alpha: 0.55 });
  }

  /* ---------------------------------------------------------------- */
  /* Phase Shift                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Stage the whole blink: implosion at the origin, tear along the path,
   * flash at the destination, two after-images between.
   *
   * @param {{fromX: number, fromY: number, toX: number, toY: number}} data
   */
  onBlink({ fromX, fromY, toX, toY }) {
    // Origin implosion — sparks converging inward, plus a mini EMP ring.
    for (let i = 0; i < 14; i++) {
      const spark = this.implodes.acquire();
      spark.x = fromX;
      spark.y = fromY;
      spark.angle = (i / 14) * Math.PI * 2 + Math.random() * 0.3;
      spark.dist = 34 + Math.random() * 26;
      spark.life = IMPLODE_SEC;
    }
    this.addBurst(fromX, fromY, 62, VFX.ghostMagenta, 5);

    const tear = this.tears.acquire();
    tear.x = fromX;
    tear.y = fromY;
    tear.toX = toX;
    tear.toY = toY;
    tear.life = TEAR_SEC;
    // Frozen per cast so the bolt's kinks do not re-randomise every frame,
    // which would read as static rather than as one torn seam in space.
    tear.seed = Math.random() * 1000;

    const flash = this.flashes.acquire();
    flash.x = toX;
    flash.y = toY;
    flash.life = FLASH_SEC;

    // After-images, staged along the path: cyan just behind the arrival,
    // magenta further back, which is what produces the chromatic split.
    const hero = this.getHeroSprite();
    const placements = [0.62, 0.3];
    for (let i = 0; i < this.ghostSprites.length; i++) {
      const sprite = this.ghostSprites[i];
      const state = this.ghostState[i];
      const f = placements[i];

      // No hero sprite means no hull to echo — the tear and the flash still
      // carry the blink on their own. (Headless tests construct this module
      // without a renderer, and that must not produce two empty rectangles.)
      if (!hero) {
        state.life = 0;
        sprite.visible = false;
        continue;
      }

      sprite.x = fromX + (toX - fromX) * f;
      sprite.y = fromY + (toY - fromY) * f;
      // Snapshot the hull as it looks RIGHT NOW: cosmetic tint aside, the
      // ghost has to be the same silhouette at the same scale and heading,
      // or it reads as a different ship rather than as where this one was.
      sprite.texture = hero.texture;
      sprite.rotation = hero.rotation;
      state.baseScaleX = hero.scale.x;
      state.baseScaleY = hero.scale.y;
      sprite.scale.set(state.baseScaleX, state.baseScaleY);
      sprite.tint = state.tint;
      sprite.alpha = state.peak;
      sprite.visible = true;
      state.life = GHOST_SEC;
    }
  }

  /** Fade the after-images out; they are sprites, not immediate-mode shapes. */
  stepGhosts(dt) {
    for (let i = 0; i < this.ghostSprites.length; i++) {
      const state = this.ghostState[i];
      if (state.life <= 0) continue;

      state.life -= dt;
      const sprite = this.ghostSprites[i];
      if (state.life <= 0) {
        state.life = 0;
        sprite.visible = false;
        sprite.alpha = 0;
        continue;
      }

      const t = state.life / GHOST_SEC;
      // Cubic falloff: most of the visible life is spent near full strength,
      // so the pair still register at a 0.35s window.
      sprite.alpha = state.peak * t * t * t;
      // Swell slightly as they fade, so the pair read as dissipating rather
      // than as two stamps sitting in space. Derived from the captured base,
      // never from the sprite's current scale.
      const swell = 1 + (1 - t) * 0.22;
      sprite.scale.set(state.baseScaleX * swell, state.baseScaleY * swell);
    }
  }

  /** Origin implosion: sparks racing inward to a point. */
  drawImplosion() {
    const g = this.aboveGfx;

    for (const spark of this.implodes.live) {
      const t = 1 - spark.life / IMPLODE_SEC;
      // Ease-IN, the mirror of every other effect here: an implosion should
      // accelerate into the point, not coast into it.
      const eased = t * t;
      const d = spark.dist * (1 - eased);
      const len = 12 * (1 - t) + 4;

      const x0 = spark.x + Math.cos(spark.angle) * d;
      const y0 = spark.y + Math.sin(spark.angle) * d;
      const x1 = spark.x + Math.cos(spark.angle) * (d + len);
      const y1 = spark.y + Math.sin(spark.angle) * (d + len);

      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke({ color: VFX.ghostCyan, width: 3 * (1 - t) + 1, alpha: 1 - t * 0.5 });
    }
  }

  /**
   * The quantum tear: a torn seam between departure and arrival.
   *
   * A jagged bolt rather than a straight line, plus two parallel action lines.
   * The jump is instantaneous, so without something connecting the two points
   * the ship simply vanishes and reappears with no indication of which way it
   * went — which is the single most important thing this effect has to say.
   */
  drawTears() {
    const g = this.aboveGfx;

    for (const tear of this.tears.live) {
      const t = tear.life / TEAR_SEC;
      const dx = tear.toX - tear.x;
      const dy = tear.toY - tear.y;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = dx / dist;
      const ny = dy / dist;
      const px = -ny;
      const py = nx;

      const STEPS = 9;
      // Two passes: a wide soft glow under a hard white core, which is the
      // cheapest way to make a 1px-accurate bolt read as high energy.
      for (const pass of [
        { color: VFX.ghostMagenta, width: 11 * t, alpha: 0.5 * t },
        { color: VFX.ghostCyan, width: 5 * t, alpha: 0.85 * t },
        { color: 0xffffff, width: 2 * t, alpha: 0.95 * t },
      ]) {
        for (let s = 0; s < STEPS; s++) {
          const f0 = s / STEPS;
          const f1 = (s + 1) / STEPS;
          // Deterministic pseudo-noise off the frozen seed: same kinks every
          // frame of this tear's life, different kinks per cast.
          const j0 = Math.sin(tear.seed + s * 2.7) * 13 * Math.sin(f0 * Math.PI);
          const j1 = Math.sin(tear.seed + (s + 1) * 2.7) * 13 * Math.sin(f1 * Math.PI);

          g.moveTo(tear.x + nx * dist * f0 + px * j0, tear.y + ny * dist * f0 + py * j0);
          g.lineTo(tear.x + nx * dist * f1 + px * j1, tear.y + ny * dist * f1 + py * j1);
          g.stroke(pass);
        }
      }

      // Comic action lines, flanking the bolt and trailing the arrival.
      for (const side of [-1, 1]) {
        for (let i = 0; i < 2; i++) {
          const off = (16 + i * 13) * side;
          const start = 0.12 + i * 0.14;
          g.moveTo(tear.x + nx * dist * start + px * off, tear.y + ny * dist * start + py * off);
          g.lineTo(tear.x + nx * dist * 0.94 + px * off, tear.y + ny * dist * 0.94 + py * off);
          g.stroke({ color: VFX.ghostCyan, width: 2.5 * t, alpha: 0.4 * t });
        }
      }
    }
  }

  /** Arrival flash — a hard white pop on the landing frame. */
  drawFlashes() {
    const g = this.aboveGfx;

    for (const flash of this.flashes.live) {
      const t = flash.life / FLASH_SEC;
      g.circle(flash.x, flash.y, 26 + (1 - t) * 26);
      g.fill({ color: 0xffffff, alpha: 0.75 * t });
      g.circle(flash.x, flash.y, 40 + (1 - t) * 40);
      g.stroke({ color: VFX.ghostCyan, width: 4 * t, alpha: 0.8 * t });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Afterburner                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Sample the hull's position while the burn is running.
   *
   * Sampled per frame rather than per fixed distance: the plume should be
   * dense when the ship is slow and stretched when it is fast, which is the
   * whole visual tell that the skill is doing something to the ship's speed.
   *
   * @param {number} dt
   */
  trackPlume(dt) {
    const skills = this.sim.activeSkills;
    const burning = skills.isActive && skills.skillId === ACTIVE_SKILL_IDS.AFTERBURNER;

    if (burning) {
      const player = this.sim.state.player;
      this.plume.push({ x: player.x, y: player.y, life: 0.42 });
    }

    for (let i = this.plume.length - 1; i >= 0; i--) {
      this.plume[i].life -= dt;
      if (this.plume[i].life <= 0) this.plume.splice(i, 1);
    }
  }

  drawPlume() {
    if (this.plume.length < 2) return;
    const g = this.belowGfx;

    for (let i = 0; i < this.plume.length; i++) {
      const node = this.plume[i];
      const t = node.life / 0.42;
      // Along the trail, not just over time: the head is the hot core and the
      // tail is the cooled edge, which is what makes it read as a plume rather
      // than a row of fading dots.
      const along = i / this.plume.length;
      const radius = 4 + along * 9;

      g.circle(node.x, node.y, radius);
      g.fill({ color: PIXI_TINT.hazard, alpha: t * 0.34 * along });
      g.circle(node.x, node.y, radius * 0.45);
      g.fill({ color: PIXI_TINT.hazardRim, alpha: t * 0.6 * along });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Overcharge Core                                                   */
  /* ---------------------------------------------------------------- */

  drawOverchargeAura() {
    const skills = this.sim.activeSkills;
    if (!skills.isActive || skills.skillId !== ACTIVE_SKILL_IDS.OVERCHARGE_CORE) return;

    const g = this.belowGfx;
    const player = this.sim.state.player;
    const pulse = 0.5 + Math.sin(this.time * 18) * 0.5;

    g.circle(player.x, player.y, 34 + pulse * 6);
    g.stroke({ color: PIXI_TINT.hazardRim, width: 2, alpha: 0.35 + pulse * 0.3 });

    // Static discharge: short radial ticks at an irregular rate, so the ring
    // reads as electrically loaded rather than as a breathing halo.
    for (let i = 0; i < 8; i++) {
      const a = this.time * 5 + (i / 8) * Math.PI * 2;
      const inner = 30;
      const outer = 30 + 10 * (0.4 + Math.sin(this.time * 22 + i * 2.1) * 0.6);
      g.moveTo(player.x + Math.cos(a) * inner, player.y + Math.sin(a) * inner);
      g.lineTo(player.x + Math.cos(a) * outer, player.y + Math.sin(a) * outer);
      g.stroke({ color: PIXI_TINT.hazard, width: 1.5, alpha: 0.55 });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Point-Defense Overdrive                                           */
  /* ---------------------------------------------------------------- */

  drawBlades() {
    const blades = this.sim.activeSkills.blades;
    if (blades.length === 0) return;

    const g = this.aboveGfx;
    const player = this.sim.state.player;

    // The bubble the interception radius actually covers, so the defensive
    // half of the skill is something the player can see the edge of.
    g.circle(player.x, player.y, 64);
    g.stroke({ color: PIXI_TINT.aegis, width: 1, alpha: 0.22 });

    for (const blade of blades) {
      const angle = Math.atan2(blade.y - player.y, blade.x - player.x);
      const len = blade.radius * 2.1;

      // Drawn as a swept bar along the tangent, not as a disc: at 11 rad/s a
      // circle reads as a stationary dot, and the smear is the speed cue.
      const tx = -Math.sin(angle);
      const ty = Math.cos(angle);
      g.moveTo(blade.x - tx * len * 0.5, blade.y - ty * len * 0.5);
      g.lineTo(blade.x + tx * len * 0.5, blade.y + ty * len * 0.5);
      g.stroke({ color: PIXI_TINT.aegis, width: 5, alpha: 0.9 });

      g.circle(blade.x, blade.y, blade.radius * 0.5);
      g.fill({ color: 0xffffff, alpha: 0.8 });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Cast ripples                                                      */
  /* ---------------------------------------------------------------- */

  drawBursts() {
    const g = this.aboveGfx;

    for (const burst of this.bursts.live) {
      const t = 1 - burst.life / burst.maxLife;
      // Ease-out: fastest at the instant of the cast, which is what ties the
      // ring to the key press rather than to the seconds after it.
      const eased = 1 - Math.pow(1 - t, 3);
      const radius = burst.radius * eased;

      g.circle(burst.x, burst.y, radius);
      g.stroke({ color: burst.color, width: burst.width * (1 - t), alpha: 1 - t });
    }
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}
