import assert from "node:assert/strict";
import test from "node:test";
import { createModels, InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import { gatewayFetch } from "../dist/gateway.js";
import { toCredential } from "../dist/oidc/tokens.js";
import { createGatewayProvider } from "../dist/provider.js";
import { context, form, json, mapFetch, metadata, rawContext, server, tokens } from "./helpers.mjs";

const prompt = {
  systemPrompt: "Répondez en français.",
  messages: [{ role: "user", content: "Bonjour", timestamp: 1 }],
  tools: [
    { name: "lookup", description: "Test", parameters: Type.Object({ query: Type.String() }) },
  ],
};
function completions(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null, usage) =>
    res.write(
      `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "synthetic-model", choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`,
    );
  chunk({ role: "assistant", content: "Bonjour 🌊" });
  chunk({
    tool_calls: [
      {
        index: 0,
        id: "call_test",
        type: "function",
        function: { name: "lookup", arguments: '{"query":' },
      },
    ],
  });
  chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] });
  chunk({}, "tool_calls", { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
  res.end("data: [DONE]\n\n");
}
function responses(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (type, values) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...values })}\n\n`);
  const message = { type: "message", id: "msg_1", role: "assistant", content: [] };
  send("response.created", { response: { id: "resp_1", status: "in_progress" } });
  send("response.output_item.added", { output_index: 0, item: message });
  send("response.output_text.delta", { output_index: 0, content_index: 0, delta: "Bonjour 🌊" });
  send("response.output_item.done", {
    output_index: 0,
    item: { ...message, content: [{ type: "output_text", text: "Bonjour 🌊" }] },
  });
  const call = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_test",
    name: "lookup",
    arguments: "",
  };
  send("response.output_item.added", { output_index: 1, item: call });
  send("response.function_call_arguments.delta", { output_index: 1, delta: '{"query":"Paris"}' });
  send("response.output_item.done", {
    output_index: 1,
    item: { ...call, arguments: '{"query":"Paris"}' },
  });
  send("response.completed", {
    response: {
      id: "resp_1",
      status: "completed",
      usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
    },
  });
  res.end();
}
async function configured(c, transport, credentialOverrides = {}) {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(c.providerId, async () => ({
    ...toCredential(c, tokens(), Date.now()),
    ...credentialOverrides,
  }));
  const models = createModels({ credentials });
  models.setProvider(createGatewayProvider(c, { runtime: { fetch: transport } }));
  return { models, model: models.getModel(c.providerId, "synthetic-model"), credentials };
}
for (const api of ["openai-completions", "openai-responses"]) {
  test(`T08/T13 ${api} : refresh puis Bearer, Unicode, usage, outils, hooks et reprise`, async (t) => {
    const c = context({ api });
    let refreshes = 0;
    const requests = [];
    const oidc = await server(t, async (req, res) => {
      if (req.url.endsWith("openid-configuration")) return json(res, metadata(c));
      const params = await form(req);
      assert.equal(params.get("grant_type"), "refresh_token");
      refreshes++;
      json(res, tokens({ access_token: "NEW.ACCESS", refresh_token: "ROTATED.REFRESH" }));
    });
    const gateway = await server(t, async (req, res) => {
      assert.equal(req.headers.authorization, "Bearer NEW.ACCESS");
      assert.equal(
        req.url,
        api === "openai-completions" ? "/v1/chat/completions" : "/v1/responses",
      );
      const chunks = [];
      for await (const part of req) chunks.push(part);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      (api === "openai-completions" ? completions : responses)(res);
    });
    const { models, model } = await configured(
      c,
      mapFetch({
        "https://issuer.example": oidc.origin,
        "https://gateway.example": gateway.origin,
      }),
      { expires: 0 },
    );
    let payloads = 0;
    let responsesSeen = 0;
    let rawEvents = 0;
    const stream = models.streamSimple(model, prompt, {
      onPayload: () => {
        payloads++;
      },
      onResponse: (r) => {
        assert.equal(r.status, 200);
        responsesSeen++;
      },
      onProviderStreamEvent: () => {
        rawEvents++;
      },
    });
    const events = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    assert.equal(result.stopReason, "toolUse", result.errorMessage);
    assert.equal(result.content.find((x) => x.type === "text").text, "Bonjour 🌊");
    assert.deepEqual(result.content.find((x) => x.type === "toolCall").arguments, {
      query: "Paris",
    });
    assert.equal(result.usage.input, 12);
    assert.equal(result.usage.output, 5);
    assert.ok(events.includes("text_delta"));
    assert.ok(events.includes("toolcall_end"));
    assert.equal(events.filter((x) => x === "done").length, 1);
    assert.equal(payloads, 1);
    assert.equal(responsesSeen, 1);
    assert.ok(rawEvents > 0);
    assert.equal(refreshes, 1);
    const toolCall = result.content.find((x) => x.type === "toolCall");
    const resumed = await models.complete(model, {
      ...prompt,
      messages: [
        ...prompt.messages,
        result,
        {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: "lookup",
          content: [{ type: "text", text: "Résultat synthétique" }],
          isError: false,
          timestamp: 2,
        },
      ],
    });
    assert.equal(resumed.stopReason, "toolUse", resumed.errorMessage);
    assert.ok(JSON.stringify(requests[1]).includes("Résultat synthétique"));
    assert.equal(refreshes, 1);
  });
}
test("T14 redirections 302/307/308 : aucune requête ni Bearer à la destination", async (t) => {
  let leakedRequests = 0;
  const sink = await server(t, (_req, res) => {
    leakedRequests++;
    res.end();
  });
  const c = context();
  for (const status of [302, 307, 308]) {
    const gateway = await server(t, (_req, res) => {
      res.writeHead(status, { location: `${sink.origin}/steal` });
      res.end();
    });
    const guarded = gatewayFetch(
      c,
      "SECRET.ACCESS",
      mapFetch({ "https://gateway.example": gateway.origin }),
    );
    await assert.rejects(
      guarded(`${c.baseUrl}/chat/completions`, { method: "POST" }),
      /Redirection gateway refusée/,
    );
  }
  assert.equal(leakedRequests, 0);
});
test("F07 garde l'hôte et le chemin exacts, force le Bearer, supprime cookies", async () => {
  const c = context();
  let hits = 0;
  const guarded = gatewayFetch(c, "EXPECTED.ACCESS", async (_url, init) => {
    hits++;
    const h = new Headers(init.headers);
    assert.equal(h.get("authorization"), "Bearer EXPECTED.ACCESS");
    assert.equal(h.get("cookie"), null);
    assert.equal(init.redirect, "manual");
    return new Response("ok");
  });
  for (const url of [
    "https://other.example/v1/chat/completions",
    `${c.baseUrl}/chat/completions?other=1`,
    "https://gateway.example/other",
    "http://gateway.example/v1/chat/completions",
  ])
    await assert.rejects(guarded(url, { method: "POST" }));
  await guarded(`${c.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer WRONG", Cookie: "SECRET" },
  });
  assert.equal(hits, 1);
});
test("F07 401/403/404/503 : erreurs exploitables masquées, aucun retry", async (t) => {
  const c = context();
  for (const status of [401, 403, 404, 503]) {
    let calls = 0;
    const gateway = await server(t, (_req, res) => {
      calls++;
      json(res, { error: { message: "SECRET.ACCESS code=SECRET" } }, status);
    });
    const { models, model } = await configured(
      c,
      mapFetch({ "https://gateway.example": gateway.origin }),
    );
    const result = await models.completeSimple(model, prompt);
    assert.equal(result.stopReason, "error");
    assert.ok(!result.errorMessage.includes("SECRET"));
    if (status === 401) assert.match(result.errorMessage, /audience\/roles/);
    assert.equal(calls, 1);
  }
});
test("F01/F06 modèle non validé, inconnu et surcharge de destination refusés", async () => {
  for (const patch of [
    { baseUrl: "https://other.example/v1" },
    { id: "unknown" },
    { provider: "agentgateway-other" },
    { api: "openai-responses" },
  ]) {
    const c = context();
    const { models, model } = await configured(c, async () => assert.fail("network"));
    // Calling the native provider directly also checks model metadata.
    const result = await models
      .getProvider(c.providerId)
      .streamSimple({ ...model, ...patch }, { messages: [] }, { apiKey: "TEST" })
      .result();
    assert.equal(result.stopReason, "error");
  }
  const c = context({ models: [{ ...rawContext().models[0], validated: false }] });
  const { models, model } = await configured(c, async () => assert.fail("network"));
  assert.match((await models.completeSimple(model, prompt)).errorMessage, /non validé/);
});
test("T12 deux contextes : URLs et credentials isolés sur les requêtes effectives", async (t) => {
  const seen = [];
  const a = context();
  const b = context({ name: "second", baseUrl: "https://second.example/v1" });
  const gateway = await server(t, (req, res) => {
    seen.push(req.headers.authorization);
    completions(res);
  });
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  const wire = [];
  for (const [c, access] of [
    [a, "FIRST"],
    [b, "SECOND"],
  ]) {
    await credentials.modify(c.providerId, async () =>
      toCredential(c, tokens({ access_token: access }), Date.now()),
    );
    models.setProvider(
      createGatewayProvider(c, {
        runtime: {
          fetch: mapFetch(
            { "https://gateway.example": gateway.origin, "https://second.example": gateway.origin },
            wire,
          ),
        },
      }),
    );
    assert.equal(
      (await models.completeSimple(models.getModel(c.providerId, "synthetic-model"), prompt))
        .stopReason,
      "toolUse",
    );
  }
  assert.deepEqual(seen, ["Bearer FIRST", "Bearer SECOND"]);
  assert.deepEqual(
    wire.map((r) => new URL(r.url).origin),
    ["https://gateway.example", "https://second.example"],
  );
});
test("F07 annulation du streaming conserve stopReason aborted", async (t) => {
  const c = context();
  const controller = new AbortController();
  const gateway = await server(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] })}\n\n`,
    );
  });
  const { models, model } = await configured(
    c,
    mapFetch({ "https://gateway.example": gateway.origin }),
  );
  const s = models.streamSimple(model, prompt, { signal: controller.signal });
  for await (const event of s) {
    if (event.type === "text_delta") controller.abort();
  }
  assert.equal((await s.result()).stopReason, "aborted");
});

test("T16 erreur SSE ne propage pas de corps serveur sensible", async (t) => {
  const c = context({ api: "openai-responses" });
  const gateway = await server(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ type: "error", code: "SECRET-CODE", message: "SECRET-ACCESS SECRET-VERIFIER" })}\n\n`,
    );
  });
  const { models, model } = await configured(
    c,
    mapFetch({ "https://gateway.example": gateway.origin }),
  );
  const result = await models.completeSimple(model, prompt);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /masqués/);
  assert.ok(!result.errorMessage.includes("SECRET"));
});

test("F07 streaming silencieux arrêté au délai total, même après les headers", async (t) => {
  const c = context({ gatewayTimeoutSeconds: 1 });
  const gateway = await server(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
  });
  const { models, model } = await configured(
    c,
    mapFetch({ "https://gateway.example": gateway.origin }),
  );
  const start = Date.now();
  const result = await models.completeSimple(model, prompt);
  assert.equal(result.stopReason, "aborted");
  assert.match(result.errorMessage, /Délai total/);
  assert.ok(Date.now() - start < 3000);
});
