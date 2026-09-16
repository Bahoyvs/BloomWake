---
name: crazygames-release-check
description: Audit BloomWake's CrazyGames SDK integration (src/services/crazygames.js) before a release or when touching portal-facing code — loading/gameplay lifecycle events, ad calls, environment fallback, error handling. Use when the user asks to prepare a CrazyGames build, check portal readiness, or after editing crazygames.js.
---

# CrazyGames portal readiness check

`src/services/crazygames.js` is the single module allowed to touch
`window.CrazyGames`. Before a release build, or after editing this file,
verify:

1. **Off-portal safety**: with `window.CrazyGames` undefined (local dev,
   `npm run dev`), the service must fall back to `environment: 'local'` or
   `'mock'` and never throw. Grep for any new direct `window.CrazyGames`
   access outside this file:
   ```bash
   grep -rn "CrazyGames" src --include=*.js | grep -v src/services/crazygames.js
   ```
   Anything found there (besides the SDK script URL constant) is a
   layering violation — route it through `CrazyGamesService` instead.

2. **SDK lifecycle events** — confirm the game calls the CrazyGames v3
   lifecycle methods at the right moments (check current call sites with
   `grep -n "gameLoadingStart\|gameLoadingStop\|gameplayStart\|gameplayStop\|happytime" src -r`):
   - `sdk.game.loadingStart()` at boot, `loadingStart()` → `loadingStop()`
     once assets are staged and the game is interactive.
   - `sdk.game.gameplayStart()` / `gameplayStop()` bracketing actual play
     (not menus) — CrazyGames uses this for ad-break placement, so calling
     it during a paused/dead state causes ads to interrupt play.
   - Ad requests go through `CrazyGamesService.requestAd`, not the raw SDK.

3. **Error resilience**: every SDK call site should be wrapped so a portal
   API failure logs a `console.warn('[BloomWake] ...')` and degrades
   gracefully rather than breaking the run — this is the existing pattern in
   `crazygames.js` (see `real` vs `environment === 'crazygames'` checks
   around auth/settings).

4. Run `node -e` or `npm test -- tests/crazygames.test.js` (or
   `npm test` if unsure of the exact filter syntax) to confirm the adapter's
   own test suite passes.

5. **Build sanity**: `npm run build` then `npm run preview` — confirm the
   game boots from `dist/` with relative asset paths (`base: './'` in
   `vite.config.js`), since CrazyGames serves the game from a subpath, not
   root.

Report as a checklist (pass/fail/not-applicable per item), not prose.
