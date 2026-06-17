import { z } from "zod";

// Parse + validate env once at boot. Fail fast on misconfig.
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  SESSION_COOKIE_NAME: z.string().default("eticket_session"),
  // base64 32-byte key for AES-256-GCM temp-password encryption
  TEMP_PW_ENC_KEY: z.string().min(1),
  STORAGE_DIR: z.string().default("./.storage"),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export const env = schema.parse(process.env);
export type Env = typeof env;
