import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createGatewayProvider } from "../../dist/provider.js";

const [authPath, config, origin] = process.argv.slice(2);
const c = JSON.parse(config);
const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
runtime.registerNativeProvider(
  createGatewayProvider(c, {
    runtime: {
      fetch: (url, init) => {
        const u = new URL(url);
        if (u.origin !== new URL(c.issuer).origin) throw new Error("Unexpected test origin");
        return fetch(`${origin}${u.pathname}`, init);
      },
    },
  }),
);
process.send({ ready: true });
await new Promise((done) => process.once("message", done));
try {
  const auth = await runtime.getAuth(c.providerId);
  process.send({ ok: auth.auth.apiKey === "PROCESS.ACCESS" });
} catch {
  process.send({ ok: false });
  process.exitCode = 1;
}
process.disconnect();
