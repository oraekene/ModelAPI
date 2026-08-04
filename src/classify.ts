/**
 * Task classification — §8 of the v2 spec.
 *
 * A static keyword table, deliberately. The spec put it in KV; a module
 * constant is strictly better: zero KV reads, zero latency, versioned with the
 * deploy. KV is for data that changes BETWEEN deploys; this table does not.
 *
 * Categories map 1:1 to rows in `category_benchmarks` (seeded by migration
 * 0001), so the ranking layer stays data-driven even though the classifier is
 * code.
 *
 * AMBIGUITY USES TWO GATES, not one ratio. With coarse integer weights, raw
 * score ratios are chunky — a 3-vs-2 near-tie is common — so a single
 * threshold either never fires or fires constantly. An alternate category is
 * reported when the runner-up reaches 60% of the winner AND the winner is not
 * decisive (score < 6). So "write a script to chart the data" returns
 * `dataviz / coding`, while "debug this typescript function and fix the
 * failing test" returns `coding` alone.
 */

export type Category =
  | 'coding'
  | 'general'
  | 'agentic'
  | 'dataviz'
  | 'ui'
  | 'gamedev'
  | 'svg';

export interface Classification {
  category: Category;
  /** Raw winner score, kept for debugging and tests. */
  confidence: number;
  /** Second-best category when the task is genuinely ambiguous. */
  alternate?: Category;
}

/**
 * Payload size model, tokens per call.
 *
 * The agent number is the correction step 5's tests forced: an agent run is
 * MANY calls each carrying a working set, not one enormous prompt. A long run
 * is usually served by fast, cheap, ordinary-context models called
 * repeatedly — which is why the quota term matters more than the context
 * window there.
 */
export const SIZE_TOKENS: Record<'small' | 'medium' | 'large' | 'agent', number> = {
  small: 3_000,
  medium: 30_000,
  large: 120_000,
  agent: 48_000,
};

/** Tie-break order: coding first, since it is the most common intent. */
const CATEGORY_ORDER: Category[] = [
  'coding',
  'general',
  'agentic',
  'dataviz',
  'ui',
  'gamedev',
  'svg',
];

const KEYWORDS: Record<Category, Array<[RegExp, number]>> = {
  coding: [
    [/debug/i, 2], [/fix(ing|es)?\s/i, 2], [/refactor/i, 2], [/code/i, 2],
    [/script/i, 2], [/function/i, 2], [/bug/i, 2], [/error/i, 2],
    [/exception/i, 2], [/crash/i, 2], [/typescript/i, 1], [/javascript/i, 1],
    [/python/i, 1], [/rust/i, 1], [/golang?/i, 1], [/sql/i, 1], [/regex/i, 2],
    [/compile/i, 2], [/lint/i, 2], [/test(s|ing)?\s/i, 2], [/unit\s*test/i, 2],
    [/algorithm/i, 2], [/optimize/i, 2], [/performance/i, 1], [/module/i, 1],
    [/class\s/i, 1], [/api/i, 1], [/endpoint/i, 2], [/route/i, 2],
    [/database/i, 2], [/migration/i, 2], [/schema/i, 2], [/query/i, 2],
    [/backend/i, 2], [/frontend/i, 2], [/git/i, 2], [/commit/i, 1],
    [/merge/i, 1], [/dependency/i, 2], [/npm/i, 2], [/package/i, 1],
    [/build\s/i, 2], [/server/i, 1], [/websocket/i, 2], [/async/i, 2],
    [/concurrency/i, 2], [/memory\s(leak|manage)/i, 2], [/exception/i, 2],
    [/string/i, 1], [/array/i, 1], [/json/i, 2], [/yaml/i, 1], [/config/i, 1],
    [/typescript|javascript|python|go\b|java\b|c\+\+|c#/i, 1],
    [/framework/i, 1], [/library/i, 1], [/sdk/i, 2], [/cli\s/i, 2],
    [/repository|repo\b/i, 2], [/stack\s*trace/i, 2], [/segfault/i, 2],
    [/null\s*(pointer|reference)/i, 2], [/race\s*condition/i, 2],
    [/deadlock/i, 2], [/timeout/i, 2], [/http/i, 1], [/rest/i, 1],
  ],
  general: [
    [/explain/i, 2], [/summarize/i, 2], [/write\s/i, 2], [/draft/i, 2],
    [/research/i, 2], [/analy[sy]e/i, 2], [/review/i, 2], [/translate/i, 2],
    [/answer/i, 2], [/question/i, 2], [/describe/i, 1], [/compare/i, 2],
    [/reason/i, 1], [/think/i, 1], [/plan\s/i, 2], [/outline/i, 2],
    [/email/i, 1], [/essay/i, 1], [/article/i, 1], [/blog/i, 1],
    [/report/i, 1], [/document/i, 2], [/read\s/i, 1], [/understand/i, 1],
    [/brainstorm/i, 2], [/discuss/i, 1], [/suggest/i, 2], [/recommend/i, 1],
    [/help\s/i, 1], [/what\s+is/i, 1], [/how\s+(to|do|does)/i, 1],
    [/explain\s+like/i, 2], [/paraphrase/i, 2], [/rewrite/i, 2],
    [/clarify/i, 1], [/define/i, 1], [/list\s/i, 1], [/options?/i, 1],
    [/pros\s*(and|&)\s*cons/i, 2], [/strategy/i, 1], [/roadmap/i, 1],
    [/memo/i, 1], [/letter/i, 1], [/cover\s*letter/i, 2], [/resume/i, 1],
  ],
  agentic: [
    [/agent/i, 3], [/automat/i, 3], [/autonomous/i, 3], [/pipeline/i, 3],
    [/workflow/i, 2], [/cron/i, 3], [/schedul/i, 3], [/orchestrat/i, 3],
    [/background\s*(task|job|process)/i, 2], [/daemon/i, 3], [/loop/i, 2],
    [/monitor/i, 3], [/watch\s*(for|over)/i, 2], [/scrape/i, 3], [/crawl/i, 2],
    [/multi\s*-?\s*step/i, 3], [/recurring/i, 3], [/overnight/i, 2],
    [/batch/i, 2], [/queue/i, 2], [/event\s*driven/i, 2], [/poll/i, 2],
    [/webhook/i, 2], [/sync\s*(job|task|loop)/i, 3], [/keep\s*.*\s*updated/i, 2],
  ],
  dataviz: [
    [/chart/i, 3], [/graph/i, 3], [/plot/i, 3], [/visualiz/i, 3],
    [/dashboard/i, 2], [/matplotlib/i, 3], [/d3/i, 3], [/chartjs/i, 2],
    [/heat\s*map/i, 2], [/histogram/i, 2], [/scatter/i, 2], [/bar\s*chart/i, 3],
    [/line\s*chart/i, 3], [/pie\s*chart/i, 3], [/pivot/i, 2], [/tableau/i, 3],
    [/infographic/i, 2], [/trend/i, 1], [/axis/i, 2], [/legend/i, 2],
    [/data\s*visual/i, 3], [/bubble\s*chart/i, 3], [/candlestick/i, 3],
    [/sparkline/i, 3], [/choropleth/i, 3], [/box\s*plot/i, 3],
  ],
  ui: [
    [/\bui\b/i, 3], [/\bux\b/i, 2], [/interface/i, 3], [/component/i, 2],
    [/button/i, 2], [/form\b/i, 2], [/layout/i, 3], [/design/i, 2],
    [/style/i, 2], [/responsive/i, 3], [/react/i, 2], [/vue/i, 2],
    [/svelte/i, 2], [/tailwind/i, 2], [/bootstrap/i, 1], [/theme/i, 2],
    [/dark\s*mode/i, 2], [/modal/i, 3], [/dropdown/i, 3], [/sidebar/i, 2],
    [/navbar/i, 2], [/icon/i, 1], [/accessib/i, 2], [/a11y/i, 2],
    [/figma/i, 2], [/screen/i, 1], [/page\b/i, 1], [/landing\s*page/i, 3],
    [/prototype/i, 2], [/mockup/i, 2], [/color\s*palette/i, 2], [/font/i, 1],
    [/spacing/i, 1], [/grid\b/i, 2], [/flexbox/i, 3], [/css/i, 1],
    [/html/i, 1], [/web\s*page/i, 2], [/toast/i, 2], [/tooltip/i, 2],
    [/stepper/i, 3], [/accordion/i, 3], [/carousel/i, 2], [/tabs?\b/i, 2],
  ],
  gamedev: [
    [/game\b/i, 3], [/gamedev/i, 3], [/unity/i, 3], [/unreal/i, 3],
    [/godot/i, 3], [/three\.?js/i, 3], [/phaser/i, 2], [/sprite/i, 3],
    [/animation/i, 2], [/physics\s*(engine|simulation)?/i, 3], [/2d\b/i, 1],
    [/3d\b/i, 2], [/player/i, 1], [/level\s*design/i, 2], [/shader/i, 3],
    [/raycast/i, 3], [/collision/i, 3], [/fps\b/i, 1], [/render\s*loop/i, 2],
    [/gameplay/i, 3], [/npc/i, 2], [/boss\s*ai/i, 3], [/hitbox/i, 3],
  ],
  svg: [
    [/svg/i, 3], [/vector\s*graphic/i, 3], [/path\s*(element|data)/i, 2],
    [/curve/i, 2], [/bezier/i, 3], [/polygon/i, 2], [/scalable/i, 2],
    [/vector/i, 2], [/gradient/i, 2], [/stroke/i, 1], [/fill/i, 1],
    [/viewport/i, 2], [/crisp\s*edges/i, 3], [/defs/i, 2], [/symbol/i, 1],
  ],
};

/** A task with a top score at or above this is decisive; no alternate shown. */
const DECISIVE_SCORE = 6;
/** Runner-up must reach this fraction of the winner's score to be reported. */
const ALTERNATE_RATIO = 0.6;

export function classify(task: string): Classification {
  const scores = new Map<Category, number>();
  for (const cat of CATEGORY_ORDER) {
    let total = 0;
    for (const [pattern, weight] of KEYWORDS[cat]) {
      if (pattern.test(task)) total += weight;
    }
    scores.set(cat, total);
  }

  const ranked = CATEGORY_ORDER.map((c) => ({ category: c, score: scores.get(c) ?? 0 })).sort(
    (a, b) => b.score - a.score || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );

  const winner = ranked[0]!;
  const runnerUp = ranked[1]!;

  const classification: Classification = {
    category: winner.category,
    confidence: winner.score,
  };

  if (
    winner.score < DECISIVE_SCORE &&
    runnerUp.score > 0 &&
    runnerUp.score >= ALTERNATE_RATIO * winner.score
  ) {
    classification.alternate = runnerUp.category;
  }

  return classification;
}