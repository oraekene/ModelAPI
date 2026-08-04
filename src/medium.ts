/**
 * Medium selection — §7 of the v2 spec.
 *
 * Decides which SURFACE a task belongs on: chat, IDE, CLI, or desktop agent.
 * Deliberately a few conditionals, not an LLM call and not benchmark data —
 * the question is "does this task need to touch the OS", and the answer is in
 * the request, not in any leaderboard.
 */

export type Medium = 'chat' | 'ide' | 'cli' | 'desktop-agent' | 'api';

export interface MediumDecision {
  /** Mediums that could serve this task, in preference order. */
  allowed: Medium[];
  /** Human-readable rationale, rendered under the platform card. */
  reason: string;
  /** True when the winner is a near thing and the score settled it. */
  contested: boolean;
}

/**
 * The `api` medium is special: an OpenRouter row is reachable from ANY
 * surface (it means "call this model directly"), so the request path never
 * filters it out — see rerank() in recommend.ts.
 */
export function selectMedium(input: {
  needsExecution: boolean;
  needsFileWrites: boolean;
  estTokens: number;
}): MediumDecision {
  const { needsExecution, needsFileWrites, estTokens } = input;

  if (needsExecution) {
    return {
      allowed: ['cli', 'ide', 'chat'],
      reason: 'Shell or OS access required — a CLI agent, or an IDE with a terminal.',
      contested: false,
    };
  }

  if (needsFileWrites) {
    if (estTokens >= 30_000) {
      return {
        allowed: ['ide', 'cli', 'chat'],
        reason: 'Multi-file edits with a substantial payload — an IDE agent is the fit.',
        contested: true,
      };
    }
    return {
      allowed: ['ide', 'chat', 'cli'],
      reason: 'File edits — an IDE, or a chat tool that can write files.',
      contested: true,
    };
  }

  return {
    allowed: ['chat', 'ide', 'cli'],
    reason: 'No execution or file writes — a chat interface will do.',
    contested: estTokens >= 30_000,
  };
}

/**
 * Context fit. Reserves 25% of the window for the response: a model that
 * barely fits the prompt will run out of room the moment the answer starts.
 */
export function fitsContext(contextWindow: number | null, estTokens: number): boolean {
  if (contextWindow == null) return true; // unknown window: do not filter on a guess
  return contextWindow >= estTokens * 1.25;
}

export function mediumLabel(m: Medium): string {
  switch (m) {
    case 'chat':
      return 'Chat';
    case 'ide':
      return 'IDE';
    case 'cli':
      return 'CLI';
    case 'desktop-agent':
      return 'Desktop agent';
    case 'api':
      return 'Direct API';
  }
}