import assert from "node:assert/strict";
import test from "node:test";

class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.value = "";
    this.textContent = "";
    this.hidden = false;
    this.dataset = {};
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  focus() { this.focused = true; }
  click() { this.onclick?.(); }
}

function browser({ storageBlocked = false } = {}) {
  const elements = new Map();
  const storage = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get("playlistName").value = "My favourites";
  get("retrySearch").hidden = true;
  globalThis.document = {
    documentElement: { dataset: { apiBase: "" } },
    getElementById: get,
    createElement: (tag) => new Element(tag),
    querySelectorAll: () => [],
  };
  globalThis.window = {};
  window.top = window;
  window.self = window;
  globalThis.location = { origin: "http://127.0.0.1:4173" };
  globalThis.localStorage = {
    getItem: (key) => {
      if (storageBlocked) throw new Error("storage denied");
      return storage.get(key) || null;
    },
    setItem: (key, value) => {
      if (storageBlocked) throw new Error("storage denied");
      storage.set(key, value);
    },
  };
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({
      tracks: [
        { id: "123", title: "Track A", artist: "Artist A", album: "Album A",
          url: "https://music.apple.com/us/album/a" },
        { id: "456", title: "Track B", artist: "Artist B", album: "Album B",
          url: "https://music.apple.com/us/album/b" },
      ],
    }),
  });
  return { get, storage };
}

test("search, add, reorder, and remove work through the rendered controls", async () => {
  const { get, storage } = browser();
  await import("../app.mjs?test=interactions");
  get("query").value = "jazz";
  get("searchForm").onsubmit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(get("results").children.length, 2);
  get("results").children[0].children.at(-1).children.at(-1).click();
  get("results").children[1].children.at(-1).children.at(-1).click();
  assert.equal(get("tracks").children.length, 2);
  assert.deepEqual(JSON.parse(storage.get("record-room-playlist-v1")).tracks.map((track) => track.id), ["123", "456"]);
  get("tracks").children[1].children.at(-1).children[0].click();
  assert.deepEqual(JSON.parse(storage.get("record-room-playlist-v1")).tracks.map((track) => track.id), ["456", "123"]);
  get("tracks").children[0].children.at(-1).children.at(-1).click();
  assert.deepEqual(JSON.parse(storage.get("record-room-playlist-v1")).tracks.map((track) => track.id), ["123"]);
});

test("denied storage is reported while in-memory playlist stays usable", async () => {
  const { get } = browser({ storageBlocked: true });
  await import("../app.mjs?test=storage-denied");
  assert.match(get("saveStatus").textContent, /session-only/);
  get("query").value = "jazz";
  get("searchForm").onsubmit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 600));
  get("results").children[0].children.at(-1).children.at(-1).click();
  assert.equal(get("tracks").children.length, 1);
  assert.match(get("saveStatus").textContent, /Not saved/);
});

test("invalid import reports error without replacing the visible list", async () => {
  const { get, storage } = browser();
  await import("../app.mjs?test=invalid-import");
  get("query").value = "jazz";
  get("searchForm").onsubmit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 600));
  get("results").children[0].children.at(-1).children.at(-1).click();
  const original = storage.get("record-room-playlist-v1");
  const input = get("importFile");
  await input.onchange({ target: {
    files: [{ size: 8, text: async () => "{invalid" }],
    value: "invalid.json",
  } });
  assert.equal(get("tracks").children.length, 1);
  assert.equal(storage.get("record-room-playlist-v1"), original);
  assert.match(get("saveStatus").textContent, /Import failed.*Current playlist unchanged/);
});
