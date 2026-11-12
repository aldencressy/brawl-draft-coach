// "Copy for Claude": the draft and the engine's numbers as plain text, to paste into a normal
// Claude chat (covered by a Claude subscription, unlike the API the built-in AI second opinion
// uses). Short instructions travel with it, so it works in any chat, with or without a setup prompt.
import type { BanHints } from "../engine/bans.js";
import type { Recommendation, ScoredCandidate } from "../engine/types.js";

const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`;
const names = (list: Array<{ name: string }>) => list.map((x) => x.name).join(", ") || "none";
const ordinal = (n: number) => `${n}${["th", "st", "nd", "rd"][n % 10 > 3 || Math.floor(n / 10) === 1 ? 0 : n % 10]}`;

/** How many of the engine's candidates to include: enough to choose from, short enough to paste. */
const CANDIDATES = 8;

export interface ChatOptions {
  /** Suggesting for a teammate's pick (any brawler), not your own. */
  teammate?: boolean;
  hints?: BanHints;
}

export function chatMessage(rec: Recommendation, opts: ChatOptions = {}): string {
  const c = rec.context;
  const who = opts.teammate ? `my teammate picks ${ordinal(c.mySlot)} (any brawler)` : `I pick ${ordinal(c.mySlot)}`;
  const after = c.enemyPicksAfterMine ? `${c.enemyPicksAfterMine} enemy pick${c.enemyPicksAfterMine > 1 ? "s" : ""} after` : "last pick, no enemy picks after";
  const lines = [
    `Brawl Stars ranked draft: ${c.mapName} (${c.mode}). ${who}, ${after}.`,
    `My team: ${names(c.allies)}. Enemy: ${names(c.enemies)}. Bans: ${names(c.bans)}.`,
    "",
    `Coach engine, from ${rec.data.games.toLocaleString("en-US")} ranked games at Mythic+ (${rec.data.mapGames.toLocaleString("en-US")} on this map). Points = win-rate points.`,
    `Parts: map = strength here; counter = vs enemies picked; synergy = with allies; later = vs the enemy's likely answers; role = role fit; comfort = my own record on it; unproven = few games here.`,
    ...rec.candidates.slice(0, CANDIDATES).map((x, i) => candidateLine(x, i)),
  ];
  if (rec.bestCounters?.length) {
    lines.push(`Best counters to their team: ${rec.bestCounters.map((b) => `${b.name} ${signed(b.points)} (#${b.rank})`).join(", ")}`);
  }
  if (opts.hints?.ifTopBanned) lines.push(`If ${rec.candidates[0]?.name} is banned, the engine's next pick: ${opts.hints.ifTopBanned.name}`);
  if (opts.hints?.chips.length) {
    lines.push(`Bans that would change it: ${opts.hints.chips.map((h) => `${h.name} banned → ${h.rises.name} #${h.rises.rank}`).join(", ")}`);
  }
  lines.push(
    "",
    `Choose from the numbered candidates or the best counters${opts.teammate ? "" : " (all are ones I own at power 11)"}. Use the numbers as evidence, and add what they can't see: map lanes and win condition, range, wall-breaking, tank/anti-tank, throwers vs assassins, what the enemy's remaining picks will target. Where the numbers disagree with what you remember about the meta, trust the numbers.`,
    `Answer fast: line 1 "PICK: <brawler> (backup: <brawler>)", then at most 3 short bullets.`,
  );
  return lines.join("\n");
}

function candidateLine(x: ScoredCandidate, i: number): string {
  const parts = Object.entries(x.parts)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k} ${signed(v)}`)
    .join(", ");
  const d = x.details;
  const onMap = d.mapGames ? `${Math.round(d.mapWinRate * 100)}% win in ${d.mapGames.toLocaleString("en-US")} games here` : "not played here yet";
  const answers = d.threats.filter((t) => t.points > 0).slice(0, 2).map((t) => `${t.name} ${signed(t.points)}`);
  const counters = d.counters.filter((t) => Math.abs(t.points) >= 1).map((t) => `${t.name} ${signed(t.points)}`);
  const extra = [
    counters.length ? `vs: ${counters.join(", ")}` : "",
    answers.length ? `likely answers: ${answers.join(", ")}` : "",
  ].filter(Boolean);
  return `${i + 1}. ${x.name} ${signed(x.score)} (${parts}) · ${onMap}${extra.length ? ` · ${extra.join(" · ")}` : ""}`;
}
