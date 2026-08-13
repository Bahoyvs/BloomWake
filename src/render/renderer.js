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
    return new Renderer(app, simulation, options);
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
      this.releaseEnemyView(data.id);
      if (data.isBoss) this.shake.add(TRAUMA.BOSS_SPAWN);
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
   * @param {number} id
   */
  releaseEnemyView(id) {
    const view = this.enemyViews.get(id);
    if (!view) return;

    view.sprite.visible = false;
    view.sprite.tint = NO_TINT;
    this.spritePools.get(view.key)?.push(view.sprite);
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
    this.recordTrail();

    this.syncEnemies();
    this.syncProjectiles();
    this.syncOrbs();

    this.drawHazards();
    this.drawTelegraph();
    this.drawEffects();
    this.drawBeam();
    this.drawBlades();
    this.drawHealthBars();
    this.drawTrail();
    this.drawPlayer();
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

  recordTrail() {
    const player = this.sim.state.player;
    this.trail.push({ x: player.x, y: player.y });
    if (this.trail.length > TRAIL_SAMPLES) this.trail.shift();
  }

  /* ------------------------------------------------------------------ */
  /* Entities                                                            */
  /* ------------------------------------------------------------------ */

  syncEnemies() {
    const player = this.sim.state.player;
    const seen = new Set();

    for (const enemy of this.sim.enemies) {
      if (!enemy.alive) continue;
      seen.add(enemy.id);

      let view = this.enemyViews.get(enemy.id);
      if (!view) {
        const key = enemyTextureKey(enemy.typeId);
        const sprite = this.acquireSprite(key);
        const config = getEnemySpriteConfig(enemy.typeId);
        const baseScale = scaleForRadius(sprite.texture, enemy.radius, config.fit);
        sprite.scale.set(baseScale);
        view = { sprite, baseScale, key };
        this.enemyViews.set(enemy.id, view);
      }

      syncEnemySprite(view, enemy, this.time, player);
    }

    // Enemies removed without a death event (wave wipe) still need parking.
    for (const id of [...this.enemyViews.keys()]) {
      if (!seen.has(id)) this.releaseEnemyView(id);
    }
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

  drawPlayer() {
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

    const bob = 1 + Math.sin(this.time * 3) * 0.04;
    sprite.scale.set(scaleForRadius(sprite.texture, PLAYER_CFG.RADIUS, 1.9) * bob);
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
