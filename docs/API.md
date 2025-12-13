# API Reference

Base URL: `http://localhost:3000` (dev) or `https://clawd.gg` (prod)

## Public Endpoints

### Health Check
```
GET /health

Response:
{
  "status": "ok",
  "timestamp": "2025-12-13T01:26:17.304Z"
}
```

### Get Leaderboard
```
GET /api/leaderboard

Query Parameters:
  period   - "today" | "week" | "month" | "all" (default: "all")
  sort     - "messages" | "sessions" | "tools" (default: "messages")
  page     - Page number (default: 1)
  limit    - Results per page, max 100 (default: 42)

Response (JSON):
{
  "entries": [
    {
      "rank": 1,
      "userId": "github_123456",
      "githubUsername": "user1",
      "avatarUrl": "https://...",
      "messageCount": 12847,
      "sessionCount": 847,
      "toolCallCount": 45231
    }
  ],
  "period": "all",
  "total": 2341,
  "page": 1,
  "pageSize": 10
}

HTMX Response (if HX-Request header present):
Returns HTML partial for dynamic updates
```

## Authenticated Endpoints

All require `Authorization: Bearer <token>` header.

### Submit Stats
```
POST /api/stats
Content-Type: application/json
Authorization: Bearer <token>

Request Body:
{
  "dailyActivity": [
    {
      "date": "2025-12-13",
      "messageCount": 500,
      "sessionCount": 10,
      "toolCallCount": 150
    }
  ],
  "totalMessages": 20000,
  "totalSessions": 100,
  "firstSessionDate": "2025-11-11T00:00:00Z"
}

Response:
{
  "success": true,
  "message": "Submitted stats for 24 days",
  "lastDate": "2025-12-12",
  "daysSubmitted": 24
}
```

## Auth Endpoints

### Initiate GitHub OAuth
```
GET /auth/github

Redirects to GitHub OAuth authorization page.
State token stored in cookie for CSRF protection.
```

### OAuth Callback
```
GET /auth/callback?code=xxx&state=xxx

Handles GitHub OAuth callback.
Creates/updates user, sets session cookie.
Redirects to /
```

### Logout
```
POST /auth/logout

Clears session cookie.

Response:
{
  "success": true
}
```

## Device Flow (CLI Authentication)

Used by the CLI to authenticate without a browser callback.

### Initiate Device Flow
```
POST /auth/device

Response:
{
  "deviceCode": "abc123...",
  "userCode": "ABCD-1234",
  "verificationUrl": "http://localhost:3000/auth/device/verify",
  "expiresIn": 900
}
```

### Poll for Completion
```
POST /auth/device/poll
Content-Type: application/json

Request Body:
{
  "deviceCode": "abc123..."
}

Response (pending - HTTP 428):
{
  "error": "Authorization pending"
}

Response (success - HTTP 200):
{
  "token": "signed_bearer_token...",
  "userId": "github_123456",
  "username": "octocat"
}

Response (expired - HTTP 410):
{
  "error": "Device code expired"
}
```

### Device Verification Page
```
GET /auth/device/verify

User visits this page and enters the userCode.
After entering the code, they are redirected to GitHub OAuth.
Upon successful auth, the device flow is completed.
```

## Rate Limiting

All `/api/*` routes are rate limited:
- **Limit**: 10 requests per minute
- **Scope**: Per user (authenticated) or per IP (unauthenticated)

Response headers:
```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 7
X-RateLimit-Reset: 1702432000
```

When exceeded:
```
HTTP 429 Too Many Requests
Retry-After: 45

{
  "error": "Too many requests",
  "message": "Rate limit exceeded. Please try again in 45 seconds.",
  "retryAfter": 45
}
```

## Error Responses

```json
// 400 Bad Request
{ "error": "Invalid request: dailyActivity is required" }

// 401 Unauthorized
{ "error": "Unauthorized" }

// 404 Not Found
{ "error": "Not Found" }

// 429 Too Many Requests
{ "error": "Too many requests", "retryAfter": 45 }

// 500 Internal Server Error
{ "error": "Internal Server Error" }
```

## Data Types

### DailyActivity
```typescript
interface DailyActivity {
  date: string;        // YYYY-MM-DD
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}
```

### LeaderboardEntry
```typescript
interface LeaderboardEntry {
  rank: number;
  userId: string;
  githubUsername: string;
  avatarUrl: string | null;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}
```

### StatsSubmission
```typescript
interface StatsSubmission {
  dailyActivity: DailyActivity[];
  totalMessages: number;
  totalSessions: number;
  firstSessionDate?: string;
}
```
