// The CLI's version, single-sourced from cli/package.json.
//
// `bun build --compile` injects it via --define (see scripts/build-cli.ts), so
// the binary carries a literal and never reads a file that isn't shipped with
// it. Running from source there's no define, so we read package.json directly.

import { readFileSync } from "node:fs";

declare const CLAWDGG_VERSION: string | undefined;

function fromPackageJson(): string {
  try {
    const path = new URL("./package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed?.version === "string" ? parsed.version : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

export function version(): string {
  return typeof CLAWDGG_VERSION === "string" ? CLAWDGG_VERSION : fromPackageJson();
}
