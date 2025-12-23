/**
 * GitHub Releases Watcher
 * Fetches detailed release notes from Claude Code GitHub releases
 * Lags behind brew, but has the detailed changelog
 */

export interface GitHubRelease {
  version: string;
  date: Date;
  notes: string;
  url: string;
}

export interface ParsedReleaseNotes {
  added: string[];
  fixed: string[];
  improved: string[];
  other: string[];
}

const RELEASES_API = 'https://api.github.com/repos/anthropics/claude-code/releases';

/**
 * Fetch the latest release from GitHub
 */
export async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  const response = await fetch(`${RELEASES_API}/latest`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'clawd-bot/1.0',
      ...(process.env.GITHUB_TOKEN && {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`
      }),
    },
  });

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = await response.json();

  return {
    version: data.tag_name.replace(/^v/, ''),  // "v2.0.74" -> "2.0.74"
    date: new Date(data.published_at),
    notes: data.body || '',
    url: data.html_url,
  };
}

/**
 * Fetch a specific release by version
 */
export async function fetchReleaseByVersion(version: string): Promise<GitHubRelease | null> {
  // Try with 'v' prefix first (e.g., v2.0.74)
  const tagVariants = [`v${version}`, version];

  for (const tag of tagVariants) {
    const response = await fetch(`${RELEASES_API}/tags/${tag}`, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'clawd-bot/1.0',
        ...(process.env.GITHUB_TOKEN && {
          'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`
        }),
      },
    });

    if (response.ok) {
      const data = await response.json();
      return {
        version: data.tag_name.replace(/^v/, ''),
        date: new Date(data.published_at),
        notes: data.body || '',
        url: data.html_url,
      };
    }
  }

  return null;
}

/**
 * Parse release notes into categories
 * Handles format like:
 * ## What's changed
 * - Added LSP tool...
 * - Fixed skill allowed-tools...
 */
export function parseReleaseNotes(notes: string): ParsedReleaseNotes {
  const result: ParsedReleaseNotes = {
    added: [],
    fixed: [],
    improved: [],
    other: [],
  };

  // Split into lines and process
  const lines = notes.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip headers and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Match bullet points
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (!bulletMatch) continue;

    const content = bulletMatch[1];
    const lowerContent = content.toLowerCase();

    // Categorize based on keywords
    if (lowerContent.startsWith('added') ||
        lowerContent.startsWith('add ') ||
        lowerContent.startsWith('new ') ||
        lowerContent.includes('added ')) {
      result.added.push(content);
    } else if (lowerContent.startsWith('fixed') ||
               lowerContent.startsWith('fix ') ||
               lowerContent.includes('fixed ')) {
      result.fixed.push(content);
    } else if (lowerContent.startsWith('improved') ||
               lowerContent.startsWith('improve ') ||
               lowerContent.startsWith('updated') ||
               lowerContent.startsWith('update ') ||
               lowerContent.includes('improved ')) {
      result.improved.push(content);
    } else {
      result.other.push(content);
    }
  }

  return result;
}

/**
 * Fetch recent releases
 */
export async function fetchRecentReleases(limit = 10): Promise<GitHubRelease[]> {
  const response = await fetch(`${RELEASES_API}?per_page=${limit}`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'clawd-bot/1.0',
      ...(process.env.GITHUB_TOKEN && {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`
      }),
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const releases = await response.json();

  return releases.map((r: any) => ({
    version: r.tag_name.replace(/^v/, ''),
    date: new Date(r.published_at),
    notes: r.body || '',
    url: r.html_url,
  }));
}
