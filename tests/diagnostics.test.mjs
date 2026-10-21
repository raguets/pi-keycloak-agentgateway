import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../dist/config.js";
import { diagnose } from "../dist/diagnostics.js";
import { context, json, mapFetch, metadata, rawContext, server } from "./helpers.mjs";

test("F08 doctor : découverte, modèles, statut sans refresh/token et HEAD anonyme", async (t) => {
  const c = context();
  const requests = [];
  const mock = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    requests.push({ method: req.method, path: req.url });
    if (req.url.endsWith("openid-configuration")) return json(res, metadata(c));
    res.writeHead(401).end();
  });
  const report = await diagnose(parseConfig({ contexts: [rawContext()] }), () => true, {
    fetch: mapFetch({
      "https://issuer.example": mock.origin,
      "https://gateway.example": mock.origin,
    }),
  });
  assert.equal(report[0].oidc, "valide");
  assert.match(report[0].authentication, /validité non vérifiée/);
  assert.ok(Math.abs(report[0].clockSkewSeconds) < 5);
  assert.match(report[0].gateway, /HTTP 401/);
  assert.equal(report[0].models[0].id, "synthetic-model");
  assert.deepEqual(
    requests.map((r) => r.method),
    ["GET", "HEAD"],
  );
});
test("F08 diagnostic conserve les erreurs réseau sans corps sensibles", async () => {
  const result = await diagnose(parseConfig({ contexts: [rawContext()] }), undefined, {
    fetch: async () => {
      throw new Error("SECRET");
    },
  });
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.equal(result[0].authentication, "non vérifié");
});
