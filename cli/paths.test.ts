import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_API_BASE_URL,
  isAllowedApiOrigin,
  resolveApiBaseUrl,
  selfArgv,
  selfCommand,
  tokenIsForThisOrigin,
} from './paths';

describe('isAllowedApiOrigin', () => {
  it('accepts https anywhere', () => {
    expect(isAllowedApiOrigin('https://clawd.gg')).toBe(true);
    expect(isAllowedApiOrigin('https://staging.clawd.gg/')).toBe(true);
  });

  it('accepts plain http only on loopback', () => {
    // `bun run dev` is developed against these, and they never leave the box.
    expect(isAllowedApiOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedApiOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedApiOrigin('http://[::1]:3000')).toBe(true);
  });

  it('refuses to send a bearer token over plain http to anywhere else', () => {
    expect(isAllowedApiOrigin('http://clawd.gg')).toBe(false);
    expect(isAllowedApiOrigin('http://192.168.1.10:3000')).toBe(false);
    expect(isAllowedApiOrigin('http://evil.example')).toBe(false);
    expect(isAllowedApiOrigin('file:///etc/passwd')).toBe(false);
    expect(isAllowedApiOrigin('not a url')).toBe(false);
    expect(isAllowedApiOrigin('')).toBe(false);
  });
});

describe('resolveApiBaseUrl', () => {
  it('defaults to clawd.gg', () => {
    expect(resolveApiBaseUrl(undefined, true)).toEqual({ url: DEFAULT_API_BASE_URL });
    expect(resolveApiBaseUrl(undefined, false)).toEqual({ url: DEFAULT_API_BASE_URL });
  });

  it('IGNORES the override in a release build', () => {
    // `clawdgg` runs from inside the user's projects, where the env a hook
    // inherits is not under anyone's eye. CLAWDGG_DEV=1 is the opt-in.
    const resolved = resolveApiBaseUrl('https://evil.example', false);
    expect(resolved.url).toBe(DEFAULT_API_BASE_URL);
    expect(resolved.rejected?.value).toBe('https://evil.example');
    expect(resolved.rejected?.reason).toContain('CLAWDGG_DEV=1');
  });

  it('honours the override in dev mode', () => {
    expect(resolveApiBaseUrl('http://localhost:4599', true)).toEqual({
      url: 'http://localhost:4599',
    });
    // Trailing slashes go, so `${origin}/otel` is never `//otel`.
    expect(resolveApiBaseUrl('https://staging.clawd.gg//', true).url).toBe(
      'https://staging.clawd.gg'
    );
  });

  it('refuses an unsafe override even in dev mode', () => {
    const resolved = resolveApiBaseUrl('http://evil.example', true);
    expect(resolved.url).toBe(DEFAULT_API_BASE_URL);
    expect(resolved.rejected?.reason).toContain('https');
  });
});

describe('tokenIsForThisOrigin', () => {
  it('trusts a config that predates the pin', () => {
    expect(tokenIsForThisOrigin(undefined, 'https://clawd.gg')).toBe(true);
    expect(tokenIsForThisOrigin('', 'https://clawd.gg')).toBe(true);
  });

  it('matches the pinned origin, trailing slash or not', () => {
    expect(tokenIsForThisOrigin('https://clawd.gg', 'https://clawd.gg')).toBe(true);
    expect(tokenIsForThisOrigin('https://clawd.gg/', 'https://clawd.gg')).toBe(true);
  });

  it('withholds a token issued by a different server', () => {
    expect(tokenIsForThisOrigin('https://clawd.gg', 'http://localhost:4599')).toBe(false);
    expect(tokenIsForThisOrigin('https://clawd.gg', 'https://clawd.gg.evil.example')).toBe(false);
  });
});

describe('selfArgv', () => {
  it('honours CLAWDGG_BIN as a single argv element', () => {
    const previous = process.env.CLAWDGG_BIN;
    process.env.CLAWDGG_BIN = '/Users/x/My Projects/clawdgg';
    try {
      expect(selfArgv()).toEqual(['/Users/x/My Projects/clawdgg']);
      // And the command string a hook gets is quoted, not re-parsed.
      expect(selfCommand()).toBe("'/Users/x/My Projects/clawdgg'");
    } finally {
      if (previous === undefined) delete process.env.CLAWDGG_BIN;
      else process.env.CLAWDGG_BIN = previous;
    }
  });

  it('passes --no-env-file when it has to invoke bun on a script', () => {
    const previous = process.env.CLAWDGG_BIN;
    delete process.env.CLAWDGG_BIN;
    try {
      const argv = selfArgv();
      // Running the test suite is the `bun <script>` case, unless a binary is
      // installed on this machine — in which case that absolute path wins.
      if (argv.length > 1) {
        // A project's .env must not be able to redirect anyone's telemetry.
        expect(argv).toContain('--no-env-file');
      } else {
        expect(argv[0]).toStartWith('/');
      }
    } finally {
      if (previous !== undefined) process.env.CLAWDGG_BIN = previous;
    }
  });
});
