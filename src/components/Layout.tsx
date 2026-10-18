import type { FC, PropsWithChildren } from 'hono/jsx';
import type { SessionUser } from '../types';

interface LayoutProps extends PropsWithChildren {
  title?: string;
  user?: SessionUser | null;
}

// ASCII art logo for clawd.gg - the terminal vibe
const ASCII_LOGO = `
 ██████╗██╗      █████╗ ██╗    ██╗██████╗    ██████╗  ██████╗
██╔════╝██║     ██╔══██╗██║    ██║██╔══██╗  ██╔════╝ ██╔════╝
██║     ██║     ███████║██║ █╗ ██║██║  ██║  ██║  ███╗██║  ███╗
██║     ██║     ██╔══██║██║███╗██║██║  ██║  ██║   ██║██║   ██║
╚██████╗███████╗██║  ██║╚███╔███╔╝██████╔╝  ╚██████╔╝╚██████╔╝
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═════╝    ╚═════╝  ╚═════╝
`;

const NavBar: FC<{ user?: SessionUser | null }> = ({ user }) => (
  <nav class="fixed top-0 left-0 right-0 z-50 border-b border-cyan-500/20 bg-black/80 backdrop-blur-md">
    <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
      <div class="flex h-16 items-center justify-between">
        {/* Logo */}
        <a href="/" class="flex items-center gap-3 group">
          {/* Brand: two spans, two tones. The glitch-text ghost layers belong
              to hero type — at 20px they landed on top of the word and the
              logo read as a rendering bug. */}
          <div class="font-mono text-xl font-bold tracking-tight">
            <span class="text-magenta-400">&gt;</span>{' '}
            <span class="text-gray-100">clawd</span><span class="text-cyan-400">.gg</span>
          </div>
          <span class="hidden sm:inline-block text-xs text-gray-500 font-mono">
            // claude code leaderboard
          </span>
        </a>

        {/* Navigation Links */}
        <div class="flex items-center gap-6">
          <a
            href="/#leaderboard"
            class="text-gray-400 hover:text-cyan-400 font-mono text-sm transition-colors duration-200"
          >
            [leaderboard]
          </a>
          <a
            href="https://github.com/anthropics/claude-code"
            target="_blank"
            rel="noopener noreferrer"
            class="text-gray-400 hover:text-cyan-400 font-mono text-sm transition-colors duration-200"
          >
            [claude-code]
          </a>

          {/* Auth Button */}
          {user ? (
            <div class="flex items-center gap-3">
              <div class="flex items-center gap-2 px-3 py-1.5 rounded border border-cyan-500/30 bg-cyan-500/10">
                {user.avatarUrl && (
                  <img
                    src={user.avatarUrl}
                    alt={user.githubUsername}
                    class="w-6 h-6 rounded-full ring-2 ring-cyan-500/50"
                  />
                )}
                <span class="text-cyan-400 font-mono text-sm">@{user.githubUsername}</span>
              </div>
              <a
                href="/auth/logout"
                class="text-gray-500 hover:text-red-400 font-mono text-xs transition-colors"
              >
                [logout]
              </a>
            </div>
          ) : (
            <a
              href="/auth/github"
              class="group relative px-4 py-2 font-mono text-sm overflow-hidden"
            >
              <span class="absolute inset-0 bg-gradient-to-r from-cyan-500 to-magenta-500 opacity-80 group-hover:opacity-100 transition-opacity"></span>
              <span class="absolute inset-[1px] bg-black group-hover:bg-gray-950 transition-colors"></span>
              <span class="relative text-cyan-400 group-hover:text-white transition-colors flex items-center gap-2">
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                </svg>
                Login with GitHub
              </span>
            </a>
          )}
        </div>
      </div>
    </div>
  </nav>
);

export const Layout: FC<LayoutProps> = ({ children, title = 'clawd.gg', user }) => (
  <html lang="en" class="dark">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{title} - Claude Code Leaderboard</title>
      <meta name="description" content="The ultimate Claude Code usage leaderboard. See who's shipping the most with AI-powered coding." />

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
                  cyan: {
                    400: '#00ff9f',
                    500: '#00d884',
                  },
                  magenta: {
                    400: '#ff00ff',
                    500: '#cc00cc',
                  },
                },
                fontFamily: {
                  mono: ['JetBrains Mono', 'monospace'],
                  sans: ['Inter', 'sans-serif'],
                },
                animation: {
                  'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                  'glow': 'glow 2s ease-in-out infinite alternate',
                },
              },
            },
          }
        `
      }} />

      {/* HTMX */}
      <script src="https://unpkg.com/htmx.org@1.9.10"></script>

      {/* Chart.js for analytics charts */}
      <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>

      {/* Custom Styles */}
      <link rel="stylesheet" href="/public/styles.css" />
    </head>
    <body class="bg-black text-gray-100 font-mono min-h-screen antialiased">
      {/* Scanline overlay */}
      <div class="scanlines pointer-events-none fixed inset-0 z-[100]"></div>

      {/* Grid background */}
      <div class="grid-bg fixed inset-0 z-0 pointer-events-none"></div>

      {/* Navigation */}
      <NavBar user={user} />

      {/* Main content */}
      <main class="relative z-10 pt-16">
        {children}
      </main>

      {/* ASCII Art Easter Egg in Console */}
      <script dangerouslySetInnerHTML={{
        __html: `
          console.log('%c${ASCII_LOGO.replace(/\n/g, '\\n')}', 'color: #00ff9f; font-family: monospace;');
          console.log('%c>>> Welcome to clawd.gg - Built by Claude Code users, for Claude Code users', 'color: #ff00ff;');
          console.log('%c>>> Want to contribute? Check out the repo!', 'color: #888;');
        `
      }} />
    </body>
  </html>
);

export default Layout;
