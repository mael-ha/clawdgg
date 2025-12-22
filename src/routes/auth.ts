import { Hono } from 'hono';
import { GitHub, generateState } from 'arctic';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { db } from '../db';
import { users, deviceAuths } from '../db/schema';
import { eq, lt, gt, and } from 'drizzle-orm';
import { createSession, destroySession, createBearerToken } from '../lib/session';
import type { SessionUser } from '../types';
import { randomBytes } from 'crypto';

const auth = new Hono();

// Generate a short user-friendly code (e.g., "ABCD-1234")
function generateUserCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude similar chars
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Initialize GitHub OAuth client
const getGitHubClient = () => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const appUrl = process.env.APP_URL || 'http://localhost:3000';

  if (!clientId || !clientSecret) {
    throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set');
  }

  return new GitHub(clientId, clientSecret, `${appUrl}/auth/callback`);
};

// GitHub OAuth types
interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

// GET /auth/github - Initiate GitHub OAuth flow
auth.get('/github', async (c) => {
  const github = getGitHubClient();
  const state = generateState();
  const url = github.createAuthorizationURL(state, ['user:email']);

  // Store state in cookie for verification
  // Only use secure cookies if APP_URL is HTTPS (not just production mode)
  const isHttps = (process.env.APP_URL || '').startsWith('https://');
  setCookie(c, 'github_oauth_state', state, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'Lax',
    maxAge: 60 * 10, // 10 minutes
    path: '/',
  });

  return c.redirect(url.toString());
});

// GET /auth/callback - Handle GitHub OAuth callback
auth.get('/callback', async (c) => {
  const github = getGitHubClient();
  const code = c.req.query('code');
  const state = c.req.query('state');
  const storedState = getCookie(c, 'github_oauth_state');

  // Verify state
  if (!code || !state || !storedState || state !== storedState) {
    return c.json({ error: 'Invalid OAuth state' }, 400);
  }

  // Clear state cookie
  deleteCookie(c, 'github_oauth_state', { path: '/' });

  try {
    // Exchange code for access token
    const tokens = await github.validateAuthorizationCode(code);
    const accessToken = tokens.accessToken();

    // Fetch user info from GitHub
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'clawd.gg',
      },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch GitHub user');
    }

    const githubUser: GitHubUser = await response.json();

    // Create or update user in database
    const userId = `github_${githubUser.id}`;
    const existingUsers = await db
      .select()
      .from(users)
      .where(eq(users.githubId, githubUser.id.toString()))
      .limit(1);

    let user: typeof users.$inferSelect;
    if (existingUsers.length > 0) {
      // Update existing user
      const updated = await db
        .update(users)
        .set({
          githubUsername: githubUser.login,
          displayName: githubUser.name,
          avatarUrl: githubUser.avatar_url,
          updatedAt: new Date(),
        })
        .where(eq(users.id, existingUsers[0]!.id))
        .returning();
      user = updated[0]!;
    } else {
      // Create new user
      const inserted = await db
        .insert(users)
        .values({
          id: userId,
          githubId: githubUser.id.toString(),
          githubUsername: githubUser.login,
          displayName: githubUser.name,
          avatarUrl: githubUser.avatar_url,
        })
        .returning();
      user = inserted[0]!;
    }

    // Check if this is a device flow auth
    const deviceCode = getCookie(c, 'device_code');

    if (deviceCode) {
      // Complete device flow - find and update in DB
      const results = await db
        .select()
        .from(deviceAuths)
        .where(eq(deviceAuths.deviceCode, deviceCode))
        .limit(1);

      const deviceAuth = results[0];
      if (deviceAuth) {
        // Create a bearer token for CLI
        const token = await createBearerToken(user.id);

        // Store the completed auth in DB
        await db
          .update(deviceAuths)
          .set({
            userId: user.id,
            username: user.githubUsername,
            token: token,
          })
          .where(eq(deviceAuths.deviceCode, deviceCode));

        // Clear device code cookie
        deleteCookie(c, 'device_code', { path: '/' });

        // Redirect to success page
        return c.redirect('/auth/device/verify?success=true');
      }
    }

    // Regular browser auth - create session
    const sessionUser: SessionUser = {
      id: user.id,
      githubUsername: user.githubUsername,
      avatarUrl: user.avatarUrl,
    };
    await createSession(c, sessionUser);

    // Redirect to home page
    return c.redirect('/');
  } catch (error) {
    console.error('OAuth callback error:', error);
    return c.json({ error: 'Authentication failed' }, 500);
  }
});

// POST /auth/logout - Logout user (API)
auth.post('/logout', async (c) => {
  destroySession(c);
  return c.json({ success: true });
});

// GET /auth/logout - Logout user (browser redirect)
auth.get('/logout', async (c) => {
  destroySession(c);
  return c.redirect('/');
});

// ============================================
// Device Flow for CLI Authentication
// ============================================

// POST /auth/device - Initiate device flow (CLI calls this)
auth.post('/device', async (c) => {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const deviceCode = randomBytes(32).toString('hex');
  const userCode = generateUserCode();
  const expiresIn = 900; // 15 minutes

  // Clean up expired codes first (opportunistic cleanup)
  await db.delete(deviceAuths).where(lt(deviceAuths.expiresAt, Date.now()));

  // Store the pending auth in SQLite
  await db.insert(deviceAuths).values({
    deviceCode,
    userCode,
    expiresAt: Date.now() + expiresIn * 1000,
  });

  return c.json({
    deviceCode,
    userCode,
    verificationUrl: `${appUrl}/auth/device/verify`,
    expiresIn,
  });
});

// GET /auth/device/verify - Show verification page
auth.get('/device/verify', async (c) => {
  const code = c.req.query('code') || '';
  const error = c.req.query('error') || '';
  const success = c.req.query('success') === 'true';

  // Styled HTML page matching main site aesthetic
  const html = `
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Link Device - clawd.gg</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            magenta: { 400: '#e879f9', 500: '#d946ef' }
          }
        }
      }
    }
  </script>
  <style>
    @keyframes pulse-slow { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.5; } }
    .animate-pulse-slow { animation: pulse-slow 4s ease-in-out infinite; }
  </style>
</head>
<body class="bg-black text-white min-h-screen flex items-center justify-center relative overflow-hidden">
  <!-- Background effects matching main site -->
  <div class="absolute inset-0 bg-gradient-to-br from-black via-gray-950 to-black"></div>
  <div class="absolute inset-0 opacity-30">
    <div class="absolute top-1/4 left-1/4 w-64 h-64 bg-cyan-500/20 rounded-full blur-3xl animate-pulse"></div>
    <div class="absolute bottom-1/4 right-1/4 w-64 h-64 bg-magenta-500/20 rounded-full blur-3xl animate-pulse-slow"></div>
  </div>

  <div class="relative z-10 max-w-md w-full mx-4">
    <!-- Card container -->
    <div class="bg-gray-950/80 border border-gray-800 rounded-xl p-8 shadow-2xl shadow-cyan-500/5">
      <!-- Header -->
      <div class="text-center mb-8">
        <a href="/" class="inline-block mb-4">
          <h1 class="text-3xl font-bold">
            <span class="text-gray-100">clawd</span><span class="text-cyan-400">.gg</span>
          </h1>
        </a>
        <p class="text-gray-500 font-mono text-sm">// link your CLI</p>
      </div>

      ${success ? `
        <!-- Success state -->
        <div class="text-center py-8">
          <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-to-br from-green-400 to-cyan-500 flex items-center justify-center">
            <svg class="w-8 h-8 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path>
            </svg>
          </div>
          <h2 class="text-xl font-bold text-green-400 mb-2">Device Linked!</h2>
          <p class="text-gray-500 font-mono text-sm">You can close this window.</p>
          <p class="text-gray-600 text-xs mt-4">Return to your terminal to continue.</p>
        </div>
      ` : `
        <!-- Code input form -->
        ${error ? `
          <div class="mb-6 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
            <p class="text-red-400 text-sm text-center font-mono">${error}</p>
          </div>
        ` : ''}

        <form method="POST" action="/auth/device/verify" class="space-y-6">
          <div>
            <label class="block text-gray-400 text-xs font-mono mb-3 text-center uppercase tracking-wider">
              Enter the code from your terminal
            </label>
            <input
              type="text"
              name="code"
              id="codeInput"
              value="${code}"
              placeholder="XXXX-XXXX"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              class="w-full bg-gray-900/50 border-2 border-gray-700 rounded-lg px-4 py-4 text-center text-2xl font-mono tracking-[0.3em] focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20 uppercase transition-all duration-200 placeholder:text-gray-700 placeholder:tracking-[0.3em]"
              maxlength="9"
              required
            />
            <p class="text-gray-600 text-xs text-center mt-2 font-mono">
              Looks like: <span class="text-gray-500">ABCD-1234</span>
            </p>
          </div>

          <button
            type="submit"
            class="group relative w-full py-4 rounded-lg font-mono font-bold text-lg overflow-hidden transition-all duration-200"
          >
            <span class="absolute inset-0 bg-gradient-to-r from-cyan-500 to-magenta-500"></span>
            <span class="absolute inset-[2px] bg-gray-950 rounded-lg group-hover:bg-gray-900 transition-colors"></span>
            <span class="relative text-cyan-400 group-hover:text-white transition-colors flex items-center justify-center gap-2">
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
              Continue with GitHub
            </span>
          </button>
        </form>

        <p class="text-gray-700 text-xs text-center mt-8 font-mono">
          // This links your CLI to GitHub for syncing stats
        </p>
      `}
    </div>

    <!-- Footer link -->
    <p class="text-center mt-6">
      <a href="/" class="text-gray-600 hover:text-cyan-400 text-xs font-mono transition-colors">
        &larr; Back to clawd.gg
      </a>
    </p>
  </div>

  <script>
    // Auto-format code with dash as user types
    const input = document.getElementById('codeInput');
    if (input) {
      input.addEventListener('input', (e) => {
        let value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (value.length > 4) {
          value = value.slice(0, 4) + '-' + value.slice(4, 8);
        }
        e.target.value = value;
      });

      // Auto-focus
      input.focus();

      // Handle paste - strip any existing dashes
      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData || window.clipboardData).getData('text');
        let value = pasted.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        if (value.length > 4) {
          value = value.slice(0, 4) + '-' + value.slice(4, 8);
        }
        e.target.value = value;
      });
    }
  </script>
</body>
</html>
  `;

  return c.html(html);
});

// POST /auth/device/verify - Verify code and redirect to GitHub OAuth
auth.post('/device/verify', async (c) => {
  const body = await c.req.parseBody();
  const userCode = (body.code as string || '').toUpperCase().trim();

  // Find matching device auth in DB (not expired)
  const results = await db
    .select()
    .from(deviceAuths)
    .where(
      and(
        eq(deviceAuths.userCode, userCode),
        gt(deviceAuths.expiresAt, Date.now())
      )
    )
    .limit(1);

  const matchingAuth = results[0];

  if (!matchingAuth) {
    return c.redirect(`/auth/device/verify?error=Invalid or expired code&code=${userCode}`);
  }

  // Store the device code in cookie and redirect to GitHub OAuth
  // Only use secure cookies if APP_URL is HTTPS (not just production mode)
  const isHttps = (process.env.APP_URL || '').startsWith('https://');
  setCookie(c, 'device_code', matchingAuth.deviceCode, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'Lax',
    maxAge: 60 * 15, // 15 minutes
    path: '/',
  });

  // Redirect to GitHub OAuth
  return c.redirect('/auth/github');
});

// POST /auth/device/poll - Poll for device auth completion (CLI calls this)
auth.post('/device/poll', async (c) => {
  const body = await c.req.json();
  const deviceCode = body.deviceCode;

  if (!deviceCode) {
    return c.json({ error: 'Device code required' }, 400);
  }

  // Find device auth in DB
  const results = await db
    .select()
    .from(deviceAuths)
    .where(eq(deviceAuths.deviceCode, deviceCode))
    .limit(1);

  const auth = results[0];

  if (!auth) {
    return c.json({ error: 'Invalid device code' }, 404);
  }

  if (auth.expiresAt < Date.now()) {
    // Clean up expired code
    await db.delete(deviceAuths).where(eq(deviceAuths.deviceCode, deviceCode));
    return c.json({ error: 'Device code expired' }, 410);
  }

  // Check if user has completed auth
  if (auth.token && auth.userId && auth.username) {
    // Clean up and return the token
    await db.delete(deviceAuths).where(eq(deviceAuths.deviceCode, deviceCode));
    return c.json({
      token: auth.token,
      userId: auth.userId,
      username: auth.username,
    });
  }

  // Still waiting for user to complete auth
  return c.json({ error: 'Authorization pending' }, 428);
});

export default auth;
