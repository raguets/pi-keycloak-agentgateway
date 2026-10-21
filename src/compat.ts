/** Pi releases whose extension/auth APIs were inspected and run through the full test suite. */
export const TESTED_PI_VERSIONS = [
  "1.0.0",
  "1.0.1",
  "1.0.2",
  "1.0.3",
  "1.0.4",
  "1.1.0",
  "1.2.0",
  "1.3.0",
];

export interface PiCompatibility {
  supported: boolean;
  /** Controlled message: reason for refusal, or a warning for a supported but degraded version. */
  message?: string;
}

function parse(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Pi 1.x keeps the native provider contract used here (registerProvider(Provider), OAuthAuth,
 * pi-ai/compat streams). A new major may break it silently, so it is refused until validated.
 */
export function checkPiVersion(version: string): PiCompatibility {
  const tested = `${TESTED_PI_VERSIONS[0]} à ${TESTED_PI_VERSIONS.at(-1)}`;
  const v = parse(version);
  if (v?.[0] !== 1)
    return {
      supported: false,
      message: `Pi ${version} non pris en charge : cette extension requiert Pi 1.x (versions testées : ${tested}).`,
    };
  if (compare(v, [1, 0, 3]) < 0)
    return {
      supported: true,
      message: `Pi ${version} : annuler une requête pendant un refresh peut empêcher Pi d'enregistrer le token renouvelé. L'extension le réutilise dans cette session, mais un redémarrage immédiat imposera /login. Pi 1.0.3 ou ultérieur est recommandé.`,
    };
  const newest = parse(TESTED_PI_VERSIONS.at(-1) ?? "");
  if (newest && compare(v, newest) > 0)
    return {
      supported: true,
      message: `Pi ${version} est plus récent que les versions testées (${tested}). Signalez tout problème.`,
    };
  return { supported: true };
}
