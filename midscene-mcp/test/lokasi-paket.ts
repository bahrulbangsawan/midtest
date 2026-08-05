import { createRequire } from 'node:module';
import { sep } from 'node:path';

/**
 * Absolute path to the installed `@midscene/core` package root.
 *
 * Two tests deliberately read files that are NOT in the package's `exports`
 * map — an internal cache validator, and the YAML player's dispatch source —
 * because pinning their real behaviour is the whole point of those guards.
 *
 * They used to reach for `../node_modules/@midscene/core/...` by hand. That
 * broke the moment this package became an npm workspace member and the
 * dependency hoisted to the repository root. A review had already warned about
 * the worse variant: with a divergent install, a hardcoded path can silently
 * pin a *different* copy than the one the code actually loads.
 *
 * Resolving through Node instead means these guards always inspect the same
 * copy the production code imports, wherever the package manager puts it.
 */
export function akarMidsceneCore(): string {
  const resolve = createRequire(import.meta.url).resolve;
  // `@midscene/core/utils` is in the package's exports map, so this entry point
  // is stable even though the files the guards read are not.
  const utils = resolve('@midscene/core/utils');
  const potong = utils.indexOf(`${sep}dist${sep}`);
  if (potong === -1) {
    throw new Error(
      `tidak bisa menemukan akar @midscene/core dari jalur resolusi: ${utils}`,
    );
  }
  return utils.slice(0, potong);
}
