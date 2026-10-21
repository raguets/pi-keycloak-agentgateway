import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseCallback } from "../dist/oidc/browser.js";
import { discover } from "../dist/oidc/discovery.js";
import { createPkce } from "../dist/oidc/pkce.js";
import { toCredential } from "../dist/oidc/tokens.js";
import { createGatewayProvider, runtimeDefaults } from "../dist/provider.js";
import {
  browserUi,
  callbackUrl,
  context,
  form,
  freePort,
  json,
  mapFetch,
  metadata,
  portAvailable,
  server,
  tokens,
} from "./helpers.mjs";

test("PKCE S256 aléatoire, 43 caractères base64url, state indépendant", () => {
  const p = createPkce();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(p.challenge, createHash("sha256").update(p.verifier).digest("base64url"));
  assert.notEqual(p.state, p.verifier);
  assert.notEqual(p.state, createPkce().state);
});
test("T03 navigateur PKCE avec mock Keycloak, redirect_uri identique et fermeture", async (t) => {
  const c = context({ callbackPort: await freePort(t) });
  let authorization;
  let exchange;
  const mock = await server(t, async (req, res) => {
    if (req.url.endsWith("openid-configuration")) json(res, metadata(c));
    else {
      exchange = await form(req);
      json(res, tokens());
    }
  });
  const p = createGatewayProvider(c, {
    runtime: { fetch: mapFetch({ "https://issuer.example": mock.origin }) },
  });
  const ui = browserUi(async (url) => {
    authorization = url;
    await fetch(callbackUrl(url));
  });
  const result = await p.auth.oauth.login(ui);
  await Promise.all(ui.jobs);
  assert.equal(result.type, "oauth");
  assert.equal(result.access, "SYNTHETIC.ACCESS");
  assert.equal(exchange.get("redirect_uri"), authorization.searchParams.get("redirect_uri"));
  assert.equal(
    createHash("sha256").update(exchange.get("code_verifier")).digest("base64url"),
    authorization.searchParams.get("code_challenge"),
  );
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(exchange.get("client_secret"), null);
  assert.ok(result.expires > Date.now() + 3_000_000);
  await portAvailable(c.callbackPort);
});
test("T04 callback state invalide et erreur OAuth sont rejetés avant échange", async (t) => {
  const c = context({ callbackPort: await freePort(t) });
  let exchanges = 0;
  const mock = await server(t, (req, res) => {
    if (!req.url.endsWith("openid-configuration")) exchanges++;
    json(res, metadata(c));
  });
  const p = createGatewayProvider(c, {
    runtime: { fetch: mapFetch({ "https://issuer.example": mock.origin }) },
  });
  const ui = browserUi((url) =>
    fetch(
      callbackUrl(url, { state: "wrong", error: "access_denied", error_description: "SECRET" }),
    ),
  );
  await assert.rejects(p.auth.oauth.login(ui), /État OAuth/);
  await Promise.all(ui.jobs);
  assert.equal(exchanges, 0);
  await portAvailable(c.callbackPort);
});
test("T05 annulation et timeout ferment le listener sans credential", async (t) => {
  for (const cancel of [true, false]) {
    const c = context({ callbackPort: await freePort(t), browserTimeoutSeconds: 1 });
    const controller = new AbortController();
    const mock = await server(t, (_req, res) => json(res, metadata(c)));
    const p = createGatewayProvider(c, {
      runtime: { fetch: mapFetch({ "https://issuer.example": mock.origin }) },
    });
    const ui = browserUi(() => {
      if (cancel) controller.abort();
    }, controller.signal);
    await assert.rejects(p.auth.oauth.login(ui), /annulée|Délai dépassé/);
    await new Promise((done) => setTimeout(done, 20));
    await portAvailable(c.callbackPort);
  }
});
test("T06 port occupé et repli manuel activé explicitement", async (t) => {
  const occupied = await server(t, (_req, res) => res.end());
  const c = context({ callbackPort: occupied.port });
  const mock = await server(t, (req, res) =>
    json(res, req.url.endsWith("openid-configuration") ? metadata(c) : tokens()),
  );
  const deps = { runtime: { fetch: mapFetch({ "https://issuer.example": mock.origin }) } };
  await assert.rejects(
    createGatewayProvider(c, deps).auth.oauth.login(browserUi(() => assert.fail())),
    /port occupé/,
  );
  const manual = createGatewayProvider(
    context({ callbackPort: occupied.port, enableManual: true }),
    deps,
  );
  let auth;
  let selections = 0;
  const credential = await manual.auth.oauth.login({
    signal: new AbortController().signal,
    notify: (event) => {
      if (event.type === "auth_url") auth = new URL(event.url);
    },
    prompt: async (prompt) =>
      prompt.type === "select" ? (++selections === 1 ? "browser" : "manual") : callbackUrl(auth),
  });
  assert.equal(selections, 2);
  assert.equal(credential.access, "SYNTHETIC.ACCESS");
});
test("F03 manuel exige l'URL entière, state, chemin et issuer ; erreurs sans description serveur", () => {
  const c = context();
  const base = `http://127.0.0.1:${c.callbackPort}/callback`;
  for (const url of [
    "bare-code",
    `${base}?code=x`,
    `${base}?state=s&state=s&code=x`,
    `${base}?state=s&code=x&iss=https://other.example`,
    `http://localhost:${c.callbackPort}/callback?state=s&code=x`,
  ])
    assert.throws(() => parseCallback(url, c, "s"));
  assert.throws(
    () => parseCallback(`${base}?state=s&error=invalid_request&error_description=SECRET`, c, "s"),
    (e) => /redirect URI/.test(e.message) && !e.message.includes("SECRET"),
  );
});
test("T18 découverte rejette issuer, origine et PKCE incohérents", async () => {
  const c = context();
  for (const change of [
    { issuer: "https://other.example" },
    { token_endpoint: "https://other.example/token" },
    { token_endpoint: "http://issuer.example/token" },
    { code_challenge_methods_supported: ["plain"] },
  ]) {
    await assert.rejects(
      discover(c, runtimeDefaults({ fetch: async () => Response.json(metadata(c, change)) })),
    );
  }
});
test("T15 indisponibilité, corps excessif, redirection, réponse non JSON et délai sont bornés", async (t) => {
  const c = context({ requestTimeoutSeconds: 1 });
  for (const fetch of [
    async () => {
      throw new Error("SECRET");
    },
    async () => new Response("SECRET"),
    async () => new Response("x".repeat(70000)),
    async () => new Response(null, { status: 302 }),
  ])
    await assert.rejects(
      discover(c, runtimeDefaults({ fetch })),
      (e) => !e.message.includes("SECRET"),
    );
  const hanging = await server(t, () => {});
  const start = Date.now();
  await assert.rejects(
    discover(c, runtimeDefaults({ fetch: mapFetch({ "https://issuer.example": hanging.origin }) })),
    /Délai/,
  );
  assert.ok(Date.now() - start < 3000);
});
test("T19 réponse sans refresh token : login refusé ; réutilisation uniquement sur opt-in", () => {
  const c = context();
  const old = toCredential(c, tokens(), Date.now());
  assert.throws(
    () => toCredential(c, tokens({ refresh_token: undefined }), Date.now()),
    /Refresh token absent/,
  );
  assert.throws(
    () => toCredential(c, tokens({ refresh_token: undefined }), Date.now(), old),
    /Refresh token absent/,
  );
  const reuse = context({ reuseRefreshTokenWhenOmitted: true });
  assert.equal(
    toCredential(reuse, tokens({ refresh_token: undefined }), Date.now(), old).refresh,
    old.refresh,
  );
  for (const patch of [
    { expires_in: -1 },
    { expires_in: "60" },
    { token_type: "Basic" },
    { access_token: "x\r\nSECRET" },
  ])
    assert.throws(() => toCredential(c, tokens(patch), Date.now()));
});
