// Browser storage for the current draft and the draft log. Storage can be unavailable
// (private windows, blocked site data), so every access is guarded and the app works without it.
import type { DraftState } from "./draftState.js";

const DRAFT_KEY = "bdc.draft.v1";
const LOG_KEY = "bdc.log.v1";
const MAX_LOG = 500;

export interface LoggedDraft {
  at: string;
  mapId: number;
  mySlot: number;
  bans: number[];
  allies: number[];
  enemies: number[];
  myPick: number | null;
  /** Top suggestions (best first) at the moment you entered your pick. */
  suggested: number[] | null;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the draft just won't survive a reload.
  }
}

export const loadDraft = () => read<DraftState>(DRAFT_KEY);
export const saveDraft = (s: DraftState) => write(DRAFT_KEY, s);

export const loadLog = () => read<LoggedDraft[]>(LOG_KEY) ?? [];

/** Adds the entry, or replaces the one with the same `at` (a draft finished again after an undo). */
export function upsertLog(entry: LoggedDraft): void {
  const log = loadLog().filter((d) => d.at !== entry.at);
  write(LOG_KEY, [...log, entry].slice(-MAX_LOG));
}

export function downloadLog(): void {
  const blob = new Blob([JSON.stringify(loadLog(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `draft-log-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
