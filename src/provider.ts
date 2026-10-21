import { createHash } from "node:crypto";
import {
  type Api,
  createProvider,
  lazyStream,
  type Model,
  type OAuthAuth,
  type OAuthCredential,
  type Provider,
  type ProviderAuthInteraction,
  type ProviderStreams,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { abortable, delay, withDeadline } from "./async.js";
import type { GatewayApi, GatewayContext } from "./config.js";
import { SafeError, safeMessage } from "./errors.js";
import { secureOptions } from "./gateway.js";
import { createLogger, type Logger } from "./logging.js";
import { browserLogin } from "./oidc/browser.js";
import { deviceLogin } from "./oidc/device.js";
import { discover } from "./oidc/discovery.js";
import type { Runtime } from "./oidc/http.js";
import { assertBinding, exchangeTokens, tokenString } from "./oidc/tokens.js";

const MAX_ROTATIONS = 16;
const ROTATION_REUSE_MIN_MS = 60_000;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export interface ProviderDependencies {
  runtime?: Partial<Runtime>;
  log?: Logger;
}
export function runtimeDefaults(overrides: Partial<Runtime> = {}): Runtime {
  return { fetch: globalThis.fetch, now: Date.now, sleep: delay, ...overrides };
}
export function createGatewayProvider(
  config: GatewayContext,
  deps: ProviderDependencies = {},
): Provider<GatewayApi> {
  // Capture an immutable configuration snapshot; never retarget a live credential.
  const c = structuredClone(config);
  const runtime = runtimeDefaults(deps.runtime);
  const log = deps.log ?? createLogger();
  // Rotations obtained by this process, keyed by a hash of the refresh token they replaced.
  const rotations = new Map<string, OAuthCredential>();
  const remember = (replaced: string, next: OAuthCredential) => {
    rotations.delete(replaced);
    rotations.set(replaced, next);
    for (const key of rotations.keys()) {
      if (rotations.size <= MAX_ROTATIONS) break;
      rotations.delete(key);
    }
  };
  const oauth: OAuthAuth = {
    name: `Keycloak – ${c.name}`,
    loginLabel: "Keycloak – Browser (PKCE)",
    async login(interaction) {
      const timeout = Math.max(
        c.browserTimeoutSeconds,
        c.enableDevice ? c.deviceTimeoutSeconds : 0,
      );
      return withDeadline(timeout, interaction.signal, async (signal) => {
        const ui: ProviderAuthInteraction = { ...interaction, signal };
        log("debug", "discovery_start");
        const d = await discover(c, runtime, signal);
        const methods = [{ id: "browser", label: "Keycloak – Browser (PKCE)" }];
        if (c.enableManual)
          methods.push({ id: "manual", label: "Keycloak – URL complète du callback (PKCE)" });
        if (c.enableDevice && d.deviceEndpoint)
          methods.push({ id: "device", label: "Keycloak – Device Code (PKCE)" });
        if (c.enableDevice && !d.deviceEndpoint)
          ui.notify({
            type: "info",
            message: "Device Code absent de la découverte OIDC ; méthode indisponible.",
          });
        let method =
          methods.length === 1
            ? "browser"
            : await abortable(
                ui.prompt({
                  type: "select",
                  message: "Méthode de connexion Keycloak",
                  options: methods,
                  signal,
                }),
                signal,
              );
        if (!methods.some((m) => m.id === method))
          throw new SafeError("method", "Méthode de connexion non autorisée.");
        const run = () =>
          withDeadline(
            method === "device" ? c.deviceTimeoutSeconds : c.browserTimeoutSeconds,
            signal,
            (flowSignal) =>
              method === "device"
                ? deviceLogin(c, d, { ...ui, signal: flowSignal }, runtime, log)
                : browserLogin(
                    c,
                    d,
                    { ...ui, signal: flowSignal },
                    runtime,
                    log,
                    method === "manual",
                  ),
          );
        let credential: OAuthCredential;
        try {
          credential = await run();
        } catch (error) {
          const alternatives = methods.filter((m) => m.id !== "browser");
          if (
            !(error instanceof SafeError) ||
            error.code !== "callback_port" ||
            !alternatives.length
          )
            throw error;
          ui.notify({ type: "info", message: safeMessage(error) });
          method = await abortable(
            ui.prompt({
              type: "select",
              message: "Repli autorisé pour ce client",
              options: alternatives,
              signal,
            }),
            signal,
          );
          if (!alternatives.some((m) => m.id === method))
            throw new SafeError("method", "Repli non autorisé.");
          credential = await run();
        }
        log("info", "login_success");
        ui.notify({
          type: "info",
          message:
            "Connexion obtenue. offline_access demandé ne garantit pas son octroi ; les politiques de session Keycloak restent applicables.",
        });
        return credential;
      });
    },
    async refresh(credential, signal) {
      assertBinding(c, credential);
      if (!tokenString(credential.refresh))
        throw new SafeError("refresh", "Refresh token invalide. Refaites /login.");
      // Pi holds CredentialStore.modify across this exchange and persistence. Pi < 1.0.3 still
      // drops the result when the caller cancels: reuse that rotation instead of replaying a
      // refresh token Keycloak has already revoked.
      const replaced = digest(credential.refresh);
      const rotated = rotations.get(replaced);
      if (rotated && rotated.expires - runtime.now() > ROTATION_REUSE_MIN_MS) {
        log("info", "refresh_reused");
        return rotated;
      }
      const current = rotated ?? credential;
      log("debug", "refresh_start");
      const d = await discover(c, runtime, signal);
      // Once sent, the exchange may rotate the token server side: let it finish within its own
      // request timeout rather than abandon the only valid refresh token on cancellation.
      const next = await exchangeTokens(
        c,
        d,
        { grant_type: "refresh_token", refresh_token: current.refresh },
        runtime,
        new AbortController().signal,
        log,
        current,
      );
      remember(replaced, next);
      if (rotated) remember(digest(current.refresh), next);
      log("info", "refresh_success");
      return next;
    },
    async toAuth(credential) {
      assertBinding(c, credential);
      if (!tokenString(credential.access) || credential.expires <= runtime.now())
        throw new SafeError(
          "token",
          "Access token expiré ou invalide. Refaites /login si le refresh échoue.",
        );
      return { apiKey: credential.access, baseUrl: c.baseUrl };
    },
  };
  const builtin = c.api === "openai-completions" ? openAICompletionsApi() : openAIResponsesApi();
  const stream = (
    mode: "stream" | "streamSimple",
    model: Model<Api>,
    transcript: TranscriptContext,
    options?: StreamOptions,
  ) =>
    lazyStream(model, async () =>
      (async function* () {
        const deadline = new AbortController();
        const timeout = setTimeout(() => deadline.abort(), c.gatewayTimeoutSeconds * 1000);
        const signal = options?.signal
          ? AbortSignal.any([options.signal, deadline.signal])
          : deadline.signal;
        let failure: string | undefined;
        try {
          const secured = {
            ...options,
            ...secureOptions(c, model, options, runtime.fetch, (message) => {
              failure = message;
            }),
            signal,
          };
          for await (const event of builtin[mode](model, transcript, secured)) {
            if (event.type === "error") {
              // A server may echo secrets in an SSE error. Preserve Pi's stream structure,
              // but expose only our controlled diagnostics, including on terminal events.
              event.error.errorMessage = deadline.signal.aborted
                ? "Délai total du streaming dépassé."
                : event.reason === "aborted"
                  ? "Requête annulée."
                  : (failure ??
                    "Réponse gateway invalide ou streaming interrompu (détails serveur masqués).");
            }
            yield event;
          }
        } catch (error) {
          if (error instanceof SafeError) throw error;
          throw new SafeError("stream", "Échec du streaming Agent Gateway (détails masqués).");
        } finally {
          clearTimeout(timeout);
        }
      })(),
    );
  const api: ProviderStreams = {
    stream: (model, context, options) => stream("stream", model, context, options),
    streamSimple: (model, context, options) => stream("streamSimple", model, context, options),
  };
  return createProvider<GatewayApi>({
    id: c.providerId,
    name: `Agent Gateway – ${c.name}`,
    baseUrl: c.baseUrl,
    auth: { oauth },
    api,
    models: c.models.map(({ validated: _validated, ...m }) => ({
      ...m,
      api: c.api,
      provider: c.providerId,
      baseUrl: c.baseUrl,
    })),
  });
}
