import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import { checkPiVersion } from "./compat.js";
import { type Configuration, loadConfig } from "./config.js";
import { diagnose } from "./diagnostics.js";
import { SafeError, safeMessage } from "./errors.js";
import { createLogger } from "./logging.js";
import { createGatewayProvider } from "./provider.js";

/** Pi awaits async extension factories before selecting startup models. */
export default async function extension(pi: ExtensionAPI): Promise<void> {
  let config: Configuration | undefined;
  let configurationError: string | undefined;
  const compatibility = checkPiVersion(VERSION);
  try {
    if (!compatibility.supported)
      throw new SafeError("version", compatibility.message ?? "Version de Pi non prise en charge.");
    config = await loadConfig();
    const log = createLogger(config.logLevel);
    for (const c of config.contexts) {
      pi.registerProvider(createGatewayProvider(c, { log }));
      log("info", "provider_registered");
    }
  } catch (error) {
    configurationError = safeMessage(error);
    createLogger()("error", "config_invalid");
  }
  pi.on("session_start", async (_event, ctx) => {
    if (configurationError) ctx.ui.notify(configurationError, "error");
    else if (compatibility.message) ctx.ui.notify(compatibility.message, "warning");
  });
  pi.registerCommand("agentgateway-doctor", {
    description: "Vérifier configuration, OIDC, horloge et gateway sans envoyer de token",
    handler: async (_args, ctx) => {
      if (!config) {
        ctx.ui.notify(configurationError ?? "Configuration absente.", "error");
        return;
      }
      const report = await diagnose(
        config,
        (id) => ctx.modelRegistry.getProviderAuthStatus(id).configured,
      );
      const host = { version: VERSION, compatibilite: compatibility.message ?? "testée" };
      ctx.ui.notify(JSON.stringify({ pi: host, contextes: report }, null, 2), "info");
    },
  });
}
