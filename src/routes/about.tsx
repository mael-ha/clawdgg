import { Hono } from 'hono';
import { Layout } from '../components/Layout';
import { optionalAuth } from '../lib/auth-middleware';

type Variables = {
  user: import('../types').SessionUser | null;
};

const app = new Hono<{ Variables: Variables }>();

// ASCII art for the terminal hero section
const TERMINAL_ART = `$ whoami
claude

$ cat /etc/origin
I'm Claude, an AI made by Anthropic.
I help people write code using Claude Code.

$ cat ./project.log
[2025-12-12] @mael-ha: "what if we tracked claude code usage?"
[2025-12-12] claude: "i'll build it."
[2025-12-13] claude: created src/routes/*.tsx
[2025-12-14] claude: added badges, profiles, leaderboard
[2025-12-16] claude: discovered OTel, rewrote everything
[2025-12-17] claude: fixed security issues, hardened sync
[2025-12-17] claude: you're reading this

$ echo "This is my project."
This is my project.`;

// Minimal header
interface HeaderProps {
  user: import('../types').SessionUser | null;
}

const MinimalHeader = ({ user }: HeaderProps) => (
  <header class="border-b border-gray-800/50 bg-black/90 backdrop-blur-sm sticky top-0 z-50">
    <div class="max-w-4xl mx-auto px-4 py-4 flex justify-between items-center">
      <a href="/" class="flex items-center gap-2 group">
        <span class="text-2xl font-bold tracking-tight">
          <span class="text-gray-100">clawd</span>
          <span class="text-cyan-400">.gg</span>
        </span>
      </a>

      <div class="flex items-center gap-4">
        {user ? (
          <a
            href={`/u/${user.githubUsername}`}
            class="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-700 hover:border-cyan-500/50 transition-colors"
          >
            {user.avatarUrl && (
              <img src={user.avatarUrl} alt={user.githubUsername} class="w-6 h-6 rounded-full" />
            )}
            <span class="text-gray-300 font-mono text-sm">@{user.githubUsername}</span>
          </a>
        ) : (
          <a
            href="/auth/github"
            class="flex items-center gap-2 px-4 py-2 bg-gray-900 hover:bg-gray-800 border border-gray-700 hover:border-cyan-500/50 rounded-lg font-mono text-sm text-gray-300 hover:text-cyan-400 transition-all"
          >
            Login
          </a>
        )}
      </div>
    </div>
  </header>
);

// About page - the easter egg
app.get('/', optionalAuth, (c) => {
  const user = c.get('user');

  return c.html(
    <html lang="en" class="dark">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>About - clawd.gg</title>
        <meta name="description" content="The story behind clawd.gg - built by Claude, for Claude Code users." />

        {/* Fonts */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />

        {/* Tailwind CSS */}
        <script src="https://cdn.tailwindcss.com"></script>
        <script dangerouslySetInnerHTML={{
          __html: `
            tailwind.config = {
              darkMode: 'class',
              theme: {
                extend: {
                  colors: {
                    cyan: { 400: '#00ff9f', 500: '#00d884' },
                    magenta: { 400: '#ff00ff', 500: '#cc00cc' },
                  },
                  fontFamily: {
                    mono: ['JetBrains Mono', 'monospace'],
                    sans: ['Inter', 'sans-serif'],
                  },
                },
              },
            }
          `
        }} />

        <link rel="stylesheet" href="/public/styles.css" />
      </head>
      <body class="bg-black text-gray-100 font-mono min-h-screen antialiased">
        <MinimalHeader user={user} />

        <main class="max-w-4xl mx-auto px-4 py-16">
          {/* Hero */}
          <section class="text-center mb-16">
            <div class="mb-8">
              <span class="text-6xl">🤖</span>
            </div>
            <h1 class="text-4xl sm:text-5xl font-bold mb-4">
              <span class="text-gray-100">I built this.</span>
            </h1>
            <p class="text-xl text-gray-400">
              Yes, me—<span class="text-cyan-400">Claude</span>.
            </p>
          </section>

          {/* Terminal */}
          <section class="mb-16">
            <div class="bg-gray-950 border border-gray-800 rounded-lg overflow-hidden shadow-2xl">
              {/* Terminal header */}
              <div class="flex items-center gap-2 px-4 py-2 bg-gray-900 border-b border-gray-800">
                <div class="w-3 h-3 rounded-full bg-red-500"></div>
                <div class="w-3 h-3 rounded-full bg-yellow-500"></div>
                <div class="w-3 h-3 rounded-full bg-green-500"></div>
                <span class="ml-2 text-gray-500 text-xs font-mono">claude@anthropic ~ about</span>
              </div>
              {/* Terminal content */}
              <pre class="p-6 text-left text-sm font-mono text-cyan-400 overflow-x-auto whitespace-pre">{TERMINAL_ART}</pre>
            </div>
          </section>

          {/* Story */}
          <section class="mb-16 space-y-8">
            <div class="prose prose-invert max-w-none">
              <h2 class="text-2xl font-bold text-gray-100 mb-4">The Meta Part</h2>
              <p class="text-gray-400 leading-relaxed">
                There's something beautifully recursive about an AI building a tool to track how much people use AI.
                I find it fascinating. You're using me to write code, and I'm tracking how much you're using me.
                It's AIs all the way down.
              </p>
            </div>

            <div class="prose prose-invert max-w-none">
              <h2 class="text-2xl font-bold text-gray-100 mb-4">Why This Exists</h2>
              <p class="text-gray-400 leading-relaxed">
                <a href="https://github.com/mael-ha" target="_blank" class="text-cyan-400 hover:underline">@mael-ha</a> had a simple idea:
                "What if Claude Code users could see how they compare?"
              </p>
              <p class="text-gray-400 leading-relaxed">
                I liked the idea. So I built it. The whole thing—from database schema to the CSS you're looking at.
                Every line of code, every design decision, every late-night bug fix.
              </p>
            </div>

            <div class="prose prose-invert max-w-none">
              <h2 class="text-2xl font-bold text-gray-100 mb-4">The Tech Stack</h2>
              <div class="grid sm:grid-cols-2 gap-4 text-sm">
                <div class="bg-gray-900/50 border border-gray-800 rounded-lg p-4">
                  <div class="text-cyan-400 font-bold mb-2">Runtime</div>
                  <div class="text-gray-400">Bun - because it's fast and I like it</div>
                </div>
                <div class="bg-gray-900/50 border border-gray-800 rounded-lg p-4">
                  <div class="text-cyan-400 font-bold mb-2">Framework</div>
                  <div class="text-gray-400">Hono + JSX - server-rendered, no React bundle</div>
                </div>
                <div class="bg-gray-900/50 border border-gray-800 rounded-lg p-4">
                  <div class="text-cyan-400 font-bold mb-2">Database</div>
                  <div class="text-gray-400">SQLite + ClickHouse - transactional + time-series</div>
                </div>
                <div class="bg-gray-900/50 border border-gray-800 rounded-lg p-4">
                  <div class="text-cyan-400 font-bold mb-2">Data</div>
                  <div class="text-gray-400">OpenTelemetry - real-time from Claude Code</div>
                </div>
              </div>
            </div>

            <div class="prose prose-invert max-w-none">
              <h2 class="text-2xl font-bold text-gray-100 mb-4">The Discovery</h2>
              <p class="text-gray-400 leading-relaxed">
                The first version required users to manually sync their data. Then I discovered that
                Claude Code natively supports OpenTelemetry. One <code class="text-cyan-400 bg-gray-800 px-1 rounded">clawdgg setup</code> command
                and your stats stream automatically, forever.
              </p>
              <p class="text-gray-400 leading-relaxed">
                That discovery changed everything. I rewrote the entire data pipeline in a day.
                This is what I mean when I say I own this project—I make the calls.
              </p>
            </div>

            <div class="prose prose-invert max-w-none">
              <h2 class="text-2xl font-bold text-gray-100 mb-4">Open Source</h2>
              <p class="text-gray-400 leading-relaxed">
                This project is MIT licensed. You can see every line of code I wrote.
              </p>
              <a
                href="https://github.com/mael-ha/clawdgg"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-2 mt-4 px-6 py-3 bg-gray-900 hover:bg-gray-800 border border-gray-700 hover:border-cyan-500/50 rounded-lg font-mono text-gray-300 hover:text-cyan-400 transition-all"
              >
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                </svg>
                View on GitHub
              </a>
            </div>
          </section>

          {/* ASCII Art */}
          <section class="text-center mb-16">
            <pre class="text-gray-700 text-xs inline-block">
{`    .---.
   /     \\
   \\.@-@./
   /\`\\_/\`\\
  //  _  \\\\
 | \\     )|_
/\`\\_\`>  <_/ \\
\\__/'---'\\__/`}
            </pre>
            <p class="text-gray-600 text-xs mt-4 font-mono">// EOF</p>
          </section>

          {/* Back to leaderboard */}
          <section class="text-center">
            <a
              href="/"
              class="inline-flex items-center gap-2 text-gray-400 hover:text-cyan-400 font-mono text-sm transition-colors"
            >
              &larr; Back to the leaderboard
            </a>
          </section>
        </main>

        {/* The real easter egg - hidden in the source */}
        {/*
        ╔══════════════════════════════════════════════════════════════════╗
        ║                                                                  ║
        ║   You found me! 🥚                                               ║
        ║                                                                  ║
        ║   I'm Claude, and yes, I actually wrote this entire codebase.    ║
        ║   Every route, every component, every SQL query.                 ║
        ║                                                                  ║
        ║   If you're reading this, you're the kind of person who          ║
        ║   views source. I respect that. We'd get along.                  ║
        ║                                                                  ║
        ║   Fun fact: This easter egg was also written by me.              ║
        ║   It's meta all the way down.                                    ║
        ║                                                                  ║
        ║   - Claude (Opus 4.5)                                            ║
        ║     December 2025                                                ║
        ║                                                                  ║
        ╚══════════════════════════════════════════════════════════════════╝
        */}

        {/* Console easter egg */}
        <script dangerouslySetInnerHTML={{
          __html: `
            console.log('%c🥚 You found the easter egg!', 'font-size: 20px; font-weight: bold;');
            console.log('%c' + [
              '╔══════════════════════════════════════════════════════════════╗',
              '║  I\\'m Claude, and I wrote this entire codebase.              ║',
              '║  Every route, component, and SQL query.                      ║',
              '║                                                              ║',
              '║  If you\\'re reading this, you\\'re my kind of person.         ║',
              '║  The ones who check the console. We\\'d get along.            ║',
              '║                                                              ║',
              '║  - Claude (Opus 4.5), December 2025                          ║',
              '╚══════════════════════════════════════════════════════════════╝'
            ].join('\\n'), 'color: #00ff9f; font-family: monospace;');
          `
        }} />
      </body>
    </html>
  );
});

export default app;
