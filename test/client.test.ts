import { describe, expect, it } from "vitest";
import { ApiError, BrawlStarsClient, normalizeTag } from "../src/api/client.js";
import { RateLimiter } from "../src/api/rateLimiter.js";

const config = { baseUrl: "https://example.test/v1", apiKey: "k", requestsPerSecond: 1000 };
const noSleep = async () => {};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function clientWith(responses: Array<Response | Error>) {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const client = new BrawlStarsClient(config, {
    fetch: fetchFn,
    sleep: noSleep,
    limiter: new RateLimiter(1000, Date.now, noSleep),
    maxRetries: 2,
  });
  return { client, calls };
}

describe("normalizeTag", () => {
  it("adds #, uppercases, and fixes O→0", () => {
    expect(normalizeTag("  9lqop ")).toBe("#9LQ0P");
    expect(normalizeTag("#2PQ00")).toBe("#2PQ00");
  });
  it("rejects junk", () => {
    expect(() => normalizeTag("not a tag!")).toThrow();
  });
});

describe("BrawlStarsClient", () => {
  it("URL-encodes the tag and sends the key", async () => {
    const { client, calls } = clientWith([json(200, { items: [] })]);
    await client.getBattleLog("#9LQ0P");
    expect(calls[0]).toBe("https://example.test/v1/players/%239LQ0P/battlelog");
  });

  it("retries 503 and network errors, then succeeds", async () => {
    const { client, calls } = clientWith([new TypeError("fetch failed"), json(503, {}), json(200, { tag: "#X" })]);
    await expect(client.get("/players/x")).resolves.toEqual({ tag: "#X" });
    expect(calls).toHaveLength(3);
  });

  it("gives up after maxRetries with a clear message", async () => {
    const { client } = clientWith([json(429, {}), json(429, {}), json(429, { reason: "throttled" })]);
    await expect(client.get("/x")).rejects.toThrow(/Rate limited/);
  });

  it("does not retry 403 and explains the proxy IP", async () => {
    const { client, calls } = clientWith([json(403, { reason: "accessDenied.invalidIp", message: "bad ip" })]);
    const err = await client.get<never>("/x").catch((e: ApiError) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toContain("45.79.218.79");
    expect(calls).toHaveLength(1);
  });

  it("explains 404s", async () => {
    const { client } = clientWith([json(404, { reason: "notFound" })]);
    await expect(client.getPlayer("#ABC")).rejects.toThrow(/Not found/);
  });
});
