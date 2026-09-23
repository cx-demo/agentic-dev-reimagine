import { SEARCH_LIMIT, safeStoreUrl, validateTerm } from "./catalog.mjs";
import {
  addTrack, emptyPlaylist, exportPlaylist, moveTrack, parsePlaylist,
  removeTrack, renamePlaylist,
} from "./playlist.mjs";

const $ = (id) => document.getElementById(id);
const storageKey = "record-room-playlist-v1";
const embedded = window.top !== window.self;
const apiBase = document.documentElement.dataset.apiBase || location.origin;
let playlist = emptyPlaylist();
let results = [];
let sequence = 0;
let timer;
let controller;
let nextSearchAt = 0;

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function save() {
  try {
    localStorage.setItem(storageKey, exportPlaylist(playlist));
    $("saveStatus").textContent = "Saved in this browser. Export JSON to keep a portable copy.";
    return true;
  } catch (error) {
    $("saveStatus").textContent = `Not saved in this browser (${error.message}). Your list remains available until this page closes; export a copy when permitted.`;
    return false;
  }
}

function load() {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) playlist = parsePlaylist(stored);
    $("saveStatus").textContent = embedded
      ? "Embedded preview storage and downloads may be blocked. Open the preview in a new tab to keep or export your list."
      : "Saved in this browser. Export JSON to keep a portable copy.";
  } catch (error) {
    $("saveStatus").textContent = `Saved list unavailable (${error.message}). You can still create a session-only list.`;
  }
}

function renderPlaylist(focusId) {
  const list = $("tracks");
  $("playlistName").value = playlist.name;
  $("playlistCount").textContent = `${playlist.tracks.length} ${playlist.tracks.length === 1 ? "track" : "tracks"} - change order with arrows`;
  list.replaceChildren();
  if (!playlist.tracks.length) {
    list.append(element("li", "playlist-empty", "Your collection is waiting. Add a track from search results."));
    return;
  }
  playlist.tracks.forEach((item, index) => {
    const row = element("li", "track");
    row.append(element("span", "track-num", String(index + 1).padStart(2, "0")));
    const copy = element("div");
    copy.append(element("div", "track-title", item.title), element("div", "track-artist", item.artist));
    const actions = element("div", "track-actions");
    for (const [symbol, direction, offset] of [["↑", "Move up", -1], ["↓", "Move down", 1]]) {
      const button = element("button", "", symbol);
      button.type = "button";
      button.setAttribute("aria-label", `${direction}: ${item.title}`);
      button.disabled = index + offset < 0 || index + offset >= playlist.tracks.length;
      button.onclick = () => {
        try {
          playlist = moveTrack(playlist, item.id, offset);
          save();
          renderPlaylist(item.id);
          $("searchStatus").textContent = `${item.title} moved ${direction === "Move up" ? "up" : "down"}.`;
        } catch (error) { $("searchStatus").textContent = error.message; }
      };
      actions.append(button);
    }
    const remove = element("button", "", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${item.title}`);
    remove.onclick = () => {
      try {
        playlist = removeTrack(playlist, item.id);
        save();
        renderPlaylist(playlist.tracks[Math.min(index, playlist.tracks.length - 1)]?.id);
        renderResults();
        $("searchStatus").textContent = `${item.title} removed.`;
        if (!playlist.tracks.length) $("playlistName").focus();
      } catch (error) { $("searchStatus").textContent = error.message; }
    };
    actions.append(remove);
    row.append(copy, actions);
    list.append(row);
    if (focusId === item.id) remove.focus();
  });
}

function renderResults() {
  const target = $("results");
  target.replaceChildren();
  if (!results.length) {
    target.append(element("div", "empty", "No tracks to show. Try another song or artist."));
    return;
  }
  results.forEach((track) => {
    const row = element("article", "result");
    row.append(element("div", "disc"));
    const text = element("div");
    text.append(element("div", "song-title", track.title),
      element("div", "song-meta", [track.artist, track.album].filter(Boolean).join(" - ")));
    const actions = element("div", "result-actions");
    const url = safeStoreUrl(track.url);
    if (url) {
      const link = element("a", "", "Store");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `Open ${track.title} in Apple Music`);
      if (embedded) link.onclick = (event) => {
        event.preventDefault();
        $("saveStatus").textContent = "Open the preview in a new tab to follow store links.";
      };
      actions.append(link);
    }
    const exists = playlist.tracks.some((item) => item.id === track.id);
    const add = element("button", "add", exists ? "Added" : "+ Add");
    add.type = "button";
    add.disabled = exists;
    add.setAttribute("aria-label", `Add ${track.title} to playlist`);
    add.onclick = () => {
      try {
        playlist = addTrack(playlist, track);
        save();
        renderPlaylist();
        renderResults();
        $("searchStatus").textContent = `${track.title} added to your playlist.`;
      } catch (error) { $("searchStatus").textContent = error.message; }
    };
    actions.append(add);
    row.append(text, actions);
    target.append(row);
  });
}

function searchError(message) {
  $("searchStatus").textContent = message;
  $("retrySearch").hidden = false;
}

async function search(term, ticket) {
  if (ticket !== sequence) return;
  nextSearchAt = Date.now() + 3100;
  const signal = new AbortController();
  controller = signal;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; signal.abort(); }, 8500);
  $("searchStatus").textContent = `Searching for "${term}"...`;
  $("retrySearch").hidden = true;
  try {
    const url = new URL("/api/search", apiBase);
    url.searchParams.set("term", term);
    const response = await fetch(url, { signal: signal.signal, credentials: "omit" });
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error("Search service returned invalid JSON."); }
    if (!response.ok) {
      if (response.status === 429) {
        const seconds = Number(response.headers.get("Retry-After"));
        if (Number.isFinite(seconds) && seconds > 0) nextSearchAt = Date.now() + seconds * 1000;
      }
      throw new Error(payload.error || `Search service returned HTTP ${response.status}.`);
    }
    if (!Array.isArray(payload.tracks)) throw new Error("Search service returned invalid track data.");
    if (ticket !== sequence) return;
    results = payload.tracks.slice(0, SEARCH_LIMIT);
    renderResults();
    $("searchStatus").textContent = results.length
      ? `${results.length} tracks found. Add your favourites to the list.`
      : "No tracks found. Try another search.";
  } catch (error) {
    if (ticket !== sequence) return;
    if (error.name === "AbortError" && !timedOut) return;
    results = [];
    renderResults();
    searchError(timedOut ? "Search timed out. Try again." : `Search failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
    if (controller === signal) controller = undefined;
  }
}

function scheduleSearch() {
  clearTimeout(timer);
  controller?.abort();
  const ticket = ++sequence;
  let term;
  try { term = validateTerm($("query").value); }
  catch (error) {
    results = [];
    $("results").replaceChildren(element("div", "empty", "Enter at least two characters to search."));
    $("searchStatus").textContent = error.message;
    $("retrySearch").hidden = true;
    return;
  }
  const delay = Math.max(450, nextSearchAt - Date.now());
  $("searchStatus").textContent = delay > 1000 ? "Waiting briefly to respect catalog limits..." : "Searching soon...";
  $("retrySearch").hidden = true;
  timer = setTimeout(() => search(term, ticket), delay);
}

$("searchForm").onsubmit = (event) => { event.preventDefault(); scheduleSearch(); };
$("query").oninput = scheduleSearch;
$("retrySearch").onclick = scheduleSearch;
document.querySelectorAll("[data-query]").forEach((button) => {
  button.onclick = () => { $("query").value = button.dataset.query; scheduleSearch(); $("query").focus(); };
});
$("playlistName").onchange = () => {
  try {
    playlist = renamePlaylist(playlist, $("playlistName").value);
    save();
    renderPlaylist();
  } catch (error) {
    $("saveStatus").textContent = error.message;
    $("playlistName").value = playlist.name;
    $("playlistName").focus();
  }
};
$("export").onclick = () => {
  if (embedded) { $("saveStatus").textContent = "Open the preview in a new tab to export a playlist."; return; }
  const href = URL.createObjectURL(new Blob([exportPlaylist(playlist)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = "record-room-playlist.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
};
$("import").onclick = () => {
  if (embedded) { $("saveStatus").textContent = "Open the preview in a new tab to import a playlist."; return; }
  $("importFile").click();
};
$("importFile").onchange = async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 256_000) throw new Error("Playlist file exceeds the 256 KB limit.");
    const candidate = parsePlaylist(await file.text());
    playlist = candidate;
    const saved = save();
    renderPlaylist();
    renderResults();
    $("saveStatus").textContent = saved
      ? "Playlist imported and saved."
      : "Playlist imported for this session, but browser storage is unavailable. Export a copy.";
  } catch (error) {
    $("saveStatus").textContent = `Import failed: ${error.message} Current playlist unchanged.`;
  } finally {
    event.target.value = "";
  }
};

load();
renderPlaylist();
