import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1),

  // Vertex AI credentials
  VERTEX_AI_PROJECT_ID: z.string().min(1).optional(),
  VERTEX_AI_SERVICE_ACCOUNT_KEY: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

  // API keys
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  EXA_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),

  // Slack credentials
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),

  // Security
  JWT_SECRET: z.string().min(1),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  // External DB connections
  SOMETHINGS_DB_URL: z.string().optional(),

  // User system
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  AVA_OWNER_SLACK_ID: z.string().optional(),

  // Langfuse tracing
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
});

function parseEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Environment validation failed:");
    for (const error of result.error.errors) {
      console.error(`  ${error.path.join(".")}: ${error.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

export const env = parseEnv();
