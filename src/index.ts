import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import auth from './routes/auth';
import api from './routes/api';
import pages from './routes/index';
import { rateLimit } from './lib/rate-limit';
import { optionalAuth } from './lib/auth-middleware';

// Create the main Hono app
const app = new Hono();

// Global middleware
app.use('*', logger());
app.use(
  '*',
  cors({
    origin: process.env.APP_URL || 'http://localhost:3000',
    credentials: true,
  })
);

// Apply optional auth to all routes (so user is available in context)
app.use('*', optionalAuth);

// Apply rate limiting to API routes
app.use('/api/*', rateLimit);

// Serve static files from public/
app.use('/public/*', serveStatic({ root: './' }));

// Mount routes
app.route('/auth', auth);
app.route('/api', api);
app.route('/', pages);

// Health check endpoint
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
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

// Export the app for testing
export default app;

// Start the server with Bun
const port = parseInt(process.env.PORT || '3000', 10);

console.log(`Starting clawd.gg server on port ${port}...`);

Bun.serve({
  fetch: app.fetch,
  port,
});

console.log(`Server running at http://localhost:${port}`);
