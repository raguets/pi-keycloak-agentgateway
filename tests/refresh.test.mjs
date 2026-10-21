import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { toCredential } from "../dist/oidc/tokens.js";
import { createGatewayProvider } from "../dist/provider.js";
import {
  browserUi,
  callbackUrl,
  causeMessages,
  context,
  form,
  freePort,
  json,
  mapFetch,
  metadata,
  server,
  tempDir,
  tokens,
} from "./helpers.mjs";

async function seeded(c, fetch, patch = {}) {
  const store = new InMemoryCredentialStore();
  const credential = {
    ...toCredential(c, tokens(), Date.now()),
    expires: Date.now() + 1000,
    ...patch,
  };
  await store.modify(c.providerId, async () => credential);
  const models = createModels({ credentials: store });
  models.setProvider(createGatewayProvider(c, { runtime: { fetch } }));
  return { store, models, credential };
}
test("T08/T09 refresh natif sous verrou Pi, rotation et deux requêtes simultanées", async (t) => {
  const c = context();
  let refreshes = 0;
  const mock = await server(t, async (req, res) => {
    if (req.url.endsWith("openid-configuration")) return json(res, metadata(c));
    const params = await form(req);
    refreshes++;
    assert.equal(params.get("refresh_token"), "SYNTHETIC.REFRESH");
    await new Promise((done) => setTimeout(done, 25));
    json(res, tokens({ access_token: "NEW.ACCESS", refresh_token: "ROTATED.REFRESH" }));
  });
  const { models, store } = await seeded(c, mapFetch({ "https://issuer.example": mock.origin }));
  const [a, b] = await Promise.all([models.getAuth(c.providerId), models.getAuth(c.providerId)]);
  assert.equal(refreshes, 1);
  assert.equal(a.auth.apiKey, "NEW.ACCESS");
  assert.deepEqual(a, b);
  assert.equal((await store.read(c.providerId)).refresh, "ROTATED.REFRESH");
  assert.equal((await models.getAuth(c.providerId)).auth.apiKey, "NEW.ACCESS");
  assert.equal(refreshes, 1);
});
test("T03/T10 stockage réel via ModelRuntime, nuit simulée puis redémarrage sans login", async (t) => {
  const dir = await tempDir(t);
  const c = context({ callbackPort: await freePort(t) });
  let refreshes = 0;
  const mock = await server(t, async (req, res) => {
    if (req.url.endsWith("openid-configuration")) return json(res, metadata(c));
    const params = await form(req);
    if (params.get("grant_type") === "refresh_token") {
      refreshes++;
      return json(
        res,
        tokens({ access_token: "MORNING.ACCESS", refresh_token: "MORNING.REFRESH" }),
      );
    }
    json(res, tokens());
  });
  const fetch = mapFetch({ "https://issuer.example": mock.origin });
  const options = {
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  };
  const evening = await ModelRuntime.create(options);
  evening.registerNativeProvider(
    createGatewayProvider(c, { runtime: { fetch, now: () => Date.now() - 86400000 } }),
  );
  const ui = browserUi((url) => globalThis.fetch(callbackUrl(url)));
  await evening.login(c.providerId, "oauth", ui);
  await Promise.all(ui.jobs);
  const persisted = JSON.parse(await readFile(options.authPath, "utf8"));
  assert.equal(persisted[c.providerId].type, "oauth");
  assert.equal(persisted[c.providerId].refresh, "SYNTHETIC.REFRESH");
  const morning = await ModelRuntime.create(options);
  morning.registerNativeProvider(createGatewayProvider(c, { runtime: { fetch } }));
  const auth = await morning.getAuth(c.providerId);
  assert.equal(auth.auth.apiKey, "MORNING.ACCESS");
  assert.equal(refreshes, 1);
  const next = JSON.parse(await readFile(options.authPath, "utf8"));
  assert.equal(next[c.providerId].refresh, "MORNING.REFRESH");
  await morning.logout(c.providerId);
  assert.equal(
    (await morning.listCredentials()).some((x) => x.providerId === c.providerId),
    false,
  );
});
test("T11 invalid_grant explicite, aucune boucle ni perte du credential", async () => {
  const c = context();
  let calls = 0;
  const { models, store, credential } = await seeded(c, async (url) => {
    if (url.endsWith("openid-configuration")) return Response.json(metadata(c));
    calls++;
    return Response.json(
      { error: "invalid_grant", error_description: "SECRET-REFRESH" },
      { status: 400 },
    );
  });
  await assert.rejects(
    models.getAuth(c.providerId),
    (e) => /invalid_grant.*\/login/.test(e.message) && !causeMessages(e).includes("SECRET"),
  );
  assert.equal(calls, 1);
  assert.deepEqual(await store.read(c.providerId), credential);
});
test("T12 changement de contexte ou de destination interdit avant refresh et Bearer", async () => {
  const c = context();
  const credential = toCredential(c, tokens(), Date.now());
  for (const patch of [
    { baseUrl: "https://other.example/v1" },
    { issuer: "https://other.example/realm" },
    { clientId: "other" },
    { name: "other" },
  ]) {
    let calls = 0;
    const p = createGatewayProvider(context(patch), {
      runtime: {
        fetch: async () => {
          calls++;
          assert.fail();
        },
      },
    });
    await assert.rejects(p.auth.oauth.toAuth(credential), /Configuration du contexte/);
    await assert.rejects(
      p.auth.oauth.refresh(credential, new AbortController().signal),
      /Configuration du contexte/,
    );
    assert.equal(calls, 0);
  }
});
test("F05 annulation d'un appel ne perd pas un refresh déjà tournant dans Pi", async (t) => {
  const c = context();
  let release;
  let started;
  const begun = new Promise((done) => {
    started = done;
  });
  const gate = new Promise((done) => {
    release = done;
  });
  let exchanges = 0;
  const { models, store } = await seeded(c, async (url) => {
    if (url.endsWith("openid-configuration")) return Response.json(metadata(c));
    exchanges++;
    started();
    await gate;
    return Response.json(
      tokens({ access_token: "ROTATION.ACCESS", refresh_token: "ROTATION.SURVIVES" }),
    );
  });
  const controller = new AbortController();
  const request = models.getAuth(c.providerId, { signal: controller.signal });
  await begun;
  controller.abort();
  release();
  await assert.rejects(request);
  t.after(release);
  // Pi >= 1.0.3 persists the finished rotation; older Pi drops it and the extension reuses it.
  await new Promise((done) => setTimeout(done, 20));
  assert.equal((await models.getAuth(c.providerId)).auth.apiKey, "ROTATION.ACCESS");
  assert.equal((await store.read(c.providerId)).refresh, "ROTATION.SURVIVES");
  assert.equal(exchanges, 1);
});

test("F05 rotation obtenue réutilisée, jamais de rejeu d'un refresh token révoqué", async () => {
  const c = context();
  const sent = [];
  let expiresIn = 3600;
  let gate = Promise.resolve();
  const provider = createGatewayProvider(c, {
    runtime: {
      fetch: async (url, init) => {
        if (url.endsWith("openid-configuration")) return Response.json(metadata(c));
        const refresh = new URLSearchParams(init.body.toString()).get("refresh_token");
        sent.push(refresh);
        await gate;
        return Response.json(
          tokens({
            access_token: `ACCESS.${sent.length}`,
            refresh_token: `ROTATED.${sent.length}`,
            expires_in: expiresIn,
          }),
        );
      },
    },
  });
  const original = { ...toCredential(c, tokens(), Date.now()), expires: Date.now() + 1000 };
  // Old Pi aborts the refresh signal when the caller cancels: the started exchange must finish.
  const controller = new AbortController();
  let release;
  gate = new Promise((done) => {
    release = done;
  });
  const pending = provider.auth.oauth.refresh(original, controller.signal);
  while (!sent.length) await new Promise((done) => setTimeout(done, 5));
  controller.abort();
  release();
  const first = await pending;
  assert.equal(first.refresh, "ROTATED.1");
  // Pi did not persist it: the next refresh still carries the original token.
  const again = await provider.auth.oauth.refresh(original, new AbortController().signal);
  assert.deepEqual(again, first);
  assert.deepEqual(sent, ["SYNTHETIC.REFRESH"]);
  // A reused rotation close to expiry is refreshed with the rotated token, not the revoked one.
  const shortLived = createGatewayProvider(c, {
    runtime: {
      fetch: async (url, init) => {
        if (url.endsWith("openid-configuration")) return Response.json(metadata(c));
        sent.push(new URLSearchParams(init.body.toString()).get("refresh_token"));
        return Response.json(
          tokens({ refresh_token: `SHORT.${sent.length}`, expires_in: expiresIn }),
        );
      },
    },
  });
  sent.length = 0;
  expiresIn = 30;
  const short = await shortLived.auth.oauth.refresh(original, new AbortController().signal);
  assert.equal(short.refresh, "SHORT.1");
  const next = await shortLived.auth.oauth.refresh(original, new AbortController().signal);
  assert.deepEqual(sent, ["SYNTHETIC.REFRESH", "SHORT.1"]);
  assert.equal(next.refresh, "SHORT.2");
});

test("T09 deux processus Pi partagent le verrou et ne tournent le refresh qu'une fois", {
  timeout: 20000,
}, async (t) => {
  const dir = await tempDir(t);
  const authPath = join(dir, "auth.json");
  const c = context();
  let exchanges = 0;
  const mock = await server(t, async (req, res) => {
    if (req.url.endsWith("openid-configuration")) return json(res, metadata(c));
    const body = await form(req);
    assert.equal(body.get("refresh_token"), "SYNTHETIC.REFRESH");
    exchanges++;
    await new Promise((done) => setTimeout(done, 100));
    json(res, tokens({ access_token: "PROCESS.ACCESS", refresh_token: "PROCESS.REFRESH" }));
  });
  const seed = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  const provider = createGatewayProvider(c);
  seed.registerNativeProvider({
    ...provider,
    auth: {
      oauth: {
        ...provider.auth.oauth,
        login: async () => ({ ...toCredential(c, tokens(), Date.now()), expires: 0 }),
      },
    },
  });
  await seed.login(c.providerId, "oauth", { prompt: async () => "", notify: () => {} });
  const children = [0, 1].map(() =>
    fork(
      new URL("./fixtures/refresh-worker.mjs", import.meta.url),
      [authPath, JSON.stringify(c), mock.origin],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    ),
  );
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill();
  });
  const ready = children.map(
    (child) =>
      new Promise((done, reject) => {
        child.once("message", (message) =>
          message.ready ? done() : reject(new Error("Worker not ready")),
        );
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code !== 0) reject(new Error("Worker exited before ready"));
        });
      }),
  );
  await Promise.all(ready);
  const results = children.map(
    (child) =>
      new Promise((done, reject) => {
        child.once("message", (message) => {
          if (!message.ok) reject(new Error("Refresh failed in worker"));
        });
        child.once("exit", (code) => (code === 0 ? done() : reject(new Error("Worker failed"))));
      }),
  );
  for (const child of children) child.send("go");
  await Promise.all(results);
  assert.equal(exchanges, 1);
  assert.equal(
    JSON.parse(await readFile(authPath, "utf8"))[c.providerId].refresh,
    "PROCESS.REFRESH",
  );
});
