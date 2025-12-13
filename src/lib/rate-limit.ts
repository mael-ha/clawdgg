import { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';

// In-memory store for rate limiting
// Key: user ID or IP, Value: { count, resetTime }
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

// Configuration
const WINDOW_MS = 60 * 1000; // 1 minute window
const MAX_REQUESTS = 10; // 10 requests per minute

// Clean up expired entries periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimitStore.entries()) {
    if (now > value.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

// Get identifier for rate limiting (user ID if authenticated, IP otherwise)
function getIdentifier(c: Context): string {
  // Try to get user from context (set by auth middleware)
  const user = c.get('user');
  if (user?.id) {
    return `user:${user.id}`;
  }

  // Fall back to IP address
  const forwarded = c.req.header('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || 'unknown';
  return `ip:${ip}`;
}

// Rate limiting middleware
export const rateLimit = createMiddleware(async (c: Context, next: Next) => {
  const identifier = getIdentifier(c);
  const now = Date.now();

  let record = rateLimitStore.get(identifier);

  // If no record or window expired, create new record
  if (!record || now > record.resetTime) {
    record = {
      count: 1,
      resetTime: now + WINDOW_MS,
    };
    rateLimitStore.set(identifier, record);

    // Set rate limit headers
    c.header('X-RateLimit-Limit', MAX_REQUESTS.toString());
    c.header('X-RateLimit-Remaining', (MAX_REQUESTS - 1).toString());
    c.header('X-RateLimit-Reset', Math.ceil(record.resetTime / 1000).toString());

    await next();
    return;
  }

  // Increment count
  record.count++;

  // Calculate remaining requests
  const remaining = Math.max(0, MAX_REQUESTS - record.count);

  // Set rate limit headers
  c.header('X-RateLimit-Limit', MAX_REQUESTS.toString());
  c.header('X-RateLimit-Remaining', remaining.toString());
  c.header('X-RateLimit-Reset', Math.ceil(record.resetTime / 1000).toString());

  // Check if rate limit exceeded
  if (record.count > MAX_REQUESTS) {
    const retryAfter = Math.ceil((record.resetTime - now) / 1000);
    c.header('Retry-After', retryAfter.toString());

    return c.json(
      {
        error: 'Too many requests',
        message: `Rate limit exceeded. Please try again in ${retryAfter} seconds.`,
        retryAfter,
      },
      429
    );
  }

  await next();
});

// Export for testing purposes
export { rateLimitStore, WINDOW_MS, MAX_REQUESTS };
