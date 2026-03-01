import dotenv from "dotenv";
dotenv.config();

import { GoogleAuth } from "google-auth-library";

const PROJECT_ID = process.env.VERTEX_AI_PROJECT_ID!;
const LOCATION = process.argv[2] || "us-east5";
const MODEL = process.argv[3] || "claude-opus-4-6@default";

async function main() {
  console.log(`Testing ${MODEL} on Vertex AI`);
  console.log(`Project: ${PROJECT_ID}, Location: ${LOCATION}\n`);

  // Parse service account key from env
  const saKey = process.env.VERTEX_AI_SERVICE_ACCOUNT_KEY;
  if (!saKey) {
    console.error("VERTEX_AI_SERVICE_ACCOUNT_KEY not set");
    process.exit(1);
  }

  const credentials = JSON.parse(saKey);
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

  const client = await auth.getClient();
  const token = await client.getAccessToken();

  const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/anthropic/models/${MODEL}:rawPredict`;

  console.log(`Endpoint: ${endpoint}\n`);

  const body = {
    anthropic_version: "vertex-2023-10-16",
    messages: [{ role: "user", content: "Say hello in one sentence." }],
    max_tokens: 128,
  };

  const start = Date.now();
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const elapsed = Date.now() - start;
  const data = (await res.json()) as Record<string, any>;

  if (!res.ok) {
    console.error(`FAILED (${res.status} ${res.statusText}) [${elapsed}ms]`);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log(`SUCCESS [${elapsed}ms]`);
  console.log(`Model: ${data.model}`);
  console.log(`Stop reason: ${data.stop_reason}`);
  console.log(`Usage: ${JSON.stringify(data.usage)}`);
  console.log(`\nResponse: ${data.content?.[0]?.text}`);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
