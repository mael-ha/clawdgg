import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import auth from './routes/auth';
import api from './routes/api';
import boards from './routes/boards';
import cli from './routes/cli';
import install from './routes/install';
import og from './routes/og';
import otel from './routes/otel';
import pages from './routes/index';
import profile from './routes/profile';
import about from './routes/about';
import { pageRateLimit, rateLimit } from './lib/rate-limit';
import { optionalAuth } from './lib/auth-middleware';
import { startSyncJob, stopSyncJob } from './jobs/sync-clickhouse';
import { healthCheck as clickhouseHealthCheck } from './db/clickhouse';

// Create the main Hono app
const app = new Hono();

// Server state
let isReady = false;
let clickhouseHealthy = false;

// Global middleware
app.use('*', logger());
app.use(
  '*',
  cors({
    origin: process.env.APP_URL || 'http://localhost:3000',
    credentials: true,
  })
);

// OTel routes - mounted first with their own auth (no session auth needed)
// OTel has its own rate limiting built into Claude Code (metrics/60s, logs/5s)
app.route('/otel', otel);

// Apply optional auth to all routes (so user is available in context)
app.use('*', optionalAuth);

// Apply rate limiting to API routes
app.use('/api/*', rateLimit);

// And a looser one to the public profile surface. /u/:username is a page, but
// /u/:username/curve is a ClickHouse scan per uncached view and card.png is a
// rasterisation — all three were reachable without a budget of any kind, by
// anyone, as fast as they could be asked for. Keyed on the address Caddy saw
// (see clientIp), not on the first X-Forwarded-For hop the client wrote.
app.use('/u/*', pageRateLimit);

// Build output is content-hashed (public/build/app-<hash>.css), so a new
// build is a new URL and the old one can be cached forever.
app.use(
  '/public/build/*',
  serveStatic({
    root: './',
    onFound: (_path, c) => {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    },
  })
);

// Serve static files from public/
app.use('/public/*', serveStatic({ root: './' }));

// Mount routes
// Before the rate limiter's /api/* scope and before `pages`: `curl | sh` is a
// public, unauthenticated path and must not be able to exhaust anyone's budget.
app.route('/install', install);
app.route('/auth', auth);
// Before /api so the CLI's own endpoints aren't shadowed by api's 404 handling.
app.route('/api/cli', cli);
// Before /api, same reason as /api/cli: api's own routing would shadow it.
app.route('/api/boards', boards);
app.route('/api', api);
// Before the profile pages: the link-preview card is an image route under
// the same /u prefix, with its own cache headers and no Layout.
app.route('/u', og);
app.route('/u', profile);
app.route('/about', about);
app.route('/', pages);

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: isReady ? (clickhouseHealthy ? 'ok' : 'degraded') : 'starting',
    services: {
      api: 'ok',
      clickhouse: clickhouseHealthy ? 'ok' : 'unavailable',
    },
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// Global error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

// Export the app for testing (not as default to avoid double server start)
export { app };

// Start the server with Bun
const port = parseInt(process.env.PORT || '3000', 10);

console.log(`Starting clawd.gg server on port ${port}...`);

Bun.serve({
  fetch: app.fetch,
  port,
});

console.log(`Server running at http://localhost:${port}`);

// Start background sync job (ClickHouse → SQLite) if ClickHouse is available
(async () => {
  try {
    clickhouseHealthy = await clickhouseHealthCheck();
    if (clickhouseHealthy) {
      console.log('[startup] ClickHouse is available, starting sync job');
      startSyncJob();
    } else {
      console.log('[startup] ClickHouse not available, sync job disabled');
      console.log('[startup] To enable: docker compose -f docker-compose.dev.yml up -d');
    }
  } catch (error) {
    console.error('[startup] Failed to initialize background services:', error);
  } finally {
    isReady = true;
  }
})();

// Graceful shutdown handlers
async function gracefulShutdown(signal: string) {
  console.log(`[shutdown] Received ${signal}, shutting down gracefully...`);
  stopSyncJob();
  console.log('[shutdown] Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
