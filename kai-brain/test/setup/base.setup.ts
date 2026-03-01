import { mkdirSync } from "node:fs";
import { join } from "node:path";

process.env.NODE_ENV = "test";
process.env.AVA_TEST_MODE = "1";
process.env.TZ ??= "UTC";
process.env.AVA_LIVE_TESTS ??= "0";
process.env.AVA_LIVE_TEST_ALLOW ??= "";
process.env.AVA_LIVE_TIMEOUT_MS ??= "120000";
process.env.AVA_E2E_WORKERS ??= "1";
process.env.AVA_AUTH_REQUIRED ??= "1";
process.env.AVA_WS_ALLOW_QUERY_TOKEN ??= "1";
process.env.AVA_AUTH_ISSUER ??= "";
process.env.AVA_AUTH_AUDIENCE ??= "";

process.env.JWT_SECRET ??= "ava-test-jwt-secret";
process.env.CREDENTIAL_ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

process.env.DATABASE_URL ??=
  process.env.AVA_TEST_DB_URL ??
  "postgresql://ava:ava_dev_password@localhost:5433/ava_dev";

process.env.VERTEX_AI_PROJECT_ID ??= "ava-test-project";
process.env.VERTEX_AI_SERVICE_ACCOUNT_KEY ??=
  '{"type":"service_account","project_id":"ava-test-project"}';

process.env.SLACK_SIGNING_SECRET ??= "test-signing-secret";
process.env.SLACK_BOT_TOKEN ??= "xoxb-test-token";

process.env.AVA_CONFIG_PATH ??= join(
  process.cwd(),
  "test/fixtures/config.test.json",
);

process.env.SANDBOX_MODE ??= "off";
process.env.SANDBOX_SCOPE ??= "user";
process.env.SANDBOX_NETWORK ??= "none";
process.env.SANDBOX_WORKDIR ??= "/workspace";

mkdirSync(join(process.cwd(), ".scratch"), { recursive: true });
mkdirSync(join(process.cwd(), ".scratch", "state"), { recursive: true });
mkdirSync(join(process.cwd(), ".scratch", "workspace"), { recursive: true });

process.env.AVA_STATE_DIR ??= join(process.cwd(), ".scratch", "state");
process.env.AVA_WORKSPACE_DIR ??= join(process.cwd(), ".scratch", "workspace");
