/**
 * npm Stats Watcher
 * Fetches download statistics from npm registry
 */

export interface NpmDownloads {
  downloads: number;
  start: string;
  end: string;
  package: string;
}

const NPM_API = 'https://api.npmjs.org/downloads';
const PACKAGE_NAME = '@anthropic-ai/claude-code';

/**
 * Fetch npm downloads for a time period
 * @param period - 'last-day' | 'last-week' | 'last-month' | 'last-year'
 */
export async function fetchNpmDownloads(period: 'last-day' | 'last-week' | 'last-month' = 'last-week'): Promise<NpmDownloads> {
  const response = await fetch(`${NPM_API}/point/${period}/${PACKAGE_NAME}`);

  if (!response.ok) {
    throw new Error(`npm API error: ${response.status}`);
  }

  return await response.json();
}

/**
 * Fetch npm downloads for a specific date range
 * @param start - Start date YYYY-MM-DD
 * @param end - End date YYYY-MM-DD
 */
export async function fetchNpmDownloadsRange(start: string, end: string): Promise<NpmDownloads> {
  const response = await fetch(`${NPM_API}/point/${start}:${end}/${PACKAGE_NAME}`);

  if (!response.ok) {
    throw new Error(`npm API error: ${response.status}`);
  }

  return await response.json();
}

/**
 * Fetch daily npm downloads for the last N days
 */
export interface DailyDownloads {
  day: string;
  downloads: number;
}

export async function fetchNpmDailyDownloads(days = 7): Promise<DailyDownloads[]> {
  const end = new Date().toISOString().split('T')[0];
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const response = await fetch(`${NPM_API}/range/${start}:${end}/${PACKAGE_NAME}`);

  if (!response.ok) {
    throw new Error(`npm API error: ${response.status}`);
  }

  const data = await response.json();
  return data.downloads || [];
}
