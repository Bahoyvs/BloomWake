/**
 * PixiJS sprite renderer.
 *
 * Entities are sprites; only VFX with no authored art (AoE rings, the lance,
 * satellites, telegraph, arena edge) remain vector, drawn as PIXI.Graphics.
 *
 * LAYERING
 * Z_ORDER from theme.js is realised as real Containers added in order, so the
 * Visual Soup rule — nothing paints above the Drifter — is now structural
 * rather than a convention about call order. Adding a draw call in the wrong
 * place cannot break it; you would have to add it to the wrong container.
 *
 * PERFORMANCE
 * Sprites are pooled per texture key and parked with `visible = false` instead
 * of being removed, so a wave wipe costs no display-list churn. Every swarm
 * hull comes off ONE atlas and differs only by tint, so Pixi batches all 200 of
 * them into a single draw call — which is what makes the Chitin Swarm's density
 * affordable in the first place.
 *
 * THE BOSS IS THE ONE EXCEPTION. The Dreadnought Station is a five-sprite
 * composite (see src/render/sprite-factory.js) rather than a single pooled
 * Sprite, so every path that touches a view — acquire, park, tint, scale —
 * has to handle both shapes. That is the cost of the boss reading as a machine
 * at 200px, and it is paid in this file so nothing else has to know.
 */

import { Application, Container, Graphics, Sprite } from 'pixi.js';
import { WORLD, PLAYER_CFG, UNIT_PX } from '../core/constants.js';
import { clamp } from '../core/math.js';
import { assets as defaultAssets, ASSET_KEYS } from '../core/assets.js';
import { CHARGE_STATE } from '../core/simulation.js';
import { ENEMIES } from '../data/enemies.js';
import { EVENTS } from '../core/event-bus.js';
import {
  ANIM_STATES,
  DEWLING_ENTITY_ID,
  DEWLING_PRIORITY,
  RUSTWHALE_PRIORITY,
} from '../core/animation.js';
import { SpriteAnimator } from './spriteAnimator.js';
import { createSlicer, formatMissingSheetReport, loadAnimationManifests } from './sheet-probe.js';
import { applyJuice, createTransform, resetTransform, sharedCycleFrame, DEATH_DISSOLVE_SEC } from './juice.js';
import {
  BOSS_FX,
  HERO_FX,
  MOVE_WAKE,
  RECOIL,
  attackRecoil,
  bossStateTransform,
  heroStateTransform,
  stateBurst,
  trailIntensity,
  wakeDue,
} from './state-fx.js';
import { Background, VOID_BASE, tryLoadNebulaImage } from './background.js';
import { Camera } from './camera.js';
/*
 * The render layer asks the input layer one question and only one: is this
 * session driven by a finger? It needs the answer because the mobile field of
 * view is a CAMERA decision, and re-deriving "is this a touch device" here
 * would leave two definitions of that in the codebase that can disagree — the
 * exact failure main.js already avoids by not deriving it from CSS.
 */
import { isTouchDevice } from '../input/touch-controls.js';
import { THEME } from './theme.js';
import {
  makeSprite,
  scaleForRadius,
  syncEnemySprite,
  getEnemySpriteConfig,
  enemyTextureKey,
  cosmeticTint,
  HERO_TEXTURE_KEY,
  HULL_ROTATION_OFFSET,
  PIXI_TINT,
  NO_TINT,
  DAMAGE_TINT,
} from './sprites.js';
import {
  DEATH_SPRAY,
  DREADNOUGHT,
  THRUSTER,
  createDreadnought,
  getDreadnoughtParts,
  dreadnoughtPulse,
  enemyTint,
  getEnemyView,
  thrusterFlame,
} from './sprite-factory.js';
import { ParticleSystem } from './particles.js';
import { ScreenShake, TRAUMA } from './screen-shake.js';
import { SkillVfx } from './skill-vfx.js';
import { CompositeBossRenderer } from './composite-boss-renderer.js';

const TRAIL_SAMPLES = 14;
const GRID_SIZE = 140;

/**
 * The perimeter energy barrier. See Renderer.drawBarrier for what each mark is
 * for; these are the numbers, in world units except where noted.
 *
 * Widths are generous because they are world-space and the camera is zoomed
 * OUT: a 3px line, which read fine at the old 1:1 scale, is a pixel and a half
 * on a mobile viewport — i.e. a shimmering dotted line rather than a barrier.
 */
const BARRIER = {
  /** Radians per second of the containment-field pulse (~0.13 Hz). */
  PULSE_RATE: 0.8,
  LINE_WIDTH: 5,
  LINE_ALPHA: 0.85,
  HAZE_WIDTH: 26,
  HAZE_ALPHA: 0.1,
  INSET: 9,
  /** Corner bracket arm length, and the gap left at the corner itself. */
  RIVET_ARM: 96,
  RIVET_GAP: 14,
  RIVET_WIDTH: 4,
};

/**
 * Hull visual diameter as a multiple of the player's collision diameter.
 *
 * The hero frame carries wings well outside its hitbox, which is intended: the
 * ship should look like it occupies more space than it can be hit in, and a
 * generous hull is what makes the canopy and wing plates legible at all. It is
 * also the only sprite the player looks at for a whole run, so it is the one
 * worth spending pixels on.
 */
const HERO_FIT = 2.6;

/**
 * Fraction of the remaining turn the hull closes per 60Hz frame.
 *
 * The other half of giving the ship mass. Positional inertia alone still reads
 * as mechanical if the hull can swap facing between two frames; at 0.15 a
 * full reversal takes roughly a fifth of a second to come round, which is slow
 * enough to see and fast enough not to fight.
 */
const HERO_TURN_LERP = 0.15;

/**
 * Step an angle toward a target along the SHORT arc, frame-rate independent.
 *
 * Wrapping is the whole difficulty: lerping 170deg toward -170deg the naive
 * way sends the hull the long way round, spinning through a full turn to cover
 * 20 degrees. Normalising the delta into (-PI, PI] first picks the short arc.
 *
 * @param {number} current - Radians
 * @param {number} target - Radians
 * @param {number} lerp - Fraction closed per 60Hz frame
 * @param {number} dt - Seconds
 * @returns {number} Radians
 */
export function approachAngle(current, target, lerp, dt) {
  let delta = (target - current) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;

  // Exponential approach, so a slow frame turns as far as the frames it
  // replaced rather than lagging behind.
  const k = 1 - Math.pow(1 - lerp, dt * 60);
  return current + delta * k;
}

/**
 * Pull the minimum display times out of an FX table for the animator.
 * @param {Object} table - HERO_FX or BOSS_FX
 * @returns {Object} state -> seconds
 */
function toDurations(table) {
  const durations = {};
  for (const [state, config] of Object.entries(table)) durations[state] = config.duration;
  return durations;
}
/** Enemies at or above this radius get a health bar; trash does not. */
const HEALTH_BAR_MIN_RADIUS = 18;

export class Renderer {
  /**
   * Construct with an already-initialised Pixi Application.
   * Use `Renderer.create()` unless you are supplying your own app (tests do).
   *
   * @param {Application} app
   * @param {import('../core/simulation.js').Simulation} simulation
   * @param {Object} [options]
   */
  constructor(app, simulation, options = {}) {
    this.app = app;
    this.sim = simulation;
    this.assets = options.assets ?? defaultAssets;
    this.getCosmetic = options.getCosmetic ?? (() => null);

    this.time = 0;
    /**
     * The tactical camera — position, zoom and the screen/world transform.
     *
     * `isTouch` is asked once at construction rather than read per frame: the
     * answer cannot change within a session, and the wider mobile field of view
     * has to be settled before the first frame is drawn or the opening wave
     * arrives at the wrong scale.
     */
    this.camera = new Camera({ isTouch: options.isTouch ?? isTouchDevice() });
    this.trail = [];
    /** enemy.id -> { sprite, baseScale, key } */
    this.enemyViews = new Map();
    /** texture key -> array of parked sprites */
    this.spritePools = new Map();

    /* ---- Phase 7 animation ---- */

    /**
     * Resolved sheet manifests. Absent in tests and before the probe runs, in
     * which case every entity renders its static sprite — the same path a
     * developer sees while art is still being placed.
     */
    const animation = options.animation ?? null;
    this.tierA = animation?.tierA ?? null;
    this.swarmCycles = animation?.swarm ?? null;
    this.slice = animation?.sheets ? createSlicer(animation.sheets) : null;

    /**
     * Drop-in nebula background texture, from `Renderer.create()`'s
     * `tryLoadNebulaImage()` probe. Null the overwhelming majority of the
     * time, in which case `Background` builds its own procedural canvas.
     */
    this.nebulaImage = options.nebulaImage ?? null;

    /**
     * ONE transform reused for every enemy in the frame. Allocating per enemy
     * would be 200 objects a frame; this is the single object Tier B mutates.
     */
    this.juiceTransform = createTransform();

    /**
     * Transform for Tier A entities. Separate from juiceTransform because the
     * hero is drawn after the swarm loop and would otherwise stomp it.
     */
    this.stateTransform = createTransform();

    /** Tier A: exactly two possible animators, ever. */
    this.heroAnimator = new SpriteAnimator(this.tierA?.dewling ?? {}, {
      priority: DEWLING_PRIORITY,
      slice: this.slice,
      fallbackDurations: toDurations(HERO_FX),
    });
    this.bossAnimator = null;
    /** Boss entity id currently bound to bossAnimator. */
    this.bossId = null;
    /** Last non-zero travel of the Drifter, for the sprite flip and the wake. */
    this.lastPlayerDx = 0;
    this.lastPlayerDy = 0;
    /** Hull angle, interpolated toward the travel heading rather than assigned. */
    this.heroFacing = 0;
    /** 0..1 engine throttle, from the simulation's velocity. */
    this.throttle = 0;
    /** Direction of the most recent shot, for the muzzle spray and recoil. */
    this.lastFireAngle = 0;
    /** Seconds left on the hard recoil kick. See drawPlayer. */
    this.recoilTimer = 0;

    /**
     * Views of enemies that have died but are still dissolving. The simulation
     * entity is recycled inside the same tick it dies, so the view carries its
     * own snapshot of the fields deathDissolve needs.
     */
    this.dyingViews = [];

    this.shake = new ScreenShake();
    this.particles = new ParticleSystem(this.assets);

    /**
     * Whether white impact flashes are drawn, from the accessibility settings.
     *
     * Held here rather than read from a settings module, because the renderer
     * must not know that a settings store exists — main.js pushes the value in
     * on change, exactly as it pushes the shake intensity. That keeps the
     * render layer configurable without making it a consumer of preferences.
     */
    this.damageFlash = true;
    /**
     * The player's damage-number preference.
     *
     * Stored and honoured here so the setting is live the moment a
     * damage-number layer lands. Nothing reads it today — the game has no
     * floating-damage renderer yet — and that is recorded plainly rather than
     * left for the next reader to discover by grepping for a consumer that
     * does not exist.
     */
    this.showDamageNumbers = true;

    this.buildStage();
    this.bindEvents();
    this.resize();
    // The very first frame is a run start too, and it is the one most likely to
    // be watched: without this the game opens on the camera sliding off (0, 0).
    this.camera.snap(this.sim.state.player);
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Async factory — Pixi v8 initialises the renderer asynchronously.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/simulation.js').Simulation} simulation
   * @param {Object} [options]
   * @returns {Promise<Renderer>}
   */
  static async create(canvas, simulation, options = {}) {
    // Probe the sheets before the first frame so the animators know which
    // clips exist. Missing sheets are the expected case, not a failure.
    let animation = options.animation;
    if (animation === undefined) {
      animation = await loadAnimationManifests();
      console.info(formatMissingSheetReport(animation.missing));
    }

    /*
     * Best-effort drop-in nebula image, awaited here rather than inside
     * `Background` so the constructor stays fully synchronous — every test
     * that builds a Renderer or a Background directly is unaffected, and the
     * asset itself does not exist in this repository (see
     * background.js#tryLoadNebulaImage for why it is deliberately outside the
     * ASSET_MANIFEST pipeline). Resolves to null almost always; that is the
     * expected case, not a failure.
     */
    let nebulaImage = options.nebulaImage;
    if (nebulaImage === undefined) {
      nebulaImage = await tryLoadNebulaImage();
    }

    const app = new Application();
    await app.init({
      canvas,
      width: window.innerWidth,
      height: window.innerHeight,
      /*
       * The clear colour must match Background's VOID_BASE, not PALETTE's
       * generic backdrop stop. The backdrop paints its own opaque void rect
       * over the viewport every frame, so the two only ever meet in the one
       * frame between a window resize and the backdrop's own resize catching
       * up — and a mismatch there flashes a band of a different black down the
       * edge of the screen. Same value, one source of truth.
       */
      backgroundColor: VOID_BASE,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      // The game drives its own fixed-step loop; Pixi should not also tick.
      autoStart: false,
    });
    return new Renderer(app, simulation, { ...options, animation, nebulaImage });
  }

  /**
   * Containers, added in Z_ORDER. The order of these addChild calls IS the
   * layering contract.
   */
  buildStage() {
    const stage = this.app.stage;

    // Background is screen-space: it must not move with the camera.
    this.backgroundLayer = new Container();
    // Everything else lives in the world, which the camera and shake transform.
    this.world = new Container();

    stage.addChild(this.backgroundLayer, this.world);

    this.layers = {
      arena: new Container(),
      hazard: new Container(),
      telegraph: new Container(),
      orb: new Container(),
      enemy: new Container(),
      /**
       * Modular bosses (src/core/composite-boss.js). Its own layer rather than
       * a child of `enemy`: a composite boss is drawn from CompositeBoss's own
       * render state, not from an entry in sim.enemies, and giving it a
       * dedicated container keeps that fact visible in the z-order contract
       * instead of being an implicit side effect of insertion order.
       */
      compositeBoss: new Container(),
      projectile: new Container(),
      cardEffect: new Container(),
      skillVfx: new Container(),
      particle: this.particles.container,
      playerTrail: new Container(),
      player: new Container(),
    };

    for (const layer of Object.values(this.layers)) this.world.addChild(layer);

    /**
     * Renders every CompositeBoss on the field. A thin wrapper over one
     * container per boss (see composite-boss-renderer.js); this class only
     * decides WHEN to sync/release a view, driven off sim.compositeBosses.
     */
    this.compositeBossRenderer = new CompositeBossRenderer({
      layer: this.layers.compositeBoss,
      assets: this.assets,
    });

    /**
     * Active-skill effects. Reads the simulation and draws; it owns no state
     * the simulation does not already have, so it needs no teardown beyond
     * its own container.
     */
    this.skillVfx = new SkillVfx(this.sim, {
      // Lazy: buildPlayer() has not run yet, and the after-images need the
      // hull's LIVE texture and heading at the instant of a blink, not
      // whatever it was when the stage was built.
      getHeroSprite: () => this.heroSprite ?? null,
    });
    this.layers.skillVfx.addChild(this.skillVfx.container);

    this.buildBackground();
    this.buildArena();
    this.buildVectorLayers();
    this.buildPlayer();
  }

  buildBackground() {
    /*
     * No `voidTile` option any more. It used to pass ASSET_KEYS.BG_VOID
     * straight through to the starfield layer, which is how a real shipped
     * bg_void.png silently overrode every tuned procedural starfield: `voidTile
     * ?? makeStarfieldTexture()` always prefers a real asset over the
     * fallback, and that PNG was legacy nebula-cloud art with the exact
     * blue/purple blobs repeatedly reported as a tiling bug in code that had
     * long since stopped drawing them. See assets.js's ASSET_KEYS comment for
     * the full account.
     */
    this.backgroundSystem = new Background(this.app, {
      nebulaImage: this.nebulaImage,
    });
    this.backgroundLayer.addChild(this.backgroundSystem.container);
  }

  buildArena() {
    /** The static tactical floor: never redrawn after boot. */
    this.arenaGfx = new Graphics();
    /** The energy barrier: redrawn per frame because it pulses. */
    this.barrierGfx = new Graphics();
    this.layers.arena.addChild(this.arenaGfx, this.barrierGfx);
    this.drawArena();
  }

  /** One reusable Graphics per vector effect; cleared and redrawn per frame. */
  buildVectorLayers() {
    this.hazardGfx = new Graphics();
    this.telegraphGfx = new Graphics();
    this.effectGfx = new Graphics();
    this.beamGfx = new Graphics();
    this.healthGfx = new Graphics();
    this.trailGfx = new Graphics();
    this.shieldGfx = new Graphics();

    this.layers.hazard.addChild(this.hazardGfx);
    this.layers.telegraph.addChild(this.telegraphGfx);
    this.layers.cardEffect.addChild(this.effectGfx, this.beamGfx);
    this.layers.enemy.addChild(this.healthGfx);
    this.layers.playerTrail.addChild(this.trailGfx);
    this.layers.player.addChild(this.shieldGfx);
  }

  buildPlayer() {
    /*
     * THERE IS NO AFTERIMAGE POOL ANY MORE.
     *
     * The Drifter used to stamp seven translucent copies of its own sprite
     * behind it while moving. In a game whose stated headline risk is the
     * player losing track of their own hull in a crowd, drawing six extra
     * hulls attached to it is working against the one thing the whole palette
     * is built to guarantee — and it was a soft, smeary effect on hardware that
     * is meant to read as machined.
     *
     * What replaces it is exhaust: hard sparks off the two nozzles (see
     * emitContinuousFx) plus the existing motion trail, neither of which is
     * ship-shaped.
     */
    /** Seconds banked toward the next exhaust emission. */
    this.wakeTimer = 0;

    this.heroSprite = makeSprite(this.assets.get(HERO_TEXTURE_KEY));
    this.layers.player.addChild(this.heroSprite);

    this.shieldSprite = makeSprite(this.assets.get(ASSET_KEYS.SHIELD));
    this.shieldSprite.anchor.set(0.5);
    this.shieldSprite.tint = PIXI_TINT.heroShield;
    this.shieldSprite.visible = false;
    this.layers.player.addChild(this.shieldSprite);

    /*
     * Twin engine flames.
     *
     * Anchored at (0.5, 0) — the TOP of the flame frame — so the sprite grows
     * away from the nozzle it is pinned to rather than around its own centre.
     * With the hull's rotation applied, sprite-local +Y points astern, which is
     * exactly where a flame should go.
     *
     * They live in the trail layer, so they can never paint over the hull.
     */
    /** Where the flames ended up this frame; the exhaust spawns from here. */
    this.nozzles = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];

    this.thrusters = [-1, 1].map(() => {
      const flame = new Sprite(this.assets.get(ASSET_KEYS.THRUSTER));
      flame.anchor.set(0.5, 0);
      flame.tint = THRUSTER.tint;
      flame.visible = false;
      this.layers.playerTrail.addChild(flame);
      return flame;
    });
  }

  /**
   * Place and size the engine flames behind the hull.
   *
   * Everything is derived from the hull's rendered diameter and its current
   * facing, so the exhausts stay glued to the ship at any scale and through
   * every turn. Length and alpha ride the throttle, which is why a coasting
   * Drifter shows two dim pilot lights and a burning one shows two long
   * flames — the clearest read the player gets that thrust and motion are now
   * different things.
   *
   * @param {number} originX - Hull position, after recoil
   * @param {number} originY
   */
  drawThrusters(originX, originY) {
    if (!this.thrusters) return;

    const texture = this.assets.get(ASSET_KEYS.THRUSTER);
    const hullDiameter = PLAYER_CFG.RADIUS * 2 * HERO_FIT;
    const burn = thrusterFlame(this.throttle ?? 0, this.time);

    const angle = this.heroFacing - HULL_ROTATION_OFFSET;
    const backX = -Math.cos(angle);
    const backY = -Math.sin(angle);
    // Perpendicular, to split the pair across the ship's beam.
    const sideX = -Math.sin(angle);
    const sideY = Math.cos(angle);

    for (let i = 0; i < this.thrusters.length; i++) {
      const flame = this.thrusters[i];
      const side = i === 0 ? -1 : 1;

      if (!this.heroSprite.visible) {
        flame.visible = false;
        continue;
      }

      flame.visible = true;
      flame.rotation = this.heroFacing;
      flame.alpha = burn.alpha * this.heroSprite.alpha;
      flame.x = originX + backX * hullDiameter * THRUSTER.back + sideX * hullDiameter * THRUSTER.side * side;
      flame.y = originY + backY * hullDiameter * THRUSTER.back + sideY * hullDiameter * THRUSTER.side * side;

      flame.scale.x = (hullDiameter * THRUSTER.width) / Math.max(texture?.width || 1, 1);
      flame.scale.y = (hullDiameter * burn.length) / Math.max(texture?.height || 1, 1);

      // Remembered so the exhaust particles can be shed from the nozzles
      // rather than from the middle of the ship.
      this.nozzles[i].x = flame.x;
      this.nozzles[i].y = flame.y;
    }
  }

  bindEvents() {
    const bus = this.sim.bus;

    bus.on('enemy:damaged', (data) => {
      if (data.x === undefined) return;
      this.particles.burst(data.x, data.y, THEME.offence.ion, 3);
      this.shake.add(TRAUMA.ENEMY_HIT);
    });

    bus.on('enemy:death', (data) => {
      // Bio-acid and hive magenta, NOT the enemy's own tint — a corpse burst
      // painted in the body colour vanishes into the enemies still alive
      // around it. See DEATH_SPRAY.
      this.particles.death(data.x, data.y, DEATH_SPRAY, data.radius);
      this.beginDissolve(data);
      if (data.isBoss) this.shake.add(TRAUMA.BOSS_SPAWN);
    });

    /**
     * Core decided an entity changed semantic state. The renderer is the only
     * side that turns that into frames, fps and textures — core never learns
     * those exist.
     */
    bus.on(EVENTS.ANIMATION_STATE, ({ entityId, state }) => {
      if (entityId === DEWLING_ENTITY_ID) {
        const before = this.heroAnimator.state;
        this.heroAnimator.requestState(state);
        // Burst only when the state actually took effect. A request that got
        // queued behind a still-playing reaction must not fire its particles
        // early, or the flash would arrive before the pose.
        if (this.heroAnimator.state !== before) this.emitStateBurst(state);
      } else if (entityId === this.bossId && this.bossAnimator) {
        // The telegraph clip is started by boss:telegraph_start instead, which
        // is the only event carrying the duration its fps must be derived from.
        if (state !== ANIM_STATES.TELEGRAPH) this.bossAnimator.requestState(state);
      }
    });

    /**
     * Step A2 — the telegraph animation is bound to the fairness window here.
     *
     * durationMs is the value the simulation already computed with
     * calculateTelegraphMs; the renderer never recomputes it. Handing it
     * straight to the animator is what makes the wind-up finish exactly as the
     * AoE resolves, whatever the frame count of the sheet turns out to be.
     */
    bus.on(EVENTS.BOSS_TELEGRAPH_START, (data) => {
      if (this.bossAnimator && data?.durationMs > 0) {
        this.bossAnimator.playTelegraph(data.durationMs);
      }
    });

    bus.on('player:damage', () => {
      const p = this.sim.state.player;
      this.particles.burst(p.x, p.y, THEME.danger.telegraph, 10);
      this.shake.add(TRAUMA.PLAYER_DAMAGE);
    });

    // Captured before the animation state arrives, so the muzzle spray and the
    // recoil both know which way the shot went. Firing also arms the kick,
    // which runs on its own short clock rather than the attack state's.
    bus.on(EVENTS.WEAPON_FIRE, (data) => {
      if (typeof data?.angle === 'number') this.lastFireAngle = data.angle;
      this.recoilTimer = RECOIL.duration;
    });

    bus.on('orb:collected', () => {
      const p = this.sim.state.player;
      this.particles.bubbles(p.x, p.y, THEME.pickup.orb, 3);
    });

    bus.on('player:level_up', () => {
      const p = this.sim.state.player;
      this.particles.bubbles(p.x, p.y, THEME.hero.rim, 14);
      this.particles.ring(p.x, p.y, 110, THEME.hero.rim);
      this.shake.add(TRAUMA.LEVEL_UP);
    });

    bus.on('boss:spawned', () => this.shake.add(TRAUMA.BOSS_SPAWN));

    bus.on('boss:telegraph_erupt', (data) => {
      const x = data?.x ?? this.sim.state.player.x;
      const y = data?.y ?? this.sim.state.player.y;
      this.particles.ring(x, y, data?.radius ?? 160, THEME.danger.telegraph);
      this.particles.burst(x, y, THEME.danger.telegraph, 18);
      this.shake.add(TRAUMA.BOSS_ERUPT);
    });

    bus.on('game:over', () => this.shake.add(TRAUMA.DEATH));
    bus.on('state:reset', () => this.resetVisuals());
  }

  /**
   * Apply the player's display preferences.
   *
   * One entry point rather than three public setters, because main.js already
   * receives the whole settings object on every change and splitting it up
   * here would only invite a caller to apply two of the three.
   *
   * Unknown and missing fields are ignored: the renderer takes what it
   * understands from the settings object and leaves the audio fields alone.
   *
   * @param {{screenShake?: number, damageFlash?: boolean,
   *          showDamageNumbers?: boolean}} settings
   */
  applySettings(settings = {}) {
    if (typeof settings.screenShake === 'number') {
      this.shake.setIntensity(settings.screenShake);
    }
    if (typeof settings.damageFlash === 'boolean') {
      this.damageFlash = settings.damageFlash;
      this.compositeBossRenderer.damageFlash = settings.damageFlash;
    }
    if (typeof settings.showDamageNumbers === 'boolean') {
      this.showDamageNumbers = settings.showDamageNumbers;
    }
  }

  resetVisuals() {
    this.particles.clear();
    this.shake.reset();
    this.trail.length = 0;
    // Put the camera ON the ship rather than letting it lerp in from wherever
    // the last run ended. A run that opens on a half-second camera slide hides
    // the first wave behind a move the player did not make.
    this.camera.snap(this.sim.state.player, this.sim.playerVx ?? 0, this.sim.playerVy ?? 0);
    for (const id of [...this.enemyViews.keys()]) this.releaseEnemyView(id);
    for (const view of this.dyingViews) this.parkSprite(view);
    this.dyingViews.length = 0;
    this.bossId = null;
    this.bossAnimator = null;
    this.compositeBossRenderer.clear();
    this.heroAnimator.forceState(ANIM_STATES.IDLE);
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.app.renderer.resize(width, height);
    this.camera.resize(width, height);

    if (this.backgroundSystem) {
      this.backgroundSystem.resize(width, height, this.camera.zoom);
    }

    /*
     * Tell the spawner how much arena is on screen, so it can push arrivals
     * past the frame edge rather than into it.
     *
     * Pushed on RESIZE rather than every frame because that is the only thing
     * that moves it: the zoom is a pure function of the viewport, so the
     * visible extent is constant between resizes. This is also the only line
     * where the renderer writes to the simulation, and it is a one-way
     * viewport hint with a null-safe default on the far side — the spawner
     * still works, on its fixed ring, if this never arrives.
     */
    const extent = this.camera.halfExtent;
    this.sim?.spawner?.setViewExtent?.(extent.x, extent.y);
  }

  get viewWidth() {
    return this.app.renderer.width;
  }

  get viewHeight() {
    return this.app.renderer.height;
  }

  /* ------------------------------------------------------------------ */
  /* Sprite pooling                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Take a display object for a texture key, reusing a parked one when
   * available.
   *
   * `composite` asks for the boss's two-layer container instead of a plain
   * Sprite. Both shapes pool under the same key, because a key only ever
   * belongs to one or the other.
   *
   * @param {string} key
   * @param {boolean} [composite]
   * @returns {Sprite|Container}
   */
  acquireSprite(key, composite = false) {
    let pool = this.spritePools.get(key);
    if (!pool) {
      pool = [];
      this.spritePools.set(key, pool);
    }

    const parked = pool.pop();
    if (parked) {
      parked.visible = true;
      return parked;
    }

    const display = composite
      ? createDreadnought(
        this.assets.get(key),
        this.assets.get(ASSET_KEYS.DREADNOUGHT_TURRET),
        this.assets.get(ASSET_KEYS.DREADNOUGHT_REACTOR),
        this.assets.get(ASSET_KEYS.DREADNOUGHT_BEAM)
      ).container
      : makeSprite(this.assets.get(key));
    this.layers.enemy.addChild(display);
    return display;
  }

  /**
   * Park a display object rather than destroying it — no display-list churn on
   * a wipe.
   *
   * Every property the animation layer may have changed is reset here, because
   * the next enemy to take this sprite inherits whatever it is left in. A
   * dissolved corpse parked at alpha 0 would come back as an invisible enemy.
   *
   * @param {Object} view
   */
  parkSprite(view) {
    const sprite = view.sprite;
    sprite.visible = false;
    sprite.alpha = 1;
    sprite.rotation = 0;
    sprite.scale.set(view.baseScale);
    // A Container has no tint of its own, so the composite's layers are reset
    // through the tintTargets list the factory handed back.
    for (const target of view.tintTargets) target.tint = NO_TINT;
    this.spritePools.get(view.key)?.push(sprite);
  }

  /**
   * @param {number} id
   */
  releaseEnemyView(id) {
    const view = this.enemyViews.get(id);
    if (!view) return;

    this.parkSprite(view);
    this.enemyViews.delete(id);
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt - Frame time in seconds
   */
  render(dt = 1 / 60) {
    this.time += dt;
    this.particles.update(dt);
    this.shake.update(dt);
    this.updateCamera(dt);
    this.trackPlayerFacing();
    this.recordTrail();

    this.syncEnemies(dt);
    this.syncCompositeBosses();
    this.syncProjectiles();
    this.syncOrbs();

    this.drawHazards();
    this.drawTelegraph();
    this.drawLockOns();
    this.drawDeathRay();
    this.drawEnemyBullets();
    this.drawEffects();
    this.drawBeam();
    this.drawSatellites();
    this.drawWingmen();
    this.skillVfx.update(dt);
    this.drawHealthBars();
    this.drawTrail();
    this.drawPlayer(dt);
    this.drawShield();
    this.drawBarrier();
    this.scrollBackdrop(dt);

    /*
     * Camera, zoom and shake as ONE transform on the world container.
     *
     * The order matters and is not commutative: the container is scaled by the
     * zoom, so the camera offset has to be expressed in the same post-scale
     * screen pixels (`-camera.x * zoom`). The shake offset is already in screen
     * pixels and is added after, which is what keeps a hit feeling like the
     * same kick whether the player is on a phone or a monitor — an unscaled
     * shake would be nearly invisible at the mobile zoom.
     */
    this.world.scale.set(this.camera.zoom);
    this.world.x = -this.camera.x * this.camera.zoom + this.shake.offsetX;
    this.world.y = -this.camera.y * this.camera.zoom + this.shake.offsetY;
    this.world.rotation = this.shake.rotation;

    this.app.render();
  }

  /**
   * @param {number} [dt] - Frame time in seconds
   */
  updateCamera(dt = 1 / 60) {
    this.camera.update(dt, this.sim.state.player, this.sim.playerVx ?? 0, this.sim.playerVy ?? 0);
  }

  /**
   * Screen pixel -> world unit, honouring the live zoom.
   *
   * Exposed on the renderer as well as on the camera because the camera is the
   * renderer's private business as far as the rest of the game is concerned:
   * anything that needs to turn a tap into an aim point (skill targeting, a
   * future reticle) should ask the renderer rather than reach through it.
   *
   * @param {number} screenX
   * @param {number} screenY
   * @returns {{x: number, y: number}}
   */
  screenToWorld(screenX, screenY) {
    return this.camera.screenToWorld(screenX, screenY);
  }

  /**
   * World unit -> screen pixel. The exact inverse of screenToWorld.
   *
   * @param {number} worldX
   * @param {number} worldY
   * @returns {{x: number, y: number}}
   */
  worldToScreen(worldX, worldY) {
    return this.camera.worldToScreen(worldX, worldY);
  }

  /** Advance the background visual system's parallax for this frame. */
  scrollBackdrop(dt = 1 / 60) {
    if (this.backgroundSystem) {
      this.backgroundSystem.update(
        dt,
        this.camera.x,
        this.camera.y,
        this.viewWidth,
        this.viewHeight,
        this.camera.zoom
      );
    }
  }

  /**
   * Fire the one-shot particle burst that belongs to a hero state.
   *
   * state-fx.js describes these as data so it never touches a rendering API;
   * turning that data into ParticleSystem calls is this method's whole job.
   *
   * @param {string} state
   */
  emitStateBurst(state) {
    const spec = stateBurst(state);
    if (!spec) return;

    const player = this.sim.state.player;

    switch (spec.kind) {
      case 'burst': {
        // Muzzle blast: a cone down the firing line, thrown from the Drifter's
        // edge rather than its centre so it leaves the body instead of
        // erupting out of it. A radial burst here said "something happened";
        // an aimed cone says "the shot went THAT way".
        const angle = this.lastFireAngle;
        this.particles.spray(player.x, player.y, angle, THEME.offence.ion, {
          count: spec.count,
          spread: 0.42,
          speed: 190,
          spawnOffset: PLAYER_CFG.RADIUS * 0.9,
        });
        // A small flash at the muzzle gives the cone an origin to come from.
        this.particles.ring(
          player.x + Math.cos(angle) * PLAYER_CFG.RADIUS,
          player.y + Math.sin(angle) * PLAYER_CFG.RADIUS,
          PLAYER_CFG.RADIUS * 1.5,
          THEME.hero.core
        );
        break;
      }
      case 'impact':
        this.particles.burst(player.x, player.y, THEME.danger.telegraph, spec.count);
        this.particles.ring(player.x, player.y, PLAYER_CFG.RADIUS * 3.4, THEME.danger.telegraph);
        break;
      case 'dissolve':
        this.particles.bubbles(player.x, player.y, THEME.hero.rim, spec.count);
        this.particles.ring(player.x, player.y, PLAYER_CFG.RADIUS * 6, THEME.hero.rim);
        break;
      case 'ring':
        this.particles.ring(player.x, player.y, PLAYER_CFG.RADIUS * 5, THEME.danger.telegraph);
        break;
      default:
        break;
    }
  }

  /**
   * Travel heading and throttle for the Drifter.
   *
   * Read straight off the simulation's velocity. This used to difference the
   * player's position frame to frame, because momentum did not exist and there
   * was nothing else to read — which meant it also picked up the position
   * clamp at the arena edge and reported a ship pinned against a wall as
   * stationary. Now that the ship carries real velocity (PLAYER_CFG.ACCEL),
   * using it is both simpler and more honest.
   *
   * The zero-motion case deliberately leaves the last heading alone, so a
   * Drifter that comes to rest keeps pointing the way it was going.
   */
  trackPlayerFacing() {
    const vx = this.sim.playerVx ?? 0;
    const vy = this.sim.playerVy ?? 0;

    if (vx !== 0 || vy !== 0) {
      this.lastPlayerDx = vx;
      this.lastPlayerDy = vy;
    }

    const speed = Math.hypot(vx, vy);
    const top = this.sim.state.player.moveSpeed * this.sim.cards.moveSpeedMultiplier * UNIT_PX;
    /** 0 (drifting) .. 1 (full burn) — drives the engine flames. */
    this.throttle = top > 0 ? clamp(speed / top, 0, 1) : 0;
  }

  recordTrail() {
    const player = this.sim.state.player;
    this.trail.push({ x: player.x, y: player.y });
    if (this.trail.length > TRAIL_SAMPLES) this.trail.shift();
  }

  /* ------------------------------------------------------------------ */
  /* Entities                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * @param {Object} enemy
   * @returns {Object} The view record for an enemy, creating one if needed
   */
  ensureEnemyView(enemy) {
    let view = this.enemyViews.get(enemy.id);
    if (view) return view;

    const key = enemyTextureKey(enemy.typeId);
    const sprite = this.acquireSprite(key, Boolean(enemy.isBoss));
    const config = getEnemySpriteConfig(enemy.typeId);
    const parts = getDreadnoughtParts(sprite);

    // The composite normalises its layers to a 1x1 box, so its scale IS the
    // world diameter and needs no texture width in the maths. A plain sprite
    // still derives its scale from the frame it happens to be drawn at.
    const baseScale = parts
      ? enemy.radius * 2
      : scaleForRadius(sprite.texture, enemy.radius, config.fit);

    sprite.scale.set(baseScale);
    sprite.alpha = 1;

    view = {
      sprite,
      baseScale,
      key,
      /** Species colour. Overwritten by the damage flash for one frame. */
      tint: enemyTint(enemy.typeId),
      /** Presentation row: bioluminescence, sway, per-species scale. */
      view: getEnemyView(enemy.typeId),
      /** Every sprite a tint has to reach — one, or the composite's three. */
      tintTargets: parts ? parts.tintTargets : [sprite],
      parts,
      /**
       * The reactor's normalised scale, captured before anything animates it.
       * Its swell multiplies this rather than the live value, or the swell
       * would compound frame over frame and the core would inflate off-screen.
       */
      reactorScale: parts ? parts.reactor.scale.x : 1,
      // Dissolve snapshot, filled in on death.
      typeId: enemy.typeId,
      x: 0,
      y: 0,
      phaseOffset: 0,
      spawnTime: 0,
      lastHitTime: -Infinity,
      deathTime: -Infinity,
      vx: 0,
      vy: 0,
    };
    this.enemyViews.set(enemy.id, view);
    return view;
  }

  /**
   * @param {number} dt - Frame time in seconds, for the Tier A boss animator
   */
  syncEnemies(dt = 1 / 60) {
    const t = this.sim.elapsed;
    const seen = new Set();

    for (const enemy of this.sim.enemies) {
      if (!enemy.alive) continue;
      seen.add(enemy.id);

      const view = this.ensureEnemyView(enemy);

      if (enemy.isBoss) {
        this.syncBoss(view, enemy, dt);
        continue;
      }

      // TIER B — the whole swarm animation system, one shared transform.
      applyJuice(enemy, t, this.juiceTransform);
      // Gated here rather than inside syncEnemySprite so the sprite layer stays
      // a pure function of the transform it is handed. The squash, the rotation
      // and the dissolve all survive — only the white frame is withheld, which
      // is what the setting actually asks for.
      if (!this.damageFlash) this.juiceTransform.flash = false;
      syncEnemySprite(view, enemy, this.juiceTransform, t);
      this.applySwarmCycle(view, enemy, t);

      // Track the last velocity so a corpse keeps facing the way it swam
      // rather than snapping to 0 the instant it dies. Two number writes.
      view.vx = enemy.vx;
      view.vy = enemy.vy;
    }

    // Enemies removed without a death event (wave wipe) still need parking.
    for (const id of [...this.enemyViews.keys()]) {
      if (!seen.has(id)) this.releaseEnemyView(id);
    }

    this.syncDyingViews(t);
  }

  /**
   * Drive every modular boss's display tree from its own render state.
   *
   * A composite boss carries its OWN container per instance (built lazily by
   * CompositeBossRenderer.sync on first sight) rather than going through the
   * enemy sprite pool: it is not one texture key but a chassis-plus-parts
   * tree, and the pool's "one sprite per texture key" contract has nowhere to
   * put that.
   */
  syncCompositeBosses() {
    const seen = new Set();
    for (const boss of this.sim.compositeBosses) {
      if (!boss.alive) continue;
      seen.add(boss.id);
      this.compositeBossRenderer.sync(boss.getRenderState());
    }
    // A boss that died or was cleared (arena wipe) without going through a
    // one-frame "not alive" state still needs its tree torn down.
    for (const id of [...this.compositeBossRenderer.views.keys()]) {
      if (!seen.has(id)) this.compositeBossRenderer.release(id);
    }
  }

  /**
   * TIER A for the Dreadnought Station. Bound lazily because the boss only
   * exists on boss waves, and rebound if a later wave spawns a new one.
   *
   * Four motions stack here, and they are deliberately independent:
   *
   *   1. The Tier A state FX (hit lurch, telegraph wind-up, death) — authored
   *      reactions, driven by the animator.
   *   2. A slow axial SPIN. This is the signal that the station is under power;
   *      at DREADNOUGHT.spin it takes most of a minute to come round, which
   *      reads as mass rather than as motion.
   *   3. A shallow scale pulse between DREADNOUGHT.scaleMin and scaleMax, so
   *      the hull is never perfectly static between attacks.
   *   4. The reactor's glow and swell, and the turrets' slow sweep — each on
   *      its own clock, so the parts never look welded into one sprite.
   *
   * Stacking rather than switching is what keeps the boss alive through its
   * quiet frames without the pulse ever fighting an authored pose: the pulse
   * multiplies the FX scale, so a death clip's collapse still wins.
   *
   * THE BOSS DOES NOT FACE ITS TRAVEL. Everything else on screen turns to point
   * where it is going; a station does not, and making it do so would undo the
   * whole "heavy, indifferent" read. Its rotation is the spin alone.
   *
   * @param {Object} view
   * @param {Object} boss
   * @param {number} dt - Frame time in seconds
   */
  syncBoss(view, boss, dt) {
    if (this.bossId !== boss.id) {
      this.bossId = boss.id;
      this.bossAnimator = new SpriteAnimator(this.tierA?.rustwhale ?? {}, {
        priority: RUSTWHALE_PRIORITY,
        slice: this.slice,
        fallbackDurations: toDurations(BOSS_FX),
      });
    }

    const sprite = view.sprite;
    const parts = view.parts;
    sprite.x = boss.x;
    sprite.y = boss.y;
    sprite.alpha = 1;

    this.bossAnimator.update(dt);
    this.bossAnimator.setFacing(boss.vx);

    const fx = resetTransform(this.stateTransform);
    bossStateTransform(this.bossAnimator.state, this.bossAnimator.elapsed, this.time, fx, {
      duration: this.bossAnimator.fallbackDuration,
    });

    // Authored frames, when the art exists, replace the keel only — the
    // turrets and the reactor are this renderer's own layers, never in a sheet.
    if (!this.bossAnimator.isFallback) {
      const texture = this.bossAnimator.currentTexture();
      if (texture) {
        if (parts) parts.spine.texture = texture;
        else sprite.texture = texture;
      }
    }

    // The reactor visibly spins up while a death ray is charging, which is the
    // only warning the player gets before the cone appears.
    const charging = this.sim.deathRay?.active && !this.sim.deathRay.firing;
    const pulse = dreadnoughtPulse(this.time, fx, Boolean(charging));

    sprite.rotation = pulse.hullRotation + fx.rotation;
    // pulse.scale is a CONSTANT now — the hull does not breathe. Only an
    // authored state FX (the death collapse) can change the chassis size.
    sprite.scale.x = view.baseScale * pulse.scale * fx.scaleX;
    sprite.scale.y = view.baseScale * pulse.scale * fx.scaleY;
    sprite.alpha = fx.alpha;

    const flash = this.damageFlash && (fx.flash || boss.hitFlash > 0);
    if (parts) {
      parts.spine.tint = flash ? DAMAGE_TINT : DREADNOUGHT.hullTint;
      parts.beam.tint = flash ? DAMAGE_TINT : DREADNOUGHT.beamTint;
      for (const turret of parts.turrets) {
        turret.tint = flash ? DAMAGE_TINT : DREADNOUGHT.turretTint;
        // Local rotation only. These inherit the container's spin because they
        // are bolted to it — an earlier pass cancelled the spin here, which
        // made the platforms hold their world angle while the keel turned under
        // them and read as two objects flying in loose formation. The rotation
        // is continuous rather than a sine: bearings turn, plates wobble.
        turret.rotation = pulse.turretSpin;
      }
      // The reactor keeps its warning colour through a hit flash: it is the
      // weak point the player is aiming at, and losing it to the flash hides
      // the target at exactly the moment they are hitting it.
      parts.reactor.tint = DREADNOUGHT.reactorTint;
      parts.reactor.alpha = pulse.reactorAlpha;
      parts.reactor.scale.set(view.reactorScale * pulse.reactorScale);
    } else {
      sprite.tint = flash ? DAMAGE_TINT : DREADNOUGHT.hullTint;
    }
  }

  /**
   * Step B3 — the optional shared swim-cycle layer.
   *
   * Applied ON TOP of the Tier B transforms, never instead of them. Every
   * instance of a type shares one sheet; the only per-instance input is the
   * entity's phaseOffset number, so this stays a frame-index lookup rather
   * than a per-entity animator. Types with no sheet fall through untouched.
   *
   * @param {Object} view
   * @param {Object} enemy
   * @param {number} t
   */
  applySwarmCycle(view, enemy, t) {
    const clip = this.swarmCycles?.[enemy.typeId];
    if (!clip?.available || !this.slice || !(clip.frames > 1)) return;

    const index = sharedCycleFrame(t, enemy.phaseOffset, clip.fps, clip.frames);
    let frames = this.cycleFrames?.get(clip.sheet);
    if (!frames) {
      if (!this.cycleFrames) this.cycleFrames = new Map();
      frames = [];
      for (let i = 0; i < clip.frames; i++) frames.push(this.slice(clip.sheet, i, clip));
      this.cycleFrames.set(clip.sheet, frames);
    }

    const texture = frames[index];
    if (texture) view.sprite.texture = texture;
  }

  /**
   * Advance dissolving corpses and park them once faded.
   *
   * Iterated back-to-front so a completed dissolve can be swap-removed without
   * disturbing the rest of the pass.
   *
   * @param {number} t - Simulation time, seconds
   */
  syncDyingViews(t) {
    for (let i = this.dyingViews.length - 1; i >= 0; i--) {
      const view = this.dyingViews[i];

      if (t - view.deathTime >= DEATH_DISSOLVE_SEC) {
        this.parkSprite(view);
        this.dyingViews[i] = this.dyingViews[this.dyingViews.length - 1];
        this.dyingViews.pop();
        continue;
      }

      applyJuice(view, t, this.juiceTransform);
      // No `t` here: a corpse should not keep shimmering. The dissolve owns
      // its alpha from this point on.
      syncEnemySprite(view, view, this.juiceTransform);
    }
  }

  /**
   * Start a death dissolve, so a killed enemy fades and shrinks instead of
   * vanishing between frames.
   *
   * The view takes a snapshot because the simulation entity is returned to the
   * enemy pool within the same tick — reading it back later would show whatever
   * enemy was next recycled into that object.
   *
   * @param {Object} data - enemy:death payload
   */
  beginDissolve(data) {
    const view = this.enemyViews.get(data.id);
    if (!view) return;
    this.enemyViews.delete(data.id);

    if (data.isBoss) {
      // The boss has an authored death clip in Tier A; it does not dissolve.
      this.parkSprite(view);
      if (this.bossId === data.id) {
        this.bossId = null;
        this.bossAnimator = null;
      }
      return;
    }

    view.x = data.x;
    view.y = data.y;
    view.typeId = data.typeId;
    view.deathTime = data.deathTime ?? this.sim.elapsed;
    view.phaseOffset = data.phaseOffset ?? 0;
    view.spawnTime = -Infinity; // Long since grown in.
    view.lastHitTime = -Infinity;
    this.dyingViews.push(view);
  }

  /**
   * Projectiles are drawn as a single Graphics batch rather than sprites:
   * they are tiny, uniform, and there are up to 50+ of them, so one geometry
   * beats 50 display objects.
   */
  /**
   * Player ordnance.
   *
   * Split in two by cost. Bolts and drone fire are tiny, uniform and numerous,
   * so they stay one Graphics batch. Nanite missiles are few (at most six per
   * salvo), individually identifiable and need to point along their own
   * heading, so they get real sprites — the arc a guided missile flies is the
   * whole appeal of that card, and a dot cannot show it.
   */
  syncProjectiles() {
    if (!this.projectileGfx) {
      this.projectileGfx = new Graphics();
      this.layers.projectile.addChild(this.projectileGfx);
    }
    if (!this.missiles) this.missiles = [];

    const g = this.projectileGfx;
    g.clear();

    let missileCount = 0;
    for (const p of this.sim.projectiles) {
      if (!p.alive) continue;

      if (p.turnRate > 0) {
        const sprite = this.acquireMissile(missileCount++);
        sprite.visible = true;
        sprite.x = p.x;
        sprite.y = p.y;
        sprite.rotation = Math.atan2(p.vy, p.vx) + HULL_ROTATION_OFFSET;
        sprite.scale.set(scaleForRadius(sprite.texture, p.radius, 2.4));
        continue;
      }

      g.circle(p.x, p.y, p.radius);
    }
    g.fill({ color: PIXI_TINT.ion, alpha: 0.95 });

    for (let i = missileCount; i < this.missiles.length; i++) {
      this.missiles[i].visible = false;
    }
  }

  /**
   * @param {number} index
   * @returns {Sprite} A pooled missile sprite, created on first use
   */
  acquireMissile(index) {
    let sprite = this.missiles[index];
    if (!sprite) {
      sprite = makeSprite(this.assets.get(ASSET_KEYS.NANITE_MISSILE));
      sprite.tint = PIXI_TINT.heroIon;
      this.layers.projectile.addChild(sprite);
      this.missiles[index] = sprite;
    }
    return sprite;
  }

  syncOrbs() {
    if (!this.orbGfx) {
      this.orbGfx = new Graphics();
      this.layers.orb.addChild(this.orbGfx);
    }
    const g = this.orbGfx;
    g.clear();

    for (const orb of this.sim.orbs) {
      if (!orb.alive) continue;
      const pulse = 1 + Math.sin(this.time * 6 + orb.id) * 0.12;
      g.circle(orb.x, orb.y, orb.radius * pulse * 1.9);
    }
    g.fill({ color: PIXI_TINT.orb, alpha: 0.28 });

    for (const orb of this.sim.orbs) {
      if (!orb.alive) continue;
      const pulse = 1 + Math.sin(this.time * 6 + orb.id) * 0.12;
      g.circle(orb.x, orb.y, orb.radius * pulse);
    }
    g.fill({ color: PIXI_TINT.orb });
  }

  /**
   * TIER A for the Drifter.
   *
   * @param {number} dt - Frame time in seconds
   */
  drawPlayer(dt) {
    const player = this.sim.state.player;
    const sprite = this.heroSprite;

    // The animator ticks BEFORE the blink check. It used to sit after the early
    // return, which froze the state clock for the whole 0.7s invulnerability
    // window — i.e. starting exactly when `hit` fires, so the hit reaction
    // could never play out.
    this.heroAnimator.update(dt);
    // Flip rather than mirrored frames: the sheet is authored facing +X only.
    this.heroAnimator.setFacing(this.lastPlayerDx);

    // Blink through invulnerability frames so the hit lands visually — but
    // never while dying. On game over the simulation stops stepping, which
    // freezes invulnTimer mid-blink; if that frozen value happened to land on
    // an "off" frame the Drifter stayed hidden and the death dissolve was never
    // drawn at all. A dying Drifter dissolves instead of blinking.
    const dying = this.heroAnimator.state === ANIM_STATES.DEATH;
    const blinking =
      !dying && this.sim.invulnTimer > 0 && Math.floor(this.sim.invulnTimer * 12) % 2 === 0;
    sprite.visible = !blinking;
    if (blinking) {
      // The flames are separate display objects in another layer, so hiding
      // the hull does not hide them. Two engine plumes hanging in space around
      // an invisible ship is a worse tell than no blink at all.
      if (this.thrusters) for (const flame of this.thrusters) flame.visible = false;
      return;
    }

    sprite.x = player.x;
    sprite.y = player.y;
    sprite.tint = cosmeticTint(this.getCosmetic());

    // Texture FIRST, then scale. Each state's art may differ in pixel size
    // (dewling_death.png is 369px where the others are 373px), and baseScale is
    // derived from the texture — measuring before the swap would mis-scale the
    // sprite for one frame on every state change.
    if (this.heroAnimator.isFallback) {
      sprite.texture = this.assets.get(HERO_TEXTURE_KEY) ?? sprite.texture;
    } else {
      const texture = this.heroAnimator.currentTexture();
      if (texture) sprite.texture = texture;
    }

    const baseScale = scaleForRadius(sprite.texture, PLAYER_CFG.RADIUS, HERO_FIT);

    // Procedural pose for the current state. This runs on every path: with a
    // single-image pose per state it IS the animation, with a multi-frame strip
    // it layers on top of the frames as squash-and-stretch.
    const fx = resetTransform(this.stateTransform);
    heroStateTransform(this.heroAnimator.state, this.heroAnimator.elapsed, this.time, fx, {
      dx: this.lastPlayerDx,
    });

    /*
     * The Drifter banks into its travel direction, and TURNS to get there.
     *
     * The hull angle is interpolated toward the heading rather than assigned to
     * it. Snapping was the other half of the "feels like a cursor" problem: a
     * ship that changes facing in one frame has no rotational inertia, and no
     * amount of positional drift compensates for that. HERO_TURN_LERP is the
     * fraction of the remaining angle closed per 60Hz frame.
     *
     * Same strip rule as the boss: an authored multi-frame strip is drawn
     * facing +X and conveys direction with the horizontal flip, so rotating it
     * as well would double up.
     *
     * Facing comes from TRAVEL, not from the firing angle: the weapon
     * re-targets several times a second, and a hull chasing it would spin on
     * the spot.
     */
    const usesStrip = !this.heroAnimator.isFallback && !this.heroAnimator.isStaticPose();
    const flip = usesStrip && this.heroAnimator.flipX ? -1 : 1;

    if (usesStrip) {
      this.heroFacing = 0;
    } else {
      const target = Math.atan2(this.lastPlayerDy, this.lastPlayerDx) + HULL_ROTATION_OFFSET;
      this.heroFacing = approachAngle(this.heroFacing, target, HERO_TURN_LERP, dt);
    }

    sprite.scale.x = baseScale * fx.scaleX * flip;
    sprite.scale.y = baseScale * fx.scaleY;
    sprite.rotation = this.heroFacing + fx.rotation;
    sprite.alpha = fx.alpha;
    if (this.damageFlash && fx.flash) sprite.tint = DAMAGE_TINT;

    /*
     * Recoil shoves the Drifter off its own shot.
     *
     * ON ITS OWN CLOCK, not the animator's. `recoilTimer` is started by the
     * weapon:fire event and runs for RECOIL.duration (~0.06s), which is far
     * shorter than the 0.17s ATTACK state it used to be tied to — the kick is
     * meant to be a snap, and reading the state's elapsed time stretched it
     * into a visible backward drift.
     *
     * Applied to the SPRITE only, never to the simulation position: the hitbox
     * must not move because of a visual effect.
     */
    if (this.recoilTimer > 0) {
      this.recoilTimer = Math.max(0, this.recoilTimer - dt);
      const kick = attackRecoil(RECOIL.duration - this.recoilTimer);
      sprite.x -= Math.cos(this.lastFireAngle) * kick;
      sprite.y -= Math.sin(this.lastFireAngle) * kick;
    }

    // After the recoil, so the flames stay welded to the nozzles through it.
    this.drawThrusters(sprite.x, sprite.y);

    this.emitContinuousFx(dt);
  }

  /**
   * Emit the FX that run WHILE a state is held, rather than once on entry.
   *
   * Movement is the state the player spends almost all their time in, so it is
   * the one that most needs continuous motion cues: ghosts of the silhouette
   * displaced through space, and droplets left behind in world space.
   *
   * @param {number} dt
   */
  emitContinuousFx(dt) {
    const moving = this.heroAnimator.state === ANIM_STATES.MOVE;
    /*
     * Throttle, not raw dx.
     *
     * This used to be `|lastPlayerDx| / 3`, which was a sane 0..1 ramp back
     * when that field held a per-frame position delta of a couple of px. It now
     * holds velocity in px/s, which tops out near 154 — so the expression
     * pinned to 1 the instant the ship moved at all and the emission rate
     * stopped varying with speed. The simulation already computes the ratio.
     */
    const speedFactor = this.throttle;

    if (moving) {
      this.wakeTimer += dt;
      if (wakeDue(this.wakeTimer, speedFactor)) {
        this.wakeTimer = 0;
        /*
         * Exhaust grit, shed from the two nozzles.
         *
         * This is the whole of the engine trail now — the ghost chain that used
         * to accompany it is gone (see buildPlayer). Emitting from the nozzles
         * rather than the hull's centre matters more than ever: the flames are
         * drawn there, so sparks appearing anywhere else read as a second,
         * unexplained effect rather than as the same one.
         */
        const heading = Math.atan2(this.lastPlayerDy, this.lastPlayerDx);
        for (const nozzle of this.nozzles) {
          this.particles.wake(nozzle.x, nozzle.y, heading, THEME.hero.ion, MOVE_WAKE.count);
        }
      }
    } else {
      this.wakeTimer = 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Vector VFX (no authored art)                                        */
  /* ------------------------------------------------------------------ */

  /**
   * The world-space tactical floor.
   *
   * Drawn ONCE, at boot. The grid does not animate and the arena does not
   * resize, so redrawing 60 lines a frame would be 60 lines a frame of pure
   * waste — and on the 4GB Chromebook the backdrop is budgeted for, the
   * tessellation of a Graphics this wide is not free.
   *
   * Its alpha came down from 0.5 when the parallax backdrop landed. There are
   * now two grids: this one, nailed to the world, and the background's, drifting
   * at 0.15 parallax. Two grids at equal weight read as moire; at 0.28 this one
   * is clearly the floor and the other clearly the distance.
   */
  drawArena() {
    const g = this.arenaGfx;
    g.clear();

    for (let x = 0; x <= WORLD.WIDTH; x += GRID_SIZE) {
      g.moveTo(x, 0).lineTo(x, WORLD.HEIGHT);
    }
    for (let y = 0; y <= WORLD.HEIGHT; y += GRID_SIZE) {
      g.moveTo(0, y).lineTo(WORLD.WIDTH, y);
    }
    g.stroke({ color: PIXI_TINT.grid, width: 1, alpha: 0.28 });
  }

  /**
   * The perimeter energy barrier.
   *
   * WHY THE EDGE NEEDS TO ANNOUNCE ITSELF. The arena is 35% bigger and the
   * camera now shows less of it in proportion, so the boundary arrives without
   * warning — and the boundary is a hard clamp, not a wall the ship bumps into.
   * A player sliding to a stop against an invisible limit reads it as the
   * controls dropping input. The barrier exists so that when the ship stops,
   * the reason is on screen.
   *
   * Three marks, each doing a different job:
   *   - a bright inner line and a wide dim outer one, which together read as a
   *     field with thickness rather than a stroked rectangle;
   *   - CORNER RIVETS, drawn as open brackets. The corner is the one place the
   *     player can be clamped on both axes at once, and the only place the edge
   *     is visible from two directions, so it gets the loudest mark;
   *   - a slow pulse on the whole thing. Motion is what separates "the edge of
   *     the arena" from "a line someone drew on the floor".
   *
   * Drawn per frame, but it is four rectangles and eight short brackets — a
   * fixed, tiny cost that does not grow with the arena or the swarm. The phase
   * comes from `this.time` rather than an accumulated delta, so the pulse
   * cannot drift out of step with the rest of the frame clock.
   */
  drawBarrier() {
    const g = this.barrierGfx;
    g.clear();

    // 0.8 Hz: slow enough to read as a field humming rather than a UI blink.
    const pulse = 0.5 + 0.5 * Math.sin(this.time * BARRIER.PULSE_RATE);
    const w = WORLD.WIDTH;
    const h = WORLD.HEIGHT;

    // Outer haze — wide, dim, and drawn OUTSIDE the play area so it never sits
    // between the player and an enemy they are trying to read.
    g.rect(-BARRIER.HAZE_WIDTH / 2, -BARRIER.HAZE_WIDTH / 2, w + BARRIER.HAZE_WIDTH, h + BARRIER.HAZE_WIDTH);
    g.stroke({
      color: PIXI_TINT.heroRim,
      width: BARRIER.HAZE_WIDTH,
      alpha: BARRIER.HAZE_ALPHA * (0.6 + 0.4 * pulse),
    });

    // The barrier proper.
    g.rect(0, 0, w, h);
    g.stroke({
      color: PIXI_TINT.heroRim,
      width: BARRIER.LINE_WIDTH,
      alpha: BARRIER.LINE_ALPHA * (0.7 + 0.3 * pulse),
    });

    // Inner containment line, a touch inside, to give the field depth.
    g.rect(BARRIER.INSET, BARRIER.INSET, w - BARRIER.INSET * 2, h - BARRIER.INSET * 2);
    g.stroke({ color: PIXI_TINT.border, width: 1, alpha: 0.35 });

    // Corner rivets: open brackets that leave the corner itself clear, so the
    // mark frames the corner instead of filling it.
    const arm = BARRIER.RIVET_ARM;
    const corners = [
      [0, 0, 1, 1],
      [w, 0, -1, 1],
      [0, h, 1, -1],
      [w, h, -1, -1],
    ];
    for (const [cx, cy, sx, sy] of corners) {
      g.moveTo(cx + sx * BARRIER.RIVET_GAP, cy);
      g.lineTo(cx + sx * arm, cy);
      g.moveTo(cx, cy + sy * BARRIER.RIVET_GAP);
      g.lineTo(cx, cy + sy * arm);
    }
    g.stroke({
      color: PIXI_TINT.heroRim,
      width: BARRIER.RIVET_WIDTH,
      alpha: 0.35 + 0.45 * pulse,
    });
  }

  /**
   * The Dart Ravager's lock-on warning.
   *
   * Drawn for exactly as long as the simulation holds the enemy in its WINDUP
   * state, which is the same window the player has to step out of the line —
   * so the warning cannot drift out of sync with the dodge it is warning about.
   *
   * Two marks, each doing a different job: a shrinking ring over the Ravager is
   * a countdown, and a line along its locked heading says WHICH WAY it is about
   * to go. The ring alone tells the player something is coming but not where
   * from, which is the wrong half of the information.
   */
  drawLockOns() {
    if (!this.lockGfx) {
      this.lockGfx = new Graphics();
      this.layers.telegraph.addChild(this.lockGfx);
    }
    const g = this.lockGfx;
    g.clear();

    for (const enemy of this.sim.enemies) {
      if (!enemy.alive || enemy.chargeState !== CHARGE_STATE.WINDUP) continue;

      const view = getEnemyView(enemy.typeId);
      const lock = view?.lockOn;
      if (!lock) continue;

      const reach = enemy.radius * 6;
      g.moveTo(enemy.x, enemy.y);
      g.lineTo(enemy.x + enemy.chargeDirX * reach, enemy.y + enemy.chargeDirY * reach);
      g.stroke({ color: lock.tint, width: 1.5, alpha: 0.5 });

      // Rings collapse inward as the wind-up runs out, so the radius is a
      // clock the player can read without counting anything.
      const def = ENEMIES[enemy.typeId];
      const remaining = clamp(enemy.chargeTimer / (def?.chargeWindup || 1), 0, 1);
      for (let i = 0; i < lock.rings; i++) {
        const spread = 1 + i * 0.6;
        g.circle(enemy.x, enemy.y, enemy.radius * (1.4 + remaining * 2.2 * spread));
      }
      g.stroke({ color: lock.tint, width: 2, alpha: 0.35 + (1 - remaining) * 0.5 });
    }
  }

  drawHazards() {
    const g = this.hazardGfx;
    g.clear();

    for (const pool of this.sim.sporePools) {
      if (!pool.alive) continue;
      const fade = Math.min(1, pool.life / 1.0);
      g.circle(pool.x, pool.y, pool.radius);
      g.fill({ color: PIXI_TINT.hazard, alpha: 0.3 * fade });
      g.circle(pool.x, pool.y, pool.radius * (0.55 + Math.sin(this.time * 2) * 0.04));
      g.stroke({ color: PIXI_TINT.hazardRim, width: 1.5, alpha: 0.5 * fade });
    }
  }

  /**
   * The Bio-Acid Bloom warning circle.
   *
   * Three rings, and each one is doing a different job:
   *
   *   - The FILLED disc grows with `progress`, so its radius is a clock. The
   *     player reads time-to-impact off how close the fill is to the outline,
   *     not off a number.
   *   - The OUTLINE sits at the final radius from frame one, so the danger
   *     zone's edge never moves. A telegraph whose boundary grows is one the
   *     player cannot commit to standing outside of.
   *   - The inner ACID ring is decoration: a second, faster pulse that makes
   *     the AoE read as biological rather than as a UI overlay.
   *
   * The colour is deliberately outside the Swarm's darkness ceiling — see the
   * note in theme.js on why signals are exempt.
   */
  drawTelegraph() {
    const g = this.telegraphGfx;
    g.clear();

    const tele = this.sim.bossTelegraph;
    if (!tele || !tele.active) return;

    const progress = Math.min(1, tele.elapsedMs / tele.totalMs);

    g.circle(tele.x, tele.y, tele.radius * progress);
    g.fill({ color: PIXI_TINT.danger, alpha: 0.18 + progress * 0.16 });

    // Urgency ramps with progress: the flicker gets faster as the AoE nears.
    const pulse = 0.55 + Math.sin(this.time * (6 + progress * 14)) * 0.25;
    g.circle(tele.x, tele.y, tele.radius);
    g.stroke({ color: PIXI_TINT.danger, width: 3, alpha: pulse });

    const acidPulse = 0.35 + Math.sin(this.time * (9 + progress * 18)) * 0.2;
    g.circle(tele.x, tele.y, tele.radius * (0.82 + Math.sin(this.time * 3.5) * 0.04));
    g.stroke({ color: PIXI_TINT.acid, width: 1.5, alpha: acidPulse });
  }

  drawEffects() {
    const g = this.effectGfx;
    g.clear();

    for (const fx of this.sim.effects) {
      if (!fx.alive) continue;
      const progress = 1 - fx.life / fx.maxLife;
      const color = fx.kind === 'tide' ? PIXI_TINT.graviton : PIXI_TINT.pulse;
      const radius = fx.radius * (0.55 + progress * 0.45);

      g.circle(fx.x, fx.y, radius);
      g.fill({ color, alpha: (1 - progress) * 0.1 });
      g.circle(fx.x, fx.y, radius);
      g.stroke({ color, width: fx.kind === 'tide' ? 5 : 3, alpha: (1 - progress) * 0.75 });
    }
  }

  drawBeam() {
    const g = this.beamGfx;
    g.clear();

    const beam = this.sim.cards.getBeamState();
    if (!beam) return;

    g.setTransform?.(1, 0, 0, 1, 0, 0);
    g.position.set(0, 0);
    g.rotation = 0;

    // Tesla Arc / Chain Lightning: draw jagged neon electric arcs
    const origin = beam.origin || this.sim.state.player;
    const chain = beam.chain && beam.chain.length > 0 ? beam.chain : null;

    if (chain) {
      let currentFrom = origin;
      for (let c = 0; c < chain.length; c++) {
        const target = chain[c];
        const dist = Math.hypot(target.x - currentFrom.x, target.y - currentFrom.y);
        const steps = Math.max(3, Math.min(8, Math.floor(dist / 28)));
        const normalX = -(target.y - currentFrom.y) / (dist || 1);
        const normalY = (target.x - currentFrom.x) / (dist || 1);

        // Compute jagged midpoints along the arc
        const points = [{ x: currentFrom.x, y: currentFrom.y }];
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          const jitter =
            (Math.sin(s * 7.1 + this.time * 25 + c * 3) * 11 + ((s % 2 === 0 ? 1 : -1) * 7)) *
            (1 - Math.abs(t - 0.5) * 0.4);
          points.push({
            x: currentFrom.x + (target.x - currentFrom.x) * t + normalX * jitter,
            y: currentFrom.y + (target.y - currentFrom.y) * t + normalY * jitter,
          });
        }
        points.push({ x: target.x, y: target.y });

        // Outer electric glow (neon cyan/purple)
        const outerColor = c === 0 ? 0x00f0ff : 0xa855f7;
        const innerColor = 0xe0f7fa;

        for (let i = 0; i < points.length - 1; i++) {
          const pA = points[i];
          const pB = points[i + 1];
          g.moveTo(pA.x, pA.y);
          g.lineTo(pB.x, pB.y);
        }
        g.stroke({ color: outerColor, width: 4.5, alpha: 0.65 * beam.fade });

        // Inner hot core
        for (let i = 0; i < points.length - 1; i++) {
          const pA = points[i];
          const pB = points[i + 1];
          g.moveTo(pA.x, pA.y);
          g.lineTo(pB.x, pB.y);
        }
        g.stroke({ color: innerColor, width: 1.8, alpha: 0.95 * beam.fade });

        // Target impact spark halo
        g.circle(target.x, target.y, 9);
        g.fill({ color: outerColor, alpha: 0.5 * beam.fade });
        g.circle(target.x, target.y, 4);
        g.fill({ color: 0xffffff, alpha: 0.9 * beam.fade });

        currentFrom = target;
      }
    } else {
      // Fallback straight beam
      const player = this.sim.state.player;
      const angle = Math.atan2(beam.dy, beam.dx);
      g.position.set(player.x, player.y);
      g.rotation = angle;
      g.rect(0, -beam.width / 2, beam.length, beam.width);
      g.fill({ color: PIXI_TINT.danger, alpha: 0.32 * beam.fade });
      g.rect(0, -beam.width * 0.12, beam.length, beam.width * 0.24);
      g.fill({ color: PIXI_TINT.heroCore, alpha: 0.85 * beam.fade });
    }
  }

  /**
   * Aegis Satellites — real satellite bodies, one sprite each.
   *
   * These used to be `Graphics.ellipse` calls, which is why they read as soft
   * blue pills orbiting the ship: a filled ellipse has no facets, no panels and
   * no edges, so nothing about it said "machine". They are pooled and reused
   * across level-ups rather than rebuilt, because the count changes (2 at L1,
   * 6 at L5) every time the card is taken.
   */
  drawSatellites() {
    if (!this.satellites) this.satellites = [];

    const blades = this.sim.cards.blades;
    const texture = this.assets.get(ASSET_KEYS.AEGIS_SAT);

    while (this.satellites.length < blades.length) {
      const sprite = makeSprite(texture);
      sprite.tint = PIXI_TINT.aegis;
      this.layers.cardEffect.addChild(sprite);
      this.satellites.push(sprite);
    }

    for (let i = 0; i < this.satellites.length; i++) {
      const sprite = this.satellites[i];
      const blade = blades[i];
      if (!blade) {
        sprite.visible = false;
        continue;
      }

      sprite.visible = true;
      sprite.x = blade.x;
      sprite.y = blade.y;
      sprite.scale.set(scaleForRadius(sprite.texture, blade.radius, 1.5));
      // Each satellite holds its own bearing relative to the orbit, so the
      // ring reads as a formation of stationkeeping drones rather than as a
      // set of identical decals sliding round a circle.
      sprite.rotation =
        Math.atan2(blade.y - this.sim.state.player.y, blade.x - this.sim.state.player.x) +
        HULL_ROTATION_OFFSET;
    }
  }

  /**
   * Tactical Wingman escort drones.
   *
   * Pooled the same way as the satellites, and for the same reason: the count
   * changes with the card's level. They use a DIFFERENT hull frame from the
   * Drifter's, so an escort can never be mistaken for the player's own ship —
   * which is the failure mode of every "friendly copy of you" effect.
   */
  drawWingmen() {
    if (!this.wingmen) this.wingmen = [];

    const drones = this.sim.cards.drones;
    const texture = this.assets.get(ASSET_KEYS.WINGMAN);

    while (this.wingmen.length < drones.length) {
      const sprite = makeSprite(texture);
      sprite.tint = PIXI_TINT.heroTrail;
      sprite.alpha = 0.95;
      this.layers.cardEffect.addChild(sprite);
      this.wingmen.push(sprite);
    }

    for (let i = 0; i < this.wingmen.length; i++) {
      const sprite = this.wingmen[i];
      const drone = drones[i];
      if (!drone) {
        sprite.visible = false;
        continue;
      }

      sprite.visible = true;
      sprite.x = drone.x;
      sprite.y = drone.y;
      sprite.scale.set(scaleForRadius(sprite.texture, PLAYER_CFG.RADIUS, 1.5));
      // The drone points where its TURRET is aimed, which the card system
      // already computed — so the escort visibly tracks targets independently
      // of where the player is flying.
      sprite.rotation = drone.angle + HULL_ROTATION_OFFSET;
    }
  }

  /**
   * The Dreadnought's radial ordnance.
   *
   * One Graphics batch, same as the player's bolts: they are small, uniform,
   * and up to a hundred can be in flight, so one geometry beats a hundred
   * display objects. Painted in the danger red, never in a swarm carapace
   * colour — a bullet the player must dodge has to read as a warning.
   */
  drawEnemyBullets() {
    if (!this.enemyBulletGfx) {
      this.enemyBulletGfx = new Graphics();
      this.layers.projectile.addChild(this.enemyBulletGfx);
    }
    const g = this.enemyBulletGfx;
    g.clear();

    const bullets = this.sim.enemyBullets;
    if (!bullets || bullets.length === 0) return;

    // Outer glow first, hot core second, so each bullet has an edge against a
    // black backdrop and still reads at speed.
    for (const b of bullets) {
      if (!b.alive) continue;
      g.circle(b.x, b.y, b.radius * 1.6);
    }
    g.fill({ color: PIXI_TINT.danger, alpha: 0.25 });

    for (const b of bullets) {
      if (!b.alive) continue;
      g.circle(b.x, b.y, b.radius);
    }
    g.fill({ color: PIXI_TINT.danger, alpha: 0.95 });
  }

  /**
   * The Dreadnought's phase-3 death ray: warning cone, then the beam.
   *
   * THE CONE AND THE BEAM ARE THE SAME SHAPE. The warning is drawn at the angle
   * and width the beam will occupy, so what the player learns to avoid during
   * the telegraph is exactly what arrives — a telegraph that only approximates
   * its attack teaches the wrong lesson.
   */
  drawDeathRay() {
    if (!this.rayGfx) {
      this.rayGfx = new Graphics();
      // Above the hazard layer but below entities: the beam is a floor hazard,
      // not something that paints over the ship the player is trying to see.
      this.layers.telegraph.addChild(this.rayGfx);
    }
    const g = this.rayGfx;
    g.clear();

    const ray = this.sim.deathRay;
    if (!ray || !ray.active) return;

    g.position.set(ray.x, ray.y);
    g.rotation = ray.angle;

    if (!ray.firing) {
      // Wind-up: a thin, brightening warning strip. Its alpha is a clock, so
      // the player reads time-to-fire off how solid the line has become.
      const progress = Math.min(1, ray.elapsed / Math.max(ray.telegraphSec, 0.0001));
      const flicker = 0.35 + Math.sin(this.time * (14 + progress * 26)) * 0.2;

      g.rect(0, -ray.halfWidth, ray.length, ray.halfWidth * 2);
      g.fill({ color: PIXI_TINT.danger, alpha: 0.06 + progress * 0.12 });
      g.rect(0, -ray.halfWidth, ray.length, ray.halfWidth * 2);
      g.stroke({ color: PIXI_TINT.danger, width: 2, alpha: flicker * (0.4 + progress * 0.6) });
      return;
    }

    // Firing: three nested strips, hot core innermost, so the beam has depth
    // and a hard edge rather than being one flat red bar.
    const throb = 0.86 + Math.sin(this.time * 22) * 0.14;
    g.rect(0, -ray.halfWidth, ray.length, ray.halfWidth * 2);
    g.fill({ color: PIXI_TINT.danger, alpha: 0.3 * throb });
    g.rect(0, -ray.halfWidth * 0.55, ray.length, ray.halfWidth * 1.1);
    g.fill({ color: PIXI_TINT.hazardRim, alpha: 0.65 * throb });
    g.rect(0, -ray.halfWidth * 0.2, ray.length, ray.halfWidth * 0.4);
    g.fill({ color: PIXI_TINT.heroCore, alpha: 0.9 * throb });
  }

  drawHealthBars() {
    const g = this.healthGfx;
    g.clear();

    for (const enemy of this.sim.enemies) {
      if (!enemy.alive || enemy.hp >= enemy.maxHp) continue;
      // Boss health is displayed on the fixed top-screen HUD bar, not above its hull
      if (enemy.isBoss) continue;
      if (enemy.radius < HEALTH_BAR_MIN_RADIUS) continue;

      const width = enemy.radius * 2;
      const ratio = Math.max(0, enemy.hp / enemy.maxHp);
      const y = enemy.y - enemy.radius - 9;

      g.rect(enemy.x - enemy.radius, y, width, 3);
      g.fill({ color: PIXI_TINT.chitin, alpha: 0.75 });
      g.rect(enemy.x - enemy.radius, y, width * ratio, 3);
      g.fill({ color: PIXI_TINT.danger });
    }
  }

  /**
   * Motion trail. The GDD calls this out as the readability device that lets a
   * player find themselves in a crowd, which is why it has its own layer above
   * every enemy and effect.
   */
  drawTrail() {
    const g = this.trailGfx;
    g.clear();

    // The trail thickens and brightens on the states that matter. It is already
    // drawn every frame, so reacting to state costs one multiply and gives the
    // Drifter a sense of weight that a static sprite cannot.
    const intensity = trailIntensity(this.heroAnimator.state, this.heroAnimator.elapsed);

    for (let i = 0; i < this.trail.length - 1; i++) {
      const point = this.trail[i];
      const t = i / this.trail.length;
      // The wake cools as it dissipates: cyan at the engine, ion blue by the
      // time it is a few frames old. Index 0 is the OLDEST sample.
      const color = t < 0.45 ? PIXI_TINT.heroIon : PIXI_TINT.heroTrail;
      g.circle(point.x, point.y, PLAYER_CFG.RADIUS * t * 0.9 * intensity);
      g.fill({ color, alpha: Math.min(0.85, t * 0.35 * intensity) });
    }
  }

  /**
   * The Hyperion Shield — circular arc barrier encompassing the Drifter.
   * Uses Kenney shield texture and locks directly to the ship's facing direction.
   */
  drawShield() {
    const state = this.sim.cards.getShieldState();
    if (!this.shieldSprite) return;

    if (!state) {
      this.shieldSprite.visible = false;
      this.shieldGfx.clear();
      return;
    }

    if (this.assets && this.shieldSprite) {
      const shieldTex = this.assets.get(ASSET_KEYS.SHIELD);
      if (shieldTex && this.shieldSprite.texture !== shieldTex) {
        this.shieldSprite.texture = shieldTex;
      }
    }

    const player = this.sim.state.player;
    this.shieldSprite.x = this.heroSprite?.x ?? player.x;
    this.shieldSprite.y = this.heroSprite?.y ?? player.y;

    // Direct orientation to always face the exact same direction as the ship
    this.shieldSprite.rotation = this.heroSprite?.rotation ?? 0;

    const targetSize = PLAYER_CFG.RADIUS * 13.4;
    const texWidth = this.shieldSprite.texture?.width || 143;
    const baseScale = targetSize / texWidth;

    if (state.ready) {
      this.shieldSprite.visible = true;
      // Gentle breathing pulse (alpha 0.5 -> 0.8)
      const pulse = 0.65 + Math.sin(this.time * 3.2) * 0.15;
      this.shieldSprite.alpha = pulse;
      const scaleWobble = 1.0 + Math.sin(this.time * 2.2) * 0.025;
      this.shieldSprite.scale.set(baseScale * scaleWobble);
      this.shieldGfx.clear();
    } else {
      // Spent: faint ghost of the shield ring plus recharge progress arc
      this.shieldSprite.visible = true;
      const ratio = state.rechargeTime > 0 ? Math.max(0, 1 - state.timer / state.rechargeTime) : 1;
      this.shieldSprite.alpha = 0.12 + ratio * 0.22;
      this.shieldSprite.scale.set(baseScale * 0.95);

      const g = this.shieldGfx;
      g.clear();
      const radius = targetSize * 0.52;
      g.arc(player.x, player.y, radius, -Math.PI / 2, -Math.PI / 2 + ratio * Math.PI * 2);
      g.stroke({ color: PIXI_TINT.heroShield, width: 2, alpha: 0.2 + ratio * 0.45 });
    }
  }

  /** Release GPU resources. */
  destroy() {
    this.app.destroy(true, { children: true });
  }
}

export { THEME };
