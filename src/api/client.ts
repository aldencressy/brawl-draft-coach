import { PROXY_IP, type ApiConfig } from "../config.js";
import { RateLimiter, defaultSleep } from "./rateLimiter.js";
import type { BattleLogEntry, BrawlerInfo, Paged, Player, RankedPlayer } from "./types.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | undefined,
    readonly path: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  maxRetries?: number;
  /** Base delay for exponential backoff; doubles each attempt. */
  retryBaseMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  limiter?: RateLimiter;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Uppercases, adds the leading #, and fixes the common O-for-0 typo. */
export function normalizeTag(tag: string): string {
  const body = tag.trim().toUpperCase().replace(/^#/, "").replace(/O/g, "0");
  if (!/^[0-9A-Z]+$/.test(body)) throw new Error(`"${tag}" doesn't look like a player tag`);
  return `#${body}`;
}

export class BrawlStarsClient {
  private readonly limiter: RateLimiter;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ApiConfig,
    options: ClientOptions = {},
  ) {
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.limiter = options.limiter ?? new RateLimiter(config.requestsPerSecond, Date.now, this.sleep);
    this.maxRetries = options.maxRetries ?? 4;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  getPlayer(tag: string): Promise<Player> {
    return this.get(`/players/${encodeURIComponent(normalizeTag(tag))}`);
  }

  getBattleLog(tag: string): Promise<Paged<BattleLogEntry>> {
    return this.get(`/players/${encodeURIComponent(normalizeTag(tag))}/battlelog`);
  }

  /** `country` is "global" or a two-letter country code such as "US". */
  getPlayerRankings(country: string, limit = 200): Promise<Paged<RankedPlayer>> {
    return this.get(`/rankings/${encodeURIComponent(country)}/players?limit=${limit}`);
  }

  getBrawlers(): Promise<Paged<BrawlerInfo>> {
    return this.get("/brawlers");
  }

  async get<T>(path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.limiter.wait();
      let response: Response;
      try {
        response = await this.fetchFn(this.config.baseUrl + path, {
          headers: { Authorization: `Bearer ${this.config.apiKey}`, Accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        const cause = err instanceof Error ? err.message : String(err);
        throw new ApiError(
          `Could not reach ${this.config.baseUrl} after ${attempt + 1} attempts (${cause}). ` +
            "Check your connection and BS_API_BASE.",
          0,
          undefined,
          path,
        );
      }

      if (response.ok) return (await response.json()) as T;

      const body = await readErrorBody(response);
      if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
        const retryAfterMs = Number(response.headers.get("retry-after")) * 1000 || 0;
        const delay = Math.max(retryAfterMs, this.backoff(attempt));
        if (response.status === 429) this.limiter.pause(delay);
        await this.sleep(delay);
        continue;
      }
      throw new ApiError(explain(response.status, body, path), response.status, body.reason, path);
    }
  }

  private backoff(attempt: number): number {
    const jitter = 0.75 + Math.random() * 0.5;
    return Math.round(this.retryBaseMs * 2 ** attempt * jitter);
  }
}

interface ErrorBody {
  reason?: string;
  message?: string;
}

async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    return (await response.json()) as ErrorBody;
  } catch {
    return {};
  }
}

function explain(status: number, body: ErrorBody, path: string): string {
  const detail = body.message ? ` Server said: "${body.message}"` : "";
  switch (body.reason ?? status) {
    case "accessDenied.invalidIp":
      return `API key rejected for this IP. When using the RoyaleAPI proxy, the key must allow ${PROXY_IP}.${detail}`;
    case "accessDenied":
    case 403:
      return `API key rejected (403). Check BS_API_KEY is copied in full and the key allows ${PROXY_IP}.${detail}`;
    case "notFound":
    case 404:
      return `Not found: ${path}. If this is a player tag, double-check it in your in-game profile.${detail}`;
    case "throttled":
    case 429:
      return `Rate limited (429) and out of retries. Lower BS_RATE_LIMIT_RPS.${detail}`;
    case "inMaintenance":
      return `Brawl Stars is in maintenance; try again later.${detail}`;
    default:
      return `Request ${path} failed with HTTP ${status}${body.reason ? ` (${body.reason})` : ""}.${detail}`;
  }
}
