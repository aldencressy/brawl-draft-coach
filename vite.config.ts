// Draft UI build. `npm run dev` serves web/ with the JSON from DATA_DIR/out at /data/;
// `npm run build:web` writes dist/ (the workflow copies the JSON into dist/data/).
import { createReadStream, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const dataOut = resolve(process.env.DATA_DIR || "data", "out");

function serveData(): Plugin {
  const handler = (req: { url?: string }, res: any, next: () => void) => {
    const m = req.url?.match(/^\/data\/([\w.-]+\.json)/);
    const file = m && join(dataOut, m[1]!);
    if (!file || !existsSync(file)) return next();
    res.setHeader("Content-Type", "application/json");
    createReadStream(file).pipe(res);
  };
  return {
    name: "serve-data",
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

export default defineConfig({
  root: "web",
  base: "./",
  plugins: [serveData()],
  // The UI imports the engine and config from outside web/.
  server: { fs: { allow: [".."] } },
  build: { outDir: "../dist", emptyOutDir: true },
});
