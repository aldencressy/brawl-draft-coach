// The scoring engine: a pure function from a draft to ranked suggestions for your pick.
// No I/O, so it runs the same in tests, the CLI and the browser.
import type { StaticBrawler } from "../outputs/static.js";
import { enemyPicksAfter, teamOfSlot } from "./draft.js";
import { StatsModel, cautious, type Edge } from "./model.js";
import type {
  Draft,
  DraftConfig,
  EngineData,
  MetaPick,
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

  const mapInfo = data.static.maps.find((m) => m.id === draft.mapId) ?? data.stats.maps[draft.mapId];
  const mode = mapInfo?.mode ?? "";
  const model = new StatsModel(data.stats, mode, draft.mapId, weights);

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

  // Brawlers the enemy might realistically pick to counter you: played on this map and not losing on it.
  const r = weights.risk;
  const plausibleEnemies = enemyPool.filter((e) => model.pickRate(e.id) >= r.minPickRate && model.mapRate(e.id) >= r.minMapWinRate);

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
    const counters = draft.enemies.map((e) => ({ id: e, name: nameOf(e), ...model.vs(id, e), z: 1 }));
    const synergies = draft.allies.map((a) => ({ id: a, name: nameOf(a), ...model.with(id, a), z: 1 }));
    const counter = mean(counters.map((c) => c.value));
    const synergy = mean(synergies.map((s) => s.value));

    // Counter risk: the enemy's best remaining counters, scaled by the picks they have left.
    // Ranked by a cautious edge (risk.z standard errors lower): the worst of dozens of noisy
    // matchups always looks bad by chance, which would punish the brawlers with the most data.
    let threats: Array<Edge & { id: number; name: string; z: number }> = [];
    let risk = 0;
    if (enemyLeft > 0) {
      threats = plausibleEnemies
        .filter((e) => e.id !== id)
        .map((e) => ({ id: e.id, name: e.name, ...model.vs(e.id, id), z: r.z }))
        .sort((a, b) => cautious(b, r.z) - cautious(a, r.z))
        .slice(0, r.weights.length);
      risk = threats.reduce((sum, t, i) => sum + r.weights[i]! * Math.max(0, cautious(t, r.z)), 0) * (enemyLeft / 3);
    }

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

    const parts: Record<Part, number> = {
      map: points(map * w.map),
      counter: points(counter * w.counter),
      synergy: points(synergy * w.synergy),
      risk: points(-risk * w.risk),
      role: points(role * w.role),
      comfort: points(comfort * w.comfort),
      unproven: points(-unproven),
    };
    const score = Math.round(Object.values(parts).reduce((a, v) => a + v, 0) * 10) / 10;
    const detail = (x: Edge & { id: number; name: string; z: number }): PairDetail => ({
      id: x.id,
      name: x.name,
      points: points(x.value),
      low: points(cautious(x, x.z)),
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

  // "Hard to counter": no counter the enemy is likely to pick beats it by a clear margin. Only
  // worth saying when it sets a brawler apart, i.e. when most candidates do have such a counter.
  const safe = new Set(
    enemyLeft > 0 && w.risk > 0 ? scored.filter((c) => (c.details.threats[0]?.low ?? 0) < weights.reasonMinPoints).map((c) => c.id) : [],
  );
  const tagSafe = safe.size <= scored.length / 2;
  for (const c of scored) c.reasons = reasonsFor(c, weights, tagSafe && safe.has(c.id));

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
      mapMeta: mapMeta(model, data, 12),
    },
    candidates: scored.slice(0, Math.max(weights.handOffTop, weights.showTop)),
    showTop: weights.showTop,
  };
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
function reasonsFor(c: ScoredCandidate, weights: Weights, hardToCounter: boolean): string[] {
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
  const n = c.details.mapGames;
  if (c.lowData) return n ? `Rarely picked here (${n} games)` : "Not picked on this map yet";
  const worst = c.details.threats[0];
  if (worst && worst.low >= weights.reasonMinPoints * 2) return `Watch for ${worst.name}`;
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
