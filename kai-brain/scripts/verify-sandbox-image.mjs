#!/usr/bin/env node
import { execa } from "execa";

const image = process.env.SANDBOX_IMAGE ?? "ava-sandbox-exec";

async function runStep(label, command, args, options = {}) {
  process.stdout.write(`[sandbox-verify] ${label}\n`);
  try {
    await execa(command, args, {
      ...options,
    });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String(error.stderr ?? "")
      : "";
    const stdout = error && typeof error === "object" && "stdout" in error
      ? String(error.stdout ?? "")
      : "";
    process.stderr.write(`[sandbox-verify] failed: ${label}\n`);
    if (stdout.trim().length > 0) {
      process.stderr.write(`${stdout.trim()}\n`);
    }
    if (stderr.trim().length > 0) {
      process.stderr.write(`${stderr.trim()}\n`);
    }
    throw error;
  }
}

await runStep("checking Docker availability", "docker", ["info"]);
await runStep("checking sandbox image exists", "docker", ["image", "inspect", image]);
await runStep(
  "checking required runtime capabilities in sandbox image",
  "docker",
  [
    "run",
    "--rm",
    image,
    "sh",
    "-lc",
    [
      "python3 --version",
      "node --version",
      "git --version",
      "rg --version",
      "python3 -c \"import requests,pandas,numpy,matplotlib; print('python-capabilities-ok')\"",
    ].join(" && "),
  ],
  { stdio: "inherit" },
);

process.stdout.write(`[sandbox-verify] image '${image}' passed verification\n`);
