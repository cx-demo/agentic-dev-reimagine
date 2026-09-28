import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { buildPreview } from "../build-preview.mjs";

test("preview inlines the same app code and styling for a sandboxed iframe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "record-room-preview-"));
  try {
    const path = await buildPreview(dir);
    const html = await readFile(path, "utf8");
    assert.match(html, /data-api-base="http:\/\/127\.0\.0\.1:4173"/);
    assert.match(html, /<style>[\s\S]*\.record-art/);
    assert.doesNotMatch(html, /<script[^>]*src=|<link[^>]*href=/);
    assert.doesNotMatch(html, /^\s*(?:import|export)\s/m);
    const source = (await readFile(new URL("../app.mjs", import.meta.url), "utf8")).match(/function searchError\(/);
    assert.ok(source);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    assert.match(script, /function searchError\(/);
    assert.doesNotThrow(() => new Script(script));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
