import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { toCredential } from "../dist/oidc/tokens.js";
import { createGatewayProvider } from "../dist/provider.js";
import { context, rawContext, tempDir, tokens } from "./helpers.mjs";

const exec = promisify(execFile);
test("T17 tarball autonome : installation locale et chargement par le CLI Pi sans registre", {
  timeout: 60000,
}, async (t) => {
  const dir = await tempDir(t);
  const npm =
    process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  const pack = await exec(
    process.execPath,
    [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", dir],
    { cwd: resolve("."), timeout: 20000 },
  );
  const info = JSON.parse(pack.stdout)[0];
  assert.ok(info.files.some((f) => f.path === "dist/index.js"));
  assert.ok(
    info.files.every(
      (f) =>
        !f.path.includes("node_modules") &&
        !f.path.includes("auth.json") &&
        !f.path.includes(".npm-cache"),
    ),
  );
  const unpack = join(dir, "offline");
  await mkdir(unpack);
  // Relative paths: GNU tar reads "G:\..." as a remote host, bsdtar does not.
  await exec("tar", ["-xzf", info.filename, "-C", "offline"], { cwd: dir });
  const pkg = join(unpack, "package");
  await assert.rejects(access(join(pkg, "node_modules")));
  const noNetwork = join(dir, "no-network.mjs");
  await writeFile(
    noNetwork,
    `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';
const block=()=>{ throw new Error('NETWORK_FORBIDDEN_IN_OFFLINE_TEST'); };
globalThis.fetch=block; http.request=block; https.request=block; net.connect=block; net.createConnection=block; tls.connect=block;
`,
  );
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_KEYCLOAK_CONFIG_JSON: JSON.stringify({
      contexts: [rawContext(), rawContext({ name: "second" })],
    }),
    npm_config_registry: "http://127.0.0.1:1",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    NO_PROXY: "*",
  };
  await exec(process.execPath, ["--import", pathToFileURL(noNetwork).href, cli, "install", pkg], {
    env,
    cwd: dir,
    timeout: 20000,
  });
  const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.ok(
    settings.packages.some((p) =>
      (typeof p === "string" ? p : p.source).replaceAll("\\", "/").endsWith("offline/package"),
    ),
  );
  // --list-models shows authenticated models only. Seed synthetic credentials via Pi's public API.
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  for (const c of [context(), context({ name: "second" })]) {
    const provider = createGatewayProvider(c);
    runtime.registerNativeProvider({
      ...provider,
      auth: {
        oauth: { ...provider.auth.oauth, login: async () => toCredential(c, tokens(), Date.now()) },
      },
    });
    await runtime.login(c.providerId, "oauth", { prompt: async () => "", notify: () => {} });
  }
  const result = await exec(
    process.execPath,
    ["--import", pathToFileURL(noNetwork).href, cli, "--list-models", "agentgateway"],
    { env, cwd: dir, timeout: 20000 },
  );
  assert.match(result.stdout, /agentgateway-test/, result.stderr);
  assert.match(result.stdout, /agentgateway-second/);
  assert.match(result.stdout, /synthetic-model/);
  assert.ok(!result.stderr.includes("Failed to load"), result.stderr);
});
