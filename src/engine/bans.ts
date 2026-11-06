// Which bans would change your pick. Instead of asking you to enter all six bans before you pick,
// the engine tries the bans that could matter and shows only the ones that change its answer, as
// one-tap chips. Bans only matter while the enemy still has picks to make after yours: a ban can
// take away the enemy's answer to one of your options. At the last pick it changes nothing.
import { recommend } from "./recommend.js";
import type { Draft, DraftConfig, EngineData, Recommendation, Weights } from "./types.js";

export interface BanChip {
  /** The brawler that, if banned, changes the suggestions. */
  id: number;
  name: string;
  /** The brawler that rises, and the rank it rises to (1 = it becomes the top suggestion). */
  rises: { id: number; name: string; rank: number };
}

export interface BanHints {
  /** The top suggestion if the current top one is banned. */
  ifTopBanned?: { id: number; name: string };
  /** Bans that would change the top suggestions, biggest change first. */
  chips: BanChip[];
}

/** How many possible bans to try. Each try is one more engine run. */
const MAX_TRIES = 8;
/**
 * A ban counts when it changes the top suggestion, or lifts a brawler into this many with a real
 * gain (at least `reasonMinPoints`): small reshuffles below the top aren't worth a tap.
 */
const TOP = 3;

export function banHints(
  draft: Draft,
  data: EngineData,
  weights: Weights,
  draftConfig: DraftConfig,
  rec: Recommendation,
  maxChips = 3,
): BanHints {
  const top = rec.candidates[0];
  if (!top || rec.context.enemyPicksAfterMine === 0) return { chips: [] };
  const run = (ban: number) => recommend({ ...draft, bans: [...draft.bans, ban] }, data, weights, draftConfig);

  const next = run(top.id).candidates[0];
  const ifTopBanned = next ? { id: next.id, name: next.name } : undefined;

  // Bans worth trying: the enemy's likely answers that hurt your options, worst first. (The top
  // suggestion itself is covered by `ifTopBanned`. Banning one of your other options just moves
  // the ones below it up a place, which the minimum gain below filters out.)
  const hurt = new Map<number, { name: string; points: number }>();
  for (const c of rec.candidates) {
    for (const t of c.details.threats) {
      if (t.points <= 0 || t.id === top.id) continue;
      const h = hurt.get(t.id) ?? { name: t.name, points: 0 };
      h.points += t.points * t.chance;
      hurt.set(t.id, h);
    }
  }
  const tries = [...hurt].sort((a, b) => b[1].points - a[1].points).slice(0, MAX_TRIES);

  const rankBefore = new Map(rec.candidates.map((c, i) => [c.id, i]));
  const scoreBefore = new Map(rec.candidates.map((c) => [c.id, c.score]));
  const chips: Array<BanChip & { gain: number }> = [];
  for (const [ban, { name }] of tries) {
    const after = run(ban).candidates;
    // The brawler that gains most among the new top ones, if it moved up into a better rank.
    let best: (BanChip["rises"] & { gain: number }) | undefined;
    after.slice(0, TOP).forEach((c, i) => {
      const was = rankBefore.get(c.id) ?? Infinity;
      if (was <= i) return;
      const gain = c.score - (scoreBefore.get(c.id) ?? c.score);
      if (i > 0 && gain < weights.reasonMinPoints) return;
      if (!best || i < best.rank - 1 || (i === best.rank - 1 && gain > best.gain)) best = { id: c.id, name: c.name, rank: i + 1, gain };
    });
    if (best) chips.push({ id: ban, name, rises: { id: best.id, name: best.name, rank: best.rank }, gain: best.gain });
  }
  chips.sort((a, b) => a.rises.rank - b.rises.rank || b.gain - a.gain);
  return { ifTopBanned, chips: chips.slice(0, maxChips).map(({ gain: _, ...chip }) => chip) };
}
