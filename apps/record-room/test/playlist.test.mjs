import assert from "node:assert/strict";
import test from "node:test";
import {
  addTrack, emptyPlaylist, exportPlaylist, moveTrack, parsePlaylist,
  removeTrack, renamePlaylist,
} from "../playlist.mjs";

const a = { id: "123", title: "Track A", artist: "Artist A", album: "Album A", url: "https://music.apple.com/us/album/a" };
const b = { id: "456", title: "Track B", artist: "Artist B", album: "", url: "https://itunes.apple.com/us/album/b" };

test("add, move, rename, and remove preserve ordered immutable state", () => {
  const empty = emptyPlaylist();
  const one = addTrack(empty, a);
  const two = addTrack(one, b);
  assert.equal(empty.tracks.length, 0);
  assert.deepEqual(two.tracks.map((track) => track.id), ["123", "456"]);
  assert.throws(() => addTrack(two, a), /already/);
  assert.deepEqual(moveTrack(two, "456", -1).tracks.map((track) => track.id), ["456", "123"]);
  assert.throws(() => moveTrack(two, "123", -1), /cannot move/);
  assert.throws(() => moveTrack(two, "123", 3), /one position/);
  assert.equal(renamePlaylist(two, " New name ").name, "New name");
  assert.throws(() => renamePlaylist(two, " "), /1-60/);
  assert.deepEqual(removeTrack(two, "123").tracks.map((track) => track.id), ["456"]);
  assert.throws(() => removeTrack(two, "999"), /not in/);
});

test("JSON export/import round-trips with names and track order intact", () => {
  const playlist = renamePlaylist(addTrack(addTrack(emptyPlaylist(), a), b), "Night songs");
  assert.deepEqual(parsePlaylist(exportPlaylist(playlist)), playlist);
});

test("invalid imports reject without changing an existing playlist", () => {
  const original = addTrack(emptyPlaylist(), a);
  for (const json of [
    "{broken",
    JSON.stringify({ version: 2, name: "Bad", tracks: [] }),
    JSON.stringify({ version: 1, name: "", tracks: [] }),
    JSON.stringify({ version: 1, name: "Bad", tracks: [a, a] }),
    JSON.stringify({ version: 1, name: "Bad", tracks: [{ ...a, url: "javascript:alert(1)" }] }),
    JSON.stringify({ version: 1, name: "Bad", tracks: [{ ...a, title: "x".repeat(201) }] }),
    "x".repeat(256_001),
  ]) assert.throws(() => parsePlaylist(json));
  assert.deepEqual(original.tracks, [a]);
});
