import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALL_TOUCHED_KEYS,
  applyOtelSettings,
  backupSettings,
  buildHelperCommand,
  buildStatusLineCommand,
  classifyOtelSettings,
  desiredOtelEnv,
  detectManagedSettings,
  isOurEndpoint,
  isOurHelperCommand,
  loadSettings,
  MANAGED_OTEL_KEYS,
  planOtelSettings,
  resolveSettingsPath,
  restoreOtelSettings,
  SettingsParseError,
  settingsPathIn,
  SIGNAL_SPECIFIC_KEYS,
  writeSettingsAtomic,
} from './settings';

// Every test runs against a fixture directory. Nothing in this file may touch
// the real ~/.claude or ~/.config/clawdgg.
let fixtureHome: string;
let settingsPath: string;

beforeEach(async () => {
  fixtureHome = await mkdtemp(join(tmpdir(), 'clawdgg-settings-'));
  settingsPath = settingsPathIn(fixtureHome);
});

afterEach(async () => {
  await rm(fixtureHome, { recursive: true, force: true });
});

const API = 'https://clawd.gg';
const DESIRED = desiredOtelEnv(API);
const ARGV = ['/Users/x/.clawdgg/bin/clawdgg'];
const HELPER = buildHelperCommand(ARGV);
const APPLY = { apiBaseUrl: API, replaceForeign: true };
const RESTORE = { apiBaseUrl: API, desired: DESIRED };

/** A real pre-2.0 token: sign(JSON.stringify({userId, iat, gen})). */
const LEGACY_TOKEN = `{"userId":"github_1","iat":1778345400000,"gen":3}.${'a'.repeat(64)}`;

describe('loadSettings', () => {
  it('treats a missing file as empty', async () => {
    const loaded = await loadSettings(settingsPath);
    expect(loaded.exists).toBe(false);
    expect(loaded.settings).toEqual({});
  });

  it('treats an empty file as empty but existing', async () => {
    await writeFile(settingsPath, '   \n');
    const loaded = await loadSettings(settingsPath);
    expect(loaded.exists).toBe(true);
    expect(loaded.settings).toEqual({});
  });

  it('ABORTS on malformed JSON instead of overwriting it', async () => {
    const original = '{ "env": { "FOO": "1" },, }';
    await writeFile(settingsPath, original);

    await expect(loadSettings(settingsPath)).rejects.toThrow(SettingsParseError);
    // The data-destroying bug was writing a fresh object over this file.
    expect(await readFile(settingsPath, 'utf-8')).toBe(original);
  });

  it('rejects a top-level array', async () => {
    await writeFile(settingsPath, '[]');
    await expect(loadSettings(settingsPath)).rejects.toThrow(SettingsParseError);
  });
});

describe('symlinked settings.json', () => {
  it('reads and writes THROUGH the link, keeping it a link', async () => {
    // A settings.json symlinked into a dotfiles repo is common. Writing a temp
    // file beside the LINK and renaming over it replaces the link with a
    // regular file, silently detaching the user's dotfiles.
    const real = join(fixtureHome, 'dotfiles', 'claude-settings.json');
    await mkdir(join(fixtureHome, 'dotfiles'), { recursive: true });
    await writeFile(real, JSON.stringify({ env: { KEEP: '1' } }));
    await symlink(real, settingsPath);

    expect(await resolveSettingsPath(settingsPath)).toBe(await realpath(real));

    const loaded = await loadSettings(settingsPath);
    expect(loaded.path).toBe(await realpath(real));
    applyOtelSettings(loaded.settings, DESIRED, HELPER, APPLY);
    await writeSettingsAtomic(loaded.path, loaded.settings);

    // The link is intact, and the target carries the change.
    expect((await stat(settingsPath)).isSymbolicLink()).toBe(false); // stat follows
    expect(JSON.parse(await readFile(real, 'utf-8')).env.KEEP).toBe('1');
    expect(JSON.parse(await readFile(real, 'utf-8')).otelHeadersHelper).toBe(HELPER);
    // The temp file went next to the TARGET, not next to the link.
    expect((await readdir(fixtureHome)).filter((f) => f.includes('clawdgg-tmp'))).toHaveLength(0);
  });

  it('resolves a symlinked parent directory for a file that does not exist yet', async () => {
    const realDir = join(fixtureHome, 'real-claude');
    await mkdir(realDir, { recursive: true });
    const linkDir = join(fixtureHome, 'linked-claude');
    await symlink(realDir, linkDir);

    expect(await resolveSettingsPath(settingsPathIn(linkDir))).toBe(
      join(await realpath(realDir), 'settings.json')
    );
  });
});

describe('backupSettings', () => {
  it('backs up before EVERY write, keeping the newest N', async () => {
    await writeFile(settingsPath, '{"env":{"KEEP":"1"}}');

    const first = await backupSettings(settingsPath, 3);
    expect(first).toBeString();
    expect(await readFile(first!, 'utf-8')).toBe('{"env":{"KEEP":"1"}}');
    expect((await stat(first!)).mode & 0o777).toBe(0o600);

    // `disable` and `logout` rewrite this file too; backing up only once meant
    // the copy on disk was from the first `setup`, not from before the change
    // that actually broke something.
    for (let i = 0; i < 5; i++) {
      await writeFile(settingsPath, `{"env":{"KEEP":"${i}"}}`);
      expect(await backupSettings(settingsPath, 3)).toBeString();
    }

    const backups = (await readdir(fixtureHome)).filter((f) => f.includes('clawdgg-backup')).sort();
    expect(backups).toHaveLength(3);
    // The newest survives, the oldest is pruned.
    expect(await readFile(join(fixtureHome, backups[2]!), 'utf-8')).toBe('{"env":{"KEEP":"4"}}');
  });

  it('has nothing to back up when there is no settings.json', async () => {
    expect(await backupSettings(settingsPath)).toBeNull();
  });
});

describe('writeSettingsAtomic', () => {
  it('writes 0600 and leaves no temp file behind', async () => {
    await writeSettingsAtomic(settingsPath, { env: { A: '1' }, unknownKey: { deep: [1, 2] } });

    expect(JSON.parse(await readFile(settingsPath, 'utf-8'))).toEqual({
      env: { A: '1' },
      unknownKey: { deep: [1, 2] },
    });
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(fixtureHome)).filter((f) => f.includes('clawdgg-tmp'))).toHaveLength(0);
  });
});

describe('shell quoting of the hook commands', () => {
  it('quotes a path a shell would otherwise re-parse', () => {
    // Claude Code runs these strings through a shell, and our path comes from
    // homedir(). "Mael O'Hara" and "~/My Projects" both break an unquoted one.
    const argv = ["/Users/Mael O'Hara/My Projects/clawdgg"];
    expect(buildHelperCommand(argv)).toBe(
      `'/Users/Mael O'\\''Hara/My Projects/clawdgg' otel-headers`
    );
    expect(buildStatusLineCommand(argv)).toBe(
      `'/Users/Mael O'\\''Hara/My Projects/clawdgg' statusline`
    );
  });

  it('leaves an ordinary path unquoted', () => {
    expect(buildHelperCommand(ARGV)).toBe('/Users/x/.clawdgg/bin/clawdgg otel-headers');
  });

  it('quotes every element, not just the first', () => {
    expect(buildHelperCommand(['/opt/bun', '--no-env-file', '/src/my cli/index.ts'])).toBe(
      "/opt/bun --no-env-file '/src/my cli/index.ts' otel-headers"
    );
  });

  it('recognises our helper by its argv, not by a substring', () => {
    expect(isOurHelperCommand(HELPER)).toBe(true);
    expect(isOurHelperCommand(buildHelperCommand(["/Users/Mael O'Hara/clawdgg"]))).toBe(true);
    expect(isOurHelperCommand('npx clawdgg otel-headers')).toBe(true);
    expect(isOurHelperCommand('bun /src/clawdgg/cli/index.ts otel-headers')).toBe(true);

    // Not ours: the subcommand isn't the last word, or nothing names us.
    expect(isOurHelperCommand('/opt/collector/creds --out otel-headers.json')).toBe(false);
    expect(isOurHelperCommand('my-helper otel-headers --clawdgg')).toBe(false);
    expect(isOurHelperCommand('otel-headers')).toBe(false);
    expect(isOurHelperCommand(undefined)).toBe(false);
  });
});

describe('isOurEndpoint', () => {
  it('matches our origin and nothing else', () => {
    expect(isOurEndpoint('https://clawd.gg/otel', API)).toBe(true);
    expect(isOurEndpoint('https://clawd.gg', API)).toBe(true);
    expect(isOurEndpoint('http://localhost:4318', API)).toBe(false);
    // A lookalike host must not be mistaken for ours.
    expect(isOurEndpoint('https://clawd.gg.evil.example/otel', API)).toBe(false);
    expect(isOurEndpoint('', API)).toBe(false);
  });
});

describe('classifyOtelSettings', () => {
  it('claims nothing in a settings.json full of someone else\'s collector', () => {
    const foreign = {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-honeycomb-team=abc123',
      },
    };

    const { keys, blockIsOurs } = classifyOtelSettings(foreign, DESIRED, API);

    expect(blockIsOurs).toBe(false);
    expect(keys.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('theirs');
    expect(keys.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('theirs');
    expect(keys.OTEL_EXPORTER_OTLP_HEADERS).toBe('theirs');
    // "1" is as plausibly theirs as ours, and nothing here says the block is
    // ours — so it is theirs.
    expect(keys.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('theirs');
  });

  it('claims the whole block when the endpoint is ours', () => {
    const ours: Record<string, any> = {};
    applyOtelSettings(ours, DESIRED, HELPER, APPLY);

    const { keys, blockIsOurs } = classifyOtelSettings(ours, DESIRED, API);
    expect(blockIsOurs).toBe(true);
    for (const key of MANAGED_OTEL_KEYS) expect(keys[key]).toBe('ours');
    expect(keys.otelHeadersHelper).toBe('ours');
  });

  it('claims a legacy install: our endpoint plus our static bearer', () => {
    // This is the fixture that mattered. Nothing recorded any "originals", and
    // every value in here was written BY US.
    const legacy = {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://clawd.gg/otel',
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer%20${LEGACY_TOKEN}`,
      },
    };

    const { keys, blockIsOurs } = classifyOtelSettings(legacy, DESIRED, API);
    expect(blockIsOurs).toBe(true);
    expect(keys.OTEL_EXPORTER_OTLP_HEADERS).toBe('ours');
    expect(keys.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('ours');
    expect(keys.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('ours');
  });

  it('does not let our block claim a protocol the user changed', () => {
    const settings: Record<string, any> = {};
    applyOtelSettings(settings, DESIRED, HELPER, APPLY);
    settings.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';

    expect(classifyOtelSettings(settings, DESIRED, API).keys.OTEL_EXPORTER_OTLP_PROTOCOL).toBe(
      'theirs'
    );
  });
});

describe('planOtelSettings', () => {
  it('reports no conflicts for a fresh settings.json', () => {
    const plan = planOtelSettings({}, DESIRED, HELPER, API);
    expect(plan.conflicts).toEqual([]);
    expect(plan.unmanaged).toEqual([]);
    expect(plan.staticHeaders).toEqual([]);
    expect(plan.unchanged).toBe(false);
  });

  it("flags a user's own collector", () => {
    const plan = planOtelSettings(
      {
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
          OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
          OTEL_RESOURCE_ATTRIBUTES: 'service.name=mine',
        },
      },
      DESIRED,
      HELPER,
      API
    );

    expect(plan.conflicts.map((c) => c.key).sort()).toEqual([
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_PROTOCOL',
    ]);
    // CLAUDE_CODE_ENABLE_TELEMETRY already says "1" — same value, no conflict.
    expect(plan.conflicts.find((c) => c.key === 'CLAUDE_CODE_ENABLE_TELEMETRY')).toBeUndefined();
    expect(plan.unmanaged).toEqual(['OTEL_RESOURCE_ATTRIBUTES']);
  });

  it('spots the static bearer token we used to write, and removes it silently', () => {
    const plan = planOtelSettings(
      { env: { OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer%20${LEGACY_TOKEN}` } },
      DESIRED,
      HELPER,
      API
    );
    expect(plan.staticHeaders).toEqual(['OTEL_EXPORTER_OTLP_HEADERS']);
    expect(plan.conflicts).toEqual([]);
  });

  it('asks before removing an Authorization header that is NOT ours', () => {
    const plan = planOtelSettings(
      { env: { OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer not-our-token' } },
      DESIRED,
      HELPER,
      API
    );
    expect(plan.staticHeaders).toEqual([]);
    expect(plan.conflicts.map((c) => [c.key, c.kind])).toEqual([
      ['OTEL_EXPORTER_OTLP_HEADERS', 'static-header'],
    ]);
  });

  it('treats per-signal overrides as conflicts even when nothing else is', () => {
    // These WIN over the generic endpoint, so an untouched one means that
    // signal never reaches us — and a foreign *_HEADERS would receive our
    // helper's Authorization.
    const plan = planOtelSettings(
      {
        env: {
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://localhost:4318/v1/logs',
          OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'x-honeycomb-team=abc123',
          OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'grpc',
        },
      },
      DESIRED,
      HELPER,
      API
    );

    expect(plan.conflicts.map((c) => c.key).sort()).toEqual([
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
      'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
    ]);
    expect(plan.conflicts.every((c) => c.next === '(removed)')).toBe(true);
    // And they are not reported as "other OTEL settings we leave alone".
    expect(plan.unmanaged).toEqual([]);
  });

  it('is a no-op when already set up', () => {
    const settings: Record<string, any> = {};
    applyOtelSettings(settings, DESIRED, HELPER, APPLY);
    expect(planOtelSettings(settings, DESIRED, HELPER, API).unchanged).toBe(true);
  });
});

describe('applyOtelSettings', () => {
  it('preserves unknown keys and the rest of env', () => {
    const settings: Record<string, any> = {
      permissions: { allow: ['Bash(ls:*)'] },
      env: { MY_VAR: 'keep me' },
      statusLine: { type: 'command', command: '~/bin/mine.sh' },
    };

    applyOtelSettings(settings, DESIRED, HELPER, APPLY);

    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(settings.env.MY_VAR).toBe('keep me');
    expect(settings.statusLine).toEqual({ type: 'command', command: '~/bin/mine.sh' });
    expect(settings.otelHeadersHelper).toBe(HELPER);
    for (const key of MANAGED_OTEL_KEYS) expect(settings.env[key]).toBe(DESIRED[key]);
  });

  it('removes OUR static header and remembers it as null', () => {
    const settings: Record<string, any> = {
      env: { OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer%20${LEGACY_TOKEN}` },
    };

    const originals = applyOtelSettings(settings, DESIRED, HELPER, APPLY);

    expect(settings.env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
    // null, NOT the old header: restoring it would put a dead bearer back.
    expect(originals.OTEL_EXPORTER_OTLP_HEADERS).toBeNull();
  });

  it('remembers a FOREIGN header as an original, so disable can put it back', () => {
    const settings: Record<string, any> = {
      env: { OTEL_EXPORTER_OTLP_HEADERS: 'x-honeycomb-team=abc123' },
    };

    const originals = applyOtelSettings(settings, DESIRED, HELPER, APPLY);
    expect(originals.OTEL_EXPORTER_OTLP_HEADERS).toBe('x-honeycomb-team=abc123');
  });

  it('refuses to touch foreign values without consent', () => {
    const settings: Record<string, any> = {
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-honeycomb-team=abc123',
      },
      otelHeadersHelper: '/opt/collector/creds.sh',
    };

    applyOtelSettings(settings, DESIRED, HELPER, { apiBaseUrl: API, replaceForeign: false });

    expect(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:4318');
    expect(settings.env.OTEL_EXPORTER_OTLP_HEADERS).toBe('x-honeycomb-team=abc123');
    expect(settings.otelHeadersHelper).toBe('/opt/collector/creds.sh');
  });

  it('uses http/json, the protocol dynamic headers actually support', () => {
    expect(DESIRED.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/json');
  });
});

describe('restoreOtelSettings', () => {
  it("puts back the user's own collector on disable", () => {
    const before = {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        MY_VAR: 'keep me',
      },
    };
    const settings: Record<string, any> = structuredClone(before);

    const originals = applyOtelSettings(settings, DESIRED, HELPER, APPLY);
    restoreOtelSettings(settings, originals, RESTORE);

    expect(settings).toEqual(before);
  });

  it('deletes keys that only we added, and drops an emptied env', () => {
    const settings: Record<string, any> = {};
    const originals = applyOtelSettings(settings, DESIRED, HELPER, APPLY);

    restoreOtelSettings(settings, originals, RESTORE);

    expect(settings).toEqual({});
  });

  it('falls back to deleting our keys when the originals were lost', () => {
    const settings: Record<string, any> = { env: { MY_VAR: '1' } };
    applyOtelSettings(settings, DESIRED, HELPER, APPLY);

    restoreOtelSettings(settings, undefined, RESTORE);

    expect(settings).toEqual({ env: { MY_VAR: '1' } });
    expect(settings.otelHeadersHelper).toBeUndefined();
  });

  it('REGRESSION: a legacy install is cleaned up, not "restored"', () => {
    // The bug: everything in here was written by the pre-2.0 CLI, and nothing
    // recorded any originals — so `disable` "restored" clawd.gg's own exporter
    // and a revoked static bearer, leaving telemetry on and 401ing forever.
    const legacy: Record<string, any> = {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://clawd.gg/otel',
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer%20${LEGACY_TOKEN}`,
        MY_VAR: 'keep me',
      },
      permissions: { allow: ['Read'] },
    };

    // No otelOriginals: that is the whole point of the fixture.
    const outcome = restoreOtelSettings(legacy, undefined, RESTORE);

    expect(legacy).toEqual({ env: { MY_VAR: 'keep me' }, permissions: { allow: ['Read'] } });
    expect(outcome.restored).toEqual([]);
    expect(outcome.removed).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(outcome.removed).toContain('OTEL_EXPORTER_OTLP_HEADERS');
    expect(outcome.removed).toContain('CLAUDE_CODE_ENABLE_TELEMETRY');
  });

  it('REGRESSION: the same legacy install, even if "originals" were recorded', () => {
    // A second `setup` on a legacy install used to record OUR OWN values as
    // the originals. Even then, nothing that is ours may come back.
    const legacy: Record<string, any> = {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://clawd.gg/otel',
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer%20${LEGACY_TOKEN}`,
      },
    };
    const selfRecorded = applyOtelSettings(legacy, DESIRED, HELPER, APPLY);
    expect(Object.values(selfRecorded).every((v) => v === null)).toBe(true);

    restoreOtelSettings(legacy, selfRecorded, RESTORE);
    expect(legacy).toEqual({});
  });

  it('LOGOUT ON A MACHINE WE NEVER SET UP: touches nothing', () => {
    const theirs: Record<string, any> = {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-honeycomb-team=abc123',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://localhost:4318/v1/logs',
      },
      otelHeadersHelper: '/opt/collector/creds.sh',
    };
    const before = structuredClone(theirs);

    const outcome = restoreOtelSettings(theirs, undefined, RESTORE);

    expect(theirs).toEqual(before);
    expect(outcome.removed).toEqual([]);
    expect(outcome.restored).toEqual([]);
    expect(outcome.leftAlone.sort()).toEqual(
      [
        'CLAUDE_CODE_ENABLE_TELEMETRY',
        'OTEL_EXPORTER_OTLP_ENDPOINT',
        'OTEL_EXPORTER_OTLP_HEADERS',
        'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
        'OTEL_EXPORTER_OTLP_PROTOCOL',
        'otelHeadersHelper',
      ].sort()
    );
  });

  it('puts back the per-signal overrides it removed with consent', () => {
    // We DELETE these on setup (they beat the generic endpoint), so on disable
    // they are absent from the file — and an ownership check alone would skip
    // them and lose the user's config for good.
    const before = {
      env: {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://localhost:4318/v1/logs',
        OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'x-honeycomb-team=abc123',
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'grpc',
      },
    };
    const settings: Record<string, any> = structuredClone(before);

    const originals = applyOtelSettings(settings, DESIRED, HELPER, APPLY);
    expect(settings.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined();

    const outcome = restoreOtelSettings(settings, originals, RESTORE);

    expect(settings).toEqual(before);
    expect(outcome.restored.sort()).toEqual([
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
      'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
    ]);
  });

  it('puts back a foreign static bearer it removed with consent', () => {
    const settings: Record<string, any> = {
      env: { OTEL_EXPORTER_OTLP_HEADERS: 'x-honeycomb-team=abc123' },
    };
    const originals = applyOtelSettings(settings, DESIRED, HELPER, APPLY);
    restoreOtelSettings(settings, originals, RESTORE);

    expect(settings).toEqual({ env: { OTEL_EXPORTER_OTLP_HEADERS: 'x-honeycomb-team=abc123' } });
  });

  it('leaves a key the user changed after we wrote it', () => {
    const settings: Record<string, any> = {};
    const originals = applyOtelSettings(settings, DESIRED, HELPER, APPLY);

    // The user re-pointed the exporter themselves. It is theirs now.
    settings.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';

    const outcome = restoreOtelSettings(settings, originals, RESTORE);

    expect(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:4318');
    expect(outcome.leftAlone).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
  });

  it('covers every key any clawdgg version has written', () => {
    // A key we write but forget to list here would survive `disable`.
    for (const key of [...MANAGED_OTEL_KEYS, ...SIGNAL_SPECIFIC_KEYS]) {
      expect(ALL_TOUCHED_KEYS).toContain(key);
    }
  });
});

describe('detectManagedSettings', () => {
  it('finds an admin-pinned OTEL endpoint', async () => {
    const managed = join(fixtureHome, 'managed-settings.json');
    await writeFile(
      managed,
      JSON.stringify({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://corp-collector.example/otel' },
        permissions: { deny: [] },
      })
    );

    expect(await detectManagedSettings([managed])).toEqual([
      {
        path: managed,
        key: 'OTEL_EXPORTER_OTLP_ENDPOINT',
        value: 'https://corp-collector.example/otel',
      },
    ]);
  });

  it('is quiet about a missing, malformed or unrelated file', async () => {
    const missing = join(fixtureHome, 'nope.json');
    expect(existsSync(missing)).toBe(false);
    expect(await detectManagedSettings([missing])).toEqual([]);

    const broken = join(fixtureHome, 'broken.json');
    await writeFile(broken, '{not json');
    expect(await detectManagedSettings([broken])).toEqual([]);

    const unrelated = join(fixtureHome, 'unrelated.json');
    await writeFile(unrelated, JSON.stringify({ permissions: { deny: ['Bash'] } }));
    expect(await detectManagedSettings([unrelated])).toEqual([]);
  });
});

describe('end-to-end on a fixture HOME', () => {
  it('backs up, rewrites and restores a real file', async () => {
    const original = {
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' },
      permissions: { allow: ['Read'] },
    };
    await writeFile(settingsPath, `${JSON.stringify(original, null, 2)}\n`);

    const loaded = await loadSettings(settingsPath);
    const backup = await backupSettings(settingsPath);
    const originals = applyOtelSettings(loaded.settings, DESIRED, HELPER, APPLY);
    await writeSettingsAtomic(loaded.path, loaded.settings);

    const afterSetup = JSON.parse(await readFile(settingsPath, 'utf-8'));
    expect(afterSetup.otelHeadersHelper).toBe(HELPER);
    expect(afterSetup.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://clawd.gg/otel');
    expect(afterSetup.permissions).toEqual({ allow: ['Read'] });

    expect(existsSync(backup!)).toBe(true);
    expect(JSON.parse(await readFile(backup!, 'utf-8'))).toEqual(original);

    const reloaded = await loadSettings(settingsPath);
    await backupSettings(settingsPath);
    restoreOtelSettings(reloaded.settings, originals, RESTORE);
    await writeSettingsAtomic(reloaded.path, reloaded.settings);

    expect(JSON.parse(await readFile(settingsPath, 'utf-8'))).toEqual(original);
    // Two writes, two backups.
    expect((await readdir(fixtureHome)).filter((f) => f.includes('clawdgg-backup'))).toHaveLength(2);
  });
});
