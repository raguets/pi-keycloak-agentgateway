import assert from "node:assert/strict";
import test from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { checkPiVersion, TESTED_PI_VERSIONS } from "../dist/compat.js";
import extension from "../dist/index.js";
import { rawContext } from "./helpers.mjs";

test("COMPAT toute version Pi 1.x acceptée, autres majeures refusées", () => {
  for (const v of TESTED_PI_VERSIONS) assert.equal(checkPiVersion(v).supported, true, v);
  for (const v of ["1.0.3", "1.0.4", "1.1.0", "1.2.0", "1.3.0"])
    assert.equal(checkPiVersion(v).message, undefined, v);
  for (const v of ["1.0.0", "1.0.1", "1.0.2", "1.0.0-beta.1"])
    assert.match(checkPiVersion(v).message, /1\.0\.3/, v);
  assert.equal(checkPiVersion("1.9.0").supported, true);
  assert.match(checkPiVersion("1.9.0").message, /plus récent/);
  for (const v of ["0.99.2", "2.0.0", "0.0.0", "", "latest"]) {
    const result = checkPiVersion(v);
    assert.equal(result.supported, false, v);
    assert.match(result.message, /Pi 1\.x/);
  }
});

test("COMPAT l'extension se charge sur la version Pi installée", async () => {
  const previous = process.env.PI_KEYCLOAK_CONFIG_JSON;
  process.env.PI_KEYCLOAK_CONFIG_JSON = JSON.stringify({
    contexts: [rawContext(), rawContext({ name: "second" })],
  });
  const providers = [];
  const notices = [];
  let callback;
  try {
    await extension({
      registerProvider: (provider) => providers.push(provider.id),
      on: (_event, cb) => {
        callback = cb;
      },
      registerCommand: () => {},
    });
    await callback({}, { ui: { notify: (text, type) => notices.push({ text, type }) } });
  } finally {
    if (previous === undefined) delete process.env.PI_KEYCLOAK_CONFIG_JSON;
    else process.env.PI_KEYCLOAK_CONFIG_JSON = previous;
  }
  assert.deepEqual(providers, ["agentgateway-test", "agentgateway-second"]);
  const expected = checkPiVersion(VERSION).message;
  assert.deepEqual(notices, expected ? [{ text: expected, type: "warning" }] : []);
});
