import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { checkSignal } from "../async.js";
import type { GatewayContext } from "../config.js";
import { SafeError } from "../errors.js";
import type { Logger } from "../logging.js";
import { type Discovery, issuerEndpoint } from "./discovery.js";
import { type Runtime, requestJson } from "./http.js";
import { createPkce } from "./pkce.js";
import { exchangeTokens } from "./tokens.js";

export async function deviceLogin(
  c: GatewayContext,
  d: Discovery,
  ui: ProviderAuthInteraction,
  runtime: Runtime,
  log: Logger,
): Promise<OAuthCredential> {
  if (!c.enableDevice || !d.deviceEndpoint)
    throw new SafeError("device", "Device Code non activé ou absent de la découverte OIDC.");
  const pkce = createPkce();
  const started = runtime.now();
  const { body } = await requestJson(
    d.deviceEndpoint,
    runtime,
    c.requestTimeoutSeconds,
    ui.signal,
    new URLSearchParams({
      client_id: c.clientId,
      scope: c.scopes.join(" "),
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    }),
  );
  if (
    typeof body.device_code !== "string" ||
    !body.device_code ||
    typeof body.user_code !== "string" ||
    !/^[\x21-\x7e]{1,128}$/.test(body.user_code) ||
    typeof body.expires_in !== "number" ||
    !Number.isSafeInteger(body.expires_in) ||
    body.expires_in < 1 ||
    body.expires_in > 86400
  )
    throw new SafeError("device", "Réponse Device Code invalide.");
  const suppliedInterval = body.interval ?? 5;
  if (
    typeof suppliedInterval !== "number" ||
    !Number.isSafeInteger(suppliedInterval) ||
    suppliedInterval < 1 ||
    suppliedInterval > 3600
  )
    throw new SafeError("device", "Intervalle Device invalide.");
  let interval = suppliedInterval;
  const verificationUri = issuerEndpoint(body.verification_uri, c.issuer, true);
  const expires = started + Math.min(body.expires_in, c.deviceTimeoutSeconds) * 1000;
  ui.notify({
    type: "device_code",
    userCode: body.user_code,
    verificationUri,
    intervalSeconds: interval,
    expiresInSeconds: Math.max(0, Math.floor((expires - runtime.now()) / 1000)),
  });
  ui.notify({
    type: "info",
    message: `Code Device valable au plus ${Math.max(0, Math.floor((expires - runtime.now()) / 1000))} s ; intervalle de vérification ${interval} s.`,
  });
  while (runtime.now() < expires) {
    checkSignal(ui.signal);
    await runtime.sleep(Math.min(interval * 1000, expires - runtime.now()), ui.signal);
    checkSignal(ui.signal);
    if (runtime.now() >= expires) break;
    try {
      return await exchangeTokens(
        c,
        d,
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: body.device_code,
          code_verifier: pkce.verifier,
        },
        runtime,
        ui.signal,
        log,
      );
    } catch (error) {
      if (!(error instanceof SafeError)) throw error;
      if (error.code === "slow_down") {
        interval += 5;
        ui.notify({
          type: "progress",
          message: `Attente Keycloak ; nouvel intervalle ${interval} s.`,
        });
      } else if (error.code === "network" || error.code === "timeout")
        interval = Math.min(interval * 2, 3600);
      else if (error.code !== "authorization_pending") throw error;
    }
  }
  throw new SafeError("device_timeout", "Device Code expiré ou délai dépassé. Refaites /login.");
}
