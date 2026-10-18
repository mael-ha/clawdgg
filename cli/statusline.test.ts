import { describe, expect, it } from 'bun:test';
import {
  applyStatusLineSetting,
  buildPlanUsageReport,
  formatStatusLine,
  removeStatusLineSetting,
  STATUSLINE_COMMAND,
} from './statusline';

describe('applyStatusLineSetting', () => {
  it('registers ours when nothing is configured', () => {
    const settings: Record<string, any> = { env: { FOO: '1' } };
    expect(applyStatusLineSetting(settings)).toEqual({ action: 'added' });
    expect(settings).toEqual({
      env: { FOO: '1' },
      statusLine: { type: 'command', command: STATUSLINE_COMMAND },
    });
  });

  it('is idempotent once registered', () => {
    const settings: Record<string, any> = {};
    applyStatusLineSetting(settings);
    const before = JSON.stringify(settings);
    expect(applyStatusLineSetting(settings)).toEqual({ action: 'already-ours' });
    expect(JSON.stringify(settings)).toBe(before);
  });

  it('leaves our command alone when the user invokes it their own way', () => {
    const settings: Record<string, any> = {
      statusLine: { type: 'command', command: 'npx clawdgg statusline', padding: 0 },
    };
    expect(applyStatusLineSetting(settings)).toEqual({ action: 'already-ours' });
    expect(settings.statusLine.command).toBe('npx clawdgg statusline');
    expect(settings.statusLine.padding).toBe(0);
  });

  it('never clobbers someone else\'s status line', () => {
    const settings: Record<string, any> = {
      statusLine: { type: 'command', command: '~/bin/my-prompt.sh' },
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
    };
    expect(applyStatusLineSetting(settings)).toEqual({
      action: 'conflict',
      existing: '~/bin/my-prompt.sh',
    });
    expect(settings.statusLine).toEqual({ type: 'command', command: '~/bin/my-prompt.sh' });
  });

  it('does not claim a status line that merely mentions us', () => {
    // The old substring test claimed these, and claiming someone else's status
    // line means deleting it on `clawdgg disable`.
    for (const command of [
      '~/bin/prompt.sh --theme clawdgg --no-statusline',
      'starship prompt # clawdgg statusline',
      '/opt/bin/statusline',
      'clawdgg status',
    ]) {
      const settings: Record<string, any> = { statusLine: { type: 'command', command } };
      expect(applyStatusLineSetting(settings)).toEqual({ action: 'conflict', existing: command });
      expect(settings.statusLine.command).toBe(command);
    }
  });

  it('claims a shell-quoted path to our binary', () => {
    const command = `'/Users/Mael O'\\''Hara/.clawdgg/bin/clawdgg' statusline`;
    expect(applyStatusLineSetting({ statusLine: { type: 'command', command } })).toEqual({
      action: 'already-ours',
    });
  });

  it('treats a bare string status line as configured', () => {
    const foreign: Record<string, any> = { statusLine: 'starship prompt' };
    expect(applyStatusLineSetting(foreign)).toEqual({
      action: 'conflict',
      existing: 'starship prompt',
    });
    expect(foreign.statusLine).toBe('starship prompt');

    const ours: Record<string, any> = { statusLine: 'clawdgg statusline' };
    expect(applyStatusLineSetting(ours)).toEqual({ action: 'already-ours' });
  });
});

describe('removeStatusLineSetting', () => {
  it('removes ours', () => {
    const settings: Record<string, any> = { env: {} };
    applyStatusLineSetting(settings);
    expect(removeStatusLineSetting(settings)).toBe('removed');
    expect(settings).toEqual({ env: {} });
  });

  it('keeps a foreign one', () => {
    const settings: Record<string, any> = {
      statusLine: { type: 'command', command: '~/bin/my-prompt.sh' },
    };
    expect(removeStatusLineSetting(settings)).toBe('not-ours');
    expect(settings.statusLine.command).toBe('~/bin/my-prompt.sh');
  });

  it('is a no-op when there is none', () => {
    expect(removeStatusLineSetting({})).toBe('absent');
  });
});

describe('formatStatusLine', () => {
  it('shows the model and the seven-day window', () => {
    expect(
      formatStatusLine({
        model: { display_name: 'Opus 5', id: 'claude-opus-5' },
        rate_limits: {
          five_hour: { used_percentage: 12, resets_at: 1790000000 },
          seven_day: { used_percentage: 41.6, resets_at: 1790400000 },
        },
      })
    ).toBe('Opus 5 · 7d 42%');
  });

  it('drops the window when rate_limits is absent', () => {
    expect(formatStatusLine({ model: { display_name: 'Opus 5' } })).toBe('Opus 5');
  });

  it('falls back to the model id, then to a bare brand', () => {
    expect(formatStatusLine({ model: { id: 'claude-sonnet-5' } })).toBe('claude-sonnet-5');
    expect(formatStatusLine({})).toBe('clawd.gg');
  });

  it('ignores an unusable seven_day percentage', () => {
    expect(
      formatStatusLine({
        model: { display_name: 'Opus 5' },
        rate_limits: { seven_day: { used_percentage: 'unknown' } },
      })
    ).toBe('Opus 5');
  });
});

describe('buildPlanUsageReport', () => {
  const now = new Date('2026-10-18T09:00:00.000Z');

  // The report rides on an argv, which `ps` shows to every user on the box.
  // The raw status line blob carries the user's cwd and transcript path; this
  // carries the windows the server is getting anyway, and nothing else.
  it('carries the windows and the session, never the paths around them', () => {
    const report = buildPlanUsageReport(
      {
        model: { display_name: 'Opus 5' },
        session_id: 'sess-1',
        cwd: '/Users/mael/code/secret-client',
        transcript_path: '/Users/mael/.claude/projects/secret-client/t.jsonl',
        rate_limits: { seven_day: { used_percentage: 41.6, resets_at: 1790400000 } },
      } as any,
      now
    );

    expect(report).toEqual({
      rate_limits: { seven_day: { used_percentage: 41.6, resets_at: 1790400000 } },
      sessionId: 'sess-1',
      capturedAt: 1792314000,
    });

    const json = JSON.stringify(report);
    expect(json).not.toContain('secret-client');
    expect(json).not.toContain('transcript');
  });

  it('stamps the capture time in the parent, where the snapshot was true', () => {
    expect(buildPlanUsageReport({ rate_limits: {} }, now).capturedAt).toBe(1792314000);
  });

  it('leaves the session out rather than sending a non-string', () => {
    expect(buildPlanUsageReport({ rate_limits: {}, session_id: 42 } as any, now).sessionId).toBeUndefined();
  });
});
