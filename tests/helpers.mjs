import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import { parseConfig } from "../dist/config.js";

export function rawContext(overrides = {}) {
  return {
    name: "test",
    baseUrl: "https://gateway.example/v1",
    api: "openai-completions",
    issuer: "https://issuer.example/realms/test",
    clientId: "synthetic-public-client",
    models: [
      {
        id: "synthetic-model",
        name: "Synthetic model",
        contextWindow: 16000,
        maxTokens: 2048,
        input: ["text"],
        reasoning: false,
        validated: true,
      },
    ],
    ...overrides,
  };
}
export function context(overrides = {}) {
  return parseConfig({ contexts: [rawContext(overrides)] }).contexts[0];
}
export function metadata(c, changes = {}) {
  return {
    issuer: c.issuer,
    authorization_endpoint: `${c.issuer}/authorize`,
    token_endpoint: `${c.issuer}/token`,
    device_authorization_endpoint: `${c.issuer}/device`,
    code_challenge_methods_supported: ["S256"],
    response_types_supported: ["code"],
    ...changes,
  };
}
export function tokens(changes = {}) {
  return {
    access_token: "SYNTHETIC.ACCESS",
    refresh_token: "SYNTHETIC.REFRESH",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid offline_access",
    ...changes,
  };
}
export async function tempDir(t) {
  await mkdir(".test-tmp", { recursive: true });
  const path = await mkdtemp(resolve(".test-tmp", "test-"));
  t.after(() => {
    const inside = relative(resolve(".test-tmp"), resolve(path));
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      throw new Error("Unsafe test cleanup path");
    return rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return path;
}
export async function server(t, handler) {
  const s = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((yes, no) => {
    s.once("error", no);
    s.listen(0, "127.0.0.1", yes);
  });
  t.after(async () => {
    s.closeAllConnections();
    await new Promise((done) => s.close(done));
  });
  return { server: s, port: s.address().port, origin: `http://127.0.0.1:${s.address().port}` };
}
export async function freePort(t) {
  const s = await server(t, (_req, res) => res.end());
  await new Promise((done) => s.server.close(done));
  return s.port;
}
export async function form(req) {
  const chunks = [];
  for await (const part of req) chunks.push(part);
  return new URLSearchParams(Buffer.concat(chunks).toString());
}
export function json(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
/** Test-only transport maps validated HTTPS names onto local mock servers; never shipped. */
export function mapFetch(routes, requests = []) {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const target = routes[url.origin];
    if (!target) throw new Error("Unexpected test destination");
    requests.push({ url: url.href, init });
    return fetch(`${target}${url.pathname}${url.search}`, init);
  };
}
export function browserUi(onUrl, signal = new AbortController().signal) {
  const jobs = [];
  return {
    signal,
    jobs,
    prompt: async () => "browser",
    notify(event) {
      if (event.type === "auth_url") {
        const job = Promise.resolve().then(() => onUrl(new URL(event.url)));
        jobs.push(job);
        void job.catch(() => {});
      }
    },
  };
}
export function callbackUrl(auth, changes = {}) {
  const url = new URL(auth.searchParams.get("redirect_uri"));
  url.search = new URLSearchParams({
    state: auth.searchParams.get("state"),
    code: "SYNTHETIC-CODE",
    ...changes,
  }).toString();
  return url.href;
}
export async function portAvailable(port) {
  const s = createServer();
  try {
    await new Promise((done, reject) => {
      s.once("error", reject);
      s.listen(port, "127.0.0.1", done);
    });
  } finally {
    await new Promise((done) => s.close(done));
  }
}
export function causeMessages(error) {
  return [error?.message, error?.cause ? causeMessages(error.cause) : ""].join(" ");
}
