import { existsSync, readFileSync } from "node:fs";

/** Loads KEY=value lines from .env into process.env without overriding real env vars. */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, raw] = match as unknown as [string, string, string];
    const value = raw.replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
  requestsPerSecond: number;
}

export const DEFAULT_API_BASE = "https://bsproxy.royaleapi.dev/v1";
export const PROXY_IP = "45.79.218.79";

export function apiConfigFromEnv(): ApiConfig {
  loadDotEnv();
  const apiKey = process.env.BS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "BS_API_KEY is not set. Copy .env.example to .env and paste your key from developer.brawlstars.com " +
        "(or set BS_API_BASE=http://localhost:8787/v1 and BS_API_KEY=mock to use the mock server).",
    );
  }
  return {
    baseUrl: (process.env.BS_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/+$/, ""),
    apiKey,
    requestsPerSecond: Number(process.env.BS_RATE_LIMIT_RPS) || 8,
  };
}

export function myTagFromEnv(): string | undefined {
  loadDotEnv();
  return process.env.MY_TAG?.trim() || undefined;
}
