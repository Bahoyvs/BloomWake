/**
 * Canvas 2D renderer for BloomWake Phase 4.
 * Render Frutevil enemy roster, spore hazard pools, Boss telegraph warning circles,
 * and card visual effects.
 */

import { WORLD, PLAYER_CFG } from '../core/constants.js';
import { clamp } from '../core/math.js';
import { ENEMIES } from '../data/enemies.js';

export const PALETTE = {
  void: '#0d0f12',
  floor: '#16191e',
  grid: '#20242b',
  border: '#39404a',
  enemy: '#8b93a1',
  enemyOutline: '#c3cad6',
  enemyFlash: '#ffffff',
  player: '#dff3ff',
  playerRing: '#7fd4ff',
  trail: '#7fd4ff',
  projectile: '#eaf6ff',
  orb: '#b9f3c8',
  blade: '#cfe8ff',
  beam: '#fff3c4',
  pulse: '#a9d8ff',
  tide: '#8fe4d0',
  shield: '#ffd9a0',
  spore: '#854d0e',
  sporeInner: '#ca8a04',
  telegraph: '#ef4444',
  telegraphFill: 'rgba(239, 68, 68, 0.25)',
  bossHpBg: '#1f2937',
  bossHpFill: '#dc2626',
};

const GRID_SIZE = 100;
const TRAIL_SAMPLES = 10;

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/simulation.js').Simulation} simulation
   */
  constructor(canvas, simulation) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sim = simulation;
    this.viewWidth = 0;
    this.viewHeight = 0;
    this.camera = { x: 0, y: 0 };
    this.trail = [];

    this.resize();
    window.addEventListener('resize', () => this.resize());
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

  /** Record the Dewling's recent path */
  recordTrail() {
    const player = this.sim.state.player;
    this.trail.push({ x: player.x, y: player.y });
    if (this.trail.length > TRAIL_SAMPLES) this.trail.shift();
  }

  render() {
    this.updateCamera();
    this.recordTrail();

    const ctx = this.ctx;
    ctx.fillStyle = PALETTE.void;
    ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);

    ctx.save();
    ctx.translate(-this.camera.x, -this.camera.y);

    this.drawArena();
    this.drawSporePools();
    this.drawBossTelegraph();
    this.drawOrbs();
    this.drawAoeEffects();
    this.drawBeam();
    this.drawEnemies();
    this.drawProjectiles();
    this.drawBlades();
    this.drawPlayer();
    this.drawShield();

    ctx.restore();
  }

  /** Render toxic spore hazard pools from Rustbloom */
  drawSporePools() {
    const ctx = this.ctx;

    for (const pool of this.sim.sporePools) {
      if (!pool.alive) continue;
      const fade = Math.min(1, pool.life / 1.0);
      ctx.globalAlpha = 0.35 * fade;
      ctx.fillStyle = PALETTE.spore;
      ctx.beginPath();
      ctx.arc(pool.x, pool.y, pool.radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.6 * fade;
      ctx.fillStyle = PALETTE.sporeInner;
      ctx.beginPath();
      ctx.arc(pool.x, pool.y, pool.radius * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Render deterministic Boss Telegraph warning circle */
  drawBossTelegraph() {
    const tele = this.sim.bossTelegraph;
    if (!tele || !tele.active) return;

    const ctx = this.ctx;
    const progress = Math.min(1, tele.elapsedMs / tele.totalMs);

    // Expanding fill ring
    ctx.fillStyle = PALETTE.telegraphFill;
    ctx.beginPath();
    ctx.arc(tele.x, tele.y, tele.radius * progress, 0, Math.PI * 2);
    ctx.fill();

    // Outer warning border
    ctx.strokeStyle = PALETTE.telegraph;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(tele.x, tele.y, tele.radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** Expanding rings left by Aurora Pulse and Tidewave. */
  drawAoeEffects() {
    const ctx = this.ctx;

    for (const fx of this.sim.effects) {
      if (!fx.alive) continue;
      const progress = 1 - fx.life / fx.maxLife;
      ctx.globalAlpha = (1 - progress) * 0.7;
      ctx.strokeStyle = fx.kind === 'tide' ? PALETTE.tide : PALETTE.pulse;
      ctx.lineWidth = fx.kind === 'tide' ? 5 : 3;
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, fx.radius * (0.55 + progress * 0.45), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** Sunbeam Lance strip */
  drawBeam() {
    const beam = this.sim.cards.getBeamState();
    if (!beam) return;

    const ctx = this.ctx;
    const player = this.sim.state.player;
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(Math.atan2(beam.dy, beam.dx));
    ctx.globalAlpha = 0.25 + beam.fade * 0.45;
    ctx.fillStyle = PALETTE.beam;
    ctx.fillRect(0, -beam.width / 2, beam.length, beam.width);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** Glasswing blades orbiting the Dewling. */
  drawBlades() {
    const ctx = this.ctx;
    ctx.fillStyle = PALETTE.blade;

    for (const blade of this.sim.cards.blades) {
      ctx.beginPath();
      ctx.arc(blade.x, blade.y, blade.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Bloomshield charge ring */
  drawShield() {
    const charge = this.sim.cards.shieldCharge;
    if (charge <= 0) return;

    const stats = this.sim.cards.getStats('bloomshield');
    if (!stats) return;

    const ctx = this.ctx;
    const player = this.sim.state.player;
    const ratio = Math.max(0, Math.min(1, charge / stats.shieldHp));
    ctx.strokeStyle = PALETTE.shield;
    ctx.globalAlpha = 0.35 + ratio * 0.5;
    ctx.lineWidth = 2 + ratio * 3;
    ctx.beginPath();
    ctx.arc(player.x, player.y, PLAYER_CFG.RADIUS + 11, -Math.PI / 2, -Math.PI / 2 + ratio * Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawArena() {
    const ctx = this.ctx;
    ctx.fillStyle = PALETTE.floor;
    ctx.fillRect(0, 0, WORLD.WIDTH, WORLD.HEIGHT);

    ctx.strokeStyle = PALETTE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const startX = Math.floor(this.camera.x / GRID_SIZE) * GRID_SIZE;
    const endX = Math.min(WORLD.WIDTH, this.camera.x + this.viewWidth);
    for (let x = Math.max(0, startX); x <= endX; x += GRID_SIZE) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, WORLD.HEIGHT);
    }
    const startY = Math.floor(this.camera.y / GRID_SIZE) * GRID_SIZE;
    const endY = Math.min(WORLD.HEIGHT, this.camera.y + this.viewHeight);
    for (let y = Math.max(0, startY); y <= endY; y += GRID_SIZE) {
      ctx.moveTo(0, y);
      ctx.lineTo(WORLD.WIDTH, y);
    }
    ctx.stroke();

    ctx.strokeStyle = PALETTE.border;
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, WORLD.WIDTH, WORLD.HEIGHT);
  }

  drawEnemies() {
    const ctx = this.ctx;

    for (const enemy of this.sim.enemies) {
      if (!enemy.alive) continue;
      const def = ENEMIES[enemy.typeId] || ENEMIES.tarling;
      const flashing = enemy.hitFlash > 0;

      ctx.fillStyle = flashing ? PALETTE.enemyFlash : (def.color || PALETTE.enemy);
      ctx.strokeStyle = enemy.isBoss ? '#ef4444' : PALETTE.enemyOutline;
      ctx.lineWidth = enemy.isBoss ? 4 : 2;

      if (def.shape === 'square') {
        const size = enemy.radius * 2;
        ctx.fillRect(enemy.x - enemy.radius, enemy.y - enemy.radius, size, size);
        ctx.strokeRect(enemy.x - enemy.radius, enemy.y - enemy.radius, size, size);
      } else if (def.shape === 'triangle') {
        ctx.beginPath();
        ctx.moveTo(enemy.x, enemy.y - enemy.radius);
        ctx.lineTo(enemy.x + enemy.radius, enemy.y + enemy.radius);
        ctx.lineTo(enemy.x - enemy.radius, enemy.y + enemy.radius);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(enemy.x, enemy.y, enemy.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      // Damage bar overlay for enemies & Boss
      if (enemy.hp < enemy.maxHp) {
        const barWidth = enemy.radius * (enemy.isBoss ? 3 : 2);
        const barHeight = enemy.isBoss ? 6 : 3;
        const ratio = Math.max(0, enemy.hp / enemy.maxHp);
        ctx.fillStyle = PALETTE.bossHpBg;
        ctx.fillRect(enemy.x - barWidth / 2, enemy.y - enemy.radius - 10, barWidth, barHeight);
        ctx.fillStyle = enemy.isBoss ? PALETTE.bossHpFill : '#e5eaf2';
        ctx.fillRect(enemy.x - barWidth / 2, enemy.y - enemy.radius - 10, barWidth * ratio, barHeight);
      }
    }
  }

  drawProjectiles() {
    const ctx = this.ctx;
    ctx.fillStyle = PALETTE.projectile;

    for (const p of this.sim.projectiles) {
      if (!p.alive) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawOrbs() {
    const ctx = this.ctx;
    ctx.fillStyle = PALETTE.orb;

    for (const orb of this.sim.orbs) {
      if (!orb.alive) continue;
      ctx.beginPath();
      ctx.moveTo(orb.x, orb.y - orb.radius);
      ctx.lineTo(orb.x + orb.radius, orb.y);
      ctx.lineTo(orb.x, orb.y + orb.radius);
      ctx.lineTo(orb.x - orb.radius, orb.y);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawPlayer() {
    const ctx = this.ctx;
    const player = this.sim.state.player;

    for (let i = 0; i < this.trail.length - 1; i++) {
      const point = this.trail[i];
      ctx.globalAlpha = (i / this.trail.length) * 0.35;
      ctx.fillStyle = PALETTE.trail;
      ctx.beginPath();
      ctx.arc(point.x, point.y, PLAYER_CFG.RADIUS * (i / this.trail.length), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Blink through invulnerability frames so the hit lands visually.
    if (this.sim.invulnTimer > 0 && Math.floor(this.sim.invulnTimer * 12) % 2 === 0) return;

    ctx.fillStyle = PALETTE.player;
    ctx.beginPath();
    ctx.arc(player.x, player.y, PLAYER_CFG.RADIUS, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = PALETTE.playerRing;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(player.x, player.y, PLAYER_CFG.RADIUS + 4, 0, Math.PI * 2);
    ctx.stroke();
  }
}
