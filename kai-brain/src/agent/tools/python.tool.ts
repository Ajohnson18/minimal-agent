/**
 * Python Execution Tool
 *
 * Allows the agent to execute Python code in a secure Docker sandbox.
 * Use for data analysis, calculations, chart generation, and other compute tasks.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import {
  executePython,
  formatPythonResult,
  isSandboxReady,
} from "../../sandbox/index.js";
import { execInContainer } from "../../sandbox/container-manager.js";
import { writeFileDocker } from "../../sandbox/docker-operations.js";
import { buildExecEnv } from "../../lib/exec-security.js";
import type { UserCredentials } from "../../db/schema/users.js";
import { randomUUID } from "node:crypto";

const PythonExecSchema = Type.Object({
  code: Type.String({
    description:
      "Python code to execute. Has access to pandas, numpy, matplotlib, seaborn, scipy, scikit-learn.",
  }),
  timeout: Type.Optional(
    Type.Number({
      description: "Maximum execution time in seconds (default: 60, max: 120)",
      minimum: 1,
      maximum: 120,
    })
  ),
  input_files: Type.Optional(
    Type.Array(
      Type.Object({
        filename: Type.String({ description: "Name of the file" }),
        content: Type.String({ description: "Content of the file" }),
      }),
      {
        description:
          "Input files to make available. The script can read these from the current directory.",
      }
    )
  ),
});

type PythonExecArgs = Static<typeof PythonExecSchema>;

export function createPythonTool(options?: {
  sandboxContainer?: string;
  userCredentials?: UserCredentials | null;
}): ToolDefinition {
  const sandboxContainer = options?.sandboxContainer;
  const userCredentials = options?.userCredentials;

  return {
    name: "python_exec",
    label: "Python",
    description: `Execute Python code in a secure sandbox for data analysis and computation.

Available packages: pandas, numpy, matplotlib, seaborn, scipy, scikit-learn, requests, beautifulsoup4, openpyxl, xlrd, pyyaml, yfinance

Use cases:
- Analyze CSV/Excel data
- Perform calculations
- Generate charts (save to PNG files)
- Process text/data
- Machine learning tasks
- Fetch stock data with yfinance

Network access is enabled for fetching data. To save output files, write them to the current directory.

Example:
\`\`\`python
import pandas as pd
import matplotlib.pyplot as plt

# Read data
df = pd.DataFrame({'x': [1,2,3], 'y': [4,5,6]})

# Analyze
print(df.describe())

# Create chart
plt.plot(df['x'], df['y'])
plt.savefig('chart.png')
print("Chart saved to chart.png")
\`\`\``,
    parameters: PythonExecSchema,
    execute: async (
      _toolCallId: string,
      args: PythonExecArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown
    ): Promise<AgentToolResult<unknown>> => {
      // Check abort signal before executing
      if (_signal?.aborted) {
        return {
          content: [{ type: "text", text: "Python execution aborted" }],
          details: { aborted: true },
        };
      }

      try {
        // Sandbox mode: execute in session container
        if (sandboxContainer) {
          return await executePythonInSandbox(sandboxContainer, args, userCredentials);
        }

        // Host mode: use ephemeral containers (existing behavior)
        const ready = await isSandboxReady();
        if (!ready) {
          return {
            content: [
              {
                type: "text",
                text: "Python execution is not available. Docker must be installed and running.",
              },
            ],
            details: { error: "Docker not available" },
          };
        }

        // Execute code
        const timeoutMs = (args.timeout || 60) * 1000;
        // Convert array of {filename, content} to Record<string, string>
        const filesRecord: Record<string, string> = {};
        if (args.input_files) {
          for (const f of args.input_files) {
            filesRecord[f.filename] = f.content;
          }
        }
        const result = await executePython(args.code, {
          timeoutMs,
          files: Object.keys(filesRecord).length > 0 ? filesRecord : undefined,
        });

        // Format result for agent
        const formattedResult = formatPythonResult(result);

        return {
          content: [{ type: "text", text: formattedResult }],
          details: {
            success: result.success,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            outputFiles: Object.keys(result.outputFiles),
            binaryFiles: Object.keys(result.binaryFilePaths),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text", text: `Python execution error: ${message}` },
          ],
          details: { error: message },
        };
      }
    },
  };
}

/**
 * Execute Python in sandbox mode (session container)
 */
async function executePythonInSandbox(
  container: string,
  args: PythonExecArgs,
  userCredentials?: UserCredentials | null,
): Promise<AgentToolResult<unknown>> {
  const scriptId = randomUUID().slice(0, 8);
  const scriptPath = `/workspace/python_${scriptId}.py`;
  const startTime = Date.now();
  const env = buildExecEnv(process.env, undefined, userCredentials);

  try {
    // 1. Write input files (if provided)
    if (args.input_files) {
      for (const file of args.input_files) {
        await writeFileDocker(
          container,
          `/workspace/${file.filename}`,
          file.content
        );
      }
    }

    // 2. Write Python script
    await writeFileDocker(container, scriptPath, args.code);

    // 3. Execute via existing execInContainer
    const result = await execInContainer(
      container,
      `python3 ${scriptPath}`,
      env,
      "/workspace",
      (args.timeout || 60) * 1000
    );

    // 4. List files created during execution (for agent convenience)
    const listResult = await execInContainer(
      container,
      `find /workspace -type f -newer ${scriptPath} 2>/dev/null || true`,
      env,
      "/workspace",
      5000
    );

    const createdFiles = listResult.stdout
      .split("\n")
      .filter((f) => f.trim() && f !== scriptPath)
      .map((f) => f.replace("/workspace/", ""));

    // 5. Cleanup script file
    await execInContainer(
      container,
      `rm -f ${scriptPath}`,
      env,
      "/workspace",
      5000
    );

    // 6. Format and return result
    const durationMs = Date.now() - startTime;
    return {
      content: [
        {
          type: "text",
          text: formatPythonOutputSandbox(result, createdFiles, durationMs),
        },
      ],
      details: {
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs,
        outputFiles: createdFiles,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Python execution failed: ${message}\n\nCheck that Python is installed in the sandbox image.`,
        },
      ],
      details: { error: message },
    };
  }
}

/**
 * Format Python output for sandbox mode
 */
function formatPythonOutputSandbox(
  result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean },
  createdFiles: string[],
  durationMs: number
): string {
  const parts: string[] = [];

  if (result.stdout) {
    parts.push("Output:");
    parts.push("```");
    parts.push(result.stdout.slice(0, 50000));
    parts.push("```");
  }

  if (result.stderr && result.exitCode !== 0) {
    parts.push("\nErrors:");
    parts.push("```");
    parts.push(result.stderr.slice(0, 10000));
    parts.push("```");
  }

  if (result.timedOut) {
    parts.push("\n⚠️ Execution timed out");
  }

  // List created files
  if (createdFiles.length > 0) {
    parts.push(`\nFiles created in /workspace:`);
    for (const file of createdFiles) {
      parts.push(`  - ${file}`);
    }
    parts.push("\nUse file tools (glob, read) to access these files.");
  }

  parts.push(`\nExecution time: ${durationMs}ms`);
  parts.push(`Exit code: ${result.exitCode}`);

  return parts.join("\n");
}
