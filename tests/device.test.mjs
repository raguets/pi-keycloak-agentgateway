import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createLogger } from "../dist/logging.js";
import { createGatewayProvider } from "../dist/provider.js";
import { context, form, json, mapFetch, metadata, server, tokens } from "./helpers.mjs";

test("T07 Device Code PKCE : pending, slow_down (+5s), succès, horloge simulée", async (t) => {
  const c = context({ enableDevice: true });
  let now = Date.now();
  const sleeps = [];
  let challenge;
  let polls = 0;
  const mock = await server(t, async (req, res) => {
    if (req.url.endsWith("openid-configuration")) return json(res, metadata(c));
    const params = await form(req);
    if (req.url.endsWith("/device")) {
      challenge = params.get("code_challenge");
      assert.equal(params.get("code_challenge_method"), "S256");
      return json(res, {
        device_code: "SYNTHETIC-DEVICE",
        user_code: "ABCD-1234",
        verification_uri: `${c.issuer}/verify`,
        expires_in: 100,
        interval: 2,
      });
    }
    assert.equal(
      createHash("sha256").update(params.get("code_verifier")).digest("base64url"),
      challenge,
    );
    assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
    polls++;
    return json(
      res,
      polls === 1
        ? { error: "authorization_pending" }
        : polls === 2
          ? { error: "slow_down" }
          : tokens(),
      polls < 3 ? 400 : 200,
    );
  });
  const events = [];
  const provider = createGatewayProvider(c, {
    runtime: {
      fetch: mapFetch({ "https://issuer.example": mock.origin }),
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    },
  });
  const result = await provider.auth.oauth.login({
    signal: new AbortController().signal,
    prompt: async () => "device",
    notify: (e) => events.push(e),
  });
  assert.equal(result.access, "SYNTHETIC.ACCESS");
  assert.deepEqual(sleeps, [2000, 2000, 7000]);
  assert.equal(events.find((e) => e.type === "device_code").expiresInSeconds, 100);
  assert.equal(events.find((e) => e.type === "device_code").userCode, "ABCD-1234");
});
test("T07 Device timeout, refus, expiration et annulation sans polling infini", async () => {
  for (const outcome of ["timeout", "access_denied", "expired_token", "cancel"]) {
    const c = context({ enableDevice: true });
    let now = Date.now();
    let polls = 0;
    const controller = new AbortController();
    const p = createGatewayProvider(c, {
      runtime: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          if (outcome === "cancel") controller.abort();
        },
        fetch: async (url) => {
          if (url.endsWith("openid-configuration")) return Response.json(metadata(c));
          if (url.endsWith("/device"))
            return Response.json({
              device_code: "dev",
              user_code: "ABCD",
              verification_uri: `${c.issuer}/verify`,
              expires_in: 10,
              interval: 5,
            });
          polls++;
          return Response.json(
            { error: outcome === "timeout" ? "authorization_pending" : outcome },
            { status: 400 },
          );
        },
      },
    });
    await assert.rejects(
      p.auth.oauth.login({
        signal: controller.signal,
        prompt: async () => "device",
        notify: () => {},
      }),
      /expiré|refusée|annulée/,
    );
    assert.ok(polls <= 1);
  }
});
test("F04 Device non proposé sans opt-in ou endpoint, URL de vérification inter-origine refusée", async () => {
  for (const patch of [
    { enableDevice: false },
    { enableDevice: true, absent: true },
    { enableDevice: true },
  ]) {
    const { absent, ...config } = patch;
    const c = context(config);
    const controller = new AbortController();
    const p = createGatewayProvider(c, {
      runtime: {
        fetch: async (url) =>
          Response.json(
            url.endsWith("openid-configuration")
              ? metadata(c, absent ? { device_authorization_endpoint: undefined } : {})
              : {
                  device_code: "dev",
                  user_code: "ABCD",
                  verification_uri: "https://attacker.example/verify",
                  expires_in: 100,
                },
          ),
      },
    });
    const ui = {
      signal: controller.signal,
      prompt: async (prompt) => {
        assert.equal(
          prompt.options.some((x) => x.id === "device"),
          c.enableDevice && !absent,
        );
        return "device";
      },
      notify: (event) => {
        if (event.type === "auth_url") controller.abort();
      },
    };
    await assert.rejects(p.auth.oauth.login(ui));
  }
});
test("T16/T20 logs debug sans secrets, offline_access non accordé reste utilisable", async () => {
  const c = context({ enableDevice: true });
  let now = Date.now();
  const logs = [];
  const events = [];
  const p = createGatewayProvider(c, {
    log: createLogger("debug", (line) => logs.push(line)),
    runtime: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      fetch: async (url) =>
        Response.json(
          url.endsWith("openid-configuration")
            ? metadata(c)
            : url.endsWith("/device")
              ? {
                  device_code: "SECRET-DEVICE",
                  user_code: "SECRET-USER-CODE",
                  verification_uri: `${c.issuer}/verify`,
                  expires_in: 100,
                }
              : tokens({
                  access_token: "SECRET-ACCESS",
                  refresh_token: "SECRET-REFRESH",
                  scope: "openid",
                }),
        ),
    },
  });
  const result = await p.auth.oauth.login({
    signal: new AbortController().signal,
    prompt: async () => "device",
    notify: (e) => events.push(e),
  });
  assert.equal(result.refresh, "SECRET-REFRESH");
  assert.ok(logs.some((line) => line.includes("offline_unconfirmed")));
  assert.ok(!logs.join(" ").includes("SECRET"));
  assert.ok(events.some((e) => e.message?.includes("ne garantit pas")));
});
