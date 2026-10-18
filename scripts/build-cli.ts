#!/usr/bin/env bun
/**
 * Build the `clawdgg` CLI.
 *
 *   bun scripts/build-cli.ts                 # standalone binary for this host
 *   bun scripts/build-cli.ts --all           # all four release targets
 *   bun scripts/build-cli.ts --bundle        # cli/dist/clawdgg.js, for `bunx clawdgg`
 *   bun scripts/build-cli.ts --all --checksums
 *
 * Output goes to dist/cli/. The version is read from cli/package.json and
 * baked in with --define, so `clawdgg version` works in a binary that ships
 * nothing but itself.
 *
 * Two autoload defaults are deliberately turned off for the standalone build:
 * a compiled Bun executable otherwise reads a .env and a bunfig.toml from
 * whatever directory it is run in, and `clawdgg` is run from inside the user's
 * projects — one stray CLAWDGG_API_URL in a repo's .env would quietly point
 * their telemetry somewhere else.
 */

import { mkdir, rm, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const ROOT = new URL("..", import.meta.url).pathname;
const ENTRY = join(ROOT, "cli/index.ts");
const OUT_DIR = join(ROOT, "dist/cli");
const BUNDLE_OUT = join(ROOT, "cli/dist/clawdgg.js");

/** The platforms install.sh knows how to ask for. */
const RELEASE_TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
] as const;

/** `clawdgg-darwin-arm64` — what the GitHub release asset is called. */
function assetName(target: string): string {
  return `clawdgg-${target.replace(/^bun-/, "")}`;
}

function hostTarget(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  return `bun-${platform}-${arch}`;
}

async function cliVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(ROOT, "cli/package.json"), "utf-8"));
  if (typeof pkg.version !== "string") throw new Error("cli/package.json has no version");
  return pkg.version;
}

async function run(args: string[]): Promise<void> {
  const proc = Bun.spawn(["bun", ...args], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`bun ${args.join(" ")} failed`);
}

async function compile(target: string, version: string): Promise<string> {
  const outfile = join(OUT_DIR, assetName(target));
  console.log(`→ ${assetName(target)}`);
  await run([
    "build",
    ENTRY,
    "--compile",
    `--target=${target}`,
    `--define`,
    `CLAWDGG_VERSION="${version}"`,
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    `--outfile=${outfile}`,
  ]);
  await chmod(outfile, 0o755);
  return outfile;
}

async function bundle(version: string): Promise<void> {
  // For `bunx clawdgg`: one file with src/lib/* inlined, so the published
  // package needs nothing outside cli/.
  console.log(`→ cli/dist/clawdgg.js`);
  await run([
    "build",
    ENTRY,
    "--target=bun",
    `--define`,
    `CLAWDGG_VERSION="${version}"`,
    `--outfile=${BUNDLE_OUT}`,
  ]);
  await chmod(BUNDLE_OUT, 0o755);
}

async function writeChecksums(files: string[]): Promise<void> {
  const lines: string[] = [];
  for (const file of files) {
    const digest = createHash("sha256").update(await Bun.file(file).bytes()).digest("hex");
    lines.push(`${digest}  ${file.slice(OUT_DIR.length + 1)}`);
  }
  const path = join(OUT_DIR, "checksums.txt");
  await writeFile(path, `${lines.join("\n")}\n`);
  console.log(`→ checksums.txt`);
  for (const line of lines) console.log(`   ${line}`);
}

const args = process.argv.slice(2);
const version = await cliVersion();
console.log(`clawdgg v${version}\n`);

if (args.includes("--bundle")) {
  await rm(join(ROOT, "cli/dist"), { recursive: true, force: true });
  await mkdir(join(ROOT, "cli/dist"), { recursive: true });
  await bundle(version);
}

if (!args.includes("--bundle") || args.includes("--all")) {
  await mkdir(OUT_DIR, { recursive: true });
  const targets = args.includes("--all") ? [...RELEASE_TARGETS] : [hostTarget()];
  const built: string[] = [];
  for (const target of targets) built.push(await compile(target, version));
  if (args.includes("--checksums")) await writeChecksums(built);
}

console.log(`\nDone.`);
