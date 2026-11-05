// The scoring engine: a pure function from a draft to ranked suggestions for your pick.
// No I/O, so it runs the same in tests, the CLI and the browser.
import type { StaticBrawler } from "../outputs/static.js";
import { enemyPicksAfter, teamOfSlot } from "./draft.js";
import { StatsModel } from "./model.js";
import type {
  Draft,
  DraftConfig,
  EngineData,
  Part,
  PairDetail,
  Recommendation,
  ScoredCandidate,
  Weights,
} from "./types.js";

const points = (p: number) => Math.round(p * 1000) / 10 || 0; // 0.0234 -> 2.3, and no -0
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function recommend(draft: Draft, data: EngineData, weights: Weights, draftConfig: DraftConfig): Recommendation {
  const brawlers = new Map(data.static.brawlers.map((b) => [b.id, b]));
  const nameOf = (id: number) => brawlers.get(id)?.name ?? `#${id}`;
  const named = (ids: number[]) => ids.map((id) => ({ id, name: nameOf(id) }));

  const mapInfo = data.stats.maps[draft.mapId] ?? data.static.maps.find((m) => m.id === draft.mapId);
  const mode = mapInfo?.mode ?? "";
  const model = new StatsModel(data.stats, mode, draft.mapId, weights.smoothing);

  const myTeam = teamOfSlot(draftConfig.order, draft.mySlot);
  const enemyLeft = enemyPicksAfter(draftConfig.order, draft.mySlot, draft.enemies.length);
  const w = weights.byPick[String(draft.mySlot)];
  if (!w) throw new Error(`weights.byPick has no entry for slot ${draft.mySlot}`);

  const taken = new Set([...draft.bans, ...draft.allies, ...draft.enemies]);
  const owned = data.roster
    ? new Map(data.roster.brawlers.filter((b) => b.power >= weights.minPower).map((b) => [b.id, b]))
    : undefined;
  const candidates = data.static.brawlers.filter((b) => !taken.has(b.id) && (!owned || owned.has(b.id)));
  // The enemy can pick anything still available, not just what you own.
  const enemyPool = data.static.brawlers.filter((b) => !taken.has(b.id));

  const rolesOf = (ids: number[]) => new Set(ids.flatMap((id) => brawlers.get(id)?.roles ?? []));
  const allyRoles = rolesOf(draft.allies);
  const enemyRoles = rolesOf(draft.enemies);

  const scored = candidates.map((b): ScoredCandidate => {
    const id = b.id;

    // Map strength
    const mapRate = model.mapRate(id);
    const map = mapRate - 0.5;
    const [mapGames] = model.mapRecord(id);

    // Counter value and synergy against what's already picked
    const counters = draft.enemies.map((e) => ({ id: e, name: nameOf(e), ...model.vs(id, e) }));
    const synergies = draft.allies.map((a) => ({ id: a, name: nameOf(a), ...model.with(id, a) }));
    const counter = mean(counters.map((c) => c.value));
    const synergy = mean(synergies.map((s) => s.value));

    // Counter risk: the worst counters still open to the enemy, scaled by picks they have left
    let threats: Array<{ id: number; name: string; value: number; games: number }> = [];
    let risk = 0;
    if (enemyLeft > 0) {
      threats = enemyPool
        .filter((e) => e.id !== id && model.mapRate(e.id) >= weights.risk.minMapWinRate)
        .map((e) => {
          const edge = model.vs(e.id, id);
          return { id: e.id, name: e.name, value: edge.value, games: edge.games };
        })
        .sort((a, b) => b.value - a.value)
        .slice(0, weights.risk.consider);
      risk = mean(threats.map((t) => Math.max(0, t.value))) * (enemyLeft / 3);
    }

    // Role fit
    const r = weights.roles;
    const rolesFilled = b.roles.filter((role) => !allyRoles.has(role)).slice(0, 2);
    const rolesDuplicated = b.roles.filter((role) => allyRoles.has(role) && !r.ignoreForDuplicates.includes(role));
    // Enemy roles this brawler answers, e.g. "tank" for an anti-tank pick against a tank
    const rolesAnswering = [...new Set(b.roles.flatMap((role) => (r.answers[role] ?? []).filter((t) => enemyRoles.has(t))))];
    const role = rolesFilled.length * r.fill - rolesDuplicated.length * r.duplicate + rolesAnswering.length * r.answer;

    // Comfort: how you do on this brawler compared with everyone else
    const mine = owned?.get(id);
    const personal = { games: mine?.games ?? 0, wins: mine?.wins ?? 0 };
    const comfort = model.personalEdge(id, [personal.games, personal.wins]);

    const parts: Record<Part, number> = {
      map: points(map * w.map),
      counter: points(counter * w.counter),
      synergy: points(synergy * w.synergy),
      risk: points(-risk * w.risk),
      role: points(role * w.role),
      comfort: points(comfort * w.comfort),
    };
    const score = Math.round(Object.values(parts).reduce((a, v) => a + v, 0) * 10) / 10;
    const detail = (x: { id: number; name: string; value: number; games: number }): PairDetail => ({
      id: x.id,
      name: x.name,
      points: points(x.value),
      games: x.games,
    });

    const candidate: ScoredCandidate = {
      id,
      name: b.name,
      score,
      parts,
      reasons: [],
      lowData: mapGames < weights.lowDataGames,
      build: buildNames(b),
      details: {
        mapWinRate: Math.round(mapRate * 1000) / 1000,
        mapGames,
        mapPickRate: model.mapGames ? Math.round((mapGames / model.mapGames) * 1000) / 1000 : 0,
        usedModeFallback: mapGames < weights.smoothing.map,
        counters: counters.map(detail),
        synergies: synergies.map(detail),
        threats: threats.map(detail),
        rolesFilled,
        rolesDuplicated,
        rolesAnswering,
        personal,
      },
    };
    candidate.warning = warningFor(candidate, weights);
    return candidate;
  });

  // "Hard to counter" is relative: some risk always shows up from noise, so the tag goes to
  // the quarter of candidates with the least.
  const riskBar = enemyLeft > 0 && w.risk > 0 ? quantile(scored.map((c) => c.parts.risk), 0.75) : Infinity;
  for (const c of scored) c.reasons = reasonsFor(c, weights, c.parts.risk >= riskBar);

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
      weights: w,
    },
    data: {
      games: data.stats.games,
      mapGames: model.mapGames,
      window: data.stats.window,
      generatedAt: data.stats.generatedAt,
    },
    candidates: scored.slice(0, Math.max(weights.handOffTop, weights.showTop)),
    showTop: weights.showTop,
  };
}

/** Short tags for the strongest positive parts, best first, at most three. */
function quantile(xs: number[], q: number): number {
  if (!xs.length) return Infinity;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function reasonsFor(c: ScoredCandidate, weights: Weights, hardToCounter: boolean): string[] {
  const min = weights.reasonMinPoints;
  const tags: Array<{ text: string; points: number }> = [];
  const pct = Math.round(c.details.mapWinRate * 100);

  if (c.parts.map >= min) tags.push({ text: `Strong on map (${pct}%)`, points: c.parts.map });
  for (const x of c.details.counters) if (x.points >= min) tags.push({ text: `Counters ${x.name}`, points: x.points });
  for (const x of c.details.synergies) if (x.points >= min) tags.push({ text: `Pairs with ${x.name}`, points: x.points });
  if (hardToCounter) tags.push({ text: "Hard to counter", points: min });
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
  if (c.lowData) return `Only ${c.details.mapGames} games on this map`;
  const worst = c.details.threats[0];
  if (worst && worst.points >= weights.reasonMinPoints * 2) return `Watch for ${worst.name}`;
  return undefined;
}

function buildNames(b: StaticBrawler): ScoredCandidate["build"] {
  if (!b.build) return undefined;
  const name = (list: Array<{ id: number; name: string }>, id?: number) => list.find((i) => i.id === id)?.name;
  return {
    gadget: name(b.gadgets, b.build.gadget),
    starPower: name(b.starPowers, b.build.starPower),
    gears: (b.build.gears ?? []).map((g) => name(b.gears, g)).filter((n): n is string => !!n),
    note: b.build.note,
  };
}
