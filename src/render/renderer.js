/**
 * Canvas 2D renderer (Phase 6 — Frutiger Aero/Aqua theme).
 *
 * Replaces the Phase 1-5 grey box. Responsibilities:
 *   - Frutiger Aero background: soft aqua gradient, drifting bubbles, light rays
 *   - Frutevil enemy sprites drawn procedurally (src/render/sprites.js)
 *   - Particle effects and trauma-based screen shake
 *   - STRICT layering per Z_ORDER, with the Dewling and its trail always last
 *
 * The Visual Soup mitigation from the Development Plan lives in two places:
 * the palette split enforced by theme.js, and the draw order enforced here.
 * Nothing is permitted to paint over the Dewling.
 */

import { WORLD, PLAYER_CFG } from '../core/constants.js';
import { clamp } from '../core/math.js';
import { THEME, getEnemyPalette, withAlpha } from './theme.js';
import { drawEnemy, drawDewling, drawOrb } from './sprites.js';
import { ParticleSystem } from './particles.js';
import { ScreenShake, TRAUMA } from './screen-shake.js';

const GRID_SIZE = 140;
const TRAIL_SAMPLES = 14;
/** Background bubbles are decorative only and drift in screen space. */
const BUBBLE_COUNT = 26;

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/simulation.js').Simulation} simulation
   * @param {Object} [options]
   * @param {() => Object} [options.getCosmetic] - Equipped Dewling cosmetic
   */
  constructor(canvas, simulation, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sim = simulation;
    this.getCosmetic = options.getCosmetic ?? (() => null);

    this.viewWidth = 0;
    this.viewHeight = 0;
    this.camera = { x: 0, y: 0 };
    this.trail = [];
    this.time = 0;

    this.particles = new ParticleSystem();
    this.shake = new ScreenShake();
    this.bubbles = makeBubbles(BUBBLE_COUNT);

    this.bindEvents();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Feedback is event-driven so the renderer never has to diff simulation
   * state to notice something happened.
   */
  bindEvents() {
    const bus = this.sim.bus;

    bus.on('enemy:damaged', (data) => {
      if (data.x === undefined) return;
      this.particles.burst(data.x, data.y, THEME.offence.dewdrop, 3);
      this.shake.add(TRAUMA.ENEMY_HIT);
    });

    bus.on('enemy:death', (data) => {
      this.particles.death(data.x, data.y, getEnemyPalette(data.typeId), data.radius);
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
      this.particles.ring(p.x, p.y, 90, THEME.hero.rim);
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
    bus.on('state:reset', () => {
      this.particles.clear();
      this.shake.reset();
      this.trail.length = 0;
    });
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.viewWidth = window.innerWidth;
    this.viewHeight = window.innerHeight;
    this.canvas.width = Math.floor(this.viewWidth * dpr);
    this.canvas.height = Math.floor(this.viewHeight * dpr);
    this.canvas.style.width = `${this.viewWidth}px`;
    this.canvas.style.height = `${this.viewHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Camera follows the Dewling, clamped so the arena edge never leaves a gap. */
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

  recordTrail() {
    const player = this.sim.state.player;
    this.trail.push({ x: player.x, y: player.y });
    if (this.trail.length > TRAIL_SAMPLES) this.trail.shift();
  }

  /**
   * @param {number} dt - Frame time in seconds
   */
  render(dt = 1 / 60) {
    this.time += dt;
    this.particles.update(dt);
    this.shake.update(dt);
    this.updateCamera();
    this.recordTrail();

    const ctx = this.ctx;
    this.drawBackground();

    ctx.save();
    this.shake.apply(ctx, this.viewWidth / 2, this.viewHeight / 2);
    ctx.translate(-this.camera.x, -this.camera.y);

    // Z_ORDER, low to high. The last two entries are non-negotiable.
    this.drawArena();
    this.drawSporePools();
    this.drawBossTelegraph();
    this.drawOrbs();
    this.drawAoeEffects();
    this.drawBeam();
    this.drawEnemies();
    this.drawProjectiles();
    this.drawBlades();
    this.particles.draw(ctx);
    this.drawTrail();
    this.drawPlayer();
    this.drawShield();

    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* Frutiger Aero background                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Deliberately simple: a two-stop vertical gradient with faint bubbles and
   * light rays. The Development Plan calls for a SIMPLIFIED background because
   * detail here is exactly what turns a busy screen into soup.
   */
  drawBackground() {
    const ctx = this.ctx;
    const gradient = ctx.createLinearGradient(0, 0, 0, this.viewHeight);
    gradient.addColorStop(0, THEME.background.top);
    gradient.addColorStop(1, THEME.background.bottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);

    // Aqua light rays from above.
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = THEME.background.ray;
    for (let i = 0; i < 4; i++) {
      const x = ((i + 0.5) / 4) * this.viewWidth + Math.sin(this.time * 0.15 + i) * 40;
      ctx.beginPath();
      ctx.moveTo(x - 70, 0);
      ctx.lineTo(x + 70, 0);
      ctx.lineTo(x + 200, this.viewHeight);
      ctx.lineTo(x - 200, this.viewHeight);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Drifting bubbles, screen-space so they read as atmosphere not parallax.
    ctx.save();
    for (const bubble of this.bubbles) {
      const y = (bubble.y - this.time * bubble.speed) % 1;
      const py = (y < 0 ? y + 1 : y) * this.viewHeight;
      const px = (bubble.x + Math.sin(this.time * 0.4 + bubble.phase) * 0.02) * this.viewWidth;

      ctx.globalAlpha = bubble.alpha;
      ctx.strokeStyle = THEME.background.bubble;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px, py, bubble.size, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawArena() {
    const ctx = this.ctx;

    ctx.strokeStyle = THEME.background.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const startX = Math.max(0, Math.floor(this.camera.x / GRID_SIZE) * GRID_SIZE);
    const endX = Math.min(WORLD.WIDTH, this.camera.x + this.viewWidth);
    for (let x = startX; x <= endX; x += GRID_SIZE) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, WORLD.HEIGHT);
    }
    const startY = Math.max(0, Math.floor(this.camera.y / GRID_SIZE) * GRID_SIZE);
    const endY = Math.min(WORLD.HEIGHT, this.camera.y + this.viewHeight);
    for (let y = startY; y <= endY; y += GRID_SIZE) {
      ctx.moveTo(0, y);
      ctx.lineTo(WORLD.WIDTH, y);
    }
    ctx.stroke();

    // Glass-edge arena boundary.
    ctx.strokeStyle = THEME.background.border;
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, WORLD.WIDTH, WORLD.HEIGHT);
    ctx.strokeStyle = withAlpha(THEME.hero.rim, 0.18);
    ctx.lineWidth = 1;
    ctx.strokeRect(4, 4, WORLD.WIDTH - 8, WORLD.HEIGHT - 8);
  }

  /* ------------------------------------------------------------------ */
  /* Hazards                                                             */
  /* ------------------------------------------------------------------ */

  /** Rustbloom toxic spore pools. */
  drawSporePools() {
    const ctx = this.ctx;

    for (const pool of this.sim.sporePools) {
      if (!pool.alive) continue;
      const fade = Math.min(1, pool.life / 1.0);

      ctx.globalAlpha = 0.3 * fade;
      ctx.fillStyle = THEME.frutevil.rust;
      ctx.beginPath();
      ctx.arc(pool.x, pool.y, pool.radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.5 * fade;
      ctx.strokeStyle = THEME.frutevil.rustRim;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(pool.x, pool.y, pool.radius * (0.55 + Math.sin(this.time * 2) * 0.04), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Rustwhale "Black Tide" telegraph.
   * The fill grows to fill the ring exactly as the strike lands, so the player
   * reads time-remaining from area rather than having to time a flash.
   */
  drawBossTelegraph() {
    const tele = this.sim.bossTelegraph;
    if (!tele || !tele.active) return;

    const ctx = this.ctx;
    const progress = Math.min(1, tele.elapsedMs / tele.totalMs);

    ctx.fillStyle = withAlpha(THEME.frutevil.warning, 0.22);
    ctx.beginPath();
    ctx.arc(tele.x, tele.y, tele.radius * progress, 0, Math.PI * 2);
    ctx.fill();

    // Pulsing boundary, faster as the strike approaches.
    const pulse = 0.55 + Math.sin(this.time * (6 + progress * 14)) * 0.25;
    ctx.strokeStyle = withAlpha(THEME.frutevil.warning, pulse);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(tele.x, tele.y, tele.radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  /* ------------------------------------------------------------------ */
  /* Entities                                                            */
  /* ------------------------------------------------------------------ */

  drawEnemies() {
    for (const enemy of this.sim.enemies) {
      if (!enemy.alive) continue;
      drawEnemy(this.ctx, enemy, this.time);
      if (showsHealthBar(enemy)) this.drawHealthBar(enemy);
    }
  }

  drawHealthBar(enemy) {
    const ctx = this.ctx;
    const width = enemy.radius * 2;
    const ratio = Math.max(0, enemy.hp / enemy.maxHp);
    const y = enemy.y - enemy.radius - 9;

    ctx.fillStyle = withAlpha(THEME.background.bottom, 0.8);
    ctx.fillRect(enemy.x - enemy.radius, y, width, 3);
    ctx.fillStyle = getEnemyPalette(enemy.typeId).rim;
    ctx.fillRect(enemy.x - enemy.radius, y, width * ratio, 3);
  }

  drawProjectiles() {
    const ctx = this.ctx;

    for (const p of this.sim.projectiles) {
      if (!p.alive) continue;

      // Motion streak behind the droplet.
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > 1) {
        const len = Math.min(16, speed * 0.03);
        const angle = Math.atan2(p.vy, p.vx);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(angle);
        ctx.fillStyle = withAlpha(THEME.offence.dewdrop, 0.35);
        ctx.fillRect(-len, -p.radius * 0.5, len, p.radius);
        ctx.restore();
      }

      ctx.fillStyle = THEME.offence.dewdrop;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawOrbs() {
    for (const orb of this.sim.orbs) {
      if (!orb.alive) continue;
      drawOrb(this.ctx, orb, this.time);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Card effects                                                        */
  /* ------------------------------------------------------------------ */

  drawAoeEffects() {
    const ctx = this.ctx;

    for (const fx of this.sim.effects) {
      if (!fx.alive) continue;
      const progress = 1 - fx.life / fx.maxLife;
      const color = fx.kind === 'tide' ? THEME.offence.tide : THEME.offence.pulse;

      ctx.strokeStyle = withAlpha(color, (1 - progress) * 0.75);
      ctx.lineWidth = fx.kind === 'tide' ? 5 : 3;
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, fx.radius * (0.55 + progress * 0.45), 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = withAlpha(color, (1 - progress) * 0.1);
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, fx.radius * (0.55 + progress * 0.45), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawBeam() {
    const beam = this.sim.cards.getBeamState();
    if (!beam) return;

    const ctx = this.ctx;
    const player = this.sim.state.player;
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(Math.atan2(beam.dy, beam.dx));

    const gradient = ctx.createLinearGradient(0, 0, beam.length, 0);
    gradient.addColorStop(0, withAlpha(THEME.offence.beam, 0.7 * beam.fade));
    gradient.addColorStop(1, withAlpha(THEME.offence.beam, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, -beam.width / 2, beam.length, beam.width);

    // Bright core line.
    ctx.fillStyle = withAlpha(THEME.hero.core, 0.55 * beam.fade);
    ctx.fillRect(0, -beam.width * 0.12, beam.length, beam.width * 0.24);
    ctx.restore();
  }

  drawBlades() {
    const ctx = this.ctx;

    for (const blade of this.sim.cards.blades) {
      ctx.fillStyle = withAlpha(THEME.offence.blade, 0.85);
      ctx.strokeStyle = withAlpha(THEME.hero.core, 0.7);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(blade.x, blade.y, blade.radius, blade.radius * 0.55, this.time * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  /* ------------------------------------------------------------------ */
  /* The Dewling — always last                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Motion trail. Not decoration: the GDD calls it out as the readability
   * device that lets a player find themselves in a crowd, which is why it sits
   * above every enemy and effect in the draw order.
   */
  drawTrail() {
    const ctx = this.ctx;

    for (let i = 0; i < this.trail.length - 1; i++) {
      const point = this.trail[i];
      const t = i / this.trail.length;
      ctx.fillStyle = withAlpha(THEME.hero.trail, t * 0.4);
      ctx.beginPath();
      ctx.arc(point.x, point.y, PLAYER_CFG.RADIUS * t * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawPlayer() {
    const player = this.sim.state.player;

    // Blink through invulnerability frames so the hit lands visually.
    if (this.sim.invulnTimer > 0 && Math.floor(this.sim.invulnTimer * 12) % 2 === 0) return;

    drawDewling(this.ctx, player.x, player.y, PLAYER_CFG.RADIUS, this.time, this.getCosmetic());
  }

  drawShield() {
    const charge = this.sim.cards.shieldCharge;
    if (charge <= 0) return;

    const stats = this.sim.cards.getStats('bloomshield');
    if (!stats) return;

    const ctx = this.ctx;
    const player = this.sim.state.player;
    const ratio = Math.max(0, Math.min(1, charge / stats.shieldHp));
    const radius = PLAYER_CFG.RADIUS + 13;

    ctx.strokeStyle = withAlpha(THEME.hero.shield, 0.3 + ratio * 0.55);
    ctx.lineWidth = 2 + ratio * 3;
    ctx.beginPath();
    ctx.arc(player.x, player.y, radius, -Math.PI / 2, -Math.PI / 2 + ratio * Math.PI * 2);
    ctx.stroke();

    // Faint petal ring so the shield reads as flowers, not a HUD gauge.
    ctx.fillStyle = withAlpha(THEME.hero.shield, 0.25 * ratio);
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + this.time * 0.8;
      ctx.beginPath();
      ctx.ellipse(
        player.x + Math.cos(angle) * radius,
        player.y + Math.sin(angle) * radius,
        4,
        2.2,
        angle,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  }
}

/**
 * Radius at or above which an enemy is tanky enough for its HP to be worth
 * reading. Rustbloom (20) and the Rustwhale (45) qualify; trash does not.
 */
const HEALTH_BAR_MIN_RADIUS = 18;

/**
 * Should this enemy show a health bar?
 *
 * Trash mobs die in one or two hits, so a bar tells the player nothing they
 * cannot see from the hit flash — but 200 of them is a field of tiny rust
 * ticks competing with the Dewling. Bars are reserved for enemies where the
 * remaining HP is actually a decision input.
 *
 * @param {Object} enemy
 * @returns {boolean}
 */
function showsHealthBar(enemy) {
  if (enemy.hp >= enemy.maxHp) return false;
  return enemy.isBoss || enemy.radius >= HEALTH_BAR_MIN_RADIUS;
}

/**
 * Background bubble field, in normalised 0..1 screen coordinates so it survives
 * a resize without regeneration.
 * @param {number} count
 */
function makeBubbles(count) {
  const bubbles = [];
  for (let i = 0; i < count; i++) {
    bubbles.push({
      x: Math.random(),
      y: Math.random(),
      size: 3 + Math.random() * 16,
      speed: 0.012 + Math.random() * 0.03,
      alpha: 0.1 + Math.random() * 0.22,
      phase: Math.random() * Math.PI * 2,
    });
  }
  return bubbles;
}

export { THEME };
