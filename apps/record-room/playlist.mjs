import { safeStoreUrl } from "./catalog.mjs";

export const MAX_TRACKS = 200;
export const emptyPlaylist = () => ({ version: 1, name: "My favourites", tracks: [] });

function nameOf(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 60) {
    throw new Error("Playlist name must be 1-60 characters.");
  }
  return value.trim();
}

function trackOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.id !== "string" || !/^[1-9]\d{0,17}$/.test(value.id) ||
      typeof value.title !== "string" || !value.title.trim() || value.title.length > 200 ||
      typeof value.artist !== "string" || !value.artist.trim() || value.artist.length > 200 ||
      typeof value.album !== "string" || value.album.length > 200) {
    throw new Error("Playlist contains invalid track metadata.");
  }
  const url = safeStoreUrl(value.url);
  if (!url) throw new Error("Playlist contains an invalid store link.");
  return { id: value.id, title: value.title.trim(), artist: value.artist.trim(), album: value.album.trim(), url };
}

export function parsePlaylist(json) {
  if (typeof json !== "string" || json.length > 256_000) {
    throw new Error("Playlist file exceeds the 256 KB limit.");
  }
  let value;
  try { value = JSON.parse(json); }
  catch { throw new Error("Playlist file is not valid JSON."); }
  if (!value || value.version !== 1 || !Array.isArray(value.tracks) || value.tracks.length > MAX_TRACKS) {
    throw new Error("Playlist file has an unsupported format or too many tracks.");
  }
  const name = nameOf(value.name);
  const tracks = value.tracks.map(trackOf);
  if (new Set(tracks.map((track) => track.id)).size !== tracks.length) {
    throw new Error("Playlist file contains duplicate tracks.");
  }
  return { version: 1, name, tracks };
}

export function exportPlaylist(playlist) {
  return JSON.stringify(parsePlaylist(JSON.stringify(playlist)), null, 2);
}

export function renamePlaylist(playlist, name) {
  return { ...playlist, name: nameOf(name) };
}

export function addTrack(playlist, value) {
  const track = trackOf(value);
  if (playlist.tracks.some((item) => item.id === track.id)) throw new Error("Track is already in your playlist.");
  if (playlist.tracks.length >= MAX_TRACKS) throw new Error("Playlist is full (200 tracks).");
  return { ...playlist, tracks: [...playlist.tracks, track] };
}

export function removeTrack(playlist, id) {
  const tracks = playlist.tracks.filter((item) => item.id !== id);
  if (tracks.length === playlist.tracks.length) throw new Error("Track is not in your playlist.");
  return { ...playlist, tracks };
}

export function moveTrack(playlist, id, offset) {
  if (offset !== -1 && offset !== 1) throw new Error("Move must be one position.");
  const index = playlist.tracks.findIndex((item) => item.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= playlist.tracks.length) {
    throw new Error("Track cannot move in that direction.");
  }
  const tracks = [...playlist.tracks];
  [tracks[index], tracks[target]] = [tracks[target], tracks[index]];
  return { ...playlist, tracks };
}
