import type { OAuthCredential } from "@earendil-works/pi-ai";
import { contextFingerprint, type GatewayContext } from "../config.js";
import { SafeError } from "../errors.js";
import type { Logger } from "../logging.js";
import type { Discovery } from "./discovery.js";
import { type Runtime, requestJson } from "./http.js";

export function assertBinding(c: GatewayContext, credential: OAuthCredential): void {
  if (credential.agentgatewayBinding !== contextFingerprint(c))
    throw new SafeError(
      "binding",
      "Configuration du contexte modifiée ou credential non lié (gateway/issuer/clientId/API/scopes). Refaites /login avant tout appel.",
    );
}
export function tokenString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32_768 &&
    /^[A-Za-z0-9._~+/-]+=*$/.test(value)
  );
}
export function toCredential(
  c: GatewayContext,
  raw: Record<string, unknown>,
  started: number,
  previous?: OAuthCredential,
): OAuthCredential {
  if (
    !tokenString(raw.access_token) ||
    typeof raw.token_type !== "string" ||
    raw.token_type.toLowerCase() !== "bearer" ||
    typeof raw.expires_in !== "number" ||
    !Number.isFinite(raw.expires_in) ||
    raw.expires_in <= 0 ||
    raw.expires_in > 31_536_000
  )
    throw new SafeError(
      "token",
      "Réponse token invalide : access token Bearer et expires_in positif requis.",
    );
  const refresh =
    raw.refresh_token === undefined && previous && c.reuseRefreshTokenWhenOmitted
      ? previous.refresh
      : raw.refresh_token;
  if (!tokenString(refresh))
    throw new SafeError(
      "token",
      "Refresh token absent ou invalide. Vérifiez le contrat Keycloak ; aucune session partielle enregistrée.",
    );
  const marginMs = Math.min(c.refreshLeewaySeconds * 1000, raw.expires_in * 100);
  return {
    type: "oauth",
    access: raw.access_token,
    refresh,
    expires: started + raw.expires_in * 1000 - marginMs,
    // OAuthCredentials explicitly supports provider-owned data via its index signature.
    agentgatewayBinding: contextFingerprint(c),
  };
}
export async function exchangeTokens(
  c: GatewayContext,
  discovery: Discovery,
  fields: Record<string, string>,
  runtime: Runtime,
  signal: AbortSignal,
  log: Logger,
  previous?: OAuthCredential,
): Promise<OAuthCredential> {
  const started = runtime.now();
  const { body } = await requestJson(
    discovery.tokenEndpoint,
    runtime,
    c.requestTimeoutSeconds,
    signal,
    new URLSearchParams({ ...fields, client_id: c.clientId }),
  );
  const credential = toCredential(c, body, started, previous);
  if (credential.expires <= runtime.now())
    throw new SafeError(
      "token",
      "Token déjà expiré à réception : vérifiez les délais et l'horloge.",
    );
  if (
    !previous &&
    (typeof body.scope !== "string" || !body.scope.split(" ").includes("offline_access"))
  )
    log("warn", "offline_unconfirmed");
  return credential;
}
