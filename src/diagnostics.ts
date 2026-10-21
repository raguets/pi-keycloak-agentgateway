import { withDeadline } from "./async.js";
import type { Configuration } from "./config.js";
import { safeMessage } from "./errors.js";
import { discover } from "./oidc/discovery.js";
import type { Runtime } from "./oidc/http.js";
import { runtimeDefaults } from "./provider.js";

export interface Diagnostic {
  providerId: string;
  models: { id: string; validated: boolean }[];
  authentication: "credential configuré (validité non vérifiée)" | "non configuré" | "non vérifié";
  oidc: string;
  deviceAvailable: boolean;
  clockSkewSeconds: number | null;
  gateway: string;
}
/** No auth resolution, refresh, catalog inference, chat or token export. Only discovery + anonymous HEAD. */
export async function diagnose(
  config: Configuration,
  configured?: (id: string) => boolean,
  overrides: Partial<Runtime> = {},
): Promise<Diagnostic[]> {
  const runtime = runtimeDefaults(overrides);
  const results: Diagnostic[] = [];
  for (const c of config.contexts) {
    const result: Diagnostic = {
      providerId: c.providerId,
      models: c.models.map((m) => ({ id: m.id, validated: m.validated })),
      authentication: configured
        ? configured(c.providerId)
          ? "credential configuré (validité non vérifiée)"
          : "non configuré"
        : "non vérifié",
      oidc: "non vérifié",
      deviceAvailable: false,
      clockSkewSeconds: null,
      gateway: "non vérifié",
    };
    try {
      const d = await discover(c, runtime);
      result.oidc = "valide";
      result.deviceAvailable = c.enableDevice && !!d.deviceEndpoint;
      const date = d.serverDate ? Date.parse(d.serverDate) : NaN;
      if (Number.isFinite(date))
        result.clockSkewSeconds = Math.round((date - runtime.now()) / 1000);
    } catch (error) {
      result.oidc = safeMessage(error);
    }
    try {
      result.gateway = await withDeadline(c.requestTimeoutSeconds, undefined, async (signal) => {
        const r = await runtime.fetch(c.baseUrl, {
          method: "HEAD",
          redirect: "manual",
          credentials: "omit",
          signal,
        });
        await r.body?.cancel();
        return `HTTP ${r.status} (sans authentification ; 401/403/405 peuvent être normaux)`;
      });
    } catch {
      result.gateway = "inaccessible (réseau/TLS/délai)";
    }
    results.push(result);
  }
  return results;
}
