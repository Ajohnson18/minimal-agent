import { execa } from "execa";
import type {
  ReadOperations,
  WriteOperations,
  EditOperations,
  LsOperations,
  FindOperations,
  GrepOperations,
} from "@mariozechner/pi-coding-agent";

function dockerExec(container: string, args: string[], input?: string) {
  const dockerArgs = input ? ["exec", "-i", container, ...args] : ["exec", container, ...args];
  return execa("docker", dockerArgs, {
    input,
    reject: false,
    timeout: 30_000,
  });
}

/**
 * Standalone helper to write a file in a Docker container.
 * Used by python.tool.ts for writing input files and scripts.
 */
export async function writeFileDocker(container: string, path: string, content: string): Promise<void> {
  const result = await dockerExec(container, ["tee", path], content);
  if (result.exitCode !== 0) {
    throw new Error(`Cannot write ${path}: ${result.stderr}`);
  }
}

export function createDockerOperations(containerName: string): {
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  ls: LsOperations;
  find: FindOperations;
  grep: GrepOperations;
} {
  const readFile = async (path: string): Promise<Buffer> => {
    const result = await dockerExec(containerName, ["cat", path]);
    if (result.exitCode !== 0) throw new Error(`Cannot read ${path}: ${result.stderr}`);
    return Buffer.from(result.stdout);
  };

  const writeFile = async (path: string, content: string): Promise<void> => {
    const result = await dockerExec(containerName, ["tee", path], content);
    if (result.exitCode !== 0) throw new Error(`Cannot write ${path}: ${result.stderr}`);
  };

  const access = async (path: string): Promise<void> => {
    const result = await dockerExec(containerName, ["test", "-r", path]);
    if (result.exitCode !== 0) throw new Error(`Cannot access ${path}: not readable`);
  };

  const mkdir = async (dir: string): Promise<void> => {
    await dockerExec(containerName, ["mkdir", "-p", dir]);
  };

  const exists = async (path: string): Promise<boolean> => {
    const result = await dockerExec(containerName, ["test", "-e", path]);
    return result.exitCode === 0;
  };

  const stat = async (path: string) => {
    const result = await dockerExec(containerName, ["stat", "--format=%F", path]);
    if (result.exitCode !== 0) throw new Error(`Cannot stat ${path}: ${result.stderr}`);
    const type = result.stdout.trim();
    return { isDirectory: () => type === "directory" };
  };

  const readdir = async (path: string): Promise<string[]> => {
    const result = await dockerExec(containerName, ["ls", "-1", path]);
    if (result.exitCode !== 0) throw new Error(`Cannot list ${path}: ${result.stderr}`);
    return result.stdout.split("\n").filter(Boolean);
  };

  const isDirectory = async (path: string): Promise<boolean> => {
    const result = await dockerExec(containerName, ["test", "-d", path]);
    return result.exitCode === 0;
  };

  const glob = async (
    pattern: string,
    cwd: string,
    options: { ignore: string[]; limit: number },
  ): Promise<string[]> => {
    const result = await dockerExec(containerName, [
      "find", cwd, "-maxdepth", "10", "-name", pattern, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*",
    ]);
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((p) => p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p)
      .slice(0, options.limit);
  };

  const readOps: ReadOperations = { readFile, access };
  const writeOps: WriteOperations = { writeFile, mkdir };
  const editOps: EditOperations = { readFile, writeFile, access };
  const lsOps: LsOperations = { exists, stat, readdir };
  const findOps: FindOperations = { exists, glob };
  const grepOps: GrepOperations = {
    isDirectory,
    readFile: async (path: string) => {
      const buf = await readFile(path);
      return buf.toString("utf-8");
    },
  };

  return {
    read: readOps,
    write: writeOps,
    edit: editOps,
    ls: lsOps,
    find: findOps,
    grep: grepOps,
  };
}
