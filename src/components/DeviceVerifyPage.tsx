import { Layout } from './Layout';

/**
 * GET /auth/device/verify — where `clawdgg login` sends the browser.
 *
 * Was a 150-line HTML template literal inside auth.ts with its own
 * tailwind.config, in which "magenta" was #e879f9 (a pink) rather than the
 * site's #ff00ff. Rendering it through Layout is what makes that class of
 * drift impossible.
 */

interface DeviceVerifyPageProps {
  code: string;
  error: string;
  success: boolean;
}

export const DeviceVerifyPage = ({ code, error, success }: DeviceVerifyPageProps) => (
  <Layout
    title="Link Device - clawd.gg"
    description="Link the clawdgg CLI to your GitHub account."
    nav={false}
    effects={false}
    islands={success ? [] : ['device-code-input']}
    bodyClass="bg-black text-white font-mono min-h-screen flex items-center justify-center relative overflow-hidden"
  >
    {/* Background effects matching main site */}
    <div class="absolute inset-0 bg-gradient-to-br from-black via-gray-950 to-black"></div>
    <div class="absolute inset-0 opacity-30">
      <div class="absolute top-1/4 left-1/4 w-64 h-64 bg-cyan-500/20 rounded-full blur-3xl animate-pulse"></div>
      <div class="absolute bottom-1/4 right-1/4 w-64 h-64 bg-magenta-500/20 rounded-full blur-3xl animate-pulse-slow"></div>
    </div>

    <div class="relative z-10 max-w-md w-full mx-4">
      {/* Card container */}
      <div class="bg-gray-950/80 border border-gray-800 rounded-xl p-8 shadow-2xl shadow-cyan-500/5">
        {/* Header */}
        <div class="text-center mb-8">
          <a href="/" class="inline-block mb-4">
            <h1 class="text-3xl font-bold">
              <span class="text-gray-100">clawd</span><span class="text-cyan-400">.gg</span>
            </h1>
          </a>
          <p class="text-gray-500 font-mono text-sm">// link your CLI</p>
        </div>

        {success ? (
          /* Success state */
          <div class="text-center py-8">
            <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-to-br from-green-400 to-cyan-500 flex items-center justify-center">
              <svg class="w-8 h-8 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path>
              </svg>
            </div>
            <h2 class="text-xl font-bold text-green-400 mb-2">Device Linked!</h2>
            <p class="text-gray-500 font-mono text-sm">You can close this window.</p>
            <p class="text-gray-600 text-xs mt-4">Return to your terminal to continue.</p>
          </div>
        ) : (
          <>
            {/* Code input form */}
            {error && (
              <div class="mb-6 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                <p class="text-red-400 text-sm text-center font-mono">{error}</p>
              </div>
            )}

            <form method="post" action="/auth/device/verify" class="space-y-6">
              <div>
                <label class="block text-gray-400 text-xs font-mono mb-3 text-center uppercase tracking-wider">
                  Enter the code from your terminal
                </label>
                <input
                  type="text"
                  name="code"
                  id="codeInput"
                  value={code}
                  placeholder="XXXX-XXXX"
                  autocomplete="off"
                  autocapitalize="characters"
                  spellcheck={false}
                  class="w-full bg-gray-900/50 border-2 border-gray-700 rounded-lg px-4 py-4 text-center text-2xl font-mono tracking-[0.3em] focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20 uppercase transition-all duration-200 placeholder:text-gray-700 placeholder:tracking-[0.3em]"
                  maxlength={9}
                  required
                />
                <p class="text-gray-600 text-xs text-center mt-2 font-mono">
                  Looks like: <span class="text-gray-500">ABCD-1234</span>
                </p>
              </div>

              <button
                type="submit"
                class="group relative w-full py-4 rounded-lg font-mono font-bold text-lg overflow-hidden transition-all duration-200"
              >
                <span class="absolute inset-0 bg-gradient-to-r from-cyan-500 to-magenta-500"></span>
                <span class="absolute inset-[2px] bg-gray-950 rounded-lg group-hover:bg-gray-900 transition-colors"></span>
                <span class="relative text-cyan-400 group-hover:text-white transition-colors flex items-center justify-center gap-2">
                  <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                  </svg>
                  Continue with GitHub
                </span>
              </button>
            </form>

            <p class="text-gray-700 text-xs text-center mt-8 font-mono">
              // This links your CLI to GitHub for syncing stats
            </p>
          </>
        )}
      </div>

      {/* Footer link */}
      <p class="text-center mt-6">
        <a href="/" class="text-gray-600 hover:text-cyan-400 text-xs font-mono transition-colors">
          &larr; Back to clawd.gg
        </a>
      </p>
    </div>
  </Layout>
);

export default DeviceVerifyPage;
