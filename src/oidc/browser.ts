import { createServer } from "node:http";
import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { abortable, checkSignal } from "../async.js";
import { type GatewayContext, redirectUri } from "../config.js";
import { oauthError, SafeError } from "../errors.js";
import type { Logger } from "../logging.js";
import type { Discovery } from "./discovery.js";
import type { Runtime } from "./http.js";
import { createPkce, equalState } from "./pkce.js";
import { exchangeTokens } from "./tokens.js";

export function parseCallback(input: string, c: GatewayContext, state: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SafeError("callback", "URL de callback complète requise, avec code et state.");
  }
  const redirect = new URL(redirectUri(c));
  if (
    url.origin !== redirect.origin ||
    url.pathname !== redirect.pathname ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new SafeError("callback", "URL de callback inattendue.");
  for (const key of ["state", "code", "error", "iss", "error_description"]) {
    if (url.searchParams.getAll(key).length > 1)
      throw new SafeError("callback", "Paramètre de callback dupliqué.");
  }
  if (!equalState(url.searchParams.get("state"), state))
    throw new SafeError("state", "État OAuth invalide : connexion refusée.");
  if (url.searchParams.has("iss") && url.searchParams.get("iss") !== c.issuer)
    throw new SafeError("callback", "Issuer du callback incohérent.");
  if (url.searchParams.has("error")) throw oauthError(url.searchParams.get("error"));
  const code = url.searchParams.get("code");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Callback codes must not contain controls.
  if (!code || code.length > 8192 || /[\x00-\x20\x7f]/.test(code))
    throw new SafeError("callback", "Code OAuth manquant ou invalide.");
  return code;
}
function authorizationUrl(
  c: GatewayContext,
  d: Discovery,
  pkce: ReturnType<typeof createPkce>,
): string {
  const url = new URL(d.authorizationEndpoint);
  url.search = new URLSearchParams({
    client_id: c.clientId,
    response_type: "code",
    redirect_uri: redirectUri(c),
    scope: c.scopes.join(" "),
    state: pkce.state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.href;
}
export async function browserLogin(
  c: GatewayContext,
  d: Discovery,
  ui: ProviderAuthInteraction,
  runtime: Runtime,
  log: Logger,
  manual = false,
): Promise<OAuthCredential> {
  const pkce = createPkce();
  const exchange = (code: string) =>
    exchangeTokens(
      c,
      d,
      {
        grant_type: "authorization_code",
        code,
        code_verifier: pkce.verifier,
        redirect_uri: redirectUri(c),
      },
      runtime,
      ui.signal,
      log,
    );
  checkSignal(ui.signal);
  if (manual) {
    if (!c.enableManual) throw new SafeError("manual", "Repli manuel désactivé.");
    ui.notify({
      type: "auth_url",
      url: authorizationUrl(c, d, pkce),
      instructions:
        "Après autorisation, copiez l'URL complète du callback (même si la page ne répond pas). Ne collez jamais un code seul.",
    });
    const input = await abortable(
      ui.prompt({
        type: "manual_code",
        message: "URL complète de redirection locale (code et state)",
        signal: ui.signal,
      }),
      ui.signal,
    );
    checkSignal(ui.signal);
    return exchange(parseCallback(input.trim(), c, pkce.state));
  }
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: unknown) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  void result.catch(() => {});
  let settled = false;
  const server = createServer({ maxHeaderSize: 16_384 }, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (settled) {
      res.writeHead(410).end("Callback terminé.");
      return;
    }
    if (
      req.method !== "GET" ||
      req.headers.host !== `127.0.0.1:${c.callbackPort}` ||
      !req.url?.startsWith(`${c.redirectPath}?`)
    ) {
      res.writeHead(404).end("Introuvable.");
      return;
    }
    settled = true;
    try {
      const code = parseCallback(`http://127.0.0.1:${c.callbackPort}${req.url}`, c, pkce.state);
      res
        .writeHead(200)
        .end("Code reçu. Retournez dans Pi pour terminer la connexion.", () => resolveCode(code));
    } catch (error) {
      res.writeHead(400).end("Connexion refusée. Consultez Pi.", () => rejectCode(error));
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxRequestsPerSocket = 1;
  try {
    await abortable(
      new Promise<void>((resolve, reject) => {
        server.once("error", () =>
          reject(
            new SafeError(
              "callback_port",
              "Callback indisponible : port occupé ou interdit. Configurez un port autorisé ou choisissez un repli activé via /login.",
            ),
          ),
        );
        server.listen({ host: "127.0.0.1", port: c.callbackPort, signal: ui.signal }, resolve);
      }),
      ui.signal,
    );
    server.on("error", () =>
      rejectCode(new SafeError("callback", "Erreur du serveur de callback.")),
    );
    checkSignal(ui.signal);
    ui.notify({
      type: "auth_url",
      url: authorizationUrl(c, d, pkce),
      instructions:
        "Ouvrez cette URL si le navigateur ne démarre pas. Attente du callback local ; Échap pour annuler.",
    });
    const code = await abortable(result, ui.signal);
    checkSignal(ui.signal);
    return await exchange(code);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
