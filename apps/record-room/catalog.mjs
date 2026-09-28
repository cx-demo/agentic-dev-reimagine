export const SEARCH_LIMIT = 12;
export const COUNTRY = "US";
export const EXPLICIT = "No";

export function validateTerm(value) {
  if (typeof value !== "string") throw new Error("Search must be text.");
  const term = value.trim();
  if (term.length < 2 || term.length > 120 || /[\u0000-\u001f\u007f]/.test(term)) {
    throw new Error("Enter 2-120 characters to search.");
  }
  return term;
}

export function safeStoreUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ["music.apple.com", "itunes.apple.com"].includes(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

export function searchUrl(term) {
  const url = new URL("https://itunes.apple.com/search");
  for (const [key, value] of Object.entries({
    term: validateTerm(term), media: "music", entity: "song",
    country: COUNTRY, explicit: EXPLICIT, limit: String(SEARCH_LIMIT),
  })) url.searchParams.set(key, value);
  return url;
}

export function normalizeCatalogResults(payload) {
  if (!payload || !Array.isArray(payload.results)) throw new Error("Invalid catalog response.");
  const seen = new Set();
  const results = [];
  for (const item of payload.results.slice(0, 200)) {
    if (!item || item.kind !== "song" || !Number.isSafeInteger(item.trackId) || item.trackId < 1 ||
        typeof item.trackName !== "string" || !item.trackName.trim() ||
        typeof item.artistName !== "string" || !item.artistName.trim()) continue;
    const url = safeStoreUrl(item.trackViewUrl);
    if (!url || seen.has(item.trackId)) continue;
    seen.add(item.trackId);
    results.push({
      id: String(item.trackId),
      title: item.trackName.trim().slice(0, 200),
      artist: item.artistName.trim().slice(0, 200),
      album: typeof item.collectionName === "string" ? item.collectionName.trim().slice(0, 200) : "",
      url,
    });
    if (results.length >= SEARCH_LIMIT) break;
  }
  return results;
}
