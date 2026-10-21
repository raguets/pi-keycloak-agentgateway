import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SafeError } from "./errors.js";
import type { LogLevel } from "./logging.js";

export type GatewayApi = "openai-completions" | "openai-responses";
export interface GatewayModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
  reasoning: boolean;
  validated: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
export interface GatewayContext {
  name: string;
  providerId: string;
  baseUrl: string;
  api: GatewayApi;
  issuer: string;
  clientId: string;
  scopes: string[];
  callbackHost: "127.0.0.1";
  callbackPort: number;
  redirectPath: string;
  browserTimeoutSeconds: number;
  deviceTimeoutSeconds: number;
  requestTimeoutSeconds: number;
  gatewayTimeoutSeconds: number;
  refreshLeewaySeconds: number;
  enableDevice: boolean;
  enableManual: boolean;
  reuseRefreshTokenWhenOmitted: boolean;
  models: GatewayModel[];
}
export interface Configuration {
  contexts: GatewayContext[];
  logLevel: LogLevel;
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(label, "objet attendu");
  return value as Record<string, unknown>;
}
function fail(label: string, reason: string): never {
  throw new SafeError("config", `Configuration : ${label} : ${reason}.`);
}
function keys(object: Record<string, unknown>, allowed: string[], label: string) {
  if (Object.keys(object).some((key) => !allowed.includes(key)))
    fail(label, "champ inconnu ou sensible interdit ; consulter le schéma");
}
function string(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Explicitly reject control characters.
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail(label, "chaîne non vide sans caractères de contrôle attendue");
  return value;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    fail(label, `entier attendu entre ${min} et ${max}`);
  return value;
}
function bool(value: unknown, label: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "boolean") fail(label, "booléen attendu");
  return value;
}
export function httpsUrl(value: unknown, label: string, allowQuery = false): URL {
  const raw = string(value, label);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(label, "URL HTTPS attendue");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (!allowQuery && url.search) ||
    raw.includes("\\")
  )
    fail(label, "HTTPS requis, sans identifiants, fragment ni paramètres inattendus");
  return url;
}
function model(value: unknown, label: string): GatewayModel {
  const raw = record(value, label);
  keys(
    raw,
    ["id", "name", "contextWindow", "maxTokens", "input", "reasoning", "validated", "cost"],
    label,
  );
  const id = string(raw.id, `${label}.id`);
  const validated = bool(raw.validated, `${label}.validated`, false);
  if (validated && /RENSEIGNER|PLACEHOLDER|VALIDER/i.test(id))
    fail(`${label}.id`, "placeholder non validable");
  const contextWindow = integer(raw.contextWindow, `${label}.contextWindow`, 1, 100_000_000);
  const maxTokens = integer(raw.maxTokens, `${label}.maxTokens`, 1, contextWindow);
  if (
    !Array.isArray(raw.input) ||
    !raw.input.length ||
    raw.input.some((x) => x !== "text" && x !== "image")
  )
    fail(`${label}.input`, "liste de text/image attendue");
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (raw.cost !== undefined) {
    const c = record(raw.cost, `${label}.cost`);
    keys(c, Object.keys(cost), `${label}.cost`);
    for (const key of Object.keys(cost) as (keyof typeof cost)[]) {
      const v = c[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
        fail(`${label}.cost`, "coûts positifs ou nuls requis");
      cost[key] = v;
    }
  }
  return {
    id,
    name: string(raw.name, `${label}.name`),
    contextWindow,
    maxTokens,
    input: [...new Set(raw.input)] as GatewayModel["input"],
    reasoning: bool(raw.reasoning, `${label}.reasoning`),
    validated,
    cost,
  };
}
function context(value: unknown, index: number): GatewayContext {
  const label = `contexts[${index}]`;
  const raw = record(value, label);
  keys(
    raw,
    [
      "name",
      "providerId",
      "baseUrl",
      "api",
      "issuer",
      "clientId",
      "scopes",
      "callbackHost",
      "callbackPort",
      "redirectPath",
      "browserTimeoutSeconds",
      "deviceTimeoutSeconds",
      "requestTimeoutSeconds",
      "gatewayTimeoutSeconds",
      "refreshLeewaySeconds",
      "enableDevice",
      "enableManual",
      "reuseRefreshTokenWhenOmitted",
      "models",
    ],
    label,
  );
  const name = string(raw.name, `${label}.name`);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))
    fail(`${label}.name`, "nom sûr en minuscules attendu");
  const providerId =
    raw.providerId === undefined
      ? `agentgateway-${name}`
      : string(raw.providerId, `${label}.providerId`);
  if (!/^agentgateway-[a-z0-9][a-z0-9_-]{0,63}$/.test(providerId))
    fail(`${label}.providerId`, "préfixe agentgateway- et nom sûr requis");
  if (raw.api !== "openai-completions" && raw.api !== "openai-responses")
    fail(`${label}.api`, "contrat explicite openai-completions ou openai-responses requis");
  const baseUrl = httpsUrl(raw.baseUrl, `${label}.baseUrl`).href.replace(/\/+$/, "");
  const issuer = httpsUrl(raw.issuer, `${label}.issuer`).href.replace(/\/+$/, "");
  const clientId = string(raw.clientId, `${label}.clientId`);
  if (raw.callbackHost !== undefined && raw.callbackHost !== "127.0.0.1")
    fail(`${label}.callbackHost`, "seul 127.0.0.1 est autorisé");
  const redirectPath =
    raw.redirectPath === undefined
      ? "/callback"
      : string(raw.redirectPath, `${label}.redirectPath`);
  if (!/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(redirectPath))
    fail(`${label}.redirectPath`, "chemin absolu simple attendu");
  const scopes = raw.scopes ?? ["openid", "offline_access"];
  if (
    !Array.isArray(scopes) ||
    scopes.some((s) => typeof s !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s))
  )
    fail(`${label}.scopes`, "liste de scopes OAuth attendue");
  if (!Array.isArray(raw.models) || !raw.models.length)
    fail(`${label}.models`, "au moins un modèle explicite requis");
  const models = raw.models.map((m, i) => model(m, `${label}.models[${i}]`));
  if (new Set(models.map((m) => m.id)).size !== models.length)
    fail(`${label}.models`, "IDs dupliqués");
  const seconds = (key: string, fallback: number, max = 3600) =>
    integer(raw[key] ?? fallback, `${label}.${key}`, 1, max);
  return {
    name,
    providerId,
    baseUrl,
    issuer,
    clientId,
    api: raw.api,
    scopes: [...new Set(["openid", ...scopes])],
    callbackHost: "127.0.0.1",
    callbackPort: integer(raw.callbackPort ?? 49170, `${label}.callbackPort`, 1, 65535),
    redirectPath,
    browserTimeoutSeconds: seconds("browserTimeoutSeconds", 300),
    deviceTimeoutSeconds: seconds("deviceTimeoutSeconds", 600),
    requestTimeoutSeconds: seconds("requestTimeoutSeconds", 10, 120),
    gatewayTimeoutSeconds: seconds("gatewayTimeoutSeconds", 300),
    refreshLeewaySeconds: integer(
      raw.refreshLeewaySeconds ?? 30,
      `${label}.refreshLeewaySeconds`,
      0,
      300,
    ),
    enableDevice: bool(raw.enableDevice, `${label}.enableDevice`, false),
    enableManual: bool(raw.enableManual, `${label}.enableManual`, false),
    reuseRefreshTokenWhenOmitted: bool(
      raw.reuseRefreshTokenWhenOmitted,
      `${label}.reuseRefreshTokenWhenOmitted`,
      false,
    ),
    models,
  };
}
export function parseConfig(value: unknown): Configuration {
  const raw = record(value, "racine");
  keys(raw, ["$schema", "contexts", "logLevel"], "racine");
  if (raw.$schema !== undefined) string(raw.$schema, "$schema");
  if (!Array.isArray(raw.contexts) || !raw.contexts.length)
    fail("contexts", "liste non vide requise");
  const contexts = raw.contexts.map(context);
  if (
    new Set(contexts.map((c) => c.name)).size !== contexts.length ||
    new Set(contexts.map((c) => c.providerId)).size !== contexts.length
  )
    fail("contexts", "noms et providerId doivent être uniques");
  const logLevel = raw.logLevel ?? "warn";
  if (typeof logLevel !== "string" || !["error", "warn", "info", "debug"].includes(logLevel))
    fail("logLevel", "niveau inconnu");
  return { contexts, logLevel: logLevel as LogLevel };
}
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const path =
    env.PI_KEYCLOAK_CONFIG ??
    join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "keycloak-agentgateway.json");
  return resolve(
    path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path,
  );
}
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Configuration> {
  let text: string;
  try {
    text = env.PI_KEYCLOAK_CONFIG_JSON ?? (await readFile(configPath(env), "utf8"));
  } catch {
    throw new SafeError(
      "config",
      "Fichier keycloak-agentgateway.json absent ou illisible. Définissez PI_KEYCLOAK_CONFIG.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new SafeError("config", "Configuration JSON invalide (contenu masqué).");
  }
  return parseConfig(value);
}
export function contextFingerprint(c: GatewayContext): string {
  return createHash("sha256")
    .update(
      JSON.stringify([c.providerId, c.baseUrl, c.issuer, c.clientId, c.api, [...c.scopes].sort()]),
    )
    .digest("hex");
}
export function redirectUri(c: GatewayContext): string {
  return `http://127.0.0.1:${c.callbackPort}${c.redirectPath}`;
}
