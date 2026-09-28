import assert from "node:assert/strict";
import test from "node:test";
import {
  COUNTRY, EXPLICIT, SEARCH_LIMIT, normalizeCatalogResults,
  safeStoreUrl, searchUrl, validateTerm,
} from "../catalog.mjs";

const song = {
  kind: "song", trackId: 123, trackName: "Blue Train", artistName: "Example Artist",
  collectionName: "Example Album", trackViewUrl: "https://music.apple.com/us/album/example/123",
};

test("search terms are bounded, trimmed, and encoded", () => {
  assert.equal(validateTerm("  blue train  "), "blue train");
  assert.throws(() => validateTerm("x"), /2-120/);
  assert.throws(() => validateTerm("x".repeat(121)), /2-120/);
  assert.throws(() => validateTerm("song\nother"), /2-120/);
  const url = searchUrl("jazz & soul");
  assert.equal(url.hostname, "itunes.apple.com");
  assert.equal(url.searchParams.get("term"), "jazz & soul");
  assert.equal(url.searchParams.get("media"), "music");
  assert.equal(url.searchParams.get("entity"), "song");
  assert.equal(url.searchParams.get("country"), COUNTRY);
  assert.equal(url.searchParams.get("explicit"), EXPLICIT);
  assert.equal(url.searchParams.get("limit"), String(SEARCH_LIMIT));
});

test("store links require exact Apple HTTPS hosts", () => {
  assert.equal(safeStoreUrl(song.trackViewUrl), song.trackViewUrl);
  for (const url of ["javascript:alert(1)", "http://music.apple.com/a",
    "https://music.apple.com.evil.test/a", "https://evil.test/a", "//music.apple.com/a",
    "https://user:pass@music.apple.com/a", "https://music.apple.com:444/a"]) {
    assert.equal(safeStoreUrl(url), null, url);
  }
});

test("catalog results normalize valid songs only and deduplicate by ID", () => {
  const result = normalizeCatalogResults({ results: [
    song, { ...song }, { ...song, trackId: 124, kind: "music-video" },
    { ...song, trackId: 125, trackViewUrl: "https://bad.test/track" },
    { ...song, trackId: 126, artistName: "" },
  ] });
  assert.deepEqual(result, [{
    id: "123", title: "Blue Train", artist: "Example Artist",
    album: "Example Album", url: song.trackViewUrl,
  }]);
  assert.throws(() => normalizeCatalogResults({ results: null }), /Invalid catalog/);
  assert.throws(() => normalizeCatalogResults(null), /Invalid catalog/);
});
