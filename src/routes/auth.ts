import { Hono } from 'hono';
import { GitHub, generateState } from 'arctic';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { createSession, destroySession, createBearerToken } from '../lib/session';
import type { SessionUser } from '../types';
import { createHmac, randomBytes } from 'crypto';

const auth = new Hono();

// In-memory store for device flow (in production, use Redis or DB)
interface DeviceAuth {
  deviceCode: string;
  userCode: string;
  expiresAt: number;
  userId?: string;
  username?: string;
  token?: string;
}

const deviceAuthStore = new Map<string, DeviceAuth>();

// Clean up expired device codes every minute
setInterval(() => {
  const now = Date.now();
  for (const [code, auth] of deviceAuthStore.entries()) {
    if (auth.expiresAt < now) {
      deviceAuthStore.delete(code);
    }
  }
}, 60 * 1000);

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
  setCookie(c, 'github_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
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

    let user;
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
        .where(eq(users.id, existingUsers[0].id))
        .returning();
      user = updated[0];
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
      user = inserted[0];
    }

    // Check if this is a device flow auth
    const deviceCode = getCookie(c, 'device_code');

    if (deviceCode) {
      // Complete device flow
      const deviceAuth = deviceAuthStore.get(deviceCode);
      if (deviceAuth) {
        // Create a bearer token for CLI
        const token = await createBearerToken(user.id);

        // Store the completed auth
        deviceAuth.userId = user.id;
        deviceAuth.username = user.githubUsername;
        deviceAuth.token = token;

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

  // Store the pending auth
  deviceAuthStore.set(deviceCode, {
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

  // Simple HTML page for device verification
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Device - clawd.gg</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-white min-h-screen flex items-center justify-center">
  <div class="max-w-md w-full p-8">
    <div class="text-center mb-8">
      <h1 class="text-3xl font-bold mb-2">
        <span class="text-gray-100">clawd</span><span class="text-cyan-400">.gg</span>
      </h1>
      <p class="text-gray-400">Link your CLI to your account</p>
    </div>

    ${success ? `
      <div class="bg-green-500/20 border border-green-500 rounded-lg p-4 text-center">
        <p class="text-green-400 font-bold">✓ Device Linked!</p>
        <p class="text-gray-400 text-sm mt-2">You can close this window and return to your terminal.</p>
      </div>
    ` : error ? `
      <div class="bg-red-500/20 border border-red-500 rounded-lg p-4 text-center mb-4">
        <p class="text-red-400">${error}</p>
      </div>
      <form method="POST" action="/auth/device/verify" class="space-y-4">
        <div>
          <label class="block text-gray-400 text-sm mb-2">Enter the code from your terminal:</label>
          <input type="text" name="code" value="${code}" placeholder="XXXX-XXXX"
            class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-center text-2xl font-mono tracking-widest focus:border-cyan-500 focus:outline-none uppercase"
            maxlength="9" required />
        </div>
        <button type="submit" class="w-full bg-cyan-500 hover:bg-cyan-400 text-black font-bold py-3 rounded-lg transition-colors">
          Link Device
        </button>
      </form>
    ` : `
      <form method="POST" action="/auth/device/verify" class="space-y-4">
        <div>
          <label class="block text-gray-400 text-sm mb-2">Enter the code from your terminal:</label>
          <input type="text" name="code" value="${code}" placeholder="XXXX-XXXX"
            class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-center text-2xl font-mono tracking-widest focus:border-cyan-500 focus:outline-none uppercase"
            maxlength="9" required />
        </div>
        <button type="submit" class="w-full bg-cyan-500 hover:bg-cyan-400 text-black font-bold py-3 rounded-lg transition-colors">
          Link Device
        </button>
      </form>
    `}

    <p class="text-gray-600 text-xs text-center mt-8">
      This will link your CLI to your GitHub account for syncing stats.
    </p>
  </div>
</body>
</html>
  `;

  return c.html(html);
});

// POST /auth/device/verify - Verify code and redirect to GitHub OAuth
auth.post('/device/verify', async (c) => {
  const body = await c.req.parseBody();
  const userCode = (body.code as string || '').toUpperCase().trim();

  // Find matching device auth
  let matchingAuth: DeviceAuth | undefined;
  for (const auth of deviceAuthStore.values()) {
    if (auth.userCode === userCode && auth.expiresAt > Date.now()) {
      matchingAuth = auth;
      break;
    }
  }

  if (!matchingAuth) {
    return c.redirect(`/auth/device/verify?error=Invalid or expired code&code=${userCode}`);
  }

  // Store the device code in cookie and redirect to GitHub OAuth
  setCookie(c, 'device_code', matchingAuth.deviceCode, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
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

  const auth = deviceAuthStore.get(deviceCode);

  if (!auth) {
    return c.json({ error: 'Invalid device code' }, 404);
  }

  if (auth.expiresAt < Date.now()) {
    deviceAuthStore.delete(deviceCode);
    return c.json({ error: 'Device code expired' }, 410);
  }

  // Check if user has completed auth
  if (auth.token && auth.userId && auth.username) {
    // Clean up and return the token
    deviceAuthStore.delete(deviceCode);
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
