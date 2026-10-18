import { describe, expect, it } from 'bun:test';
import { gzipSync } from 'node:zlib';
import {
  decodeOtlpBody,
  parseOtlpEvents,
  parseOtlpMetrics,
  type OtlpLogsRequest,
  type OtlpMetricsRequest,
} from './otel';

// ═══════════════════════════════════════════════════════════════════════════
// Fixture builders — attribute names taken verbatim from
// https://code.claude.com/docs/en/monitoring-usage (Claude Code 2.1.30x).
// ═══════════════════════════════════════════════════════════════════════════

const NANOS = '1760745600000000000'; // 2025-10-18 00:00:00 UTC
const TS = '2025-10-18 00:00:00.000';

type Attrs = Record<string, string | number | boolean>;

function attrs(map: Attrs) {
  return Object.entries(map).map(([key, value]) => ({
    key,
    value:
      typeof value === 'number'
        ? { doubleValue: value }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : { stringValue: value },
  }));
}

function metricsBody(
  name: string,
  dataPoints: { attrs: Attrs; value: number; timeUnixNano?: string }[],
  resource: Attrs = {}
): OtlpMetricsRequest {
  return {
    resourceMetrics: [
      {
        resource: { attributes: attrs(resource) },
        scopeMetrics: [
          {
            scope: { name: 'com.anthropic.claude_code' },
            metrics: [
              {
                name,
                sum: {
                  dataPoints: dataPoints.map(dp => ({
                    timeUnixNano: dp.timeUnixNano ?? NANOS,
                    asDouble: dp.value,
                    attributes: attrs(dp.attrs),
                  })),
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function logsBody(records: { attrs: Attrs }[], resource: Attrs = {}): OtlpLogsRequest {
  return {
    resourceLogs: [
      {
        resource: { attributes: attrs(resource) },
        scopeLogs: [
          {
            scope: { name: 'com.anthropic.claude_code' },
            logRecords: records.map(r => ({
              timeUnixNano: NANOS,
              attributes: attrs(r.attrs),
            })),
          },
        ],
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe('parseOtlpMetrics — standard attributes', () => {
  it('reads standard attributes from the datapoint (where the docs put them)', () => {
    const rows = parseOtlpMetrics(
      metricsBody('claude_code.token.usage', [
        {
          attrs: {
            type: 'input',
            model: 'claude-opus-5-5',
            'session.id': 'sess-dp',
            'terminal.type': 'iTerm.app',
            'app.version': '2.1.302',
            'user.account_uuid': 'acct-dp',
            'organization.id': 'org-dp',
          },
          value: 42,
        },
      ]),
      'u1'
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      timestamp: TS,
      user_id: 'u1',
      session_id: 'sess-dp',
      metric_name: 'claude_code.token.usage',
      value: 42,
      token_type: 'input',
      terminal_type: 'iTerm.app',
      app_version: '2.1.302',
      account_uuid: 'acct-dp',
      organization_id: 'org-dp',
    });
  });

  it('falls back to resource attributes when the datapoint has none', () => {
    const rows = parseOtlpMetrics(
      metricsBody(
        'claude_code.token.usage',
        [{ attrs: { type: 'output' }, value: 7 }],
        {
          'session.id': 'sess-res',
          'terminal.type': 'tmux',
          'app.version': '2.1.100',
          'user.account_uuid': 'acct-res',
          'organization.id': 'org-res',
        }
      ),
      'u1'
    );

    expect(rows[0]).toMatchObject({
      session_id: 'sess-res',
      terminal_type: 'tmux',
      app_version: '2.1.100',
      account_uuid: 'acct-res',
      organization_id: 'org-res',
    });
  });

  it('accepts service.version as the resource spelling of app.version', () => {
    const rows = parseOtlpMetrics(
      metricsBody('claude_code.token.usage', [{ attrs: { type: 'input' }, value: 1 }], {
        'service.name': 'claude-code',
        'service.version': '2.1.302',
      }),
      'u1'
    );
    expect(rows[0]?.app_version).toBe('2.1.302');
  });

  it('prefers the datapoint value over the resource value', () => {
    const rows = parseOtlpMetrics(
      metricsBody(
        'claude_code.token.usage',
        [{ attrs: { type: 'input', 'session.id': 'dp-wins' }, value: 1 }],
        { 'session.id': 'res-loses' }
      ),
      'u1'
    );
    expect(rows[0]?.session_id).toBe('dp-wins');
  });
});

describe('parseOtlpMetrics — renamed and new attributes', () => {
  it('reads code_edit_tool.decision tool_name, decision, language and source', () => {
    const rows = parseOtlpMetrics(
      metricsBody('claude_code.code_edit_tool.decision', [
        {
          attrs: {
            tool_name: 'Edit',
            decision: 'accept',
            source: 'config',
            language: 'TypeScript',
          },
          value: 1,
        },
      ]),
      'u1'
    );
    expect(rows[0]).toMatchObject({
      tool: 'Edit',
      decision: 'accept',
      language: 'TypeScript',
      source: 'config',
    });
  });

  it('still reads the legacy `tool` attribute name', () => {
    const rows = parseOtlpMetrics(
      metricsBody('claude_code.code_edit_tool.decision', [
        { attrs: { tool: 'Write', decision: 'reject', language: 'Python' }, value: 1 },
      ]),
      'u1'
    );
    expect(rows[0]?.tool).toBe('Write');
  });

  it('captures query_source, speed, effort and agent/skill/plugin/mcp names', () => {
    const rows = parseOtlpMetrics(
      metricsBody('claude_code.cost.usage', [
        {
          attrs: {
            model: 'claude-opus-5-5',
            query_source: 'subagent',
            speed: 'fast',
            effort: 'xhigh',
            'agent.name': 'opus-coder',
            'skill.name': 'claude-api',
            'plugin.name': 'pr-review-toolkit',
            'mcp_server.name': 'gmail',
            'mcp_tool.name': 'send_message',
          },
          value: 0.42,
        },
      ]),
      'u1'
    );
    expect(rows[0]).toMatchObject({
      query_source: 'subagent',
      speed: 'fast',
      effort: 'xhigh',
      agent_name: 'opus-coder',
      skill_name: 'claude-api',
      plugin_name: 'pr-review-toolkit',
      mcp_server_name: 'gmail',
      mcp_tool_name: 'send_message',
    });
  });

  it('captures start_type on session.count only', () => {
    const session = parseOtlpMetrics(
      metricsBody('claude_code.session.count', [{ attrs: { start_type: 'resume' }, value: 1 }]),
      'u1'
    );
    expect(session[0]?.start_type).toBe('resume');

    const tokens = parseOtlpMetrics(
      metricsBody('claude_code.token.usage', [
        { attrs: { type: 'input', start_type: 'resume' }, value: 1 },
      ]),
      'u1'
    );
    expect(tokens[0]?.start_type).toBe('');
  });

  it('keeps datapoints that differ only by query_source as separate rows', () => {
    const rows = parseOtlpMetrics(
      metricsBody('claude_code.token.usage', [
        { attrs: { type: 'input', model: 'claude-opus-5-5', query_source: 'main' }, value: 100 },
        { attrs: { type: 'input', model: 'claude-opus-5-5', query_source: 'subagent' }, value: 900 },
      ]),
      'u1'
    );
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.query_source)).toEqual(['main', 'subagent']);
  });
});

describe('parseOtlpEvents', () => {
  it('reads tool_result decision_type / decision_source and tool_use_id', () => {
    const rows = parseOtlpEvents(
      logsBody([
        {
          attrs: {
            'event.name': 'tool_result',
            tool_name: 'Bash',
            tool_use_id: 'toolu_01',
            success: 'true',
            duration_ms: 1234,
            decision_type: 'accept',
            decision_source: 'user_permanent',
            'session.id': 'sess-dp',
          },
        },
      ]),
      'u1'
    );
    expect(rows[0]).toMatchObject({
      event_name: 'claude_code.tool_result',
      tool_name: 'Bash',
      tool_use_id: 'toolu_01',
      tool_success: 1,
      tool_duration_ms: 1234,
      decision: 'accept',
      source: 'user_permanent',
      session_id: 'sess-dp',
    });
  });

  it('still reads tool_decision legacy decision / source names', () => {
    const rows = parseOtlpEvents(
      logsBody([
        {
          attrs: {
            'event.name': 'tool_decision',
            tool_name: 'Edit',
            decision: 'reject',
            source: 'user_reject',
          },
        },
      ]),
      'u1'
    );
    expect(rows[0]).toMatchObject({ decision: 'reject', source: 'user_reject' });
  });

  it('captures user_prompt command attribution without the prompt text', () => {
    const rows = parseOtlpEvents(
      logsBody([
        {
          attrs: {
            'event.name': 'user_prompt',
            prompt_length: 120,
            prompt: 'SECRET PROMPT TEXT',
            prompt_text: 'SECRET PROMPT TEXT',
            command_name: 'commit',
            command_source: 'custom',
            'prompt.id': 'prompt-1',
          },
        },
      ]),
      'u1'
    );
    expect(rows[0]).toMatchObject({
      event_name: 'claude_code.user_prompt',
      prompt_length: 120,
      command_name: 'commit',
      command_source: 'custom',
      prompt_id: 'prompt-1',
    });
    expect(JSON.stringify(rows[0])).not.toContain('SECRET PROMPT TEXT');
  });

  it('captures api_request correlation and attribution attributes', () => {
    const rows = parseOtlpEvents(
      logsBody([
        {
          attrs: {
            'event.name': 'api_request',
            model: 'claude-opus-5-5',
            cost_usd: 0.25,
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 30,
            cache_creation_tokens: 40,
            duration_ms: 900,
            request_id: 'req_abc',
            'prompt.id': 'prompt-1',
            query_source: 'subagent',
            speed: 'normal',
            effort: 'high',
            'agent.name': 'explorer',
            'skill.name': 'dataviz',
          },
        },
      ]),
      'u1'
    );
    expect(rows[0]).toMatchObject({
      event_name: 'claude_code.api_request',
      cost_usd: 0.25,
      cache_write_tokens: 40,
      request_id: 'req_abc',
      prompt_id: 'prompt-1',
      query_source: 'subagent',
      speed: 'normal',
      effort: 'high',
      agent_name: 'explorer',
      skill_name: 'dataviz',
    });
  });

  it('falls back to resource attributes for the standard set', () => {
    const rows = parseOtlpEvents(
      logsBody([{ attrs: { 'event.name': 'user_prompt', prompt_length: 5 } }], {
        'session.id': 'sess-res',
        'app.version': '2.1.302',
        'terminal.type': 'vscode',
        'user.account_uuid': 'acct-res',
        'organization.id': 'org-res',
      }),
      'u1'
    );
    expect(rows[0]).toMatchObject({
      session_id: 'sess-res',
      app_version: '2.1.302',
      terminal_type: 'vscode',
      account_uuid: 'acct-res',
      organization_id: 'org-res',
    });
  });

  it('skips records with no event.name', () => {
    expect(parseOtlpEvents(logsBody([{ attrs: { tool_name: 'Bash' } }]), 'u1')).toHaveLength(0);
  });
});

describe('decodeOtlpBody', () => {
  const body = { resourceMetrics: [] };
  const json = () => new TextEncoder().encode(JSON.stringify(body));

  it('parses an uncompressed JSON body', () => {
    const result = decodeOtlpBody(json(), undefined, 'application/json', 1024, 'resourceMetrics');
    expect(result).toEqual({ ok: true, body });
  });

  it('decompresses a gzip body', () => {
    const gz = new Uint8Array(gzipSync(Buffer.from(JSON.stringify(body))));
    const result = decodeOtlpBody(gz, 'gzip', 'application/json', 1024, 'resourceMetrics');
    expect(result).toEqual({ ok: true, body });
  });

  it('treats Content-Encoding: identity as uncompressed', () => {
    const result = decodeOtlpBody(json(), 'identity', 'application/json', 1024, 'resourceMetrics');
    expect(result.ok).toBe(true);
  });

  it('400s on a gzip header with a non-gzip body', () => {
    const result = decodeOtlpBody(json(), 'gzip', 'application/json', 1024, 'resourceMetrics');
    expect(result).toEqual({ ok: false, status: 400, error: 'Malformed gzip body' });
  });

  it('400s on malformed JSON instead of throwing', () => {
    const raw = new TextEncoder().encode('{not json');
    const result = decodeOtlpBody(raw, undefined, 'application/json', 1024, 'resourceMetrics');
    expect(result).toEqual({ ok: false, status: 400, error: 'Malformed JSON body' });
  });

  it('400s on a non-object top level', () => {
    const raw = new TextEncoder().encode('[]');
    const result = decodeOtlpBody(raw, undefined, 'application/json', 1024, 'resourceMetrics');
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('400s when the signal root is not an array', () => {
    const raw = new TextEncoder().encode('{"resourceMetrics":{}}');
    const result = decodeOtlpBody(raw, undefined, 'application/json', 1024, 'resourceMetrics');
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('415s on protobuf', () => {
    const result = decodeOtlpBody(json(), undefined, 'application/x-protobuf', 1024, 'resourceMetrics');
    expect(result).toMatchObject({ ok: false, status: 415 });
  });

  it('415s on an unsupported Content-Encoding', () => {
    const result = decodeOtlpBody(json(), 'br', 'application/json', 1024, 'resourceMetrics');
    expect(result).toMatchObject({ ok: false, status: 415 });
  });

  it('413s on an oversized wire body', () => {
    const result = decodeOtlpBody(json(), undefined, 'application/json', 4, 'resourceMetrics');
    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it('413s when the decompressed payload exceeds the limit (gzip bomb)', () => {
    const bomb = JSON.stringify({ resourceMetrics: [], pad: 'x'.repeat(50_000) });
    const gz = new Uint8Array(gzipSync(Buffer.from(bomb)));
    expect(gz.byteLength).toBeLessThan(1024);
    const result = decodeOtlpBody(gz, 'gzip', 'application/json', 1024, 'resourceMetrics');
    expect(result).toEqual({ ok: false, status: 413, error: 'Decompressed body too large' });
  });

  it('accepts a missing Content-Type', () => {
    const result = decodeOtlpBody(json(), undefined, undefined, 1024, 'resourceMetrics');
    expect(result.ok).toBe(true);
  });
});
