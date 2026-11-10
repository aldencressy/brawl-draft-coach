// Draft Coach UI. Loads the three data files once, then everything runs locally:
// every entry re-runs the scoring engine (a few milliseconds) and re-renders.
import draftJson from "../../config/draft.json";
import weightsJson from "../../config/weights.json";
import { banHints, type BanHints } from "../../src/engine/bans.js";
import { recommend } from "../../src/engine/recommend.js";
import type { Draft, DraftConfig, EngineData, Recommendation, ScoredCandidate, Weights } from "../../src/engine/types.js";
import type { RosterData } from "../../src/outputs/me.js";
import type { StaticBrawler, StaticData } from "../../src/outputs/static.js";
import type { StatsData } from "../../src/outputs/stats.js";
import {
  add,
  draftFromLink,
  expectedTarget,
  isComplete,
  isTaken,
  myPickId,
  myTeam,
  newDraft,
  nextSlot,
  parseDraftLink,
  teammateSlot,
  remove,
  sideOfSlot,
  type DraftState,
  type Target,
} from "./draftState.js";
import { draftKey, type AiTake } from "../../src/ai/prompt.js";
import { aiConfig, askAi, isAbort, loadAiSettings, saveAiSettings } from "./ai.js";
import { parseEntry, search } from "./search.js";
import { downloadLog, loadDraft, loadLog, saveDraft, upsertLog } from "./storage.js";

const weights = weightsJson as unknown as Weights;
const order = (draftJson as unknown as DraftConfig).order;
const app = document.getElementById("app")!;

let data: EngineData;
let byId: Map<number, StaticBrawler>;
let owned: Set<number> | null;
let state: DraftState = loadDraft() ?? newDraft();
let history: DraftState[] = [];
let ui = { query: "", active: 0, override: null as Target | null, message: "", isError: false, mapQuery: "" };

// AI second opinion: one request per distinct draft state, newest wins.
let aiSettings = loadAiSettings();
let ai = {
  key: null as string | null,
  status: "idle" as "idle" | "waiting" | "thinking" | "done" | "error",
  take: null as AiTake | null,
  error: "",
  showSettings: false,
  controller: null as AbortController | null,
  timer: 0 as number | ReturnType<typeof setTimeout>,
};

// ---------- helpers ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const nameOf = (id: number) => byId.get(id)?.name ?? `#${id}`;
const initials = (name: string) => name.replace(/[^A-Za-z ]/g, "").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const portrait = (id: number, cls = "") => {
  const b = byId.get(id);
  return b?.image
    ? `<img class="${cls}" src="${esc(b.image)}" alt="" loading="lazy">`
    : `<div class="ph ${cls}">${esc(initials(b?.name ?? "?"))}</div>`;
};
const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;
const modeName = (key: string) => data.static.modes.find((m) => m.key === key)?.name ?? key;
const mapOf = (id: number) => data.static.maps.find((m) => m.id === id) ?? (data.stats.maps[id] && { id, ...data.stats.maps[id]!, image: "" });

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function setState(next: DraftState, remember = true): void {
  if (remember) history = [...history.slice(-50), state];
  state = next;
  saveDraft(state);
}

function say(message: string, isError = false): void {
  ui.message = message;
  ui.isError = isError;
}

// ---------- data ----------

async function loadData(): Promise<void> {
  const get = async <T>(name: string, optional = false): Promise<T | undefined> => {
    const res = await fetch(`./data/${name}`, { cache: "no-cache" });
    if (!res.ok) {
      if (optional) return undefined;
      throw new Error(`Couldn't load ${name} (HTTP ${res.status})`);
    }
    return (await res.json()) as T;
  };
  const [stats, staticData, roster] = await Promise.all([
    get<StatsData>("stats.json"),
    get<StaticData>("static.json"),
    get<RosterData>("roster.json", true),
  ]);
  data = { stats: stats!, static: staticData!, roster };
  byId = new Map(data.static.brawlers.map((b) => [b.id, b]));
  owned = roster ? new Set(roster.brawlers.map((b) => b.id)) : null;
}

/** Brawlers most picked on this map first, so likely picks are near the top of the grid. */
function brawlersForMap(mapId: number): StaticBrawler[] {
  const onMap = data.stats.maps[mapId]?.brawlers ?? {};
  const overall = data.stats.overall.brawlers;
  const games = (id: number) => (onMap[id]?.[0] ?? 0) * 1000 + (overall[id]?.[0] ?? 0) / 1000;
  return [...data.static.brawlers].sort((a, b) => games(b.id) - games(a.id));
}

// ---------- engine ----------

/**
 * Suggestions for whoever on your team picks next: you, until your pick is in; then your next
 * teammate, so you can call out a pick for them. Once your team has all three, the suggestions
 * from when you picked come back.
 */
function suggestions(): Recommendation | null {
  const target = suggestionTarget();
  if (!target) return state.frozen?.pick === myPickId(order, state) ? (state.frozen?.rec ?? null) : null;
  // A teammate can pick any brawler, and your own record says nothing about theirs.
  const pool = target.teammate ? { ...data, roster: undefined } : data;
  return recommend(target.draft, pool, weights, { order });
}

/** The draft as the engine sees it for the pick being suggested, or null when there's none left. */
function suggestionTarget(): { draft: Draft; teammate: boolean } | null {
  if (!state.mapId || !state.mySlot) return null;
  const allies = state.picks.filter((p) => p.side === "ally").map((p) => p.id);
  const enemies = state.picks.filter((p) => p.side === "enemy").map((p) => p.id);
  const base = { mapId: state.mapId, bans: state.bans, enemies };
  if (myPickId(order, state) === null) return { draft: { ...base, mySlot: state.mySlot, allies }, teammate: false };
  const slot = teammateSlot(order, state);
  return slot ? { draft: { ...base, mySlot: slot, allies }, teammate: true } : null;
}

const currentDraft = (): Draft | null => suggestionTarget()?.draft ?? null;

/**
 * Bans that would change your pick, worked out just after the suggestions are drawn (it takes a
 * few engine runs), then drawn in. Only before your pick and while the enemy still picks after you.
 */
const hintCache = new Map<string, BanHints>();
let hintTimer: ReturnType<typeof setTimeout> | undefined;

function hintsFor(rec: Recommendation): BanHints | undefined {
  const draft = currentDraft();
  if (!draft || !rec.context.enemyPicksAfterMine) return undefined;
  const key = JSON.stringify(draft);
  const cached = hintCache.get(key);
  if (cached) return cached;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    if (hintCache.size > 50) hintCache.clear();
    hintCache.set(key, banHints(draft, data, weights, { order }, rec));
    // Draw them in if the draft hasn't moved on meanwhile.
    if (JSON.stringify(currentDraft()) === key) renderSuggestions(rec);
  }, 0);
  return undefined;
}

// ---------- actions ----------

function enter(id: number, target?: Target): void {
  const before = suggestions();
  const result = add(order, state, id, target ?? ui.override ?? undefined);
  if (!result.ok) {
    say(`${nameOf(id)}: ${result.reason}`, true);
    return render();
  }
  let next = result.state;
  // Snapshot what was suggested when your own pick goes in.
  const mine = myPickId(order, next);
  if (mine !== null && myPickId(order, state) === null && before) {
    const aiCurrent = ai.status === "done" && ai.key === draftKey(before) ? ai.take!.ranking.map((r) => r.id) : null;
    next = { ...next, suggestedAtMyPick: before.candidates.map((c) => c.id), frozen: { pick: mine, rec: before }, aiAtMyPick: aiCurrent };
  }
  if (isComplete(next)) {
    next = { ...next, loggedAt: next.loggedAt ?? new Date().toISOString() };
    logDraft(next);
  }
  setState(next);
  ui = { ...ui, query: "", active: 0, override: null };
  say("");
  render();
}

function logDraft(s: DraftState): void {
  if (!s.mapId || !s.mySlot || !s.picks.length) return;
  upsertLog({
    at: s.loggedAt ?? new Date().toISOString(),
    mapId: s.mapId,
    mySlot: s.mySlot,
    bans: s.bans,
    allies: s.picks.filter((p) => p.side === "ally").map((p) => p.id),
    enemies: s.picks.filter((p) => p.side === "enemy").map((p) => p.id),
    myPick: myPickId(order, s),
    suggested: s.suggestedAtMyPick,
    aiSuggested: s.aiAtMyPick ?? null,
  });
}

function undo(): void {
  const prev = history.pop();
  if (!prev) return say("Nothing to undo");
  state = prev;
  saveDraft(state);
  say("Undone");
}

function startNewDraft(): void {
  // An unfinished draft is still worth logging if you made your pick.
  if (!state.loggedAt && myPickId(order, state) !== null) logDraft(state);
  setState(newDraft());
  history = [];
  resetAi();
  ui = { query: "", active: 0, override: null, message: "", isError: false, mapQuery: "" };
  render();
}

// ---------- setup screen ----------

function renderSetup(): void {
  const current = data.stats.currentMaps.map(mapOf).filter((m): m is NonNullable<typeof m> => !!m);
  const q = ui.mapQuery.toLowerCase().replace(/[^a-z0-9]/g, "");
  const pool = q ? [...current, ...data.static.maps.filter((m) => !data.stats.currentMaps.includes(m.id))] : current;
  const maps = pool.filter((m) => m.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(q));

  let mapsHtml = "";
  let lastMode = "";
  for (const m of q ? maps : [...maps].sort((a, b) => a.mode.localeCompare(b.mode))) {
    if (!q && m.mode !== lastMode) mapsHtml += `<div class="mode-head">${esc(modeName(m.mode))}</div>`;
    lastMode = m.mode;
    mapsHtml += `<button class="mapcard ${m.id === state.mapId ? "active" : ""}" data-map="${m.id}">
      ${m.image ? `<img src="${esc(m.image)}" alt="" loading="lazy">` : `<div class="ph" style="width:72px;height:46px"></div>`}
      <span><div>${esc(m.name)}</div><div class="mode">${esc(modeName(m.mode))} · ${(data.stats.maps[m.id]?.games ?? 0).toLocaleString()} games</div></span>
    </button>`;
  }

  const slotsHtml = [1, 2, 3, 4, 5, 6]
    .map((s) => {
      const team = order[s - 1]!;
      const teammates = order.map((t, i) => (t === team ? i + 1 : 0)).filter(Boolean).join(", ");
      return `<button data-slot="${s}"><b>${s}</b><span class="t ${team}">${team} team</span><span class="t">picks ${teammates}</span></button>`;
    })
    .join("");

  app.innerHTML = `<div class="setup">
    <h1>Draft Coach</h1>
    <div class="step">1. Map <span class="fresh">(type to filter, <kbd>Enter</kbd> picks the first)</span></div>
    <input id="mapq" placeholder="Search maps" value="${esc(ui.mapQuery)}" autocomplete="off" style="background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px">
    <div class="maps">${mapsHtml || `<div class="fresh">No map matches.</div>`}</div>
    ${
      state.mapId
        ? `<div class="step">2. Your pick slot for ${esc(mapOf(state.mapId)?.name ?? "")} <span class="fresh">(press <kbd>1</kbd>–<kbd>6</kbd>)</span></div>
           <div class="slotpick">${slotsHtml}</div>`
        : ""
    }
    <div class="foot"><span>${dataLabel()} · updated ${ago(data.stats.generatedAt)}</span></div>
  </div>`;

  const input = document.getElementById("mapq") as HTMLInputElement;
  if (!state.mapId) input.focus();
  input.addEventListener("input", () => {
    ui.mapQuery = input.value;
    renderSetup();
    const again = document.getElementById("mapq") as HTMLInputElement;
    again.focus();
    again.setSelectionRange(again.value.length, again.value.length);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && maps[0]) chooseMap(maps[0].id);
  });
  app.querySelectorAll<HTMLElement>("[data-map]").forEach((el) => el.addEventListener("click", () => chooseMap(Number(el.dataset.map))));
  app.querySelectorAll<HTMLElement>("[data-slot]").forEach((el) => el.addEventListener("click", () => chooseSlot(Number(el.dataset.slot))));
}

/** "101,864 games at Mythic+", plus the balance change the stats start from, if one is set. */
function dataLabel(): string {
  const base = `${data.stats.games.toLocaleString()} games at ${rankLabel()}`;
  const change = data.stats.weighting?.balanceChange;
  if (!change?.date) return base;
  const when = new Date(`${change.date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  return change.weightBefore === 0 ? `${base} since the ${when} balance change` : `${base} · older than ${when} counts ${Math.round(change.weightBefore * 100)}%`;
}

function rankLabel(): string {
  const r = data.stats.minRank;
  const tiers = ["Bronze", "Silver", "Gold", "Diamond", "Mythic", "Legendary", "Masters"];
  return `${tiers[Math.floor((r - 1) / 3)] ?? "Rank " + r}+`;
}

function chooseMap(id: number): void {
  setState({ ...state, mapId: id });
  ui.mapQuery = "";
  render();
  (document.activeElement as HTMLElement | null)?.blur();
}

function chooseSlot(slot: number): void {
  setState({ ...state, mySlot: slot });
  render();
}

// ---------- draft screen ----------

function renderDraft(): void {
  if (!document.getElementById("entry")) {
    app.innerHTML = `<div class="app">
      <header id="hdr"></header>
      <div class="left">
        <div id="board"></div>
        <div class="entry">
          <input id="entry" placeholder="Type a brawler, Enter to add" autocomplete="off" spellcheck="false">
          <div class="target" id="target"></div>
        </div>
        <div class="hint" id="hint"></div>
        <div class="grid" id="grid"></div>
        <div class="foot" id="foot"></div>
      </div>
      <div class="right"><div class="ai" id="ai"></div><div class="suggest" id="suggest"></div></div>
    </div>`;
    wireEntry();
  }
  const input = document.getElementById("entry") as HTMLInputElement;
  if (input.value !== ui.query) input.value = ui.query;

  const rec = suggestions();
  renderHeader();
  renderBoard();
  renderTarget();
  renderGrid();
  renderSuggestions(rec);
  renderFoot();
  maybeAskAi(rec);
  renderAi();
  // Keep typing in the entry box, unless you're in another field (like the AI key).
  const focused = document.activeElement;
  if (!focused || focused === document.body) input.focus();
}

function renderHeader(): void {
  const map = mapOf(state.mapId!);
  const team = myTeam(order, state.mySlot!);
  document.getElementById("hdr")!.innerHTML = `
    <div class="map">
      ${map?.image ? `<img src="${esc(map.image)}" alt="">` : ""}
      <div><h1>${esc(map?.name ?? "Unknown map")}</h1>
      <div class="sub">${esc(modeName(map?.mode ?? ""))} · you pick ${ordinal(state.mySlot!)} (${team} team)</div></div>
    </div>
    <div class="fresh">Updated ${ago(data.stats.generatedAt)} · ${dataLabel()}</div>
    <div class="actions">
      <button id="undo" title="Ctrl+Z">Undo</button>
      <button id="setup">Map / slot</button>
      <button id="new">New draft</button>
    </div>`;
  document.getElementById("undo")!.onclick = () => (undo(), render());
  document.getElementById("setup")!.onclick = () => {
    setState({ ...state, mySlot: null });
    render();
  };
  document.getElementById("new")!.onclick = startNewDraft;
}

const ordinal = (n: number) => `${n}${["th", "st", "nd", "rd"][n % 10 > 3 || Math.floor(n / 10) === 1 ? 0 : n % 10]}`;

function renderBoard(): void {
  const slot = nextSlot(order, state);
  const target = expectedTarget(order, state);
  const mine = myPickId(order, state);
  const team = (side: "ally" | "enemy") => {
    const picks = state.picks.filter((p) => p.side === side);
    const cells = [0, 1, 2].map((i) => {
      const p = picks[i];
      if (p) {
        return `<div class="slot filled ${p.id === mine ? "you" : ""}" data-remove="${p.id}" title="Click to remove">
          ${portrait(p.id)}<span class="nm">${esc(nameOf(p.id))}${p.id === mine ? " (you)" : ""}</span></div>`;
      }
      const isNext = i === picks.length && target === side;
      const isYou = side === "ally" && slot === state.mySlot && isNext;
      return `<div class="slot ${isNext ? "next" : ""}">${isNext ? (isYou ? "Your pick" : "Next") : ""}</div>`;
    });
    return `<div class="team ${side}"><h2>${side === "ally" ? "Your team" : "Enemy"}</h2><div class="slots">${cells.join("")}</div></div>`;
  };
  const bans = state.bans
    .map((id) => `<span class="chip" data-remove="${id}" title="Click to remove">${portrait(id)}${esc(nameOf(id))}</span>`)
    .join("");
  document.getElementById("board")!.innerHTML = `
    <div class="board">${team("ally")}${team("enemy")}</div>
    ${bans ? `<div class="bans">Bans: ${bans}</div>` : ""}`;
  document.querySelectorAll<HTMLElement>("#board [data-remove]").forEach((el) =>
    el.addEventListener("click", () => {
      setState(remove(state, Number(el.dataset.remove)));
      say(`Removed ${nameOf(Number(el.dataset.remove))}`);
      render();
    }),
  );
}

function currentTarget(): Target | null {
  const prefix = parseEntry(ui.query).target;
  return prefix ?? ui.override ?? expectedTarget(order, state);
}

function renderTarget(): void {
  const t = currentTarget();
  const el = document.getElementById("target")!;
  el.innerHTML = (["ally", "enemy"] as const)
    .map((x) => `<button class="${x} ${t === x ? "on" : ""}" data-t="${x}">${x === "ally" ? "Ally" : "Enemy"}</button>`)
    .join("");
  el.querySelectorAll<HTMLElement>("[data-t]").forEach((b) =>
    b.addEventListener("click", () => {
      ui.override = b.dataset.t as Target;
      render();
    }),
  );

  const hint = document.getElementById("hint")!;
  hint.className = `hint ${ui.isError ? "error" : ""}`;
  if (ui.message) {
    hint.textContent = ui.message;
    return;
  }
  const slot = nextSlot(order, state);
  if (isComplete(state)) hint.innerHTML = `Draft complete. Logged. <kbd>New draft</kbd> when you're ready.`;
  else if (slot === state.mySlot) hint.innerHTML = `<b style="color:var(--gold)">Your pick</b> (pick ${slot}) · enter what you lock in`;
  else if (slot) hint.innerHTML = `Next: ${sideOfSlot(order, state.mySlot!, slot)} pick (pick ${slot}) · <kbd>-</kbd> enemy <kbd>+</kbd> ally to override`;
}

function matches(): StaticBrawler[] {
  const { query } = parseEntry(ui.query);
  return search(brawlersForMap(state.mapId!), query);
}

function tileTitle(b: StaticBrawler): string {
  const [games, wins] = data.stats.maps[state.mapId!]?.brawlers[b.id] ?? [0, 0];
  const stats = games ? `${Math.round((wins / games) * 100)}% win in ${games.toLocaleString()} games here` : "not played here yet";
  return `${b.name}: ${stats}${owned && !owned.has(b.id) ? " (not owned)" : ""}`;
}

function renderGrid(): void {
  const list = matches();
  const available = list.filter((b) => !isTaken(state, b.id));
  ui.active = Math.min(ui.active, Math.max(0, available.length - 1));
  const activeId = ui.query.trim() ? available[ui.active]?.id : undefined;
  document.getElementById("grid")!.innerHTML = list
    .map((b) => {
      const cls = [isTaken(state, b.id) ? "taken" : "", b.id === activeId ? "active" : "", owned && !owned.has(b.id) ? "unowned" : ""].join(" ");
      return `<div class="tile ${cls}" data-id="${b.id}" title="${esc(tileTitle(b))}">${portrait(b.id)}<span class="nm">${esc(b.name)}</span></div>`;
    })
    .join("");
  document.querySelectorAll<HTMLElement>("#grid .tile:not(.taken)").forEach((el) => el.addEventListener("click", () => enter(Number(el.dataset.id), parseEntry(ui.query).target)));
  document.querySelector("#grid .tile.active")?.scrollIntoView({ block: "nearest" });
}

function renderSuggestions(rec: Recommendation | null): void {
  const el = document.getElementById("suggest")!;
  if (!rec) return void (el.innerHTML = "");
  const mine = myPickId(order, state);
  const c = rec.context;
  const shown = rec.candidates.slice(0, rec.showTop);
  const rest = rec.candidates.slice(rec.showTop);
  const teammate = mine !== null && rec.context.mySlot !== state.mySlot;
  // Where your pick ranked when you made it.
  const atMyPick = state.frozen?.pick === mine ? state.frozen.rec : rec;
  const myRank = mine !== null ? atMyPick.candidates.findIndex((x) => x.id === mine) : -1;
  const hints = hintsFor(rec);
  const after = c.enemyPicksAfterMine ? `${c.enemyPicksAfterMine} enemy pick${c.enemyPicksAfterMine > 1 ? "s" : ""} after` : "last word";

  el.innerHTML = `
    <h2><span>${teammate ? `Teammate's pick (pick ${c.mySlot})` : "Your pick"}</span><span>${after}${teammate ? "" : c.enemyPicksAfterMine ? " you" : ""}</span></h2>
    <div class="ctx">${rec.data.mapGames.toLocaleString()} games on this map${rec.data.mapGames < 300 ? " · thin data, treat as a rough guide" : ""}</div>
    ${mine !== null ? `<div class="done">You locked in <b>${esc(nameOf(mine))}</b>${myRank >= 0 ? ` (#${myRank + 1} suggestion)` : ""}.${teammate ? ` Now suggesting for your teammate's pick, from every brawler.` : state.frozen?.pick === mine ? " These are the suggestions from when you picked." : ""}</div>` : ""}
    ${bestCounterHtml(rec)}
    ${banChipsHtml(hints)}
    ${shown.map((x, i) => candidateHtml(x, i, !teammate && x.id === mine, i === 0 ? hints?.ifTopBanned : undefined, !teammate)).join("")}
    ${rest.length ? `<div class="next-up">Also: ${rest.map((x) => `${esc(x.name)} ${signed(x.score)}`).join(" · ")}</div>` : ""}
    ${!rec.candidates.length ? `<div class="done">Nothing left to suggest from your roster.</div>` : ""}`;
  el.querySelectorAll<HTMLElement>("[data-ban]").forEach((b) =>
    b.addEventListener("click", () => enter(Number(b.dataset.ban), "ban")),
  );
}

/** The best pure counter to their team, so it's always in view even when it doesn't rank first. */
function bestCounterHtml(rec: Recommendation): string {
  const b = rec.bestCounter;
  if (!b) return "";
  const where = b.rank === 1 ? "also the #1 pick" : `#${b.rank} overall, ${signed(b.score)}`;
  return `<div class="bestcounter">Best counter to their team: <b>${esc(b.name)}</b> <span class="p">+${b.points}</span> <span>(${where})</span></div>`;
}

/** One-tap bans: only the ones that would change your pick. */
function banChipsHtml(hints: BanHints | undefined): string {
  if (!hints?.chips.length) return "";
  const chips = hints.chips
    .map((c) => `<button class="banchip" data-ban="${c.id}" title="Tap if ${esc(c.name)} is banned">${esc(c.name)} <span>→ ${esc(c.rises.name)} #${c.rises.rank}</span></button>`)
    .join("");
  return `<div class="banchips"><span>If banned (tap to update):</span>${chips}</div>`;
}

function candidateHtml(x: ScoredCandidate, i: number, isMine: boolean, ifBanned?: { name: string }, forYou = true): string {
  const parts = Object.entries(x.parts)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `<span class="${v > 0 ? "p" : "n"}">${k} ${signed(v)}</span>`)
    .join("");
  const d = x.details;
  const onMap = d.mapGames
    ? `${Math.round(d.mapWinRate * 100)}% win here · ${d.mapGames.toLocaleString()} games · picked in ${Math.round(d.mapPickRate * 100)}%`
    : "Not played on this map yet";
  return `<div class="cand ${i === 0 ? "first" : ""}">
    ${portrait(x.id)}
    <div class="name"><span class="rank">${i + 1}</span>${esc(x.name)}${isMine ? " ✓" : ""}</div>
    <div class="score ${x.score >= 0 ? "pos" : "neg"}">${signed(x.score)}</div>
    <div class="why">${x.reasons.map((r) => `<span>${esc(r)}</span>`).join("") || `<span class="fresh">No standout reason</span>`}</div>
    <div class="extra">
      <span class="onmap">${onMap}</span>
      ${ifBanned ? `<span class="ifban"><button class="banchip" data-ban="${x.id}" title="Tap if ${esc(x.name)} is banned">If banned</button> → ${esc(ifBanned.name)}</span>` : ""}
      ${answersHtml(x)}
      ${x.warning ? `<span class="warn">⚠ ${esc(x.warning)}</span>` : ""}
      ${kitHtml(x.id, forYou)}
      <span class="parts">${parts}</span>
    </div>
  </div>`;
}

/** For early picks: the enemy's likely answers that do well against this pick (from playing out the draft). */
function answersHtml(x: ScoredCandidate): string {
  const bad = x.details.threats.filter((t) => t.points > 0).slice(0, 3);
  if (!bad.length) return "";
  return `<span class="answers">Likely answers: ${bad.map((t) => `${esc(t.name)} <b>+${t.points}</b>`).join(", ")}</span>`;
}

/**
 * The brawler's gadgets and star powers with the recommended one marked and the ones you don't
 * own dimmed, then the recommended gears. Hover an item for its description.
 */
function kitHtml(id: number, forYou = true): string {
  const b = byId.get(id);
  if (!b) return "";
  // For a teammate's pick, your own items don't apply.
  const mine = forYou ? data.roster?.brawlers.find((r) => r.id === id) : undefined;
  const owns = (kind: "gadgets" | "starPowers" | "gears", itemId: number) => !mine || mine[kind].includes(itemId);
  const alternatives = new Set(b.build?.alternatives ?? []);
  const chip = (item: { id: number; name: string; description?: string }, kind: "gadgets" | "starPowers" | "gears", recommended: boolean) => {
    const owned = owns(kind, item.id);
    const alt = !recommended && alternatives.has(item.id);
    const tip = [item.description, alt ? "A close second in community builds" : "", owned ? "" : "You don't own this yet"].filter(Boolean).join(" · ");
    return `<span class="chip ${recommended ? "rec" : ""} ${alt ? "alt" : ""} ${owned ? "" : "missing"}" title="${esc(tip)}">${esc(item.name)}</span>`;
  };
  const build = b.build;
  const row = (label: string, list: typeof b.gadgets, kind: "gadgets" | "starPowers", pick?: number) =>
    list.length ? `<span class="kit-row"><span class="kit-label">${label}</span>${list.map((i) => chip(i, kind, i.id === pick)).join("")}</span>` : "";
  const gears = (build?.gears ?? []).map((g) => b.gears.find((i) => i.id === g)).filter((g): g is NonNullable<typeof g> => !!g);
  const missing = [
    ...[build?.gadget].filter((g): g is number => g !== undefined && !owns("gadgets", g)).map(() => "gadget"),
    ...[build?.starPower].filter((g): g is number => g !== undefined && !owns("starPowers", g)).map(() => "star power"),
    ...gears.filter((g) => !owns("gears", g.id)).map((g) => g.name),
  ];
  return `<span class="kit">
    ${row("Gadget", b.gadgets, "gadgets", build?.gadget)}
    ${row("Star power", b.starPowers, "starPowers", build?.starPower)}
    ${gears.length ? `<span class="kit-row"><span class="kit-label">Gears</span>${gears.map((g) => chip(g, "gears", true)).join("")}${mine?.hyperCharges.length ? `<span class="chip hyper" title="You own its hypercharge">Hypercharge</span>` : ""}</span>` : ""}
    ${build?.note ? `<span class="kit-note">${esc(build.note)}</span>` : ""}
    ${missing.length ? `<span class="warn">You don't own the recommended ${esc(missing.join(", "))}</span>` : ""}
  </span>`;
}

function renderFoot(): void {
  const n = loadLog().length;
  document.getElementById("foot")!.innerHTML = `
    <span><kbd>Enter</kbd> add · <kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>Tab</kbd> target · <kbd>Esc</kbd> clear · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo</span>
    <a id="export">Export draft log (${n})</a>`;
  document.getElementById("export")!.onclick = downloadLog;
}

function wireEntry(): void {
  const input = document.getElementById("entry") as HTMLInputElement;
  input.addEventListener("input", () => {
    ui.query = input.value;
    ui.active = 0;
    say("");
    renderTarget();
    renderGrid();
  });
  input.addEventListener("keydown", (e) => {
    const list = matches().filter((b) => !isTaken(state, b.id));
    if (e.key === "Enter") {
      e.preventDefault();
      if (!parseEntry(ui.query).query) return;
      const pick = list[ui.active];
      if (pick) enter(pick.id, parseEntry(ui.query).target);
      else say("No brawler matches", true), renderTarget();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      ui.active = Math.max(0, Math.min(list.length - 1, ui.active + (e.key === "ArrowDown" ? 1 : -1)));
      renderGrid();
    } else if (e.key === "Tab") {
      e.preventDefault();
      ui.override = currentTarget() === "ally" ? "enemy" : "ally";
      renderTarget();
    } else if (e.key === "Escape") {
      ui = { ...ui, query: "", active: 0, override: null };
      say("");
      render();
    } else if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey) && !input.value) {
      e.preventDefault();
      undo();
      render();
    }
  });
}

// ---------- AI second opinion ----------

function resetAi(): void {
  ai.controller?.abort();
  clearTimeout(ai.timer);
  ai = { ...ai, key: null, status: "idle", take: null, error: "", controller: null };
}

/** Asks automatically once picks start and until you've picked; each new draft state replaces the last request. */
function maybeAskAi(rec: Recommendation | null, force = false): void {
  if (!rec || !aiSettings.enabled || !aiSettings.apiKey) return;
  const pickedAlready = myPickId(order, state) !== null;
  if (pickedAlready || isComplete(state)) return; // keep showing the answer you picked with
  const key = draftKey(rec);
  if (!force && key === ai.key && ai.status !== "error") return;

  ai.controller?.abort();
  clearTimeout(ai.timer);
  ai = { ...ai, key, status: "waiting", take: null, error: "", controller: null };
  // A short pause so a burst of entries makes one request, not several.
  ai.timer = setTimeout(() => void runAi(rec, key), force ? 0 : aiConfig.debounceMs);
}

async function runAi(rec: Recommendation, key: string): Promise<void> {
  const controller = new AbortController();
  ai = { ...ai, status: "thinking", controller };
  renderAi();
  const started = Date.now();
  try {
    const take = await askAi(rec, data.static, aiSettings.apiKey, controller.signal);
    if (ai.key !== key) return; // the draft moved on while we waited
    ai = { ...ai, status: "done", take, controller: null };
    console.info(`AI answered in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    if (isAbort(err) || ai.key !== key) return;
    ai = { ...ai, status: "error", error: err instanceof Error ? err.message : String(err), controller: null };
  }
  renderAi();
}

function renderAi(): void {
  const el = document.getElementById("ai");
  if (!el) return;
  const settingsHtml = `
    <div class="ai-settings">
      <label>Anthropic API key
        <input id="ai-key" type="password" placeholder="sk-ant-..." value="${esc(aiSettings.apiKey)}" autocomplete="off" spellcheck="false">
      </label>
      <label class="check"><input id="ai-on" type="checkbox" ${aiSettings.enabled ? "checked" : ""}> Ask automatically during drafts</label>
      <div class="row"><button id="ai-save">Save</button>${aiSettings.apiKey ? `<button id="ai-forget">Remove key</button>` : ""}</div>
      <div class="fresh">Stored only in this browser and sent only to api.anthropic.com. Model: ${esc(aiConfig.model)}, effort ${esc(aiConfig.effort)}. Each request is charged to your API account.</div>
    </div>`;

  let body: string;
  if (!aiSettings.apiKey || ai.showSettings) {
    body = settingsHtml;
  } else if (!aiSettings.enabled) {
    body = `<div class="fresh">Automatic AI is off.</div><div class="row"><button id="ai-now">Ask now</button></div>`;
  } else if (ai.status === "thinking" || ai.status === "waiting") {
    body = `<div class="thinking">Thinking it over…</div>`;
  } else if (ai.status === "error") {
    body = `<div class="err">${esc(ai.error)}</div><div class="row"><button id="ai-now">Try again</button></div>`;
  } else if (ai.status === "done" && ai.take) {
    const t = ai.take;
    body = `
      ${t.summary ? `<div class="summary">${esc(t.summary)}</div>` : ""}
      <ol>${t.ranking
        .map((r) => `<li><b>${esc(r.name)}</b> <span class="fresh">stats #${r.engineRank}</span><div class="note">${esc(r.note)}</div></li>`)
        .join("")}</ol>
      ${t.warning ? `<div class="warn">⚠ ${esc(t.warning)}</div>` : ""}
      ${myPickId(order, state) === null && !isComplete(state) ? `<div class="row"><button id="ai-now">Ask again</button></div>` : ""}`;
  } else {
    body = `<div class="fresh">Waiting for the draft.</div><div class="row"><button id="ai-now">Ask now</button></div>`;
  }

  el.innerHTML = `<h2><span>AI second opinion</span>${aiSettings.apiKey ? `<a id="ai-gear">${ai.showSettings ? "Done" : "Settings"}</a>` : ""}</h2>${body}`;

  document.getElementById("ai-gear")?.addEventListener("click", () => {
    ai.showSettings = !ai.showSettings;
    renderAi();
  });
  document.getElementById("ai-now")?.addEventListener("click", () => {
    maybeAskAi(suggestions(), true);
    renderAi();
  });
  document.getElementById("ai-save")?.addEventListener("click", () => {
    const key = (document.getElementById("ai-key") as HTMLInputElement).value.trim();
    const enabled = (document.getElementById("ai-on") as HTMLInputElement).checked;
    aiSettings = { apiKey: key, enabled };
    saveAiSettings(aiSettings);
    ai.showSettings = false;
    resetAi();
    render();
  });
  document.getElementById("ai-forget")?.addEventListener("click", () => {
    aiSettings = { apiKey: "", enabled: aiSettings.enabled };
    saveAiSettings(aiSettings);
    resetAi();
    renderAi();
  });
}

// ---------- top level ----------

function render(): void {
  if (!state.mapId || !state.mySlot) {
    if (document.getElementById("entry")) app.innerHTML = "";
    return renderSetup();
  }
  renderDraft();
}

document.addEventListener("keydown", (e) => {
  // Slot picking on the setup screen
  if (state.mapId && !state.mySlot && /^[1-6]$/.test(e.key) && document.activeElement?.id !== "mapq") {
    chooseSlot(Number(e.key));
    e.preventDefault();
  }
});

setInterval(() => {
  // Keep "updated X min ago" honest without disturbing typing.
  if (state.mapId && state.mySlot) renderHeader();
}, 60_000);

/** A draft in the link (`#map=…&slot=…`), e.g. from `npm run suggest -- --link`: start it fresh. */
function applyLinkedDraft(): void {
  const link = parseDraftLink(location.hash);
  if (!link) return;
  window.history.replaceState(null, "", location.pathname + location.search);
  if (!mapOf(link.mapId)) return say("That link's map isn't in the data", true);
  if (!state.loggedAt && myPickId(order, state) !== null) logDraft(state);
  setState(draftFromLink(link, (id) => byId.has(id)), false);
  history = [];
  resetAi();
  ui = { ...ui, query: "", active: 0, override: null };
  say("Draft loaded from link");
}

window.addEventListener("hashchange", () => {
  if (!data) return;
  applyLinkedDraft();
  render();
});

loadData()
  .then(() => {
    applyLinkedDraft();
    render();
  })
  .catch((err: unknown) => {
    app.innerHTML = `<p class="error">${esc(err instanceof Error ? err.message : String(err))}</p>`;
  });
