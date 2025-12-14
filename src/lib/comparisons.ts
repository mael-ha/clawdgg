// Fun comparisons for stats display
// Inspired by Claude Code's "You've used ~112x more tokens than The Great Gatsby"

// Token counts for famous texts (approximate)
const FAMOUS_TEXTS = [
  { name: 'a tweet', tokens: 70 },
  { name: 'this README', tokens: 500 },
  { name: 'a short story', tokens: 2_500 },
  { name: 'a research paper', tokens: 8_000 },
  { name: 'The Little Prince', tokens: 25_000 },
  { name: 'The Great Gatsby', tokens: 62_000 },
  { name: 'Harry Potter (book 1)', tokens: 100_000 },
  { name: '1984', tokens: 120_000 },
  { name: 'Pride and Prejudice', tokens: 150_000 },
  { name: 'The Lord of the Rings', tokens: 500_000 },
  { name: 'War and Peace', tokens: 650_000 },
  { name: 'the entire Harry Potter series', tokens: 1_100_000 },
  { name: 'the King James Bible', tokens: 800_000 },
  { name: 'Wikipedia (Simple English)', tokens: 50_000_000 },
];

// Lines of code in famous projects (approximate)
const FAMOUS_CODEBASES = [
  { name: 'a Hello World', lines: 5 },
  { name: 'a TODO app', lines: 500 },
  { name: 'jQuery (minified)', lines: 1_500 },
  { name: 'Express.js', lines: 5_000 },
  { name: 'Lodash', lines: 17_000 },
  { name: 'React', lines: 50_000 },
  { name: 'Vue.js', lines: 60_000 },
  { name: 'SQLite', lines: 150_000 },
  { name: 'Redis', lines: 170_000 },
  { name: 'Linux kernel (core)', lines: 500_000 },
  { name: 'Chromium', lines: 35_000_000 },
];

// Prompt counts
const PROMPT_COMPARISONS = [
  { name: 'a job interview', prompts: 20 },
  { name: 'a podcast episode worth of questions', prompts: 50 },
  { name: 'a month of daily standups', prompts: 100 },
  { name: 'a semester of office hours', prompts: 500 },
  { name: 'a year of therapy sessions', prompts: 2_000 },
];

// Get a fun token comparison
export function getTokenComparison(tokens: number): string {
  // Find the closest comparison
  for (let i = FAMOUS_TEXTS.length - 1; i >= 0; i--) {
    const text = FAMOUS_TEXTS[i];
    const ratio = tokens / text.tokens;

    if (ratio >= 1) {
      if (ratio >= 100) {
        return `~${Math.round(ratio)}x more tokens than ${text.name}`;
      } else if (ratio >= 10) {
        return `~${Math.round(ratio)}x the length of ${text.name}`;
      } else if (ratio >= 2) {
        return `~${ratio.toFixed(1)}x ${text.name}`;
      } else {
        return `about the length of ${text.name}`;
      }
    }
  }

  return 'just getting started';
}

// Get a fun lines comparison
export function getLinesComparison(lines: number): string {
  for (let i = FAMOUS_CODEBASES.length - 1; i >= 0; i--) {
    const codebase = FAMOUS_CODEBASES[i];
    const ratio = lines / codebase.lines;

    if (ratio >= 1) {
      if (ratio >= 100) {
        return `${Math.round(ratio)}x ${codebase.name}`;
      } else if (ratio >= 10) {
        return `~${Math.round(ratio)}x ${codebase.name}`;
      } else if (ratio >= 2) {
        return `~${ratio.toFixed(1)}x ${codebase.name}`;
      } else {
        return `about the size of ${codebase.name}`;
      }
    }
  }

  return 'a few functions';
}

// Get a fun prompts comparison
export function getPromptsComparison(prompts: number): string {
  for (let i = PROMPT_COMPARISONS.length - 1; i >= 0; i--) {
    const comparison = PROMPT_COMPARISONS[i];
    const ratio = prompts / comparison.prompts;

    if (ratio >= 1) {
      if (ratio >= 100) {
        return `${Math.round(ratio)}x ${comparison.name}`;
      } else if (ratio >= 10) {
        return `~${Math.round(ratio)}x ${comparison.name}`;
      } else if (ratio >= 2) {
        return `~${ratio.toFixed(1)}x ${comparison.name}`;
      } else {
        return `like ${comparison.name}`;
      }
    }
  }

  return 'a quick chat';
}

// Get ROI comparison for subscription users
export function getSubscriptionROI(apiEquivalentCost: number, monthlySubscription: number = 20): string {
  const roi = apiEquivalentCost / monthlySubscription;

  if (roi >= 100) {
    return `${Math.round(roi)}x ROI on your subscription`;
  } else if (roi >= 10) {
    return `~${Math.round(roi)}x your subscription value`;
  } else if (roi >= 2) {
    return `${roi.toFixed(1)}x your $${monthlySubscription}/month`;
  } else if (roi >= 1) {
    return `breaking even on your subscription`;
  } else {
    return `still warming up`;
  }
}

// Get a random fun fact based on stats
export function getRandomFunFact(stats: {
  tokens?: number;
  prompts?: number;
  lines?: number;
  commits?: number;
}): string {
  const facts: string[] = [];

  if (stats.tokens && stats.tokens > 10_000) {
    facts.push(`You've exchanged ${getTokenComparison(stats.tokens)}`);
  }

  if (stats.prompts && stats.prompts > 100) {
    facts.push(`Your prompts would fill ${Math.ceil(stats.prompts / 280)} tweets`);
  }

  if (stats.lines && stats.lines > 1_000) {
    facts.push(`Claude wrote enough code for ${getLinesComparison(stats.lines)}`);
  }

  if (stats.commits && stats.commits > 10) {
    facts.push(`${stats.commits} commits means ~${Math.round(stats.commits * 2.5)} cups of coffee saved`);
  }

  if (facts.length === 0) {
    return 'Keep coding, the fun facts will come!';
  }

  return facts[Math.floor(Math.random() * facts.length)];
}

// Get all comparisons for display
export function getAllComparisons(stats: {
  tokens: number;
  prompts: number;
  lines: number;
}): { tokens: string; prompts: string; lines: string } {
  return {
    tokens: getTokenComparison(stats.tokens),
    prompts: getPromptsComparison(stats.prompts),
    lines: getLinesComparison(stats.lines),
  };
}
