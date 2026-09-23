import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COUNTRY, EXPLICIT, normalizeCatalogResults, searchUrl, validateTerm } from "./catalog.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/catalog.mjs", ["catalog.mjs", "text/javascript; charset=utf-8"]],
  ["/playlist.mjs", ["playlist.mjs", "text/javascript; charset=utf-8"]],
]);

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

export async function startServer({ port = 4173, fetchImpl = fetch, now = Date.now, log = console.error } = {}) {
  const cache = new Map();
  let nextRequestAt = 0;
  let boundPort;
  const server = createServer(async (request, response) => {
    if (request.headers.host !== `127.0.0.1:${boundPort}`) {
      json(response, 403, { error: "Invalid host." });
      return;
    }
    let url;
    try { url = new URL(request.url || "/", `http://127.0.0.1:${boundPort}`); }
    catch { json(response, 400, { error: "Invalid request URL." }); return; }
    if (url.pathname === "/api/search") {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      response.setHeader("Access-Control-Allow-Private-Network", "true");
      if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
      if (request.method !== "GET") { json(response, 405, { error: "Only GET is supported." }); return; }
      let term;
      try { term = validateTerm(url.searchParams.get("term")); }
      catch (error) { json(response, 400, { error: error.message }); return; }
      if ([...url.searchParams.keys()].some((key) => key !== "term")) {
        json(response, 400, { error: "Only a search term is accepted." });
        return;
      }
      const key = term.toLocaleLowerCase("en-US");
      const cached = cache.get(key);
      if (cached && cached.expires > now()) { json(response, 200, cached.value); return; }
      if (now() < nextRequestAt) {
        json(response, 429, { error: "Search limit reached. Try again shortly." }, {
          "Retry-After": String(Math.ceil((nextRequestAt - now()) / 1000)),
        });
        return;
      }
      nextRequestAt = now() + 3100;
      try {
        const upstream = await fetchImpl(searchUrl(term), {
          signal: AbortSignal.timeout(8000),
          headers: { Accept: "application/json" },
          redirect: "error",
        });
        if (!upstream.ok) {
          const retry = Number(upstream.headers?.get("Retry-After"));
          const retryAfter = Number.isInteger(retry) && retry > 0 && retry <= 120 ? retry : 4;
          if (upstream.status === 429) nextRequestAt = Math.max(nextRequestAt, now() + retryAfter * 1000);
          json(response, upstream.status === 429 ? 429 : 502,
            { error: upstream.status === 429 ? "Catalog rate-limited. Try again later." : "Catalog unavailable." },
            upstream.status === 429 ? { "Retry-After": String(retryAfter) } : {});
          return;
        }
        const value = {
          tracks: normalizeCatalogResults(await upstream.json()),
          country: COUNTRY, explicit: EXPLICIT,
        };
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, { expires: now() + 60_000, value });
        json(response, 200, value);
      } catch (error) {
        log("Catalog search failed:", error);
        json(response, error?.name === "TimeoutError" || error?.name === "AbortError" ? 504 : 502,
          { error: error?.name === "TimeoutError" || error?.name === "AbortError"
            ? "Catalog timed out. Try again." : "Catalog search failed. Try again." });
      }
      return;
    }
    if (request.method !== "GET" || !staticFiles.has(url.pathname)) {
      json(response, 404, { error: "Not found." });
      return;
    }
    const [name, mediaType] = staticFiles.get(url.pathname);
    try {
      const body = await readFile(join(here, name));
      response.writeHead(200, {
        "Content-Type": mediaType,
        "Cache-Control": "no-store",
        ...(name === "index.html" ? {
          "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'",
        } : {}),
      });
      response.end(body);
    } catch (error) {
      log("Static file read failed:", error);
      json(response, 500, { error: "App asset unavailable." });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  boundPort = server.address().port;
  return { server, port: boundPort, url: `http://127.0.0.1:${boundPort}/` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().then(({ url }) => {
    console.log(`Record Room: ${url}`);
  }).catch((error) => {
    console.error("Record Room failed to start:", error);
    process.exitCode = 1;
  });
}
