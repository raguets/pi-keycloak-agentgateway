import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

await mkdir("artifacts", { recursive: true });
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Exécuter via npm run bundle:offline.");
const result = spawnSync(process.execPath, [npm, "pack", "--pack-destination", "artifacts"], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (result.status === 0) {
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  const filename = `pi-keycloak-agentgateway-${version}.tgz`;
  const digest = createHash("sha256")
    .update(await readFile(join("artifacts", filename)))
    .digest("hex");
  await writeFile(join("artifacts", `${filename}.sha256`), `${digest}  ${filename}\n`);
}
