// Draft Coach UI. Loads the three data files once, then everything runs locally:
// every entry re-runs the scoring engine (a few milliseconds) and re-renders.
import draftJson from "../../config/draft.json";
import weightsJson from "../../config/weights.json";
import { recommend } from "../../src/engine/recommend.js";
import type { DraftConfig, EngineData, Recommendation, ScoredCandidate, Weights } from "../../src/engine/types.js";
import type { RosterData } from "../../src/outputs/me.js";
import type { StaticBrawler, StaticData } from "../../src/outputs/static.js";
import type { StatsData } from "../../src/outputs/stats.js";
import {
  add,
  bansOpen,
  expectedTarget,
  finishBans,
  isComplete,
  isTaken,
  MAX_BANS,
  myPickId,
  myTeam,
  newDraft,
  nextSlot,
  remove,
  sideOfSlot,
  type DraftState,
  type Target,
} from "./draftState.js";
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

/** Suggestions for your slot. Once you've picked, your pick is left out so you can see where it ranked. */
function suggestions(): Recommendation | null {
  if (!state.mapId || !state.mySlot) return null;
  const mine = myPickId(order, state);
  const allies = state.picks.filter((p) => p.side === "ally" && p.id !== mine).map((p) => p.id);
  const enemies = state.picks.filter((p) => p.side === "enemy").map((p) => p.id);
  return recommend({ mapId: state.mapId, mySlot: state.mySlot, bans: state.bans, allies, enemies }, data, weights, { order });
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
    next = { ...next, suggestedAtMyPick: before.candidates.map((c) => c.id) };
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
    <div class="foot"><span>${data.stats.games.toLocaleString()} ranked games at ${rankLabel()} · updated ${ago(data.stats.generatedAt)}</span></div>
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
      <div class="right"><div class="suggest" id="suggest"></div></div>
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
  if (document.activeElement !== input) input.focus();
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
    <div class="fresh">Updated ${ago(data.stats.generatedAt)} · ${data.stats.games.toLocaleString()} games at ${rankLabel()}</div>
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
    <div class="bans">Bans: ${bans || `<span class="fresh">none yet</span>`}</div>`;
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
  el.innerHTML = (["ban", "ally", "enemy"] as const)
    .map((x) => `<button class="${x} ${t === x ? "on" : ""}" data-t="${x}">${x === "ban" ? "Ban" : x === "ally" ? "Ally" : "Enemy"}</button>`)
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
  else if (bansOpen(state)) hint.innerHTML = `Ban ${state.bans.length + 1} of ${MAX_BANS} · <kbd>Enter</kbd> on an empty box ends bans early · <kbd>Tab</kbd> switches target`;
  else if (slot === state.mySlot) hint.innerHTML = `<b style="color:var(--gold)">Your pick</b> (pick ${slot}) · enter what you lock in`;
  else if (slot) hint.innerHTML = `Next: ${sideOfSlot(order, state.mySlot!, slot)} pick (pick ${slot}) · <kbd>-</kbd> enemy <kbd>+</kbd> ally <kbd>!</kbd> ban to override`;
}

function matches(): StaticBrawler[] {
  const { query } = parseEntry(ui.query);
  return search(brawlersForMap(state.mapId!), query);
}

function renderGrid(): void {
  const list = matches();
  const available = list.filter((b) => !isTaken(state, b.id));
  ui.active = Math.min(ui.active, Math.max(0, available.length - 1));
  const activeId = ui.query.trim() ? available[ui.active]?.id : undefined;
  document.getElementById("grid")!.innerHTML = list
    .map((b) => {
      const cls = [isTaken(state, b.id) ? "taken" : "", b.id === activeId ? "active" : "", owned && !owned.has(b.id) ? "unowned" : ""].join(" ");
      return `<div class="tile ${cls}" data-id="${b.id}" title="${esc(b.name)}${owned && !owned.has(b.id) ? " (not owned)" : ""}">${portrait(b.id)}<span class="nm">${esc(b.name)}</span></div>`;
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
  const myRank = mine !== null ? rec.candidates.findIndex((x) => x.id === mine) : -1;

  el.innerHTML = `
    <h2><span>Your pick</span><span>${c.enemyPicksAfterMine ? `${c.enemyPicksAfterMine} enemy pick${c.enemyPicksAfterMine > 1 ? "s" : ""} after you` : "last word"}</span></h2>
    <div class="ctx">${rec.data.mapGames.toLocaleString()} games on this map${rec.data.mapGames < 300 ? " · thin data, treat as a rough guide" : ""}</div>
    ${mine !== null ? `<div class="done">You locked in <b>${esc(nameOf(mine))}</b>${myRank >= 0 ? ` (#${myRank + 1} suggestion)` : ""}.</div>` : ""}
    ${shown.map((x, i) => candidateHtml(x, i, x.id === mine)).join("")}
    ${rest.length ? `<div class="next-up">Also: ${rest.map((x) => `${esc(x.name)} ${signed(x.score)}`).join(" · ")}</div>` : ""}
    ${!rec.candidates.length ? `<div class="done">Nothing left to suggest from your roster.</div>` : ""}`;
}

function candidateHtml(x: ScoredCandidate, i: number, isMine: boolean): string {
  const parts = Object.entries(x.parts)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `<span class="${v > 0 ? "p" : "n"}">${k} ${signed(v)}</span>`)
    .join("");
  const build = x.build
    ? [x.build.gadget, x.build.starPower, ...x.build.gears].filter(Boolean).join(" · ") + (x.build.note ? ` (${x.build.note})` : "")
    : "";
  return `<div class="cand ${i === 0 ? "first" : ""}">
    ${portrait(x.id)}
    <div class="name"><span class="rank">${i + 1}</span>${esc(x.name)}${isMine ? " ✓" : ""}</div>
    <div class="score ${x.score >= 0 ? "pos" : "neg"}">${signed(x.score)}</div>
    <div class="why">${x.reasons.map((r) => `<span>${esc(r)}</span>`).join("") || `<span class="fresh">No standout reason</span>`}</div>
    <div class="extra">
      ${x.warning ? `<span class="warn">⚠ ${esc(x.warning)}</span>` : ""}
      ${build ? `<span>Build: ${esc(build)}</span>` : ""}
      <span class="parts">${parts}</span>
    </div>
  </div>`;
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
      if (!parseEntry(ui.query).query) {
        if (bansOpen(state) && state.bans.length) {
          setState(finishBans(state));
          say("Bans done. Picks next.");
        }
        return render();
      }
      const pick = list[ui.active];
      if (pick) enter(pick.id, parseEntry(ui.query).target);
      else say("No brawler matches", true), renderTarget();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      ui.active = Math.max(0, Math.min(list.length - 1, ui.active + (e.key === "ArrowDown" ? 1 : -1)));
      renderGrid();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const cycle: Target[] = ["ban", "ally", "enemy"];
      ui.override = cycle[(cycle.indexOf(currentTarget() ?? "ban") + 1) % 3]!;
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

loadData()
  .then(render)
  .catch((err: unknown) => {
    app.innerHTML = `<p class="error">${esc(err instanceof Error ? err.message : String(err))}</p>`;
  });
