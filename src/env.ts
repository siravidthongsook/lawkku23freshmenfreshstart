import { z } from "zod";

// Parse + validate env once at boot. Fail fast on misconfig.
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(33491),
  DATABASE_URL: z.string().url(),
  SESSION_COOKIE_NAME: z.string().default("lawkku_freshstart23_session"),
  // base64 32-byte key for AES-256-GCM temp-password encryption
  TEMP_PW_ENC_KEY: z.string().min(1),
  STORAGE_DIR: z.string().default("./.storage"),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Observability kill-switches: default ON, set "false" to disable (§14).
  OTEL_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  METRICS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // OTLP HTTP collector (Tempo). App must boot even if unreachable.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default("http://tempo:4318"),
});

export const env = schema.parse(process.env);
export type Env = typeof env;
