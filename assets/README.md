# Assets

Drop the art here; the game picks it up on reload with no code changes.

```
assets/
  sprites/
    dewling.png            hero — glossy translucent water drop
    bubble_particle.png    hit / dash particles
    lens_flare.png         level-up and boss-spawn flares
    tarling.png            oily dark droplet
    ashfish.png            rusty mechanical fish
    cracked_wisp.png       shattered glass shard
    rustbloom.png          decaying metallic flower
    smogmoth.png           torn mechanical moth
    rustwhale_boss.png     plated rusty submarine-whale
  ui/
    bg_aqua.jpg            seamless Frutiger Aqua backdrop (bokeh + light rays)
```

## Authoring notes

**Any resolution works.** Sprites are scaled from the entity's collision radius
(`scaleForRadius` in `src/render/sprites.js`), so a 256px and a 1024px source
render at the same in-game size. Power-of-two sources batch best.

**Centre the subject.** Every sprite is anchored at (0.5, 0.5), so the art's
visual centre becomes the collision centre. Off-centre art will look like it has
a mis-aligned hitbox.

**Trim tightly, then allow for glow.** Visual size is `radius * 2 * fit`, where
`fit` defaults to 1.15 and is overridden per enemy in `ENEMY_SPRITE_CONFIG`.
Excess transparent padding shrinks the apparent character.

**Face right.** Sprites that rotate to face travel (`ashfish`, `smogmoth`,
`rustwhale`) should be drawn pointing along +X.

**Keep Frutevil dark.** The Dewling stays findable in a 200-enemy swarm only
because no enemy approaches its luminance. Enemy art must sit at or below a mean
relative luminance of 0.25, and the Dewling at or above 0.6. A dev-mode audit
(`src/render/asset-audit.js`) measures the real pixels on load and warns in the
console if a texture breaks this — check it after any art drop.

**Damage flash is a tint, not a sprite.** Do not author a hit variant; the
renderer multiplies the sprite by a tint on hit.

**Missing files are safe.** Anything absent is replaced by a generated
placeholder and logged, so a partial drop still runs.
