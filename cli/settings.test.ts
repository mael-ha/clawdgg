import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyOtelSettings,
  backupSettingsOnce,
  buildHelperCommand,
  desiredOtelEnv,
  loadSettings,
  MANAGED_OTEL_KEYS,
  planOtelSettings,
  restoreOtelSettings,
  SettingsParseError,
  settingsPathIn,
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

const DESIRED = desiredOtelEnv('https://clawd.gg');
const HELPER = buildHelperCommand('/Users/x/.clawdgg/bin/clawdgg');

describe('loadSettings', () => {
  it('treats a missing file as empty', async () => {
    expect(await loadSettings(settingsPath)).toEqual({ exists: false, settings: {} });
  });

  it('treats an empty file as empty but existing', async () => {
    await writeFile(settingsPath, '   \n');
    expect(await loadSettings(settingsPath)).toEqual({ exists: true, settings: {} });
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

describe('backupSettingsOnce', () => {
  it('copies the file aside, once', async () => {
    await writeFile(settingsPath, '{"env":{"KEEP":"1"}}');

    const first = await backupSettingsOnce(settingsPath);
    expect(first).toBeString();
    expect(await readFile(first!, 'utf-8')).toBe('{"env":{"KEEP":"1"}}');

    // A second setup run must not pile up backups (or shadow the pre-clawdgg one).
    expect(await backupSettingsOnce(settingsPath)).toBeNull();
    const backups = (await readdir(fixtureHome)).filter((f) => f.includes('clawdgg-backup'));
    expect(backups).toHaveLength(1);
  });

  it('has nothing to back up when there is no settings.json', async () => {
    expect(await backupSettingsOnce(settingsPath)).toBeNull();
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

describe('planOtelSettings', () => {
  it('reports no conflicts for a fresh settings.json', () => {
    const plan = planOtelSettings({}, DESIRED, HELPER);
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
      HELPER
    );

    expect(plan.conflicts.map((c) => c.key).sort()).toEqual([
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_PROTOCOL',
    ]);
    // CLAUDE_CODE_ENABLE_TELEMETRY already says "1" — same value, no conflict.
    expect(plan.conflicts.find((c) => c.key === 'CLAUDE_CODE_ENABLE_TELEMETRY')).toBeUndefined();
    expect(plan.unmanaged).toEqual(['OTEL_RESOURCE_ATTRIBUTES']);
  });

  it('spots the static bearer token we used to write', () => {
    const plan = planOtelSettings(
      { env: { OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20abc' } },
      DESIRED,
      HELPER
    );
    expect(plan.staticHeaders).toEqual(['OTEL_EXPORTER_OTLP_HEADERS']);
  });

  it('is a no-op when already set up', () => {
    const settings: Record<string, any> = {};
    applyOtelSettings(settings, DESIRED, HELPER);
    expect(planOtelSettings(settings, DESIRED, HELPER).unchanged).toBe(true);
  });
});

describe('applyOtelSettings', () => {
  it('preserves unknown keys and the rest of env', () => {
    const settings: Record<string, any> = {
      permissions: { allow: ['Bash(ls:*)'] },
      env: { MY_VAR: 'keep me' },
      statusLine: { type: 'command', command: '~/bin/mine.sh' },
    };

    applyOtelSettings(settings, DESIRED, HELPER);

    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(settings.env.MY_VAR).toBe('keep me');
    expect(settings.statusLine).toEqual({ type: 'command', command: '~/bin/mine.sh' });
    expect(settings.otelHeadersHelper).toBe(HELPER);
    for (const key of MANAGED_OTEL_KEYS) expect(settings.env[key]).toBe(DESIRED[key]);
  });

  it('removes the static header and remembers it', () => {
    const settings: Record<string, any> = {
      env: { OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20old' },
    };

    const originals = applyOtelSettings(settings, DESIRED, HELPER);

    expect(settings.env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
    expect(originals.OTEL_EXPORTER_OTLP_HEADERS).toBe('Authorization=Bearer%20old');
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

    const originals = applyOtelSettings(settings, DESIRED, HELPER);
    restoreOtelSettings(settings, originals);

    expect(settings).toEqual(before);
  });

  it('deletes keys that only we added, and drops an emptied env', () => {
    const settings: Record<string, any> = {};
    const originals = applyOtelSettings(settings, DESIRED, HELPER);

    restoreOtelSettings(settings, originals);

    expect(settings).toEqual({});
  });

  it('falls back to deleting our keys when the originals were lost', () => {
    const settings: Record<string, any> = { env: { MY_VAR: '1' } };
    applyOtelSettings(settings, DESIRED, HELPER);

    restoreOtelSettings(settings, undefined);

    expect(settings).toEqual({ env: { MY_VAR: '1' } });
    expect(settings.otelHeadersHelper).toBeUndefined();
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
    const backup = await backupSettingsOnce(settingsPath);
    const originals = applyOtelSettings(loaded.settings, DESIRED, HELPER);
    await writeSettingsAtomic(settingsPath, loaded.settings);

    const afterSetup = JSON.parse(await readFile(settingsPath, 'utf-8'));
    expect(afterSetup.otelHeadersHelper).toBe(HELPER);
    expect(afterSetup.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://clawd.gg/otel');
    expect(afterSetup.permissions).toEqual({ allow: ['Read'] });

    expect(existsSync(backup!)).toBe(true);
    expect(JSON.parse(await readFile(backup!, 'utf-8'))).toEqual(original);

    const reloaded = await loadSettings(settingsPath);
    restoreOtelSettings(reloaded.settings, originals);
    await writeSettingsAtomic(settingsPath, reloaded.settings);

    expect(JSON.parse(await readFile(settingsPath, 'utf-8'))).toEqual(original);
  });
});
