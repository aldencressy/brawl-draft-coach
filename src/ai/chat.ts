// "Copy for Claude": the draft as a few plain lines, to paste into a normal Claude chat (covered by
// a Claude subscription, unlike the API the built-in AI second opinion uses). Just the map, bans,
// whose pick it is, and the picks so far; the chat's own setup prompt says how to answer.
import type { Recommendation } from "../engine/types.js";

const names = (list: Array<{ name: string }>) => list.map((x) => x.name).join(", ") || "none";
const ordinal = (n: number) => `${n}${["th", "st", "nd", "rd"][n % 10 > 3 || Math.floor(n / 10) === 1 ? 0 : n % 10]}`;
const modeName = (mode: string) => mode.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

export interface ChatOptions {
  /** Suggesting for a teammate's pick, not your own. */
  teammate?: boolean;
}

export function chatMessage(rec: Recommendation, opts: ChatOptions = {}): string {
  const c = rec.context;
  return [
    `Map: ${c.mapName}${c.mode ? ` (${modeName(c.mode)})` : ""}`,
    `Bans: ${names(c.bans)}`,
    opts.teammate ? `Teammate picks ${ordinal(c.mySlot)}` : `I pick ${ordinal(c.mySlot)}`,
    `My team: ${names(c.allies)}`,
    `Enemy: ${names(c.enemies)}`,
  ].join("\n");
}
