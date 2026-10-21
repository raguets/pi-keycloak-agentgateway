import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";
import { checkSignal } from "./async.js";
import type { GatewayContext } from "./config.js";
import { SafeError } from "./errors.js";
import { tokenString } from "./oidc/tokens.js";

export function assertModel(c: GatewayContext, model: Model<Api>): void {
  const configured = c.models.find((m) => m.id === model.id);
  if (!configured) throw new SafeError("model", "Modèle inconnu dans ce contexte Agent Gateway.");
  if (!configured.validated)
    throw new SafeError(
      "model",
      "Modèle non validé. Confirmez ID, API, capacités et limites puis définissez validated: true.",
    );
  if (model.provider !== c.providerId || model.baseUrl !== c.baseUrl || model.api !== c.api)
    throw new SafeError(
      "binding",
      "Destination du modèle différente du contexte authentifié. Vérifiez les surcharges models.json.",
    );
}

/** Restrict the actual wire destination too: metadata/SDK overrides cannot bypass this guard. */
export function gatewayFetch(
  c: GatewayContext,
  token: string,
  transport: typeof fetch = fetch,
  onFailure?: (message: string) => void,
): typeof fetch {
  if (!tokenString(token))
    throw new SafeError("auth", "Access token absent ou invalide. Refaites /login.");
  const expected = `${c.baseUrl}/${c.api === "openai-completions" ? "chat/completions" : "responses"}`;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.href !== expected || method !== "POST")
      throw new SafeError(
        "destination",
        "Requête hors de l'endpoint Agent Gateway autorisé : envoi refusé.",
      );
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    headers.set("Authorization", `Bearer ${token}`);
    headers.delete("cookie");
    headers.delete("proxy-authorization");
    headers.delete("host");
    let response: Response;
    try {
      response = await transport(input, {
        ...init,
        headers,
        redirect: "manual",
        credentials: "omit",
      });
    } catch {
      checkSignal(init?.signal ?? undefined);
      onFailure?.("Gateway inaccessible : vérifiez réseau, certificat et délai de requête.");
      throw new SafeError(
        "gateway_network",
        "Gateway inaccessible : vérifiez réseau, certificat et délai de requête.",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      onFailure?.("Redirection gateway refusée ; aucun token transmis à la destination.");
      throw new SafeError(
        "redirect",
        "Redirection gateway refusée ; aucun token transmis à la destination.",
      );
    }
    if (!response.ok) {
      // Preserve HTTP status for Pi, but discard untrusted error bodies/headers.
      await response.body?.cancel();
      const message =
        response.status === 401 || response.status === 403
          ? "Gateway : accès refusé. Vérifiez audience/roles, le contexte et refaites /login si la session est révoquée. Aucun rejeu automatique."
          : response.status === 404
            ? "Gateway : endpoint ou modèle inconnu. Vérifiez le contrat API et l'ID du modèle."
            : "Erreur gateway. Réessayez plus tard ou consultez l'administrateur.";
      onFailure?.(message);
      return Response.json(
        { error: { message, type: "agentgateway_error" } },
        { status: response.status },
      );
    }
    return response;
  };
}

export function secureOptions(
  c: GatewayContext,
  model: Model<Api>,
  options: StreamOptions | undefined,
  transport?: typeof fetch,
  onFailure?: (message: string) => void,
): StreamOptions {
  assertModel(c, model);
  return {
    ...options,
    transport: "sse",
    maxRetries: 0,
    timeoutMs: Math.min(options?.timeoutMs ?? Infinity, c.gatewayTimeoutSeconds * 1000),
    fetch: gatewayFetch(c, options?.apiKey ?? "", transport, onFailure),
  };
}
