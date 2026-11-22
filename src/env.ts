import { spawn } from "node:child_process";
import { appendFile, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const XCODE_DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";
export const LOG_FILE_PATH = "/tmp/renew-ios-sideloads.log";

export function expandHome(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function shortenHome(absPath: string): string {
  const home = homedir();
  if (absPath === home) return "~";
  if (absPath.startsWith(`${home}/`)) return `~${absPath.slice(home.length)}`;
  return absPath;
}

export function splitSemicolonList(raw?: string): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const expanded = expandHome(trimmed);
    if (seen.has(expanded)) continue;
    seen.add(expanded);
    result.push(expanded);
  }
  return result;
}

export interface ShimEnvironment {
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

/**
 * Create temporary Xcode shims so tools like `tauri ios build` that query
 * `xcode-select -p` work even when system xcode-select points to CommandLineTools.
 */
export async function createShimEnv(teamId?: string): Promise<ShimEnvironment> {
  const shimDir = await mkdtemp(join(tmpdir(), "ios-sideload-shims-"));

  const xcodeSelectShim = [
    "#!/bin/sh",
    'if [ "$1" = "-p" ] || [ "$1" = "--print-path" ]; then',
    `  echo "${XCODE_DEVELOPER_DIR}"`,
    "  exit 0",
    "fi",
    'exec /usr/bin/xcode-select "$@"',
    "",
  ].join("\n");

  const xcodebuildShim = [
    "#!/bin/sh",
    `export DEVELOPER_DIR=${XCODE_DEVELOPER_DIR}`,
    `exec ${XCODE_DEVELOPER_DIR}/usr/bin/xcodebuild "$@"`,
    "",
  ].join("\n");

  const xcrunShim = [
    "#!/bin/sh",
    `export DEVELOPER_DIR=${XCODE_DEVELOPER_DIR}`,
    'exec /usr/bin/xcrun "$@"',
    "",
  ].join("\n");

  const files: Array<[string, string]> = [
    [join(shimDir, "xcode-select"), xcodeSelectShim],
    [join(shimDir, "xcodebuild"), xcodebuildShim],
    [join(shimDir, "xcrun"), xcrunShim],
  ];

  await Promise.all(
    files.map(async ([filePath, content]) => {
      await writeFile(filePath, content, "utf8");
      await chmod(filePath, 0o755);
    }),
  );

  const user = process.env.USER || userInfo().username;
  const home = homedir();
  const basePath = [
    shimDir,
    "/opt/homebrew/opt/rustup/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    `${home}/.nix-profile/bin`,
    `/etc/profiles/per-user/${user}/bin`,
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVELOPER_DIR: XCODE_DEVELOPER_DIR,
    PATH: basePath,
    ...(teamId ? { APPLE_DEVELOPMENT_TEAM: teamId } : {}),
  };

  return {
    env,
    cleanup: async () => {
      await rm(shimDir, { recursive: true, force: true });
    },
  };
}

export interface CommandResult {
  code: number;
  output: string;
}

export interface RunCommandOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  extraEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  logFile?: string;
  onOutput?: (chunk: string) => void;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  return spawnWithStreaming(command, args, false, options);
}

export async function runShellCommand(
  script: string,
  options: RunCommandOptions,
): Promise<CommandResult> {
  return spawnWithStreaming("/bin/bash", ["-lc", script], false, options);
}

async function spawnWithStreaming(
  command: string,
  args: string[],
  shell: boolean,
  options: RunCommandOptions,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.extraEnv ? { ...options.env, ...options.extraEnv } : options.env,
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let combined = "";
    let writeChain = Promise.resolve();

    const pushChunk = (data: Buffer | string) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      combined += text;
      options.onOutput?.(text);
      if (options.logFile) {
        const target = options.logFile;
        writeChain = writeChain.then(() => appendFile(target, text, "utf8")).catch(() => {});
      }
    };

    child.stdout?.on("data", pushChunk);
    child.stderr?.on("data", pushChunk);

    const onAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1500);
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", async (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      await writeChain;
      reject(error);
    });

    child.on("close", async (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      await writeChain;
      if (options.signal?.aborted) {
        reject(new Error("Cancelled"));
        return;
      }
      resolve({ code: code ?? 1, output: combined });
    });
  });
}
