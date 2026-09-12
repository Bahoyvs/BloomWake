/**
 * Chitin Swarm visual mapping.
 *
 * The theme brief specifies a scale and a tint per species, and a chassis plus
 * a spin for the boss. Those are numbers someone will be tempted to "just
 * nudge" during a polish pass, and a nudge that lands a carapace outside the
 * palette's darkness band silently undoes the Visual Soup contract that
 * tests/theme.test.js protects. So the brief is pinned here.
 *
 * The composite tests use fake textures rather than real ones: everything
 * asserted is arithmetic on scale, rotation and layer order, none of which
 * needs a GPU. What they do need is PixiJS's Container/Sprite, which construct
 * fine in Node.
 */

import { describe, it, expect } from 'vitest';
import {
  DEATH_SPRAY,
  DREADNOUGHT,
  ENEMY_VIEW,
  HERO_TINT,
  HULL_ROTATION_OFFSET,
  NO_TINT,
  SWARM_REFERENCE_DIAMETER,
  THRUSTER,
  bioLuminance,
  createDreadnought,
  dreadnoughtPulse,
  enemyDiameter,
  enemyFit,
  enemyTint,
  getDreadnoughtParts,
  getEnemyView,
  thrusterFlame,
} from '../src/render/sprite-factory.js';
import { ENEMIES } from '../src/data/enemies.js';
import {
  MAX_ENEMY_LUMINANCE,
  MIN_HERO_LUMINANCE,
  PALETTE,
  THEME,
  relativeLuminance,
} from '../src/render/theme.js';

/** 0xrrggbb -> '#rrggbb' */
const asHex = (value) => `#${value.toString(16).padStart(6, '0')}`;
const fakeTexture = (width = 64, height = width) => ({ width, height });

describe('Species mapping', () => {
  const SPEC = {
    tarling: { name: 'Xeno Larva', klass: 'light', scale: 0.55 },
    cracked_wisp: { name: 'Dart Ravager', klass: 'light', scale: 0.75 },
    ashfish: { name: 'Mantis Strider', klass: 'medium', scale: 0.8 },
    smogmoth: { name: 'Phantom Stalker', klass: 'medium', scale: 0.95 },
    rustbloom: { name: 'Brood Spore', klass: 'heavy', scale: 1.15 },
    bio_goliath: { name: 'Bio-Goliath', klass: 'heavy', scale: 1.5 },
  };

  it.each(Object.entries(SPEC))('maps %s to its named class and scale', (id, spec) => {
    const view = getEnemyView(id);
    expect(view.name).toBe(spec.name);
    expect(view.class).toBe(spec.klass);
    expect(view.scale).toBeCloseTo(spec.scale, 6);
  });

  it('gives every enemy in the roster a view row and a tint', () => {
    for (const id of Object.keys(ENEMIES)) {
      expect(ENEMY_VIEW[id], id).toBeDefined();
      expect(enemyTint(id), id).not.toBe(NO_TINT);
    }
  });

  it('keeps every species tint inside the palette darkness band', () => {
    // The tints are Pixi ints here and hex strings in theme.js. If the two ever
    // disagreed, the swarm would render outside the band the palette tests
    // believe it is in — those tests check the strings, this checks the ints
    // that actually reach the GPU.
    for (const id of Object.keys(ENEMY_VIEW)) {
      expect(relativeLuminance(asHex(enemyTint(id))), id).toBeLessThanOrEqual(
        MAX_ENEMY_LUMINANCE
      );
    }
  });

  it('sizes each species off the shared reference, not off its hitbox', () => {
    expect(enemyDiameter('tarling')).toBeCloseTo(SWARM_REFERENCE_DIAMETER * 0.55, 6);
    expect(enemyDiameter('bio_goliath')).toBeCloseTo(SWARM_REFERENCE_DIAMETER * 1.5, 6);
  });

  it('derives fit from the collision radius so the two cannot drift apart', () => {
    // fit is what scaleForRadius consumes; it has to land the sprite on the
    // reference diameter whatever the hitbox happens to be.
    for (const [id, enemy] of Object.entries(ENEMIES)) {
      expect(enemyFit(id) * enemy.radius * 2, id).toBeCloseTo(enemyDiameter(id), 6);
    }
  });

  it('orders the roster by weight class, so size reads as threat', () => {
    // Relative order is what the player reads; the absolute numbers are tuning.
    // Compared on DIAMETER, not fit: fit is per-hitbox and deliberately not
    // monotonic — a small-radius dart needs a bigger multiplier than a cruiser.
    const size = (id) => enemyDiameter(id);
    expect(size('bio_goliath')).toBeGreaterThan(size('rustbloom'));
    expect(size('rustbloom')).toBeGreaterThan(size('smogmoth'));
    expect(size('smogmoth')).toBeGreaterThan(size('ashfish'));
    expect(size('ashfish')).toBeGreaterThan(size('cracked_wisp'));
    expect(size('cracked_wisp')).toBeGreaterThan(size('tarling'));
  });

  it('renders the chaff big enough to have a silhouette at all', () => {
    // The failure this replaces: sizing off the hitbox put the wave-1 enemy at
    // 28px, where a detailed hull is indistinguishable from a coloured dot.
    expect(enemyDiameter('tarling')).toBeGreaterThanOrEqual(34);
  });

  it('spans the full silhouette range the brief calls for', () => {
    // A roster clustered around one size is the failure this guards: the
    // player cannot triage a swarm whose members are all the same footprint.
    const scales = Object.values(ENEMY_VIEW)
      .filter((v) => v.class !== 'boss')
      .map((v) => v.scale);
    expect(Math.min(...scales)).toBeCloseTo(0.55, 6);
    expect(Math.max(...scales)).toBeCloseTo(1.5, 6);
    // The heaviest must be at least twice the footprint of the lightest.
    expect(Math.max(...scales) / Math.min(...scales)).toBeGreaterThanOrEqual(2);
  });

  it('gives all six swarm classes a distinct footprint', () => {
    // Six classes at six sizes is what lets the player triage a mixed wave by
    // silhouette alone, before any hue or detail has resolved.
    const swarm = Object.values(ENEMY_VIEW).filter((v) => v.class !== 'boss');
    expect(swarm).toHaveLength(6);
    expect(new Set(swarm.map((v) => v.scale)).size).toBe(6);
  });

  it('falls back to a neutral view for an unknown id rather than throwing', () => {
    expect(enemyTint('not_a_species')).toBe(NO_TINT);
    // No radius in the data table, so it renders at its hitbox size: odd
    // looking, never wrong-sized, and never NaN.
    expect(enemyFit('not_a_species')).toBe(1);
  });
});

describe('Hero hull wash', () => {
  it('keeps the hull inside the hero luminance band', () => {
    // The wash multiplies the frame, so it sets the ceiling on how bright the
    // ship can be. Below the floor and the Drifter stops being findable.
    expect(relativeLuminance(asHex(HERO_TINT))).toBeGreaterThanOrEqual(MIN_HERO_LUMINANCE);
  });

  it('is a wash, not the saturated neon', () => {
    // Painting the hull with raw heroPrimary would zero its red channel and
    // flatten every plate and canopy on the frame into one cyan shape.
    expect(HERO_TINT).not.toBe(PALETTE.heroPrimary);
    expect(relativeLuminance(asHex(HERO_TINT))).toBeGreaterThan(
      relativeLuminance(asHex(PALETTE.heroPrimary))
    );
  });

  it('spends the saturated neon on the engines instead', () => {
    expect(THRUSTER.tint).toBe(PALETTE.heroPrimary);
  });
});

describe('Engine flames', () => {
  it('grows and brightens with throttle', () => {
    const idle = thrusterFlame(0, 0);
    const burn = thrusterFlame(1, 0);
    expect(burn.length).toBeGreaterThan(idle.length);
    expect(burn.alpha).toBeGreaterThan(idle.alpha);
  });

  it('still shows a pilot light while coasting', () => {
    // A ship with momentum spends real time at zero throttle. Flames that cut
    // out entirely would read as the engines having failed.
    expect(thrusterFlame(0, 0).length).toBeGreaterThan(0);
    expect(thrusterFlame(0, 0).alpha).toBeGreaterThan(0);
  });

  it('clamps out-of-range throttle instead of extrapolating', () => {
    expect(thrusterFlame(-5, 0).length).toBeCloseTo(thrusterFlame(0, 0).length, 6);
    expect(thrusterFlame(9, 0).alpha).toBeCloseTo(thrusterFlame(1, 0).alpha, 6);
  });

  it('flickers under burn but holds steady at rest', () => {
    const burning = new Set();
    const coasting = new Set();
    for (let t = 0; t < 1; t += 0.01) {
      burning.add(thrusterFlame(1, t).length.toFixed(4));
      coasting.add(thrusterFlame(0, t).length.toFixed(4));
    }
    expect(burning.size).toBeGreaterThan(1);
    // At zero throttle the flicker is scaled out, so a parked ship does not
    // sit there strobing.
    expect(coasting.size).toBe(1);
  });
});

describe('Bioluminescent pulse', () => {
  it('never brightens an enemy past its painted luminance', () => {
    for (const id of Object.keys(ENEMY_VIEW)) {
      const view = getEnemyView(id);
      for (let t = 0; t < 6; t += 0.05) {
        const alpha = bioLuminance(t, 0, view);
        expect(alpha, `${id} @ ${t}`).toBeLessThanOrEqual(1);
        expect(alpha, `${id} @ ${t}`).toBeGreaterThan(0);
      }
    }
  });

  it('de-synchronises instances by phase offset, so a wall does not breathe as one', () => {
    const view = getEnemyView('tarling');
    expect(bioLuminance(1, 0, view)).not.toBeCloseTo(bioLuminance(1, 1.7, view), 3);
  });

  it('reads the Phantom Stalker cloak off the SIMULATION, not off a sine', () => {
    /*
     * The cloak used to be a free-running sine on the renderer's own clock,
     * which meant the moment the Stalker was hard to see had nothing to do
     * with where it was or what it was doing — decoration wearing a mechanic's
     * clothes. It is `entity.visibility` now, set by Simulation.updateCloak, so
     * the fade IS the mechanic and the reveal lands at the range the player can
     * actually react to.
     */
    const view = getEnemyView('smogmoth');
    const dark = bioLuminance(1, 0, view, { visibility: 0.2 });
    const lit = bioLuminance(1, 0, view, { visibility: 1 });

    expect(dark).toBeLessThan(lit * 0.35);
    // With no entity to read, it renders fully visible rather than vanishing.
    expect(bioLuminance(1, 0, view)).toBeGreaterThan(0.8);
  });

  it('leaves species without a cloak unaffected by an entity visibility', () => {
    const view = getEnemyView('tarling');
    expect(bioLuminance(1, 0, view, { visibility: 0.2 })).toBeCloseTo(
      bioLuminance(1, 0, view),
      9
    );
  });

  it('never fully hides the Phantom Stalker, which would make it undodgeable', () => {
    const view = getEnemyView('smogmoth');
    for (let t = 0; t < 8; t += 0.02) {
      expect(bioLuminance(t, 0, view, { visibility: 0.2 })).toBeGreaterThan(0.1);
    }
  });
});

describe('The Dreadnought Station composite', () => {
  const build = () =>
    createDreadnought(
      fakeTexture(64, 128), // keel: portrait cross
      fakeTexture(32), // turret platform
      fakeTexture(48), // reactor
      fakeTexture(160, 48) // beam: wide horizontal slab
    );

  it('lays the beam down first and the reactor last', () => {
    /*
     * Layer order is the design: the wide cross-member goes down first and is
     * the reason the station has shoulders at all, the turrets sit on it, the
     * keel covers the join so it reads as one welded structure, and the reactor
     * ends up IN the chassis rather than behind it.
     */
    const { container, spine, beam, turrets, reactor } = build();
    const at = (child) => container.children.indexOf(child);
    expect(at(beam)).toBeLessThan(at(turrets[0]));
    for (const turret of turrets) expect(at(turret)).toBeLessThan(at(spine));
    expect(at(spine)).toBeLessThan(at(reactor));
  });

  it('makes the cross-member the widest thing on the station', () => {
    // Without it the keel alone is a tall thin cross that reads as a single
    // bar at any distance -- the exact silhouette the redesign removed.
    const { spine, beam } = build();
    const width = (sprite, source) => sprite.scale.x * source;
    expect(width(beam, 160)).toBeGreaterThan(width(spine, 64));
    expect(DREADNOUGHT.beamScale).toBeGreaterThan(DREADNOUGHT.turretScale);
  });

  it('mirrors the turret platforms across the keel', () => {
    const { turrets } = build();
    expect(turrets).toHaveLength(2);
    expect(turrets[0].x).toBeCloseTo(-turrets[1].x, 6);
    expect(turrets[0].x).not.toBe(0);
  });

  it('mounts the turrets outboard of the keel rather than on top of it', () => {
    /*
     * The keel frame is portrait, so at keelScale it spans well under the
     * container box; the turrets have to sit outside THAT half-width or they
     * are just lumps under the hull. Compared against the keel rather than
     * against a fixed number, so re-scaling the keel cannot silently swallow
     * them.
     */
    const { spine } = build();
    const keelHalfWidth = (spine.scale.x * 64) / 2;
    expect(DREADNOUGHT.turretOffset).toBeGreaterThan(keelHalfWidth);
    // ...and inboard of the beam's tips, so they land ON the cross-member.
    expect(DREADNOUGHT.turretOffset).toBeLessThan(DREADNOUGHT.beamScale / 2);
  });

  it('authors every part around the origin and shifts the KEEL onto it', () => {
    /*
     * The keel is a cross with a long lower arm, so its geometric centre sits
     * below the point where the arms actually meet. Rather than offsetting
     * every attachment down to find it, the keel is shifted so its measured
     * hub lands on (0,0) -- which is where the beam, the turrets and the
     * reactor all already are. Mounting parts at the keel's centre instead
     * hangs them in the empty space under the chassis, which is precisely what
     * the first assembly looked like.
     */
    const { spine, beam, turrets, reactor } = build();
    expect(DREADNOUGHT.keelHubY).toBeLessThan(0);
    expect(spine.y).toBeCloseTo(-DREADNOUGHT.keelHubY * DREADNOUGHT.keelScale, 6);
    expect(beam.y).toBe(0);
    expect(reactor.y).toBe(0);
    for (const turret of turrets) expect(turret.y).toBe(0);
  });

  it('keeps the measured hub inside the keel frame', () => {
    // A hub offset past +/-0.5 would be off the frame entirely.
    expect(Math.abs(DREADNOUGHT.keelHubY)).toBeLessThan(0.5);
  });

  it('normalises each part off its LARGER dimension, not its width', () => {
    // The keel is a tall cross, the beam is a wide slab and the turrets are
    // squat diamonds. Dividing a tall frame by its width would blow it up to
    // several times its intended height.
    const { spine, beam } = build();
    expect(spine.scale.x).toBeCloseTo(DREADNOUGHT.keelScale / 128, 6);
    expect(beam.scale.x).toBeCloseTo(DREADNOUGHT.beamScale / 160, 6);
  });

  it('sizes every part against the container box', () => {
    /*
     * The assembly is authored against the BOX rather than against the keel's
     * width, because the widest element is now the horizontal cross-member and
     * it is sized to fill the box outright. The keel is laid over it.
     */
    const { turrets, reactor } = build();
    expect(turrets[0].scale.x).toBeCloseTo(DREADNOUGHT.turretScale / 32, 6);
    expect(turrets[0].x).toBeCloseTo(-DREADNOUGHT.turretOffset, 6);
    expect(reactor.scale.x).toBeCloseTo(DREADNOUGHT.reactorScale / 48, 6);
  });

  it('keeps the turrets and reactor smaller than the keel they mount to', () => {
    expect(DREADNOUGHT.turretScale).toBeGreaterThan(0);
    expect(DREADNOUGHT.turretScale).toBeLessThan(1);
    expect(DREADNOUGHT.reactorScale).toBeGreaterThan(0);
    expect(DREADNOUGHT.reactorScale).toBeLessThan(1);
  });

  it('paints a grey station with a warning core', () => {
    const { spine, beam, turrets, reactor } = build();
    expect(asHex(spine.tint)).toBe(THEME.swarm.dreadnought);
    expect(asHex(beam.tint)).toBe(asHex(DREADNOUGHT.beamTint));
    expect(asHex(turrets[0].tint)).toBe(asHex(DREADNOUGHT.turretTint));
    expect(asHex(reactor.tint)).toBe(THEME.danger.reactor);
  });

  it('keeps the hull inside the swarm darkness band despite being grey', () => {
    // A grey boss is the easiest way to restart the visual-soup problem at
    // boss scale. Gunmetal, not battleship.
    expect(relativeLuminance(asHex(DREADNOUGHT.hullTint))).toBeLessThanOrEqual(
      MAX_ENEMY_LUMINANCE
    );
    expect(relativeLuminance(asHex(DREADNOUGHT.turretTint))).toBeLessThanOrEqual(
      MAX_ENEMY_LUMINANCE
    );
    expect(relativeLuminance(asHex(DREADNOUGHT.beamTint))).toBeLessThanOrEqual(
      MAX_ENEMY_LUMINANCE
    );
  });

  it('leaves the reactor out of the tint targets, so a hit flash cannot hide it', () => {
    // It is the weak point the player is aiming at; losing it to the flash
    // hides the target at exactly the moment they are hitting it.
    const { reactor, tintTargets } = build();
    expect(tintTargets).not.toContain(reactor);
    expect(tintTargets).toHaveLength(4);
  });

  it('survives a missing texture without dividing by zero', () => {
    const { spine, beam, turrets, reactor } = createDreadnought(
      undefined,
      { width: 0 },
      null,
      undefined
    );
    expect(Number.isFinite(spine.scale.x)).toBe(true);
    expect(Number.isFinite(beam.scale.x)).toBe(true);
    expect(Number.isFinite(turrets[0].scale.x)).toBe(true);
    expect(Number.isFinite(reactor.scale.x)).toBe(true);
  });

  it('makes its parts recoverable from a pooled container alone', () => {
    const { container, spine } = build();
    expect(getDreadnoughtParts(container).spine).toBe(spine);
    expect(getDreadnoughtParts(null)).toBeNull();
  });
});

describe('Dreadnought motion', () => {
  it('holds the hull at a fixed scale -- a capital ship does not breathe', () => {
    /*
     * The station used to pulse between 1.92x and 2.08x with a
     * volume-preserving squash on top. At boss size that read as a rubber
     * station, and it was the worst single offender in the de-liquify pass.
     */
    for (let t = 0; t < 10; t += 0.01) {
      expect(dreadnoughtPulse(t, null).scale).toBe(DREADNOUGHT.scale);
    }
  });

  it('sits at the 2.2x the brief asks for', () => {
    expect(DREADNOUGHT.scale).toBeCloseTo(2.2, 6);
  });

  it('writes no deformation into the caller transform at all', () => {
    for (let t = 0; t < 4; t += 0.01) {
      const out = { scaleX: 1, scaleY: 1 };
      dreadnoughtPulse(t, out);
      expect(out.scaleX).toBe(1);
      expect(out.scaleY).toBe(1);
    }
  });

  it('turns slowly enough to read as mass, not as motion', () => {
    // The brief's figure is ~0.002 rad per frame; stored per second so it
    // survives a frame-rate change.
    expect(DREADNOUGHT.spin / 60).toBeCloseTo(0.002, 3);
  });

  it('rotates continuously and monotonically', () => {
    const a = dreadnoughtPulse(1, null).hullRotation;
    const b = dreadnoughtPulse(2, null).hullRotation;
    expect(b - a).toBeCloseTo(DREADNOUGHT.spin, 6);
  });

  it('leaves an authored state transform untouched', () => {
    // The authored clips (a death collapse) have to keep winning, and with the
    // idle pulse writing nothing they trivially do.
    const out = { scaleX: 0.5, scaleY: 0.5 };
    dreadnoughtPulse(0.3, out);
    expect(out.scaleX).toBe(0.5);
    expect(out.scaleY).toBe(0.5);
  });

  it('keeps the reactor glow visible at its dimmest', () => {
    for (let t = 0; t < 8; t += 0.02) {
      const { reactorAlpha, reactorScale } = dreadnoughtPulse(t, null);
      expect(reactorAlpha).toBeGreaterThanOrEqual(DREADNOUGHT.reactorGlow.min - 1e-9);
      expect(reactorAlpha).toBeLessThanOrEqual(1);
      // The swell is a multiplier applied to a captured base scale, so it must
      // stay near 1 or the core inflates off the chassis.
      expect(reactorScale).toBeGreaterThanOrEqual(1);
      expect(reactorScale).toBeLessThanOrEqual(1 + DREADNOUGHT.reactorSwell + 1e-9);
    }
  });

  it('turns the turret bearings continuously rather than wobbling them', () => {
    // A sine sweep reads as a loose plate; a bearing under power turns.
    const a = dreadnoughtPulse(1, null).turretSpin;
    const b = dreadnoughtPulse(2, null).turretSpin;
    expect(b - a).toBeCloseTo(DREADNOUGHT.turretSpin, 6);
    // Faster than the hull, so the two motions stay legible as separate.
    expect(DREADNOUGHT.turretSpin).toBeGreaterThan(DREADNOUGHT.spin);
  });

  it('spins the reactor up while a death ray is charging', () => {
    // The only warning the player gets before the phase-3 cone appears.
    const calm = [];
    const charging = [];
    for (let t = 0; t < 4; t += 0.01) {
      calm.push(dreadnoughtPulse(t, null, false).reactorAlpha);
      charging.push(dreadnoughtPulse(t, null, true).reactorAlpha);
    }

    // Count direction changes: one per half-cycle, so more of them means the
    // core is beating faster. Counting merely-rising samples would not — half
    // of a sine's samples rise at any frequency.
    const beats = (xs) =>
      xs.filter((v, i) => i > 0 && i < xs.length - 1 && (v - xs[i - 1]) * (xs[i + 1] - v) < 0)
        .length;
    expect(beats(charging)).toBeGreaterThan(beats(calm));

    // Swells harder too, and never past full opacity — which would silently
    // do nothing on a display object.
    expect(Math.max(...charging.map((_, i) => dreadnoughtPulse(i * 0.01, null, true).reactorScale)))
      .toBeGreaterThan(
        Math.max(...calm.map((_, i) => dreadnoughtPulse(i * 0.01, null, false).reactorScale))
      );
    for (const alpha of charging) expect(alpha).toBeLessThanOrEqual(1);
  });
});

describe('Death spray', () => {
  it('throws the bioluminescent signal colours, never a carapace colour', () => {
    expect(DEATH_SPRAY.primary).toBe(THEME.bio.acid);
    expect(DEATH_SPRAY.secondary).toBe(THEME.bio.magenta);
    expect(Object.values(THEME.swarm)).not.toContain(DEATH_SPRAY.primary);
    expect(Object.values(THEME.swarm)).not.toContain(DEATH_SPRAY.secondary);
  });

  it('mixes both colours into every burst', () => {
    expect(DEATH_SPRAY.secondaryShare).toBeGreaterThan(0);
    expect(DEATH_SPRAY.secondaryShare).toBeLessThan(1);
  });
});

describe('Hull orientation', () => {
  it('turns the atlas hulls a quarter turn to face +X', () => {
    // Kenney hulls are drawn pointing up (-Y); the renderer's facing maths
    // assumes +X. Getting this wrong makes every ship fly sideways.
    expect(HULL_ROTATION_OFFSET).toBeCloseTo(Math.PI / 2, 9);
  });
});
