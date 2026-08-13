/**
 * Procedural sprites (Phase 6).
 *
 * Everything is drawn with Canvas 2D paths rather than image assets. That keeps
 * the build tiny (a Basic Launch conversion benchmark), avoids an asset
 * pipeline, and lets every silhouette be tinted straight from the palette so
 * the contrast rule in theme.js can never be bypassed by a stray PNG.
 *
 * Each enemy gets a distinct SILHOUETTE, not just a distinct colour: at swarm
 * density the shape is what a player actually reads.
 */

import { THEME, getEnemyPalette, withAlpha } from './theme.js';

/**
 * Draw one Frutevil enemy.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} enemy - Simulation entity
 * @param {number} time - Seconds since run start, for idle animation
 */
export function drawEnemy(ctx, enemy, time) {
  const palette = getEnemyPalette(enemy.typeId);
  const flashing = enemy.hitFlash > 0;
  const r = enemy.radius;

  ctx.save();
  ctx.translate(enemy.x, enemy.y);

  // A hit blanches the silhouette rather than tinting it, so damage reads even
  // on the darkest enemies without breaking the luminance rule for long.
  ctx.fillStyle = flashing ? withAlpha(THEME.frutevil.warning, 0.85) : palette.fill;
  ctx.strokeStyle = palette.rim;
  ctx.lineWidth = 1.5;

  switch (enemy.typeId) {
    case 'ashfish':
      drawAshfish(ctx, r, time, enemy.id);
      break;
    case 'cracked_wisp':
      drawCrackedWisp(ctx, r, time, enemy.id);
      break;
    case 'rustbloom':
      drawRustbloom(ctx, r, time, enemy.id);
      break;
    case 'smogmoth':
      drawSmogmoth(ctx, r, time, enemy.id);
      break;
    case 'rustwhale':
      drawRustwhale(ctx, r, time);
      break;
    case 'tarling':
    default:
      drawTarling(ctx, r, time, enemy.id);
      break;
  }

  ctx.restore();
}

/** Oily black droplet with a greasy sheen. */
function drawTarling(ctx, r, time, id) {
  const wobble = Math.sin(time * 4 + id) * 0.08;

  ctx.beginPath();
  ctx.moveTo(0, -r * (1.15 + wobble));
  ctx.bezierCurveTo(r * 0.95, -r * 0.35, r * 0.8, r, 0, r);
  ctx.bezierCurveTo(-r * 0.8, r, -r * 0.95, -r * 0.35, 0, -r * (1.15 + wobble));
  ctx.fill();
  ctx.stroke();

  // Oil-slick highlight: the only light on a Frutevil, kept small and dim.
  ctx.fillStyle = withAlpha(THEME.frutevil.tarRim, 0.55);
  ctx.beginPath();
  ctx.ellipse(-r * 0.28, -r * 0.25, r * 0.2, r * 0.32, -0.5, 0, Math.PI * 2);
  ctx.fill();
}

/** Ash-grey dead fish, drifting on its side. */
function drawAshfish(ctx, r, time, id) {
  const tail = Math.sin(time * 5 + id) * 0.5;

  ctx.beginPath();
  ctx.ellipse(0, 0, r * 1.25, r * 0.66, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Tail fin.
  ctx.beginPath();
  ctx.moveTo(-r * 1.15, 0);
  ctx.lineTo(-r * 1.9, -r * 0.55 + tail * r * 0.2);
  ctx.lineTo(-r * 1.9, r * 0.55 + tail * r * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Dead eye — a hollow ring, no pupil.
  ctx.strokeStyle = THEME.frutevil.ashRim;
  ctx.beginPath();
  ctx.arc(r * 0.55, -r * 0.12, r * 0.16, 0, Math.PI * 2);
  ctx.stroke();
}

/** Cracked glass shard spirit — angular, unlike everything else. */
function drawCrackedWisp(ctx, r, time, id) {
  const spin = time * 1.6 + id;
  ctx.rotate(spin);

  ctx.beginPath();
  ctx.moveTo(0, -r * 1.3);
  ctx.lineTo(r * 0.95, -r * 0.15);
  ctx.lineTo(r * 0.5, r * 1.15);
  ctx.lineTo(-r * 0.6, r * 1.05);
  ctx.lineTo(-r, -r * 0.25);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Fracture lines.
  ctx.strokeStyle = withAlpha(THEME.frutevil.shardRim, 0.75);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, -r * 1.1);
  ctx.lineTo(r * 0.15, r * 0.2);
  ctx.lineTo(-r * 0.45, r * 0.85);
  ctx.moveTo(r * 0.15, r * 0.2);
  ctx.lineTo(r * 0.75, -r * 0.05);
  ctx.stroke();
}

/** Rusted, wilting flower that squats in place. */
function drawRustbloom(ctx, r, time, id) {
  const breathe = 1 + Math.sin(time * 2 + id) * 0.05;
  const petals = 6;

  for (let i = 0; i < petals; i++) {
    const angle = (i / petals) * Math.PI * 2 + Math.sin(time * 0.6 + id) * 0.1;
    ctx.save();
    ctx.rotate(angle);
    ctx.beginPath();
    // Drooping petal: control points pull downward-outward.
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(r * 0.55 * breathe, -r * 0.5, r * 1.15 * breathe, r * 0.25);
    ctx.quadraticCurveTo(r * 0.5 * breathe, r * 0.4, 0, 0);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Spore-bearing core.
  ctx.fillStyle = THEME.frutevil.rustRim;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.36 * breathe, 0, Math.PI * 2);
  ctx.fill();
}

/** Soot moth with a torn wing. */
function drawSmogmoth(ctx, r, time, id) {
  const flap = Math.abs(Math.sin(time * 9 + id));
  const span = r * (0.55 + flap * 0.75);

  for (const side of [-1, 1]) {
    ctx.save();
    ctx.scale(side, 1);
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.15);
    ctx.quadraticCurveTo(span * 1.5, -r * 1.2, span * 1.7, r * 0.1);
    // The torn edge: a notch on the trailing side.
    ctx.lineTo(span * 1.15, r * 0.05);
    ctx.lineTo(span * 1.3, r * 0.6);
    ctx.quadraticCurveTo(span * 0.5, r * 0.7, 0, r * 0.25);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Body.
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.26, r * 0.72, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/** The Rustwhale: a corrupted leviathan, drawn big and slow. */
function drawRustwhale(ctx, r, time) {
  const surge = Math.sin(time * 1.4) * 0.05;

  // Body.
  ctx.beginPath();
  ctx.ellipse(0, 0, r * (1.35 + surge), r * 0.82, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Tail flukes.
  ctx.beginPath();
  ctx.moveTo(-r * 1.25, 0);
  ctx.lineTo(-r * 2.15, -r * 0.85);
  ctx.lineTo(-r * 1.6, 0);
  ctx.lineTo(-r * 2.15, r * 0.85);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Rusted plating ridges.
  ctx.strokeStyle = withAlpha(THEME.frutevil.whaleRim, 0.7);
  ctx.lineWidth = 1.5;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(i * r * 0.42, -r * 0.66);
    ctx.quadraticCurveTo(i * r * 0.42 + r * 0.1, 0, i * r * 0.42, r * 0.66);
    ctx.stroke();
  }

  // Single sunken eye.
  ctx.fillStyle = THEME.frutevil.warning;
  ctx.beginPath();
  ctx.arc(r * 0.85, -r * 0.2, r * 0.12, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * The Dewling: layered translucent Aqua bubble.
 *
 * Drawn last of everything (Z_ORDER.PLAYER) and built from the brightest
 * colours in the palette, so it stays the visual anchor at any enemy count.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} radius
 * @param {number} time
 * @param {Object} [cosmetic] - Equipped cosmetic {tint, ring}
 */
export function drawDewling(ctx, x, y, radius, time, cosmetic = null) {
  const body = cosmetic?.tint ?? THEME.hero.body;
  const rim = cosmetic?.ring ?? THEME.hero.rim;
  const bob = Math.sin(time * 3) * 0.04;
  const r = radius * (1 + bob);

  ctx.save();
  ctx.translate(x, y);

  // Outer halo — soft, wide, unmistakable at a glance.
  const halo = ctx.createRadialGradient(0, 0, r * 0.6, 0, 0, r * 3.1);
  halo.addColorStop(0, withAlpha(rim, 0.42));
  halo.addColorStop(0.5, withAlpha(rim, 0.12));
  halo.addColorStop(1, withAlpha(rim, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, r * 3.1, 0, Math.PI * 2);
  ctx.fill();

  // Water body with a vertical light gradient.
  const bodyFill = ctx.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.1, 0, 0, r);
  bodyFill.addColorStop(0, THEME.hero.core);
  bodyFill.addColorStop(0.55, body);
  bodyFill.addColorStop(1, withAlpha(rim, 0.9));
  ctx.fillStyle = bodyFill;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();

  // Refraction ring.
  ctx.strokeStyle = withAlpha(THEME.hero.core, 0.9);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.98, 0, Math.PI * 2);
  ctx.stroke();

  // Specular highlight — the classic Frutiger Aqua glass dot.
  ctx.fillStyle = withAlpha(THEME.hero.specular, 0.95);
  ctx.beginPath();
  ctx.ellipse(-r * 0.32, -r * 0.38, r * 0.22, r * 0.16, -0.6, 0, Math.PI * 2);
  ctx.fill();

  // Small secondary glint.
  ctx.fillStyle = withAlpha(THEME.hero.specular, 0.5);
  ctx.beginPath();
  ctx.arc(r * 0.35, r * 0.3, r * 0.09, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/**
 * XP orb: a small Aqua droplet with a bright core.
 * @param {CanvasRenderingContext2D} ctx
 */
export function drawOrb(ctx, orb, time) {
  const pulse = 1 + Math.sin(time * 6 + orb.id) * 0.12;
  const r = orb.radius * pulse;

  ctx.fillStyle = withAlpha(THEME.pickup.orb, 0.35);
  ctx.beginPath();
  ctx.arc(orb.x, orb.y, r * 1.9, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = THEME.pickup.orb;
  ctx.beginPath();
  ctx.arc(orb.x, orb.y, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = THEME.pickup.orbCore;
  ctx.beginPath();
  ctx.arc(orb.x - r * 0.25, orb.y - r * 0.25, r * 0.35, 0, Math.PI * 2);
  ctx.fill();
}
