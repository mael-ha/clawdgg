import type { FC } from 'hono/jsx';
import type { TrustStyle as TrustStyleData } from '../db/clickhouse';

// ═══════════════════════════════════════════════════════════════════════════
// TRUST STYLE - Shows your relationship with Claude
// The "woaw" insight: unique to clawd.gg, shows how you work WITH Claude
// ═══════════════════════════════════════════════════════════════════════════

interface TrustStyleProps {
  trustStyle: TrustStyleData | null;
}

// Generate insight based on trust patterns
function generateInsight(trust: TrustStyleData): string {
  const hasAutoApprove = trust.autoApproved > 0;
  const hasManualReview = trust.userTemporary > 0 || trust.userReject > 0;

  if (trust.autonomyRate > 80) {
    return "You let Claude fly — most tools auto-approved";
  }
  if (trust.autonomyRate > 50 && hasManualReview) {
    return "You trust Claude with most things, but still review some tools";
  }
  if (trust.editAcceptRate > 95) {
    return "You trust Claude's code suggestions (95%+ accepted)";
  }
  if (trust.userReject > trust.userTemporary * 0.2) {
    return "You're selective — you review Claude's work carefully";
  }

  return `${Math.round(trust.editAcceptRate)}% edit acceptance rate`;
}

export const TrustStyleComponent: FC<TrustStyleProps> = ({ trustStyle }) => {
  if (!trustStyle || trustStyle.totalEdits === 0) {
    return (
      <div class="text-gray-500 font-mono text-sm text-center py-8">
        No trust data yet — accept or reject some edits
      </div>
    );
  }

  const insight = generateInsight(trustStyle);

  // Calculate totals for decision breakdown
  const totalDecisions = trustStyle.autoApproved + trustStyle.userPermanent +
                         trustStyle.userTemporary + trustStyle.userAbort + trustStyle.userReject;

  return (
    <div>
      {/* Stats line */}
      <div class="flex items-center justify-end mb-4">
        <span class="text-gray-500 font-mono text-xs">
          {trustStyle.totalEdits.toLocaleString()} edits
        </span>
      </div>

      {/* Edit acceptance rate - main metric */}
      <div class="mb-4">
        <div class="flex items-center justify-between mb-2">
          <span class="text-gray-400 font-mono text-xs">Edit Acceptance</span>
          <span class="text-white font-mono text-lg font-bold">
            {Math.round(trustStyle.editAcceptRate)}%
          </span>
        </div>
        <div class="h-3 bg-gray-800 rounded-full overflow-hidden">
          <div
            class="h-full rounded-full bg-gradient-to-r from-green-500 to-green-400 transition-all duration-700"
            style={`width: ${trustStyle.editAcceptRate}%;`}
          />
        </div>
      </div>

      {/* Autonomy rate */}
      <div class="mb-4">
        <div class="flex items-center justify-between mb-2">
          <span class="text-gray-400 font-mono text-xs">Autonomy</span>
          <span class="text-cyan-400 font-mono text-sm">
            {Math.round(trustStyle.autonomyRate)}%
          </span>
        </div>
        <div class="h-2 bg-gray-800 rounded-full overflow-hidden">
          <div
            class="h-full rounded-full bg-cyan-500/60 transition-all duration-700"
            style={`width: ${trustStyle.autonomyRate}%;`}
          />
        </div>
        <div class="text-gray-600 font-mono text-[10px] mt-1">
          auto-approved + permanent
        </div>
      </div>

      {/* Decision breakdown */}
      {totalDecisions > 0 && (
        <div class="mt-4 pt-4 border-t border-gray-800">
          <div class="text-gray-500 font-mono text-xs mb-2">Decisions</div>
          <div class="grid grid-cols-3 gap-2 text-center">
            <div>
              <div class="text-green-400 font-mono text-sm font-bold">
                {(trustStyle.autoApproved + trustStyle.userPermanent + trustStyle.userTemporary).toLocaleString()}
              </div>
              <div class="text-gray-600 font-mono text-[10px]">accepts</div>
            </div>
            <div>
              <div class="text-red-400 font-mono text-sm font-bold">
                {trustStyle.userReject.toLocaleString()}
              </div>
              <div class="text-gray-600 font-mono text-[10px]">rejects</div>
            </div>
            <div>
              <div class="text-yellow-400 font-mono text-sm font-bold">
                {trustStyle.userAbort.toLocaleString()}
              </div>
              <div class="text-gray-600 font-mono text-[10px]">aborts</div>
            </div>
          </div>
        </div>
      )}

      {/* Insight */}
      <div class="mt-4 pt-4 border-t border-gray-800">
        <div class="flex items-start gap-2">
          <span class="text-cyan-500 text-sm">💡</span>
          <span class="text-gray-400 text-sm">{insight}</span>
        </div>
      </div>
    </div>
  );
};

export default TrustStyleComponent;
