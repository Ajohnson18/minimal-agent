import { beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workerRoot = "";

beforeAll(() => {
  const workerId = process.env.VITEST_WORKER_ID ?? "0";
  workerRoot = join(
    tmpdir(),
    "ava-agent-e2e",
    `worker-${workerId}-${process.pid}`,
  );

  rmSync(workerRoot, { recursive: true, force: true });
  mkdirSync(workerRoot, { recursive: true });
  mkdirSync(join(workerRoot, "state"), { recursive: true });
  mkdirSync(join(workerRoot, "workspace"), { recursive: true });
  mkdirSync(join(workerRoot, "skills"), { recursive: true });

  process.env.AVA_STATE_DIR = join(workerRoot, "state");
  process.env.AVA_WORKSPACE_DIR = join(workerRoot, "workspace");
  process.env.SKILLS_DIR = join(workerRoot, "skills");
  process.env.AVA_E2E_ROOT = workerRoot;
});

afterAll(() => {
  if (!workerRoot) return;
  rmSync(workerRoot, { recursive: true, force: true });
});
