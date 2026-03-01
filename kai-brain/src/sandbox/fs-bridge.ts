import { execa } from "execa";

export interface FsBridge {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
  fileExists(path: string): Promise<boolean>;
}

/**
 * Creates a filesystem bridge that operates on files inside a Docker container
 * via `docker exec`. Used when exec runs sandboxed so file tools can still
 * access the container's filesystem.
 */
export function createDockerFsBridge(containerName: string): FsBridge {
  return {
    async readFile(path: string): Promise<string> {
      const result = await execa("docker", ["exec", containerName, "cat", path], {
        reject: false,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to read ${path}: ${result.stderr}`);
      }
      return result.stdout;
    },

    async writeFile(path: string, content: string): Promise<void> {
      const result = await execa("docker", ["exec", "-i", containerName, "tee", path], {
        input: content,
        reject: false,
        stdout: "ignore",
      });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to write ${path}: ${result.stderr}`);
      }
    },

    async listDir(path: string): Promise<string[]> {
      const result = await execa("docker", ["exec", containerName, "ls", "-1", path], {
        reject: false,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to list ${path}: ${result.stderr}`);
      }
      return result.stdout
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
    },

    async fileExists(path: string): Promise<boolean> {
      const result = await execa("docker", ["exec", containerName, "test", "-e", path], {
        reject: false,
      });
      return result.exitCode === 0;
    },
  };
}
