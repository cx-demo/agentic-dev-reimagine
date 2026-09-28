import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const source = dirname(fileURLToPath(import.meta.url));
const defaultOutput = join(homedir(), ".flow-loop", "work",
  "cx-demo", "agentic-dev-reimagine", "9", "impl-round-1", "demo");

export async function buildPreview(output = defaultOutput) {
  const html = await readFile(join(source, "index.html"), "utf8");
  if (!html.includes('data-api-base=""')) throw new Error("App entrypoint is missing its API base marker.");
  const css = await readFile(join(source, "styles.css"), "utf8");
  const scripts = await Promise.all(["catalog.mjs", "playlist.mjs", "app.mjs"]
    .map((file) => readFile(join(source, file), "utf8")));
  const inline = scripts.map((code) => code
    .replace(/^import\s+\{[\s\S]*?\}\s+from\s+"[^"]+";$/gm, "")
    .replace(/^export\s+/gm, "")).join("\n");
  if (/^\s*(?:import|export)\s/m.test(inline)) {
    throw new Error("Preview contains an unsupported module import/export.");
  }
  new Script(inline);
  const page = html
    .replace('data-api-base=""', 'data-api-base="http://127.0.0.1:4173"')
    .replace('<link rel="stylesheet" href="./styles.css">', `<style>\n${css}\n</style>`)
    .replace('<script type="module" src="./app.mjs"></script>',
      `<script>\n${inline.replace(/<\/script/gi, "<\\/script")}\n</script>`);
  if (page.includes('src="./app.mjs"') || page.includes('href="./styles.css"')) {
    throw new Error("Preview must be self-contained.");
  }
  await mkdir(output, { recursive: true });
  const path = join(output, "index.html");
  await writeFile(path, page);
  return path;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildPreview().then(console.log).catch((error) => {
    console.error("Preview build failed:", error);
    process.exitCode = 1;
  });
}
