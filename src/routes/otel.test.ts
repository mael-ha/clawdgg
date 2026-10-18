import { describe, expect, it } from 'bun:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  NO_EVENT_SEQUENCE,
  decodeOtlpBody,
  parseOtlpEvents,
  parseOtlpMetrics,
  parseTimestamp,
  redactAbsolutePaths,
  type OtlpLogsRequest,
  type OtlpMetricsRequest,
} from './otel';

// The parsers return { rows, skipped }. Most tests are about the rows; the
// skip counters have their own describe block ("malformed payloads").
const parseMetrics = (body: OtlpMetricsRequest, userId: string) =>
  parseOtlpMetrics(body, userId).rows;
const parseEvents = (body: OtlpLogsRequest, userId: string) =>
  parseOtlpEvents(body, userId).rows;

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
    const rows = parseMetrics(
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
    const rows = parseMetrics(
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
    const rows = parseMetrics(
      metricsBody('claude_code.token.usage', [{ attrs: { type: 'input' }, value: 1 }], {
        'service.name': 'claude-code',
        'service.version': '2.1.302',
      }),
      'u1'
    );
    expect(rows[0]?.app_version).toBe('2.1.302');
  });

  it('prefers the datapoint value over the resource value', () => {
    const rows = parseMetrics(
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
    const rows = parseMetrics(
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
    const rows = parseMetrics(
      metricsBody('claude_code.code_edit_tool.decision', [
        { attrs: { tool: 'Write', decision: 'reject', language: 'Python' }, value: 1 },
      ]),
      'u1'
    );
    expect(rows[0]?.tool).toBe('Write');
  });

  it('captures query_source, speed, effort and agent/skill/plugin/mcp names', () => {
    const rows = parseMetrics(
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
    const session = parseMetrics(
      metricsBody('claude_code.session.count', [{ attrs: { start_type: 'resume' }, value: 1 }]),
      'u1'
    );
    expect(session[0]?.start_type).toBe('resume');

    const tokens = parseMetrics(
      metricsBody('claude_code.token.usage', [
        { attrs: { type: 'input', start_type: 'resume' }, value: 1 },
      ]),
      'u1'
    );
    expect(tokens[0]?.start_type).toBe('');
  });

  it('keeps datapoints that differ only by query_source as separate rows', () => {
    const rows = parseMetrics(
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
    const rows = parseEvents(
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
    const rows = parseEvents(
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
    const rows = parseEvents(
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
    const rows = parseEvents(
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
    const rows = parseEvents(
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
    expect(parseEvents(logsBody([{ attrs: { tool_name: 'Bash' } }]), 'u1')).toHaveLength(0);
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

describe('identity-completing attributes', () => {
  it('stores active_time.total `type` in time_type, not token_type', () => {
    const rows = parseMetrics(
      metricsBody('claude_code.active_time.total', [
        { attrs: { type: 'user' }, value: 120 },
        { attrs: { type: 'cli' }, value: 340 },
      ]),
      'u1'
    );
    expect(rows.map(r => r.time_type)).toEqual(['user', 'cli']);
    expect(rows.map(r => r.token_type)).toEqual(['', '']);
    expect(rows.map(r => r.line_type)).toEqual(['', '']);
  });

  it('leaves time_type empty on metrics that are not active_time', () => {
    const rows = parseMetrics(
      metricsBody('claude_code.token.usage', [{ attrs: { type: 'input' }, value: 1 }]),
      'u1'
    );
    expect(rows[0]?.time_type).toBe('');
    expect(rows[0]?.token_type).toBe('input');
  });

  it('reads marketplace.name alongside plugin.name', () => {
    const rows = parseMetrics(
      metricsBody('claude_code.cost.usage', [
        { attrs: { 'plugin.name': 'pr-review-toolkit', 'marketplace.name': 'anthropic' }, value: 1 },
      ]),
      'u1'
    );
    expect(rows[0]).toMatchObject({ plugin_name: 'pr-review-toolkit', marketplace_name: 'anthropic' });
  });

  it('reads event.sequence, message.uuid, client_request_id, error_type and tool_source', () => {
    const rows = parseEvents(
      logsBody([
        {
          attrs: {
            'event.name': 'tool_result',
            'event.sequence': 42,
            'message.uuid': 'msg-1',
            client_request_id: 'creq_1',
            error_type: 'Error:ENOENT',
            tool_source: 'mcp',
            'marketplace.name': 'anthropic',
          },
        },
      ]),
      'u1'
    );
    expect(rows[0]).toMatchObject({
      event_sequence: 42,
      message_uuid: 'msg-1',
      client_request_id: 'creq_1',
      error_type: 'Error:ENOENT',
      tool_source: 'mcp',
      marketplace_name: 'anthropic',
    });
  });

  it('reads event.sequence 0 as 0, and a missing one as -1', () => {
    const withZero = parseEvents(
      logsBody([{ attrs: { 'event.name': 'user_prompt', 'event.sequence': 0 } }]),
      'u1'
    );
    expect(withZero[0]?.event_sequence).toBe(0);

    const without = parseEvents(logsBody([{ attrs: { 'event.name': 'user_prompt' } }]), 'u1');
    expect(without[0]?.event_sequence).toBe(NO_EVENT_SEQUENCE);
    expect(NO_EVENT_SEQUENCE).toBe(-1);
  });
});

describe('privacy at ingest', () => {
  it('never stores tool_parameters or tool_input, however they are sent', () => {
    const rows = parseEvents(
      logsBody([
        {
          attrs: {
            'event.name': 'tool_result',
            tool_name: 'Bash',
            tool_parameters: '{"command":"cat ~/.ssh/id_rsa"}',
            tool_input: '{"command":"cat ~/.ssh/id_rsa"}',
          },
        },
      ]),
      'u1'
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain('id_rsa');
    expect(Object.keys(rows[0]!)).not.toContain('tool_parameters');
  });

  it.each([
    ["ENOENT: no such file, open '/Users/mael/secrets/key.ts'", "ENOENT: no such file, open '<path>'"],
    ['cannot read /home/deploy/app/.env', 'cannot read <path>'],
    ['tmpdir /tmp/build-9f2/out.log gone', 'tmpdir <path> gone'],
    ['config at ~/.claude/settings.json is invalid', 'config at <path> is invalid'],
    ['Access denied: C:\\Users\\bob\\Documents\\x.txt', 'Access denied: <path>'],
  ])('strips %s', (raw, expected) => {
    expect(redactAbsolutePaths(raw)).toBe(expected);
  });

  it('leaves an error with no path alone', () => {
    expect(redactAbsolutePaths('overloaded_error: please retry')).toBe(
      'overloaded_error: please retry'
    );
  });

  it('strips paths out of the stored error_message', () => {
    const rows = parseEvents(
      logsBody([
        {
          attrs: {
            'event.name': 'tool_result',
            error: "EACCES: permission denied, open '/Users/mael/code/private/.env'",
          },
        },
      ]),
      'u1'
    );
    expect(rows[0]?.error_message).toBe("EACCES: permission denied, open '<path>'");
  });
});

describe('malformed payloads', () => {
  it('keeps the good datapoints and counts the bad ones', () => {
    const body: OtlpMetricsRequest = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.token.usage',
                  sum: {
                    dataPoints: [
                      // no timeUnixNano
                      { asDouble: 1, attributes: attrs({ type: 'input' }) } as any,
                      { timeUnixNano: NANOS, asDouble: 2, attributes: attrs({ type: 'output' }) },
                      // attribute object with no `value`
                      {
                        timeUnixNano: NANOS,
                        asDouble: 3,
                        attributes: [{ key: 'type' }] as any,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const result = parseOtlpMetrics(body, 'u1');
    expect(result.skipped).toBe(1);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map(r => r.value)).toEqual([2, 3]);
    // The valueless attribute reads as absent rather than throwing.
    expect(result.rows[1]?.token_type).toBe('');
  });

  it('survives a null entry in resourceMetrics', () => {
    const result = parseOtlpMetrics({ resourceMetrics: [null] } as any, 'u1');
    expect(result).toEqual({ rows: [], skipped: 0 });
  });

  it('survives non-array attributes and scope containers', () => {
    const body = {
      resourceMetrics: [
        {
          resource: { attributes: 'nope' },
          scopeMetrics: { metrics: [] },
        },
      ],
    } as any;
    expect(parseOtlpMetrics(body, 'u1')).toEqual({ rows: [], skipped: 0 });
  });

  it('counts a log record with no event.name or no timestamp as skipped', () => {
    const noName = parseOtlpEvents(logsBody([{ attrs: { tool_name: 'Bash' } }]), 'u1');
    expect(noName).toEqual({ rows: [], skipped: 1 });

    const noTime = parseOtlpEvents(
      {
        resourceLogs: [
          {
            scopeLogs: [
              { logRecords: [{ attributes: attrs({ 'event.name': 'user_prompt' }) } as any] },
            ],
          },
        ],
      },
      'u1'
    );
    expect(noTime).toEqual({ rows: [], skipped: 1 });
  });

  it('survives a null entry in resourceLogs', () => {
    expect(parseOtlpEvents({ resourceLogs: [null] } as any, 'u1')).toEqual({ rows: [], skipped: 0 });
  });

  it('reads an unparseable timestamp as no timestamp', () => {
    expect(parseTimestamp('not-a-number')).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp(1.5)).toBe('1970-01-01 00:00:00.000');
    expect(parseTimestamp(NANOS)).toBe(TS);
  });
});

describe('gzip bomb', () => {
  const LIMIT = 1024 * 1024; // the real /v1/metrics limit
  const BOMB_BYTES = 128 * 1024 * 1024;

  // A 128 MiB run of zeros compresses to ~128 KiB: a 1000:1 ratio, the shape of
  // a real bomb. Built in its own scope so the source buffer is unreferenced
  // before anything is measured.
  const bomb = (() => {
    const gz = new Uint8Array(gzipSync(Buffer.alloc(BOMB_BYTES)));
    expect(gz.byteLength).toBeLessThan(LIMIT);
    return gz;
  })();

  // The REJECTION is the proof, not the status code: with maxOutputLength zlib
  // refuses to produce the buffer at all, so there is no 128 MiB allocation to
  // measure afterwards.
  it('refuses to decompress past the limit instead of allocating it', () => {
    let thrown: NodeJS.ErrnoException | undefined;
    try {
      gunzipSync(bomb, { maxOutputLength: LIMIT });
    } catch (error) {
      thrown = error as NodeJS.ErrnoException;
    }
    expect(thrown?.code).toBe('ERR_BUFFER_TOO_LARGE');
  });

  it('answers 413 without the payload ever reaching memory', () => {
    const before = process.memoryUsage().rss;
    const result = decodeOtlpBody(bomb, 'gzip', 'application/json', LIMIT, 'resourceMetrics');
    const grew = process.memoryUsage().rss - before;

    expect(result).toEqual({ ok: false, status: 413, error: 'Decompressed body too large' });
    // Had the output been materialised, rss would have grown by ~128 MiB.
    expect(grew).toBeLessThan(BOMB_BYTES / 8);
  });
});
