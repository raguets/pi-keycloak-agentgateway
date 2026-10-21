import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { configPath, contextFingerprint, loadConfig, parseConfig } from "../dist/config.js";
import extension from "../dist/index.js";
import { context, rawContext, tempDir } from "./helpers.mjs";

test("T01 configuration multi-contextes, IDs uniques et scopes dédupliqués", () => {
  const c = parseConfig({
    contexts: [rawContext({ scopes: ["openid", "openid"] }), rawContext({ name: "second" })],
  });
  assert.deepEqual(
    c.contexts.map((x) => x.providerId),
    ["agentgateway-test", "agentgateway-second"],
  );
  assert.deepEqual(c.contexts[0].scopes, ["openid"]);
  assert.throws(() => parseConfig({ contexts: [rawContext(), rawContext()] }), /uniques/);
});
test("T02 validation stricte sans valeurs sensibles dans les erreurs", () => {
  assert.throws(() => parseConfig({ logLevel: ["debug"], contexts: [rawContext()] }));
  assert.throws(() => parseConfig({ $schema: { secret: "SECRET" }, contexts: [rawContext()] }));
  for (const patch of [
    { issuer: undefined },
    { clientId: "" },
    { clientSecret: "SECRET" },
    { baseUrl: "http://gateway.example" },
    { issuer: "https://user:SECRET@issuer.example" },
    { baseUrl: "https://gateway.example/?token=SECRET" },
    { callbackHost: "0.0.0.0" },
    { callbackPort: 0 },
    { callbackPort: 65536 },
    { callbackPort: "123abc" },
    { name: "../../SECRET" },
    { redirectPath: "//evil" },
    { redirectPath: "/a/../callback" },
    { api: "guess" },
    { browserTimeoutSeconds: 0 },
    { scopes: ["scope with spaces"] },
    { scopes: "openid" },
    { enableDevice: "yes" },
    { models: [] },
    { models: [{ ...rawContext().models[0], maxTokens: 17000 }] },
    { models: [{ ...rawContext().models[0], id: "ID_A_RENSEIGNER" }] },
  ])
    assert.throws(
      () => parseConfig({ contexts: [rawContext(patch)] }),
      (e) => !e.message.includes("SECRET"),
    );
});
test("F01 JSON env prioritaire, chemin personnalisé et JSON invalide masqué", async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({ contexts: [rawContext()] }));
  assert.equal((await loadConfig({ PI_KEYCLOAK_CONFIG: path })).contexts.length, 1);
  assert.equal(configPath({ PI_CODING_AGENT_DIR: dir }), join(dir, "keycloak-agentgateway.json"));
  assert.equal(
    (
      await loadConfig({
        PI_KEYCLOAK_CONFIG: "absent",
        PI_KEYCLOAK_CONFIG_JSON: JSON.stringify({ contexts: [rawContext()] }),
      })
    ).contexts.length,
    1,
  );
  await assert.rejects(
    loadConfig({ PI_KEYCLOAK_CONFIG_JSON: "SECRET invalid" }),
    (e) => !e.message.includes("SECRET"),
  );
});
test("T02 erreur de configuration désactive l'extension sans interrompre Pi", async () => {
  const previous = process.env.PI_KEYCLOAK_CONFIG_JSON;
  process.env.PI_KEYCLOAK_CONFIG_JSON = JSON.stringify({
    contexts: [rawContext({ issuer: undefined })],
  });
  const notices = [];
  let callback;
  try {
    await extension({
      registerProvider: () => assert.fail(),
      on: (_event, cb) => {
        callback = cb;
      },
      registerCommand: () => {},
    });
    await callback({}, { ui: { notify: (text) => notices.push(text) } });
    assert.match(notices[0], /issuer/);
  } finally {
    if (previous === undefined) delete process.env.PI_KEYCLOAK_CONFIG_JSON;
    else process.env.PI_KEYCLOAK_CONFIG_JSON = previous;
  }
});
test("F06 empreinte liée à gateway, issuer, clientId, providerId, API et scopes", () => {
  const c = context();
  for (const patch of [
    { baseUrl: "https://other.example/v1" },
    { issuer: "https://other.example/realm" },
    { clientId: "other" },
    { providerId: "agentgateway-other" },
    { api: "openai-responses" },
    { scopes: ["openid"] },
  ])
    assert.notEqual(contextFingerprint(c), contextFingerprint(context(patch)));
});
