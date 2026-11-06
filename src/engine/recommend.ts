// The scoring engine: a pure function from a draft to ranked suggestions for your pick.
// No I/O, so it runs the same in tests, the CLI and the browser.
//
// Every pick is judged the same way: by its own part in the completed 3v3. That's its strength
// on the map (with matchup luck removed) plus its pair effect with every enemy and every teammate
// on the final board. For a last pick the board is known. For earlier picks the rest of the draft
// is played out: each remaining pick, in draft order, goes to the side that owns it, which takes
// the brawler that helps it most given everything picked so far. So a strong brawler that's easy
// to answer scores lower as a first pick than as a last pick, because the enemy gets to answer it.
import type { StaticBrawler } from "../outputs/static.js";
import { enemyPicksAfter, teamOfSlot } from "./draft.js";
import { StatsModel, cautious, type Edge } from "./model.js";
import type { Draft, DraftConfig, EngineData, MetaPick, Part, PairDetail, Recommendation, ScoredCandidate, Team, Weights } from "./types.js";

const points = (p: number) => Math.round(p * 1000) / 10 || 0; // 0.0234 -> 2.3, and no -0

export function recommend(draft: Draft, data: EngineData, weights: Weights, draftConfig: DraftConfig): Recommendation {
  const brawlers = new Map(data.static.brawlers.map((b) => [b.id, b]));
  const nameOf = (id: number) => brawlers.get(id)?.name ?? `#${id}`;
  const named = (ids: number[]) => ids.map((id) => ({ id, name: nameOf(id) }));

  const mapInfo = data.static.maps.find((m) => m.id === draft.mapId) ?? data.stats.maps[draft.mapId];
  const mode = mapInfo?.mode ?? "";
  const model = new StatsModel(data.stats, mode, draft.mapId, weights);

  const myTeam = teamOfSlot(draftConfig.order, draft.mySlot);
  const enemyLeft = enemyPicksAfter(draftConfig.order, draft.mySlot, draft.enemies.length);
  const later = remainingPicks(draftConfig.order, myTeam, draft);

  const taken = new Set([...draft.bans, ...draft.allies, ...draft.enemies]);
  const owned = data.roster
    ? new Map(data.roster.brawlers.filter((b) => b.power >= weights.minPower).map((b) => [b.id, b]))
    : undefined;
  const candidates = data.static.brawlers.filter((b) => !taken.has(b.id) && (!owned || owned.has(b.id)));
  // Who the other players might pick in the rest of the draft: anything available that's actually
  // played on this map (they can pick brawlers you don't own).
  const pool = data.static.brawlers.filter((b) => !taken.has(b.id) && model.pickRate(b.id) >= weights.simulation.minPickRate).map((b) => b.id);

  const rolesOf = (ids: number[]) => new Set(ids.flatMap((id) => brawlers.get(id)?.roles ?? []));
  const allyRoles = rolesOf(draft.allies);
  const enemyRoles = rolesOf(draft.enemies);

  const scored = candidates.map((b): ScoredCandidate => {
    const id = b.id;
    const mapRate = model.mapRate(id);
    const [mapGames] = model.mapRecord(id);

    // Your pick's own contribution to the 3v3 with what's already on the board.
    const counters = draft.enemies.map((e) => ({ id: e, name: nameOf(e), ...model.vs(id, e) }));
    const synergies = draft.allies.map((a) => ({ id: a, name: nameOf(a), ...model.with(id, a) }));
    const counter = counters.reduce((t, c) => t + c.value, 0);
    const synergy = synergies.reduce((t, s) => t + s.value, 0);

    // The rest of the draft, played out after this pick: the enemy's likely answers and your
    // teammates' likely picks, and how your pick does against and with them. For each enemy pick
    // still to come, count whichever is worse for you: the simulated answer, or the matchup this
    // brawler really gets per enemy in its games. Real players counter popular blind picks harder
    // than the simulation does, and that history is the best evidence of it.
    const rest = playOut(model, [...draft.allies, id], [...draft.enemies], later, pool.filter((p) => p !== id));
    const answers = rest.enemies.map((e) => ({ id: e, name: nameOf(e), ...model.vs(e, id) }));
    const realMatchup = model.luck(id).perEnemy;
    const laterValue =
      rest.enemies.reduce((t, e) => t + Math.min(model.vs(id, e).value, realMatchup), 0) +
      weights.simulation.teammateWeight * rest.allies.reduce((t, a) => t + model.with(id, a).value, 0);

    // Role fit
    const ro = weights.roles;
    const rolesFilled = b.roles.filter((role) => !allyRoles.has(role)).slice(0, 2);
    const rolesDuplicated = b.roles.filter((role) => allyRoles.has(role) && !ro.ignoreForDuplicates.includes(role));
    // Enemy roles this brawler answers, e.g. "tank" for an anti-tank pick against a tank
    const rolesAnswering = [...new Set(b.roles.flatMap((role) => (ro.answers[role] ?? []).filter((t) => enemyRoles.has(t))))];
    const role = rolesFilled.length * ro.fill - rolesDuplicated.length * ro.duplicate + rolesAnswering.length * ro.answer;

    // Comfort: how you do on this brawler compared with everyone else
    const mine = owned?.get(id);
    const personal = { games: mine?.games ?? 0, wins: mine?.wins ?? 0 };
    const comfort = model.personalEdge(id, [personal.games, personal.wins]);

    // Unproven: the less we know about it here, the more it costs (see weights.uncertainty).
    const unproven = weights.uncertainty.z * model.mapRateError(id);

    const r = { b, mapRate, mapGames, counters, synergies, answers, teammates: rest.allies, rolesFilled, rolesDuplicated, rolesAnswering, personal };
    const parts: Record<Part, number> = {
      map: points(model.strength(id) - 0.5),
      counter: points(counter),
      synergy: points(synergy),
      later: points(laterValue),
      role: points(role * weights.roleWeight),
      comfort: points(comfort * weights.comfortWeight),
      unproven: points(-unproven),
    };
    const score = Math.round(Object.values(parts).reduce((a, v) => a + v, 0) * 10) / 10;
    const detail = (x: Edge & { id: number; name: string }): PairDetail => ({
      id: x.id,
      name: x.name,
      points: points(x.value),
      low: points(cautious(x, 1)),
      games: x.games,
    });

    const candidate: ScoredCandidate = {
      id: r.b.id,
      name: r.b.name,
      score,
      parts,
      reasons: [],
      lowData: r.mapGames < weights.lowDataGames,
      build: buildNames(r.b),
      details: {
        mapWinRate: Math.round(r.mapRate * 1000) / 1000,
        mapGames: r.mapGames,
        mapPickRate: model.mapGames ? Math.round((r.mapGames / model.mapGames) * 1000) / 1000 : 0,
        usedModeFallback: r.mapGames < weights.smoothing.map,
        counters: r.counters.map(detail),
        synergies: r.synergies.map(detail),
        // The enemy's likely answers to this pick, worst for you first.
        threats: r.answers.map(detail).sort((a, b) => b.points - a.points),
        likelyTeammates: named(r.teammates),
        rolesFilled: r.rolesFilled,
        rolesDuplicated: r.rolesDuplicated,
        rolesAnswering: r.rolesAnswering,
        personal: r.personal,
      },
    };
    candidate.warning = warningFor(candidate, weights);
    candidate.reasons = reasonsFor(candidate, weights, enemyLeft > 0);
    return candidate;
  });

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return {
    version: 1,
    context: {
      mapId: draft.mapId,
      mapName: mapInfo?.name ?? `Map ${draft.mapId}`,
      mode,
      mySlot: draft.mySlot,
      myTeam,
      enemyPicksAfterMine: enemyLeft,
      allies: named(draft.allies),
      enemies: named(draft.enemies),
      bans: named(draft.bans),
    },
    data: {
      games: data.stats.games,
      mapGames: model.mapGames,
      window: data.stats.window,
      generatedAt: data.stats.generatedAt,
      mapMeta: mapMeta(model, data, 12),
    },
    candidates: scored.slice(0, Math.max(weights.handOffTop, weights.showTop)),
    showTop: weights.showTop,
  };
}

/**
 * Which picks are still to come after yours, in draft order, as the side that makes each one.
 * Entered picks fill each side's slots in order; your own slot is left out.
 */
export function remainingPicks(order: DraftConfig["order"], myTeam: Team, draft: Pick<Draft, "mySlot" | "allies" | "enemies">): Array<"ally" | "enemy"> {
  let allies = draft.allies.length;
  let enemies = draft.enemies.length;
  const out: Array<"ally" | "enemy"> = [];
  order.forEach((team, i) => {
    if (i + 1 === draft.mySlot) return;
    const side = team === myTeam ? "ally" : "enemy";
    if (side === "ally" && allies > 0) allies--;
    else if (side === "enemy" && enemies > 0) enemies--;
    else out.push(side);
  });
  return out;
}

/** What adding `b` is worth to its side: its strength here plus its pair effects with the board. */
function pickValue(model: StatsModel, b: number, own: number[], other: number[]): number {
  let v = model.strength(b) - 0.5;
  for (const a of own) v += model.with(b, a).value;
  for (const o of other) v += model.vs(b, o).value;
  return v;
}

/**
 * Plays out the remaining picks: each goes to the side that owns it, which takes the pool
 * brawler worth most to it right now. Returns the brawlers each side adds.
 */
export function playOut(
  model: StatsModel,
  allies: number[],
  enemies: number[],
  picks: Array<"ally" | "enemy">,
  pool: number[],
): { allies: number[]; enemies: number[] } {
  const ours = [...allies];
  const theirs = [...enemies];
  const used = new Set([...allies, ...enemies]);
  const added = { allies: [] as number[], enemies: [] as number[] };
  for (const side of picks) {
    const own = side === "ally" ? ours : theirs;
    const other = side === "ally" ? theirs : ours;
    let best: number | undefined;
    let bestValue = -Infinity;
    for (const b of pool) {
      if (used.has(b)) continue;
      const v = pickValue(model, b, own, other);
      if (v > bestValue) [best, bestValue] = [b, v];
    }
    if (best === undefined) break;
    own.push(best);
    used.add(best);
    (side === "ally" ? added.allies : added.enemies).push(best);
  }
  return added;
}

/** The most-picked brawlers on this map: what the map rewards at this rank. */
function mapMeta(model: StatsModel, data: EngineData, count: number): MetaPick[] {
  return data.static.brawlers
    .map((b) => {
      const [games, wins] = model.mapRecord(b.id);
      return { id: b.id, name: b.name, games, winRate: games ? Math.round((wins / games) * 1000) / 1000 : 0, pickRate: Math.round(model.pickRate(b.id) * 1000) / 1000 };
    })
    .filter((m) => m.pickRate > 0)
    .sort((a, b) => b.pickRate - a.pickRate)
    .slice(0, count);
}

/** Short tags for the strongest positive parts, best first, at most three. */
function reasonsFor(c: ScoredCandidate, weights: Weights, enemyStillToPick: boolean): string[] {
  const min = weights.reasonMinPoints;
  const tags: Array<{ text: string; points: number }> = [];
  const pct = Math.round(c.details.mapWinRate * 100);

  // Only claim map strength from this map's own games, not from what carried over.
  if (c.parts.map >= min && !c.lowData) tags.push({ text: `Strong on map (${pct}%)`, points: c.parts.map });
  // Only name matchups that hold up after allowing for noise.
  for (const x of c.details.counters) if (x.points >= min && x.low > 0) tags.push({ text: `Counters ${x.name}`, points: x.points });
  for (const x of c.details.synergies) if (x.points >= min && x.low > 0) tags.push({ text: `Pairs with ${x.name}`, points: x.points });
  // Small edges against (or with) everyone can add up even when no single one stands out.
  const named = (prefix: string) => tags.some((t) => t.text.startsWith(prefix));
  if (c.parts.counter >= min && !named("Counters")) tags.push({ text: "Good into their picks", points: c.parts.counter });
  if (c.parts.synergy >= min && !named("Pairs with")) tags.push({ text: "Fits your team", points: c.parts.synergy });
  // The rest of the draft goes well after this pick: the enemy has no good answer to it.
  if (enemyStillToPick && c.parts.later >= min) tags.push({ text: "Hard to answer", points: c.parts.later });
  for (const target of c.details.rolesAnswering) tags.push({ text: `Answers their ${target}`, points: c.parts.role });
  if (!c.details.rolesAnswering.length && c.parts.role >= min && c.details.rolesFilled[0]) {
    tags.push({ text: `Adds ${c.details.rolesFilled[0]}`, points: c.parts.role });
  }
  if (c.parts.comfort >= min) {
    const { games, wins } = c.details.personal;
    tags.push({ text: `Your pick: ${Math.round((wins / games) * 100)}% in ${games}`, points: c.parts.comfort });
  }
  return tags
    .sort((a, b) => b.points - a.points)
    .slice(0, 3)
    .map((t) => t.text);
}

function warningFor(c: ScoredCandidate, weights: Weights): string | undefined {
  const n = c.details.mapGames;
  if (c.lowData) return n ? `Rarely picked here (${n} games)` : "Not picked on this map yet";
  // Likely enemy answers that clearly beat this pick.
  const answers = c.details.threats.filter((t) => t.low >= weights.reasonMinPoints).map((t) => t.name);
  if (answers.length) return `Likely answer${answers.length > 1 ? "s" : ""}: ${answers.join(", ")}`;
  return undefined;
}

function buildNames(b: StaticBrawler): ScoredCandidate["build"] {
  if (!b.build) return undefined;
  const name = (list: Array<{ id: number; name: string }>, id?: number) => list.find((i) => i.id === id)?.name;
  return {
    gadget: name(b.gadgets, b.build.gadget),
    starPower: name(b.starPowers, b.build.starPower),
    gears: (b.build.gears ?? []).map((g) => name(b.gears, g)).filter((n): n is string => !!n),
    alternatives: (b.build.alternatives ?? []).map((a) => name([...b.gadgets, ...b.starPowers], a)).filter((n): n is string => !!n),
    note: b.build.note,
  };
}
