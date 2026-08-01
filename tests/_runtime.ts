/**
 * Locate a runnable reference `happi.md` for cross-runtime conformance.
 *
 * Resolution order: $HAPPI_MD, then the usual local install paths. Previously
 * this was a single hardcoded absolute path containing one developer's home
 * directory, so conformance silently skipped on every other machine and in
 * CI — a suite that cannot fail is not a suite.
 *
 * Fetch the published reference to enable these tests anywhere:
 *
 *   curl -fsSL "https://gist.githubusercontent.com/LaurieScheepers/2483d5c218c21ecc931130bcee7dee83/raw/happi.md" -o /tmp/happi.md
 *   HAPPI_MD=/tmp/happi.md npm test
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function candidates(): string[] {
  const fromEnv = process.env.HAPPI_MD;
  const paths = fromEnv ? [fromEnv] : [];
  paths.push(join(homedir(), ".hal", "happi.md"));
  paths.push(join(homedir(), ".hal", "HAPPI.md"));
  return paths;
}

/** Absolute path to a reference happi.md, or null when none is reachable. */
export function referenceRuntimePath(): string | null {
  for (const path of candidates()) {
    if (existsSync(path)) return path;
  }
  return null;
}

/** Spawn command for the reference runtime, or null when unavailable. */
export function referenceRuntimeCmd(): string[] | null {
  const path = referenceRuntimePath();
  return path === null ? null : ["bash", path, "run"];
}
