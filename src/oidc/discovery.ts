import { type GatewayContext, httpsUrl } from "../config.js";
import { SafeError } from "../errors.js";
import { type Runtime, requestJson } from "./http.js";

export interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceEndpoint?: string;
  serverDate: string | null;
}

/** Conservative same-origin policy. An IdP on several origins needs a reviewed extension change. */
export function issuerEndpoint(value: unknown, issuer: string, allowQuery = false): string {
  const url = httpsUrl(value, "endpoint OIDC", allowQuery);
  if (url.origin !== new URL(issuer).origin)
    throw new SafeError(
      "discovery",
      "Endpoint OIDC hors de l'origine de l'issuer : connexion refusée.",
    );
  return url.href;
}
export async function discover(
  c: GatewayContext,
  runtime: Runtime,
  signal?: AbortSignal,
): Promise<Discovery> {
  const { body, date } = await requestJson(
    `${c.issuer}/.well-known/openid-configuration`,
    runtime,
    c.requestTimeoutSeconds,
    signal,
  );
  if (body.issuer !== c.issuer)
    throw new SafeError("discovery", "Issuer retourné par OIDC incohérent avec la configuration.");
  for (const [key, required] of [
    ["code_challenge_methods_supported", "S256"],
    ["response_types_supported", "code"],
  ] as const) {
    if (body[key] !== undefined && (!Array.isArray(body[key]) || !body[key].includes(required)))
      throw new SafeError(
        "discovery",
        "La découverte OIDC ne permet pas Authorization Code avec PKCE S256.",
      );
  }
  return {
    issuer: c.issuer,
    authorizationEndpoint: issuerEndpoint(body.authorization_endpoint, c.issuer),
    tokenEndpoint: issuerEndpoint(body.token_endpoint, c.issuer),
    deviceEndpoint:
      body.device_authorization_endpoint === undefined
        ? undefined
        : issuerEndpoint(body.device_authorization_endpoint, c.issuer),
    serverDate: date,
  };
}
