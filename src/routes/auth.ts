import { Hono } from 'hono';
import { GitHub, generateState } from 'arctic';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { db } from '../db';
import { users, deviceAuths } from '../db/schema';
import { eq, lt, gt, and } from 'drizzle-orm';
import { createSession, destroySession, createBearerToken } from '../lib/session';
import type { SessionUser } from '../types';
import { randomBytes } from 'crypto';
import { DeviceVerifyPage } from '../components/DeviceVerifyPage';

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

  return c.html(DeviceVerifyPage({ code, error, success }));
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
