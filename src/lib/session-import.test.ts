import { describe, expect, it } from 'bun:test';
import {
  BUILTIN_SLASH_COMMANDS,
  contentLength,
  describeTranscriptPath,
  fillPromptGapsFromHistory,
  fmtTs,
  isBuiltinSlashCommand,
  mapHistoryText,
  mapJsonlText,
  mapLine,
  type MapOptions,
} from './session-import';

const OPTS: MapOptions = {
  userId: 'github_1',
  provenance: 'import',
  sessionFallback: 'file-session',
  isSubagentFile: false,
  excludeBuiltinSlashPrompts: true,
};

const userLine = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  timestamp: '2026-03-01T10:00:00.000Z',
  sessionId: 's1',
  message: { content: text },
  ...extra,
});

const assistantLine = (usage: Record<string, unknown>, model = 'claude-opus-5') => ({
  type: 'assistant',
  timestamp: '2026-03-01T10:00:01.500Z',
  sessionId: 's1',
  message: { model, usage },
});

describe('fmtTs', () => {
  it('formats as ClickHouse DateTime64(3) in UTC', () => {
    expect(fmtTs(new Date('2026-03-01T10:00:01.500Z'))).toBe('2026-03-01 10:00:01.500');
    expect(fmtTs(new Date('2026-01-02T03:04:05.006Z'))).toBe('2026-01-02 03:04:05.006');
  });
});

describe('contentLength', () => {
  it('counts a string, text blocks, and nothing else', () => {
    expect(contentLength('hello')).toBe(5);
    expect(contentLength([{ type: 'text', text: 'ab' }, { type: 'text', text: 'cde' }])).toBe(5);
    expect(contentLength([{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /' } }])).toBe(0);
    expect(contentLength(undefined)).toBe(0);
  });
});

describe('isBuiltinSlashCommand', () => {
  it('matches Claude Code session commands, with or without arguments', () => {
    expect(isBuiltinSlashCommand('/clear')).toBe(true);
    expect(isBuiltinSlashCommand('/compact focus on the bug')).toBe(true);
    expect(isBuiltinSlashCommand('/model opus')).toBe(true);
    expect(isBuiltinSlashCommand('  /status')).toBe(true);
    expect(isBuiltinSlashCommand('/MODEL')).toBe(true);
  });

  it('does NOT match work: skills, plugins, MCP and custom commands', () => {
    // These ask the model to do something, so they count exactly like a prompt.
    expect(isBuiltinSlashCommand('/code-review')).toBe(false);
    expect(isBuiltinSlashCommand('/security-review')).toBe(false);
    expect(isBuiltinSlashCommand('/init')).toBe(false);
    expect(isBuiltinSlashCommand('/my-team:deploy')).toBe(false);
    expect(isBuiltinSlashCommand('/knowledge:create')).toBe(false);
  });

  it('is not fooled by prose that merely contains a slash', () => {
    expect(isBuiltinSlashCommand('what does /clear do?')).toBe(false);
    expect(isBuiltinSlashCommand('')).toBe(false);
    expect(isBuiltinSlashCommand('/')).toBe(false);
  });

  it('never lists a bundled skill as a built-in', () => {
    for (const name of ['code-review', 'security-review', 'simplify', 'review', 'loop', 'run']) {
      expect(BUILTIN_SLASH_COMMANDS.has(name)).toBe(false);
    }
  });
});

describe('mapLine — user prompts', () => {
  it('emits a user_prompt carrying the LENGTH and never the text', () => {
    const { events } = mapLine(userLine('fix the auth bug'), OPTS);

    expect(events).toEqual([
      {
        timestamp: '2026-03-01 10:00:00.000',
        user_id: 'github_1',
        session_id: 's1',
        provenance: 'import',
        event_name: 'claude_code.user_prompt',
        prompt_length: 16,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('auth bug');
  });

  it('excludes subagent-file prompts (Task delegations, not typed by a human)', () => {
    const { events } = mapLine(userLine('do the thing'), { ...OPTS, isSubagentFile: true });
    expect(events).toEqual([]);
  });

  it('excludes isSidechain prompts', () => {
    const { events } = mapLine(userLine('do the thing', { isSidechain: true }), OPTS);
    expect(events).toEqual([]);
  });

  it('excludes built-in slash commands but keeps custom ones', () => {
    expect(mapLine(userLine('/clear'), OPTS).events).toEqual([]);
    expect(mapLine(userLine('/compact'), OPTS).events).toEqual([]);
    expect(mapLine(userLine('/code-review'), OPTS).events).toHaveLength(1);
    expect(mapLine(userLine('/my-cmd arg'), OPTS).events).toHaveLength(1);
  });

  it('keeps built-ins when the flag is off (backfill-jsonl behaviour)', () => {
    const legacy = { ...OPTS, provenance: 'backfill' as const, excludeBuiltinSlashPrompts: false };
    expect(mapLine(userLine('/clear'), legacy).events).toHaveLength(1);
  });

  it('falls back to the file name when a line has no sessionId', () => {
    const line = userLine('hi');
    delete (line as any).sessionId;
    expect(mapLine(line, OPTS).events[0]!.session_id).toBe('file-session');
  });
});

describe('mapLine — assistant usage', () => {
  it('emits an api_request plus one metric per non-zero token type, and a cost', () => {
    const { events, metrics } = mapLine(
      assistantLine({
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
        cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 },
      }),
      OPTS
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.event_name).toBe('claude_code.api_request');
    expect(events[0]!.input_tokens).toBe(10);
    expect(events[0]!.cache_write_tokens).toBe(40);
    expect(events[0]!.cost_usd).toBeGreaterThan(0);

    expect(metrics.filter((m) => m.metric_name === 'claude_code.token.usage').map((m) => m.token_type))
      .toEqual(['input', 'output', 'cacheRead', 'cacheCreation']);
    expect(metrics.filter((m) => m.metric_name === 'claude_code.cost.usage')).toHaveLength(1);
  });

  it('skips zero token types instead of writing zero-valued rows', () => {
    const { metrics } = mapLine(assistantLine({ input_tokens: 5, output_tokens: 0 }), OPTS);
    expect(metrics.filter((m) => m.token_type).map((m) => m.token_type)).toEqual(['input']);
  });

  it('drops <synthetic> rows (local placeholders that never hit the API)', () => {
    const { events, metrics } = mapLine(
      assistantLine({ input_tokens: 0, output_tokens: 0 }, '<synthetic>'),
      OPTS
    );
    expect(events).toEqual([]);
    expect(metrics).toEqual([]);
  });

  it('prices 1h cache creation above 5m, and reports the flat fallback', () => {
    const split = mapLine(
      assistantLine({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
      }),
      OPTS
    );
    const flat = mapLine(
      assistantLine({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 }),
      OPTS
    );

    expect(split.events[0]!.cost_usd).toBeGreaterThan(flat.events[0]!.cost_usd!);
    expect(split.flatCacheFallbacks).toBe(0);
    expect(flat.flatCacheFallbacks).toBe(1);
  });

  it('emits a tool_result per tool_use block', () => {
    const { events } = mapLine(
      {
        type: 'assistant',
        timestamp: '2026-03-01T10:00:01.500Z',
        sessionId: 's1',
        message: {
          model: 'claude-opus-5',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            { type: 'tool_use', name: 'Read' },
          ],
        },
      },
      OPTS
    );
    expect(events.map((e) => e.tool_name)).toEqual(['Bash', 'Read']);
    expect(JSON.stringify(events)).not.toContain('ls');
  });
});

describe('mapJsonlText', () => {
  const text = [
    JSON.stringify(userLine('one')),
    'not json at all',
    JSON.stringify({ type: 'user', message: { content: 'no timestamp' } }),
    JSON.stringify({ ...userLine('two'), timestamp: '2026-05-01T10:00:00.000Z' }),
    '',
  ].join('\n');

  it('skips malformed and timestamp-less lines', () => {
    expect(mapJsonlText(text, OPTS).events).toHaveLength(2);
  });

  it('applies the time window, [from, to)', () => {
    const windowed = mapJsonlText(text, { ...OPTS, to: new Date('2026-04-01T00:00:00Z') });
    expect(windowed.events.map((e) => e.timestamp)).toEqual(['2026-03-01 10:00:00.000']);

    const exclusive = mapJsonlText(text, { ...OPTS, from: new Date('2026-05-01T10:00:00.000Z') });
    expect(exclusive.events.map((e) => e.timestamp)).toEqual(['2026-05-01 10:00:00.000']);
  });
});

describe('describeTranscriptPath', () => {
  it('reads the session id off the file name and spots subagent files', () => {
    expect(describeTranscriptPath('/h/.claude/projects/p/abc-123.jsonl')).toEqual({
      sessionFallback: 'abc-123',
      isSubagentFile: false,
    });
    expect(describeTranscriptPath('/h/.claude/projects/p/abc/subagents/agent-7.jsonl')).toEqual({
      sessionFallback: 'agent-7',
      isSubagentFile: true,
    });
  });
});

describe('mapHistoryText', () => {
  const at = (iso: string) => new Date(iso).getTime();
  const history = [
    JSON.stringify({ timestamp: at('2026-03-01T10:00:00Z'), display: 'fix the bug', sessionId: 's1' }),
    JSON.stringify({ timestamp: at('2026-03-01T10:00:20Z'), display: 'fix the bug', sessionId: 's1' }),
    JSON.stringify({ timestamp: at('2026-03-01T10:02:00Z'), display: '/clear', sessionId: 's1' }),
    JSON.stringify({ timestamp: at('2026-03-01T10:03:00Z'), display: '/code-review', sessionId: 's1' }),
    JSON.stringify({ timestamp: at('2026-03-01T10:04:00Z'), display: '   ', sessionId: 's1' }),
    JSON.stringify({ timestamp: at('2026-06-01T10:00:00Z'), display: 'much later', sessionId: 's2' }),
  ].join('\n');

  it('drops built-ins, keeps custom commands, dedupes up-arrow repeats', () => {
    const result = mapHistoryText(history, {
      userId: 'github_1',
      provenance: 'import',
      slashPolicy: 'drop-builtin',
    });

    expect(result.events.map((e) => e.prompt_length)).toEqual([11, 12, 10]);
    expect(result.droppedSlash).toBe(1);
    expect(result.droppedDuplicate).toBe(1);
    expect(result.droppedEmpty).toBe(1);
    expect(result.parsed).toBe(6);
  });

  it("drop-all keeps backfill-jsonl's historical behaviour", () => {
    const result = mapHistoryText(history, {
      userId: 'github_1',
      provenance: 'backfill-history',
      slashPolicy: 'drop-all',
    });
    expect(result.droppedSlash).toBe(2);
    expect(result.events.map((e) => e.prompt_length)).toEqual([11, 10]);
  });

  it('enforces the window and never carries prompt text', () => {
    const result = mapHistoryText(history, {
      userId: 'github_1',
      provenance: 'import',
      slashPolicy: 'drop-builtin',
      to: new Date('2026-04-01T00:00:00Z'),
    });

    expect(result.droppedOutOfWindow).toBe(1);
    expect(JSON.stringify(result.events)).not.toContain('fix the bug');
    expect(JSON.stringify(result.events)).not.toContain('much later');
  });
});

describe('fillPromptGapsFromHistory', () => {
  const prompt = (timestamp: string) => ({
    timestamp,
    user_id: 'github_1',
    session_id: 's1',
    event_name: 'claude_code.user_prompt',
    prompt_length: 5,
    provenance: 'import' as const,
  });

  it('keeps history only for days the transcripts never covered', () => {
    const transcripts = [prompt('2026-03-01 10:00:00.000'), prompt('2026-03-03 10:00:00.000')];
    const history = [
      prompt('2026-03-01 10:00:00.123'), // same day as a transcript: would double-count
      prompt('2026-03-02 09:00:00.000'),
      prompt('2026-03-02 11:00:00.000'),
    ];

    const result = fillPromptGapsFromHistory(transcripts, history);

    expect(result.events.map((e) => e.timestamp)).toEqual([
      '2026-03-02 09:00:00.000',
      '2026-03-02 11:00:00.000',
    ]);
    expect(result.coveredDays).toBe(2);
    expect(result.gapDays).toEqual(['2026-03-02']);
  });

  it('counts a day as covered only when it has a real prompt event', () => {
    const apiOnly = [
      {
        timestamp: '2026-03-02 10:00:00.000',
        user_id: 'github_1',
        session_id: 's1',
        event_name: 'claude_code.api_request',
        provenance: 'import' as const,
      },
    ];

    // A day with API calls but no user_prompt rows (a subagent-only transcript)
    // is still a prompt gap.
    expect(fillPromptGapsFromHistory(apiOnly, [prompt('2026-03-02 09:00:00.000')]).events)
      .toHaveLength(1);
  });
});

describe('one prompt rule, every source', () => {
  // Real shapes, taken verbatim from ~/.claude/projects/**/*.jsonl on
  // 2026-10-18. Claude Code wraps a dispatched command in tags, and the
  // command-name tag is not always first.
  it.each([
    '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>',
    '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-fable-5</command-args>',
    '<command-message>rename</command-message>\n<command-name>/rename</command-name>',
  ])('detects a built-in command wrapped in <command-name> tags', text => {
    expect(isBuiltinSlashCommand(text)).toBe(true);
  });

  it('keeps a wrapped custom or workflow command — those reach a model', () => {
    // /init and /code-review are bundled workflow commands, not session
    // management: they do real work, so they count exactly like a typed prompt.
    expect(isBuiltinSlashCommand('<command-message>init</command-message>\n<command-name>/init</command-name>')).toBe(false);
    expect(isBuiltinSlashCommand('<command-name>/code-review</command-name>')).toBe(false);
    expect(isBuiltinSlashCommand('<command-name>/my-own-thing</command-name>')).toBe(false);
  });

  it('drops built-in slash prompts from JSONL by DEFAULT', () => {
    const line = {
      type: 'user',
      timestamp: '2026-10-18T09:00:00.000Z',
      sessionId: 's1',
      message: { content: '<command-name>/compact</command-name>' },
    };
    // No excludeBuiltinSlashPrompts passed at all.
    const dropped = mapLine(line, { userId: 'u', provenance: 'backfill', sessionFallback: 's1', isSubagentFile: false });
    expect(dropped.events).toHaveLength(0);

    // And an explicit false still counts it, for a deliberate comparison run.
    const kept = mapLine(line, {
      userId: 'u',
      provenance: 'backfill',
      sessionFallback: 's1',
      isSubagentFile: false,
      excludeBuiltinSlashPrompts: false,
    });
    expect(kept.events).toHaveLength(1);
  });

  it('keeps a free-typed prompt and a custom command from JSONL', () => {
    const base = { userId: 'u', provenance: 'backfill' as const, sessionFallback: 's1', isSubagentFile: false };
    for (const content of ['just a normal prompt', '<command-name>/code-review</command-name>']) {
      const out = mapLine(
        { type: 'user', timestamp: '2026-10-18T09:00:00.000Z', sessionId: 's1', message: { content } },
        base
      );
      expect(out.events).toHaveLength(1);
      expect(out.events[0]!.event_name).toBe('claude_code.user_prompt');
    }
  });

  it('applies drop-builtin to history.jsonl by DEFAULT', () => {
    const raw = [
      { timestamp: Date.parse('2026-10-18T09:00:00Z'), display: '/compact', sessionId: 's1' },
      { timestamp: Date.parse('2026-10-18T09:01:00Z'), display: '/code-review', sessionId: 's1' },
      { timestamp: Date.parse('2026-10-18T09:02:00Z'), display: 'a typed prompt', sessionId: 's1' },
      { timestamp: Date.parse('2026-10-18T09:03:00Z'), display: '<command-name>/model</command-name>', sessionId: 's1' },
    ]
      .map(r => JSON.stringify(r))
      .join('\n');

    // No slashPolicy passed at all.
    const out = mapHistoryText(raw, { userId: 'u', provenance: 'backfill-history' });
    expect(out.events).toHaveLength(2); // /code-review + the typed prompt
    expect(out.droppedSlash).toBe(2);   // /compact + the wrapped /model
  });

  it('still supports drop-all for comparing against a historical run', () => {
    const raw = JSON.stringify({
      timestamp: Date.parse('2026-10-18T09:00:00Z'),
      display: '/code-review',
      sessionId: 's1',
    });
    const out = mapHistoryText(raw, {
      userId: 'u',
      provenance: 'backfill-history',
      slashPolicy: 'drop-all',
    });
    expect(out.events).toHaveLength(0);
    expect(out.droppedSlash).toBe(1);
  });
});

describe('fast-mode speed reaches the rows', () => {
  const line = (speed: string | undefined) => ({
    type: 'assistant',
    timestamp: '2026-10-18T09:00:00.000Z',
    sessionId: 's1',
    message: {
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 0,
        ...(speed === undefined ? {} : { speed }),
      },
    },
  });

  const opts = { userId: 'u', provenance: 'backfill' as const, sessionFallback: 's1', isSubagentFile: false };

  it('prices Opus 5.5 fast mode at $8/MTok and records the speed', () => {
    const out = mapLine(line('fast'), opts);
    const apiRequest = out.events.find(e => e.event_name === 'claude_code.api_request')!;
    expect(apiRequest.speed).toBe('fast');
    expect(apiRequest.cost_usd).toBeCloseTo(8, 6);
    expect(out.metrics.every(m => m.speed === 'fast')).toBe(true);
  });

  it('prices standard and absent speed at the standard $4/MTok', () => {
    for (const speed of ['standard', undefined]) {
      const apiRequest = mapLine(line(speed), opts).events.find(
        e => e.event_name === 'claude_code.api_request'
      )!;
      expect(apiRequest.cost_usd).toBeCloseTo(4, 6);
    }
  });
});

describe('Haiku 5.5 prompt-length tier reaches the rows', () => {
  const haikuLine = (inputTokens: number) => ({
    type: 'assistant',
    timestamp: '2026-10-18T09:00:00.000Z',
    sessionId: 's1',
    message: {
      model: 'claude-haiku-5-5',
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });

  const opts = { userId: 'u', provenance: 'backfill' as const, sessionFallback: 's1', isSubagentFile: false };

  it('uses the standard tier at 100K input tokens', () => {
    const cost = mapLine(haikuLine(100_000), opts).events[0]!.cost_usd!;
    expect(cost).toBeCloseTo(100_000 * 0.1 / 1e6, 10);
  });

  it('uses the 5x tier just above 100K', () => {
    const cost = mapLine(haikuLine(100_001), opts).events[0]!.cost_usd!;
    expect(cost).toBeCloseTo(100_001 * 0.5 / 1e6, 10);
  });

  it('counts cache reads toward the prompt length, per the pricing page', () => {
    // 60K fresh + 60K cache read = 120K prompt, over the threshold even though
    // neither category alone is.
    const out = mapLine(
      {
        type: 'assistant',
        timestamp: '2026-10-18T09:00:00.000Z',
        sessionId: 's1',
        message: {
          model: 'claude-haiku-5-5',
          usage: { input_tokens: 60_000, output_tokens: 0, cache_read_input_tokens: 60_000 },
        },
      },
      opts
    );
    // priced at the high tier: 60000*0.50 + 60000*0.05 per MTok
    expect(out.events[0]!.cost_usd).toBeCloseTo((60_000 * 0.5 + 60_000 * 0.05) / 1e6, 10);
  });
});
