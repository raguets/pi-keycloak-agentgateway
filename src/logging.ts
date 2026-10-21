export type LogLevel = "error" | "warn" | "info" | "debug";
export type LogEvent =
  | "config_invalid"
  | "provider_registered"
  | "discovery_start"
  | "login_success"
  | "refresh_start"
  | "refresh_success"
  | "refresh_reused"
  | "offline_unconfirmed";

/** Allowlisted events only: no arbitrary errors, URLs, credentials or payloads accepted. */
export function createLogger(
  level: LogLevel = "warn",
  sink: (line: string) => void = (line) => console.error(line),
) {
  const levels: LogLevel[] = ["error", "warn", "info", "debug"];
  return (severity: LogLevel, event: LogEvent) => {
    if (levels.indexOf(severity) <= levels.indexOf(level))
      sink(`[agentgateway] ${severity} ${event}`);
  };
}
export type Logger = ReturnType<typeof createLogger>;
