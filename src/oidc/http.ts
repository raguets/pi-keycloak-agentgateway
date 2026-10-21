import { checkSignal, withDeadline } from "../async.js";
import { oauthError, SafeError } from "../errors.js";

export interface Runtime {
  fetch: typeof globalThis.fetch;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Bound response size as well as request duration; never include a response body in errors. */
export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new SafeError("response", "Réponse JSON absente.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) throw new SafeError("response", "Réponse JSON trop volumineuse.");
      chunks.push(value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch (e) {
    await reader.cancel().catch(() => {});
    if (e instanceof SafeError) throw e;
    throw new SafeError("response", "Réponse JSON invalide (contenu masqué).");
  } finally {
    reader.releaseLock();
  }
}

export async function requestJson(
  url: string,
  runtime: Runtime,
  seconds: number,
  signal?: AbortSignal,
  form?: URLSearchParams,
): Promise<{ body: Record<string, unknown>; date: string | null }> {
  return withDeadline(seconds, signal, async (requestSignal) => {
    let response: Response;
    try {
      response = await runtime.fetch(url, {
        method: form ? "POST" : "GET",
        body: form,
        headers: {
          Accept: "application/json",
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: requestSignal,
      });
    } catch {
      checkSignal(requestSignal);
      throw new SafeError(
        "network",
        "Endpoint OIDC inaccessible : vérifiez réseau, TLS, issuer et absence de redirection.",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new SafeError("redirect", "Redirection OIDC refusée.");
    }
    if (response.status === 404) {
      await response.body?.cancel();
      throw new SafeError(
        "discovery",
        "Issuer ou endpoint OIDC introuvable (HTTP 404). Vérifiez l'URL du realm.",
      );
    }
    if (response.status >= 500) {
      await response.body?.cancel();
      throw new SafeError("unavailable", "Serveur Keycloak indisponible. Réessayez plus tard.");
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(response);
    } catch (error) {
      checkSignal(requestSignal);
      throw error;
    }
    checkSignal(requestSignal);
    if (!response.ok || body.error !== undefined) throw oauthError(body.error);
    return { body, date: response.headers.get("date") };
  });
}
