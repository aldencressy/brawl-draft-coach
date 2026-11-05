// Serves fixtures/ in the shape of the Brawl Stars API so everything runs without a key.
//   npm run mock               -> http://localhost:8787/v1
//   MOCK_FLAKY=1 npm run mock  -> every 3rd request fails with 503 to exercise retries
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.MOCK_PORT) || 8787;
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const flaky = process.env.MOCK_FLAKY === "1";
let requestCount = 0;

function fixturePath(path: string): string | undefined {
  const tag = (s: string) => decodeURIComponent(s).replace(/^#/, "").toUpperCase();
  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/v1\/players\/([^/]+)\/battlelog$/))) return `battlelogs/${tag(m[1]!)}.json`;
  if ((m = path.match(/^\/v1\/players\/([^/]+)$/))) return `players/${tag(m[1]!)}.json`;
  if ((m = path.match(/^\/v1\/rankings\/([^/]+)\/players$/))) return `rankings/${decodeURIComponent(m[1]!)}.json`;
  if (path === "/v1/brawlers") return "brawlers.json";
  return undefined;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    console.log(`${status} ${req.method} ${url.pathname}`);
  };

  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ") || auth === "Bearer ") {
    return send(403, { reason: "accessDenied", message: "Invalid authorization" });
  }
  if (auth === "Bearer bad-ip") {
    return send(403, { reason: "accessDenied.invalidIp", message: "Invalid authorization: API key does not allow access from IP 1.2.3.4" });
  }
  if (flaky && ++requestCount % 3 === 0) {
    return send(503, { reason: "unknownException", message: "Simulated failure" });
  }

  const file = fixturePath(url.pathname);
  if (!file || !existsSync(join(FIXTURES, file))) {
    return send(404, { reason: "notFound", message: `No fixture for ${url.pathname}` });
  }
  const data = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
  const limit = Number(url.searchParams.get("limit"));
  if (limit && Array.isArray(data.items)) data.items = data.items.slice(0, limit);
  send(200, data);
});

server.listen(PORT, () => {
  console.log(`Mock Brawl Stars API on http://localhost:${PORT}/v1${flaky ? " (flaky mode)" : ""}`);
});
