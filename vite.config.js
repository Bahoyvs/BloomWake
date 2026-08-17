import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Copy the art folder into the build output.
 *
 * The manifest in src/core/assets.js points at `/assets/sprites/...`, and the
 * art lives in `assets/` at the project root. Vite's dev server happens to
 * serve project-root files, so this works in dev with no help — but only
 * `publicDir` is copied on build, so a production bundle would ship with every
 * texture 404ing and fall back to placeholders.
 *
 * Rather than move the folder (the art drop location is a fixed convention) or
 * pull in vite-plugin-static-copy, copy it during `closeBundle`.
 */
function copyGameAssets() {
  return {
    name: 'bloomwake-copy-assets',
    apply: 'build',
    closeBundle() {
      const from = resolve(__dirname, 'assets');
      if (!existsSync(from)) {
        this.warn('assets/ not found — build will run on placeholder textures');
        return;
      }
      cpSync(from, resolve(__dirname, 'dist', 'assets'), { recursive: true });
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [copyGameAssets()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
  },
  server: {
    port: 3000,
    open: false,
    watch: {
      ignored: ['**/assets/**'],
    },
  },
});
