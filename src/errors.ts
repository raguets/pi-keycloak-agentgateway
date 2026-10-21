/** Only these controlled messages may cross a UI/log boundary. Never attach raw causes. */
export class SafeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentGatewayError";
  }
}

export function safeMessage(error: unknown): string {
  return error instanceof SafeError
    ? error.message
    : "Opération interrompue ou erreur interne. Relancez le diagnostic Agent Gateway.";
}

const oauthMessages: Record<string, string> = {
  invalid_grant: "Session Keycloak expirée ou révoquée (invalid_grant). Refaites /login dans Pi.",
  invalid_client: "Client OAuth refusé : vérifiez clientId et le mode client public.",
  unauthorized_client: "Flux non autorisé pour ce client Keycloak (notamment Device Code).",
  invalid_scope: "Scopes non autorisés : vérifiez notamment offline_access.",
  access_denied: "Autorisation refusée par Keycloak.",
  expired_token: "Le code Device a expiré. Refaites /login.",
  invalid_request: "Requête OAuth refusée : vérifiez clientId, PKCE et la redirect URI autorisée.",
  authorization_pending: "Autorisation Device en attente.",
  slow_down: "Keycloak demande de ralentir le polling Device.",
  temporarily_unavailable: "Keycloak temporairement indisponible. Réessayez plus tard.",
};

export function oauthError(value: unknown): SafeError {
  const code =
    typeof value === "string" && Object.hasOwn(oauthMessages, value) ? value : "oauth_error";
  return new SafeError(code, oauthMessages[code] ?? "Keycloak a refusé la requête OAuth.");
}
