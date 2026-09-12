import { defineConfig } from 'vite';

/**
 * Vite config.
 *
 * ASSET PIPELINE
 * Game art is staged into `public/assets/` by `npm run assets`
 * (tools/build-assets.mjs), which converts the Kenney vendor packs in
 * `assets/` into the two JSON spritesheets and the handful of UI plates the
 * game actually loads. Vite copies `publicDir` verbatim on build, so the
 * manifest's `assets/ships/fleet.json` resolves identically in dev and in a
 * production bundle with no plugin involved.
 *
 * This replaces an earlier `closeBundle` hook that copied the whole `assets/`
 * tree into `dist/`. That shipped all 1100+ raw vendor files — every UI colour
 * variant, both unused spritesheets, the fonts — for the sake of the dozen the
 * game reads, and it wrote them to the same `dist/assets/` path publicDir now
 * owns. Staging first and serving only the staged output is both smaller and
 * unambiguous about which copy is live.
 */
export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
  },
  server: {
    port: 3000,
    open: false,
    watch: {
      // The vendor packs are inputs to `npm run assets`, not to the dev server.
      ignored: ['**/assets/**'],
    },
  },
});
