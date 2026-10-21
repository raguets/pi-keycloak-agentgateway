// Runs the full test suite against each Pi 1.x release, in an isolated copy of the project.
// Usage: npm run test:pi-versions [-- 1.0.0 1.3.0]
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TESTED_PI_VERSIONS } from "../dist/compat.js";

const npm = process.env.npm_execpath;
if (!npm) throw new Error("Exécuter via npm run test:pi-versions.");
const versions = process.argv.slice(2).length ? process.argv.slice(2) : TESTED_PI_VERSIONS;
for (const v of versions)
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`Version invalide : ${v}`);

const work = resolve(".test-tmp", "pi-versions");
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
for (const entry of ["src", "tests", "package.json", "package-lock.json", "tsconfig.json"])
  await cp(entry, join(work, entry), { recursive: true });
const env = { ...process.env, npm_config_cache: resolve(".npm-cache"), npm_config_fund: "false" };
const run = (args) =>
  spawnSync(process.execPath, [npm, ...args], { cwd: work, env, stdio: "inherit" }).status === 0;

if (!run(["ci", "--audit=false"])) throw new Error("npm ci a échoué.");
const results = [];
for (const v of versions) {
  console.log(`\n=== Pi ${v} ===`);
  // Pi packages are released in lockstep: pin every sibling to the release under test, as the
  // lockfile otherwise keeps the newest ones next to an older pi-coding-agent.
  const view = spawnSync(
    process.execPath,
    [npm, "view", `@earendil-works/pi-coding-agent@${v}`, "dependencies", "--json"],
    { cwd: work, env, encoding: "utf8" },
  );
  if (view.status !== 0) throw new Error(`Pi ${v} introuvable dans le registre.`);
  const pinned = { "@earendil-works/pi-coding-agent": v };
  for (const [name, range] of Object.entries(JSON.parse(view.stdout)))
    if (name.startsWith("@earendil-works/")) pinned[name] = range.replace(/^[\^~]/, "");
  const specs = Object.entries(pinned).map(([name, version]) => `${name}@${version}`);
  const installed = run(["install", "--no-save", "--audit=false", ...specs]);
  let matches = true;
  for (const [name, version] of Object.entries(pinned)) {
    const path = join(work, "node_modules", name, "package.json");
    const actual = JSON.parse(await readFile(path, "utf8")).version;
    if (actual !== version) {
      console.error(`${name} : ${actual} installé au lieu de ${version}`);
      matches = false;
    }
  }
  results.push({ version: v, ok: installed && matches && run(["test"]) });
}
console.log("\nVersion Pi  Résultat");
for (const r of results) console.log(`${r.version.padEnd(11)} ${r.ok ? "OK" : "ÉCHEC"}`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
