/**
 * PixiJS sprite renderer (Phase 6b).
 *
 * Replaces the Phase 6 immediate-mode Canvas 2D renderer. Entities are sprites;
 * only VFX with no authored art (AoE rings, beam, blades, telegraph, arena
 * edge) remain vector, drawn as PIXI.Graphics.
 *
 * LAYERING
 * Z_ORDER from theme.js is realised as real Containers added in order, so the
 * Visual Soup rule — nothing paints above the Dewling — is now structural
 * rather than a convention about call order. Adding a draw call in the wrong
 * place cannot break it; you would have to add it to the wrong container.
 *
 * PERFORMANCE
 * Sprites are pooled per texture key and parked with `visible = false` instead
 * of being removed, so a wave wipe costs no display-list churn. Pixi batches
 * same-texture sprites automatically, which is the whole reason for the pivot.
 */

import { Application, Container, Graphics, Sprite, TilingSprite } from 'pixi.js';
import { WORLD, PLAYER_CFG } from '../core/constants.js';
import { clamp } from '../core/math.js';
import { assets as defaultAssets, ASSET_KEYS } from '../core/assets.js';
import { EVENTS } from '../core/event-bus.js';
import {
  ANIM_STATES,
  DEWLING_ENTITY_ID,
  DEWLING_PRIORITY,
  RUSTWHALE_PRIORITY,
} from '../core/animation.js';
import { SpriteAnimator } from './spriteAnimator.js';
import { createSlicer, formatMissingSheetReport, loadAnimationManifests } from './sheet-probe.js';
import { applyJuice, createTransform, sharedCycleFrame, DEATH_DISSOLVE_SEC } from './juice.js';
import { THEME, getEnemyPalette } from './theme.js';
import {
  makeSprite,
  scaleForRadius,
  syncEnemySprite,
  getEnemySpriteConfig,
  enemyTextureKey,
  cosmeticTint,
  HERO_TEXTURE_KEY,
  PIXI_TINT,
  NO_TINT,
  DAMAGE_TINT,
} from './sprites.js';
import { ParticleSystem } from './particles.js';
import { ScreenShake, TRAUMA } from './screen-shake.js';

const TRAIL_SAMPLES = 14;
const GRID_SIZE = 140;
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
    this.camera = { x: 0, y: 0 };
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
     * ONE transform reused for every enemy in the frame. Allocating per enemy
     * would be 200 objects a frame; this is the single object Tier B mutates.
     */
    this.juiceTransform = createTransform();

    /** Tier A: exactly two possible animators, ever. */
    this.heroAnimator = new SpriteAnimator(this.tierA?.dewling ?? {}, {
      priority: DEWLING_PRIORITY,
      slice: this.slice,
    });
    this.bossAnimator = null;
    /** Boss entity id currently bound to bossAnimator. */
    this.bossId = null;
    /** Last non-zero horizontal travel of the Dewling, for the sprite flip. */
    this.lastPlayerDx = 0;
    this.lastPlayerX = undefined;

    /**
     * Views of enemies that have died but are still dissolving. The simulation
     * entity is recycled inside the same tick it dies, so the view carries its
     * own snapshot of the fields deathDissolve needs.
     */
    this.dyingViews = [];

    this.shake = new ScreenShake();
    this.particles = new ParticleSystem(this.assets);

    this.buildStage();
    this.bindEvents();
    this.resize();
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

    const app = new Application();
    await app.init({
      canvas,
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: 0x03080f,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      // The game drives its own fixed-step loop; Pixi should not also tick.
      autoStart: false,
    });
    return new Renderer(app, simulation, { ...options, animation });
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
      projectile: new Container(),
      cardEffect: new Container(),
      particle: this.particles.container,
      playerTrail: new Container(),
      player: new Container(),
    };

    for (const layer of Object.values(this.layers)) this.world.addChild(layer);

    this.buildBackground();
    this.buildArena();
    this.buildVectorLayers();
    this.buildPlayer();
  }

  buildBackground() {
    const texture = this.assets.get(ASSET_KEYS.BG_AQUA);
    if (texture) {
      this.backdrop = new TilingSprite({
        texture,
        width: window.innerWidth,
        height: window.innerHeight,
      });
      this.backgroundLayer.addChild(this.backdrop);
    }
  }

  buildArena() {
    this.arenaGfx = new Graphics();
    this.layers.arena.addChild(this.arenaGfx);
    this.drawArena();
  }

  /** One reusable Graphics per vector effect; cleared and redrawn per frame. */
  buildVectorLayers() {
    this.hazardGfx = new Graphics();
    this.telegraphGfx = new Graphics();
    this.effectGfx = new Graphics();
    this.beamGfx = new Graphics();
    this.bladeGfx = new Graphics();
    this.healthGfx = new Graphics();
    this.trailGfx = new Graphics();
    this.shieldGfx = new Graphics();

    this.layers.hazard.addChild(this.hazardGfx);
    this.layers.telegraph.addChild(this.telegraphGfx);
    this.layers.cardEffect.addChild(this.effectGfx, this.beamGfx, this.bladeGfx);
    this.layers.enemy.addChild(this.healthGfx);
    this.layers.playerTrail.addChild(this.trailGfx);
    this.layers.player.addChild(this.shieldGfx);
  }

  buildPlayer() {
    this.heroSprite = makeSprite(this.assets.get(HERO_TEXTURE_KEY));
    this.layers.player.addChild(this.heroSprite);
  }

  bindEvents() {
    const bus = this.sim.bus;

    bus.on('enemy:damaged', (data) => {
      if (data.x === undefined) return;
      this.particles.burst(data.x, data.y, THEME.offence.dewdrop, 3);
      this.shake.add(TRAUMA.ENEMY_HIT);
    });

    bus.on('enemy:death', (data) => {
      this.particles.death(data.x, data.y, getEnemyPalette(data.typeId), data.radius);
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
        this.heroAnimator.requestState(state);
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
      this.particles.burst(p.x, p.y, THEME.frutevil.warning, 10);
      this.shake.add(TRAUMA.PLAYER_DAMAGE);
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
      this.particles.ring(x, y, data?.radius ?? 160, THEME.frutevil.warning);
      this.particles.burst(x, y, THEME.frutevil.warning, 18);
      this.shake.add(TRAUMA.BOSS_ERUPT);
    });

    bus.on('game:over', () => this.shake.add(TRAUMA.DEATH));
    bus.on('state:reset', () => this.resetVisuals());
  }

  resetVisuals() {
    this.particles.clear();
    this.shake.reset();
    this.trail.length = 0;
    for (const id of [...this.enemyViews.keys()]) this.releaseEnemyView(id);
    for (const view of this.dyingViews) this.parkSprite(view);
    this.dyingViews.length = 0;
    this.bossId = null;
    this.bossAnimator = null;
    this.heroAnimator.forceState(ANIM_STATES.IDLE);
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.app.renderer.resize(width, height);
    if (this.backdrop) {
      this.backdrop.width = width;
      this.backdrop.height = height;
    }
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
   * Take a sprite for a texture key, reusing a parked one when available.
   * @param {string} key
   * @returns {Sprite}
   */
  acquireSprite(key) {
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

    const sprite = makeSprite(this.assets.get(key));
    this.layers.enemy.addChild(sprite);
    return sprite;
  }

  /**
   * Park a sprite rather than destroying it — no display-list churn on a wipe.
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
    sprite.tint = NO_TINT;
    sprite.alpha = 1;
    sprite.rotation = 0;
    sprite.scale.set(view.baseScale);
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
    this.updateCamera();
    this.trackPlayerFacing();
    this.recordTrail();

    this.syncEnemies(dt);
    this.syncProjectiles();
    this.syncOrbs();

    this.drawHazards();
    this.drawTelegraph();
    this.drawEffects();
    this.drawBeam();
    this.drawBlades();
    this.drawHealthBars();
    this.drawTrail();
    this.drawPlayer(dt);
    this.drawShield();
    this.scrollBackdrop();

    // Camera + shake as one transform on the world container.
    this.world.x = -this.camera.x + this.shake.offsetX;
    this.world.y = -this.camera.y + this.shake.offsetY;
    this.world.rotation = this.shake.rotation;

    this.app.render();
  }

  updateCamera() {
    const player = this.sim.state.player;

    this.camera.x =
      this.viewWidth >= WORLD.WIDTH
        ? (WORLD.WIDTH - this.viewWidth) / 2
        : clamp(player.x - this.viewWidth / 2, 0, WORLD.WIDTH - this.viewWidth);

    this.camera.y =
      this.viewHeight >= WORLD.HEIGHT
        ? (WORLD.HEIGHT - this.viewHeight) / 2
        : clamp(player.y - this.viewHeight / 2, 0, WORLD.HEIGHT - this.viewHeight);
  }

  /** Parallax the backdrop slightly against camera motion. */
  scrollBackdrop() {
    if (!this.backdrop) return;
    this.backdrop.tilePosition.x = -this.camera.x * 0.25;
    this.backdrop.tilePosition.y = -this.camera.y * 0.25 + Math.sin(this.time * 0.1) * 8;
  }

  /**
   * Horizontal travel direction of the Dewling, for the Tier A sprite flip.
   *
   * The simulation stores the player's position but not its velocity, and
   * adding one purely for a render concern would push a render need into
   * src/core/. Differencing the position here keeps that boundary intact. The
   * zero-motion case deliberately leaves the last facing alone, so a Dewling
   * that stops does not snap back to facing right.
   */
  trackPlayerFacing() {
    const x = this.sim.state.player.x;
    if (this.lastPlayerX !== undefined) {
      const dx = x - this.lastPlayerX;
      if (dx !== 0) this.lastPlayerDx = dx;
    }
    this.lastPlayerX = x;
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
    const sprite = this.acquireSprite(key);
    const config = getEnemySpriteConfig(enemy.typeId);
    const baseScale = scaleForRadius(sprite.texture, enemy.radius, config.fit);
    sprite.scale.set(baseScale);
    sprite.alpha = 1;

    view = {
      sprite,
      baseScale,
      key,
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
      syncEnemySprite(view, enemy, this.juiceTransform);
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
   * TIER A for the boss. Bound lazily because the Rustwhale only exists on boss
   * waves, and rebound if a later wave spawns a new one.
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
      });
    }

    const sprite = view.sprite;
    sprite.x = boss.x;
    sprite.y = boss.y;
    sprite.alpha = 1;
    sprite.tint = boss.hitFlash > 0 ? DAMAGE_TINT : NO_TINT;

    this.bossAnimator.update(dt);
    this.bossAnimator.setFacing(boss.vx);
    if (this.bossAnimator.isFallback) {
      // Step A5 — no sheet for this state: keep the existing static sprite,
      // rotated to face travel as Phase 6b did.
      sprite.rotation = Math.atan2(boss.vy, boss.vx);
      sprite.scale.set(view.baseScale);
      return;
    }

    sprite.rotation = 0;
    this.bossAnimator.applyTo(sprite, view.baseScale);
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
  syncProjectiles() {
    if (!this.projectileGfx) {
      this.projectileGfx = new Graphics();
      this.layers.projectile.addChild(this.projectileGfx);
    }
    const g = this.projectileGfx;
    g.clear();

    for (const p of this.sim.projectiles) {
      if (!p.alive) continue;
      g.circle(p.x, p.y, p.radius);
    }
    g.fill({ color: PIXI_TINT.dewdrop, alpha: 0.95 });
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
   * TIER A for the Dewling.
   *
   * @param {number} dt - Frame time in seconds
   */
  drawPlayer(dt) {
    const player = this.sim.state.player;
    const sprite = this.heroSprite;

    // Blink through invulnerability frames so the hit lands visually.
    const blinking =
      this.sim.invulnTimer > 0 && Math.floor(this.sim.invulnTimer * 12) % 2 === 0;
    sprite.visible = !blinking;
    if (blinking) return;

    sprite.x = player.x;
    sprite.y = player.y;
    sprite.tint = cosmeticTint(this.getCosmetic());

    this.heroAnimator.update(dt);
    // Flip rather than mirrored frames: the sheet is authored facing +X only.
    this.heroAnimator.setFacing(this.lastPlayerDx);

    if (this.heroAnimator.isFallback) {
      // Step A5 — no sheet for this state, so the Phase 6b idle bob stands in.
      const bob = 1 + Math.sin(this.time * 3) * 0.04;
      sprite.scale.set(scaleForRadius(sprite.texture, PLAYER_CFG.RADIUS, 1.9) * bob);
      return;
    }

    this.heroAnimator.applyTo(
      sprite,
      scaleForRadius(sprite.texture, PLAYER_CFG.RADIUS, 1.9)
    );
  }

  /* ------------------------------------------------------------------ */
  /* Vector VFX (no authored art)                                        */
  /* ------------------------------------------------------------------ */

  drawArena() {
    const g = this.arenaGfx;
    g.clear();

    for (let x = 0; x <= WORLD.WIDTH; x += GRID_SIZE) {
      g.moveTo(x, 0).lineTo(x, WORLD.HEIGHT);
    }
    for (let y = 0; y <= WORLD.HEIGHT; y += GRID_SIZE) {
      g.moveTo(0, y).lineTo(WORLD.WIDTH, y);
    }
    g.stroke({ color: PIXI_TINT.grid, width: 1, alpha: 0.5 });

    g.rect(0, 0, WORLD.WIDTH, WORLD.HEIGHT);
    g.stroke({ color: PIXI_TINT.border, width: 3 });
    g.rect(4, 4, WORLD.WIDTH - 8, WORLD.HEIGHT - 8);
    g.stroke({ color: PIXI_TINT.heroRim, width: 1, alpha: 0.18 });
  }

  drawHazards() {
    const g = this.hazardGfx;
    g.clear();

    for (const pool of this.sim.sporePools) {
      if (!pool.alive) continue;
      const fade = Math.min(1, pool.life / 1.0);
      g.circle(pool.x, pool.y, pool.radius);
      g.fill({ color: PIXI_TINT.rust, alpha: 0.3 * fade });
      g.circle(pool.x, pool.y, pool.radius * (0.55 + Math.sin(this.time * 2) * 0.04));
      g.stroke({ color: PIXI_TINT.rustRim, width: 1.5, alpha: 0.5 * fade });
    }
  }

  drawTelegraph() {
    const g = this.telegraphGfx;
    g.clear();

    const tele = this.sim.bossTelegraph;
    if (!tele || !tele.active) return;

    const progress = Math.min(1, tele.elapsedMs / tele.totalMs);
    g.circle(tele.x, tele.y, tele.radius * progress);
    g.fill({ color: PIXI_TINT.warning, alpha: 0.22 });

    const pulse = 0.55 + Math.sin(this.time * (6 + progress * 14)) * 0.25;
    g.circle(tele.x, tele.y, tele.radius);
    g.stroke({ color: PIXI_TINT.warning, width: 3, alpha: pulse });
  }

  drawEffects() {
    const g = this.effectGfx;
    g.clear();

    for (const fx of this.sim.effects) {
      if (!fx.alive) continue;
      const progress = 1 - fx.life / fx.maxLife;
      const color = fx.kind === 'tide' ? PIXI_TINT.tide : PIXI_TINT.pulse;
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

    const player = this.sim.state.player;
    g.setTransform?.(1, 0, 0, 1, 0, 0);
    const angle = Math.atan2(beam.dy, beam.dx);

    // Build the strip in local space then rotate the Graphics object itself.
    g.rect(0, -beam.width / 2, beam.length, beam.width);
    g.fill({ color: PIXI_TINT.beam, alpha: 0.55 * beam.fade });
    g.rect(0, -beam.width * 0.12, beam.length, beam.width * 0.24);
    g.fill({ color: PIXI_TINT.heroCore, alpha: 0.55 * beam.fade });

    g.position.set(player.x, player.y);
    g.rotation = angle;
  }

  drawBlades() {
    const g = this.bladeGfx;
    g.clear();

    for (const blade of this.sim.cards.blades) {
      g.ellipse(blade.x, blade.y, blade.radius, blade.radius * 0.55);
    }
    g.fill({ color: PIXI_TINT.blade, alpha: 0.85 });
  }

  drawHealthBars() {
    const g = this.healthGfx;
    g.clear();

    for (const enemy of this.sim.enemies) {
      if (!enemy.alive || enemy.hp >= enemy.maxHp) continue;
      if (!enemy.isBoss && enemy.radius < HEALTH_BAR_MIN_RADIUS) continue;

      const width = enemy.radius * 2;
      const ratio = Math.max(0, enemy.hp / enemy.maxHp);
      const y = enemy.y - enemy.radius - 9;

      g.rect(enemy.x - enemy.radius, y, width, 3);
      g.fill({ color: 0x000000, alpha: 0.6 });
      g.rect(enemy.x - enemy.radius, y, width * ratio, 3);
      g.fill({ color: PIXI_TINT.warning });
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

    for (let i = 0; i < this.trail.length - 1; i++) {
      const point = this.trail[i];
      const t = i / this.trail.length;
      g.circle(point.x, point.y, PLAYER_CFG.RADIUS * t * 0.9);
      g.fill({ color: PIXI_TINT.heroTrail, alpha: t * 0.35 });
    }
  }

  drawShield() {
    const g = this.shieldGfx;
    g.clear();

    const charge = this.sim.cards.shieldCharge;
    if (charge <= 0) return;
    const stats = this.sim.cards.getStats('bloomshield');
    if (!stats) return;

    const player = this.sim.state.player;
    const ratio = Math.max(0, Math.min(1, charge / stats.shieldHp));
    const radius = PLAYER_CFG.RADIUS + 13;

    g.arc(player.x, player.y, radius, -Math.PI / 2, -Math.PI / 2 + ratio * Math.PI * 2);
    g.stroke({ color: PIXI_TINT.heroShield, width: 2 + ratio * 3, alpha: 0.3 + ratio * 0.55 });
  }

  /** Release GPU resources. */
  destroy() {
    this.app.destroy(true, { children: true });
  }
}

export { THEME };
