# Assets

This folder holds **vendor source packs**. Nothing here is served.

The game loads `public/assets/`, which is produced from these packs by:

```
npm run assets      # node tools/build-assets.mjs
```

```
assets/                        (source — Kenney packs, unmodified)
  spaceship_shooter/           Space Shooter Redux: detailed fighters, ordnance
  spaceship_expansion/         Shooter Expansion 2X: heavy hulls, stations, FX
  spaceship_UI/                Sci-Fi UI plates and fonts
  spaceship_simple/            Simple Space — NOT compiled; see below

public/assets/                 (generated — this is what ships)
  ships/
    raider.png                 copied verbatim from Space Shooter Redux
    raider.json                Pixi spritesheet, all 294 frames
    armada.png                 copied verbatim from the 2X expansion
    armada.json                Pixi spritesheet, all 278 frames
  ui/
    panel_card.png             level-up card plate (9-sliced in hud.css)
    panel_glass.png            translucent plate
    panel_button.png           button plate
    badge_common.png           rarity badges: blue / green / yellow / red
    badge_uncommon.png
    badge_rare.png
    badge_legendary.png
    bg_void.png                generated seamless starfield tile
```

`public/assets/` is a build product but is **committed**, so a clean checkout
runs without a build step. Re-run `npm run assets` after touching a vendor pack
or the staging script.

## Why the layout is one atlas per pack

An atlas is one PNG plus offsets into it. Splitting a pack across `ships/` and a
separate `combat/` would either duplicate the image or leave two JSON files
pointing at the same one, with no way to tell which copy is live. One atlas per
pack means one texture upload per pack, and role is expressed in `ASSET_KEYS`
(`src/core/assets.js`) where it belongs.

Both packs are compiled **whole**, with no frame filter. An earlier revision
emitted only the ordnance subset of the shooter pack and skipped the expansion
entirely — it saved ~70KB of JSON and cost the entire art direction. Frames are
offsets into a PNG that ships either way; pick frames in the manifest, not in
the build script.

`spaceship_simple/` is the flat white silhouette pack the detailed art replaced.
It is kept as source but is no longer compiled, because nothing references it.

## Why the conversion step exists

Kenney ships Starling/Sparrow `.xml` atlases. PixiJS 8 reads JSON spritesheets.
Rather than hand-maintain a JSON that silently rots the next time a pack is
updated, `tools/build-assets.mjs` derives it from the `.xml` — reading the PNG's
dimensions straight out of its IHDR header, so the whole pipeline runs on a bare
Node with no native image dependency.

The one generated file, `bg_void.png`, is written by a small PNG encoder in the
same script. None of the packs ships a tileable backdrop, and a tile that does
not wrap shows a seam the moment the camera pans.

## Authoring notes

**Colour is a tint over detail, not instead of it.** Every faction colour is a
`.tint` applied at render time from `ENEMY_VIEW` in
`src/render/sprite-factory.js`. Because a tint multiplies, the frame's own
shading survives it — a tinted hull reads as a lit object, not a coloured
cut-out. That is what makes the palette enforceable (a tint is a number a test
can read) and what lets the swarm batch into one draw call per atlas.

So: **do not author pre-coloured enemy art.** Add a frame and a tint-table row.

**Silhouette carries the species; scale carries the threat.** At speed, against
a dark backdrop, five dark hulls differ by outline and size long before they
differ by hue. Each species uses a different frame, and `scale` spans 0.6x to
1.5x of `SWARM_REFERENCE_DIAMETER`.

**Sizes are absolute, not relative to the hitbox.** `enemyDiameter()` is the
on-screen size; `enemyFit()` derives the `scaleForRadius` multiplier from it and
the collision radius. Multiplying `scale` into the radius instead double-counts
size — the radii already span 9px to 20px — and rendered the wave-1 chaff at
28px, too small to have a silhouette at all.

**Any resolution works.** Sprites are scaled from the entity's collision radius
(`scaleForRadius` in `src/render/sprites.js`), off the frame's LARGER dimension
so tall and wide frames both fit their intended circle.

**Centre the subject.** Every sprite is anchored at (0.5, 0.5).

**Hulls point up.** The Kenney convention is -Y, and `HULL_ROTATION_OFFSET`
corrects it to the renderer's +X facing. Art that points a different way will
fly sideways.

**Keep the swarm dark once tinted.** The Drifter stays findable in a 200-enemy
swarm only because no enemy approaches its luminance. The tinted result must sit
at or below a mean relative luminance of 0.25, and the Drifter at or above 0.6.
`src/render/asset-audit.js` measures the real pixels *through the tint*, cropped
to each sprite's atlas frame, and warns in the console — check it after any art
drop.

**Damage flash is a tint, not a frame.** Do not author a hit variant.

**The flash is white, so it shows your UNTINTED art.** A Pixi tint multiplies
and cannot add light, so the only tint that brightens a near-black carapace is
pure white — which means a flashing enemy renders the frame's own colours. Keep
accent colours on enemy hulls muted for that reason, and note the flash is rate-
limited per enemy (`FLASH_REFRACTORY_SEC` in `src/core/simulation.js`): a maxed
build lands several hits a second and an ungated flash left the whole swarm
permanently lit.

**Missing files are safe.** Anything absent is replaced by a generated
placeholder and logged, so a partial drop still runs.

## The composite boss

The Dreadnought Station is assembled from **five** frames rather than picked as
one: a wide horizontal cross-member, two turret platforms at its tips, a
vertical keel laid over the join, and a reactor at the hub.

The cross-member is what gives the station a silhouette. The keel on its own is
a tall thin cross that reads as a single bar at any distance, which is exactly
the shape the redesign removed.

Two constraints, both easy to break:

- **The keel frame must be unpainted grey.** `spaceStation_017` was tried and
  rejected: it carries bright blue solar panels, and because a tint multiplies,
  the gunmetal wash cannot remove them — blue times grey is still blue.
- **`keelHubY` is measured from the frame**, not guessed. It is where the keel's
  own arms cross as a fraction of its normalised box; the keel is shifted so
  that point lands on the container origin, where every other part already is.
  A cross with a long lower arm has its geometric centre well below its hub, and
  parts mounted at the centre hang in empty space beneath the chassis.

Everything else is sized against the container box, because the widest element
is now the beam and it fills that box outright.

## Animation sheets

Tier A frame animation (`src/data/animations.js`) looks for optional strips
alongside the atlases in `public/assets/ships/` — `drifter_idle.png`,
`leviathan_telegraph.png`, `strider_swim.png` and so on. None ship today; every
entity falls back to its static atlas frame plus procedural motion, which is the
expected state. Frame counts are measured from the file, never typed into the
manifest.
