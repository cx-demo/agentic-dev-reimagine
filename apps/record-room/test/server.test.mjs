import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { startServer } from "../server.mjs";

const song = {
  kind: "song", trackId: 123, trackName: "Blue Train", artistName: "Example Artist",
  collectionName: "Example Album", trackViewUrl: "https://music.apple.com/us/album/example/123",
};

async function serve(fetchImpl, fn, now = Date.now) {
  const logged = [];
  const running = await startServer({ port: 0, fetchImpl, now, log: (...args) => logged.push(args) });
  try { await fn({ ...running, logged }); }
  finally { await new Promise((resolve, reject) => running.server.close((error) => error ? reject(error) : resolve())); }
}

test("catalog endpoint bounds requests, normalizes data, caches and throttles", async () => {
  let clock = 1000;
  const requests = [];
  await serve(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ results: [song, { ...song, trackId: 124, trackViewUrl: "https://bad.test" }] }) };
  }, async ({ url }) => {
    const first = await fetch(url + "api/search?term=jazz", { headers: { Origin: "null" } });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual((await first.json()).tracks, [{
      id: "123", title: "Blue Train", artist: "Example Artist",
      album: "Example Album", url: song.trackViewUrl,
    }]);
    assert.equal(requests.length, 1);
    const upstream = requests[0].url;
    assert.equal(upstream.hostname, "itunes.apple.com");
    assert.equal(upstream.searchParams.get("explicit"), "No");
    assert.equal(upstream.searchParams.get("limit"), "12");
    assert.equal(requests[0].options.redirect, "error");

    const cached = await fetch(url + "api/search?term=JAZZ");
    assert.equal(cached.status, 200);
    assert.equal(requests.length, 1);
    const throttled = await fetch(url + "api/search?term=blues");
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers.get("retry-after"), "4");
    clock += 3101;
    assert.equal((await fetch(url + "api/search?term=blues")).status, 200);
    assert.equal(requests.length, 2);
    const preflight = await fetch(url + "api/search", {
      method: "OPTIONS",
      headers: { Origin: "null", "Access-Control-Request-Private-Network": "true" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
  }, () => clock);
});

test("invalid requests cannot choose upstream host, route, or method", async () => {
  await serve(async () => { throw new Error("should not reach provider"); }, async ({ url, port }) => {
    for (const path of ["api/search?term=x", "api/search?term=jazz&url=https://evil.test"]) {
      const response = await fetch(url + path);
      assert.equal(response.status, 400);
    }
    assert.equal((await fetch(url + "api/search?term=jazz", { method: "POST" })).status, 405);
    assert.equal((await fetch(url + "secret.txt")).status, 404);
    const forbidden = await new Promise((resolve, reject) => {
      const req = request({
        hostname: "127.0.0.1", port, path: "/api/search?term=jazz",
        headers: { Host: "evil.test" },
      }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      req.on("error", reject);
      req.end();
    });
    assert.equal(forbidden, 403);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
    assert.match(await page.text(), /Record Room/);
  });
});

test("provider failures and timeouts are explicit", async () => {
  await serve(async () => { throw new Error("network down"); }, async ({ url, logged }) => {
    const response = await fetch(url + "api/search?term=jazz");
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /failed/);
    assert.equal(logged.length, 1);
  });
  await serve(async () => {
    const error = new Error("timeout");
    error.name = "TimeoutError";
    throw error;
  }, async ({ url }) => {
    const response = await fetch(url + "api/search?term=jazz");
    assert.equal(response.status, 504);
    assert.match((await response.json()).error, /timed out/);
  });
  await serve(async () => ({ ok: true, json: async () => ({ results: "invalid" }) }),
    async ({ url }) => {
      const response = await fetch(url + "api/search?term=jazz");
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /failed/);
    });
});

test("provider rate limiting is forwarded as a bounded retry delay", async () => {
  let calls = 0;
  await serve(async () => {
    calls++;
    return { ok: false, status: 429, headers: { get: () => "7" } };
  }, async ({ url }) => {
    const first = await fetch(url + "api/search?term=jazz");
    assert.equal(first.status, 429);
    assert.equal(first.headers.get("retry-after"), "7");
    assert.match((await first.json()).error, /rate-limited/);
    const second = await fetch(url + "api/search?term=blues");
    assert.equal(second.status, 429);
    assert.equal(calls, 1);
  }, () => 1000);
});
