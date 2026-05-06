/**
 * Brew Watcher
 * Monitors Homebrew cask commits for new Claude Code versions
 * This is the FASTEST source for detecting new releases
 */

export interface BrewCommit {
  version: string;
  date: Date;
  sha: string;
}

interface GitHubCommit {
  sha: string;
  commit: {
    author: {
      date: string;
    };
    message: string;
  };
}

const HOMEBREW_CASK_API = 'https://api.github.com/repos/Homebrew/homebrew-cask/commits';
const CASK_PATH = 'Casks/c/claude-code.rb';

/**
 * Fetch recent commits to the Claude Code cask file
 */
export async function fetchBrewCommits(limit = 10): Promise<BrewCommit[]> {
  const url = `${HOMEBREW_CASK_API}?path=${CASK_PATH}&per_page=${limit}`;

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'clawdgg-bot/1.0',
      ...(process.env.GITHUB_TOKEN && {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`
      }),
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const commits: GitHubCommit[] = await response.json();

  return commits
    .map((commit) => {
      // Extract version from commit message like "claude-code 2.0.76"
      const match = commit.commit.message.match(/claude-code\s+([\d.]+)/i);
      if (!match) return null;

      return {
        version: match[1],
        date: new Date(commit.commit.author.date),
        sha: commit.sha,
      };
    })
    .filter((c): c is BrewCommit => c !== null);
}

/**
 * Get the latest version from brew
 */
export async function getLatestBrewVersion(): Promise<BrewCommit | null> {
  const commits = await fetchBrewCommits(1);
  return commits[0] ?? null;
}

/**
 * Check brew cask API for current version and stats
 */
export interface BrewCaskInfo {
  version: string;
  installs30d: number;
  installs90d: number;
  installs365d: number;
}

export async function fetchBrewCaskInfo(): Promise<BrewCaskInfo> {
  const response = await fetch('https://formulae.brew.sh/api/cask/claude-code.json');

  if (!response.ok) {
    throw new Error(`Brew API error: ${response.status}`);
  }

  const data = await response.json();

  return {
    version: data.version,
    installs30d: data.analytics?.install?.['30d']?.['claude-code'] ?? 0,
    installs90d: data.analytics?.install?.['90d']?.['claude-code'] ?? 0,
    installs365d: data.analytics?.install?.['365d']?.['claude-code'] ?? 0,
  };
}
