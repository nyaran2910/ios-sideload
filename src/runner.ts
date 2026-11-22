import { appendFile, writeFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import { createShimEnv, LOG_FILE_PATH, runCommand, runShellCommand } from "./env";
import { evictStaleCachedProfiles, renewAppProvisioning } from "./provisioning";
import type { DeviceInfo, ProjectPlan, ProjectRunState } from "./types";

export interface RunOptions {
  plans: ProjectPlan[];
  device: DeviceInfo;
  teamId: string;
  launchAfterInstall: boolean;
  signal: AbortSignal;
  onUpdate: (projectId: string, state: ProjectRunState) => void;
}

export interface RunSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  cancelled: boolean;
}

export async function executePlans({
  plans,
  device,
  teamId,
  launchAfterInstall,
  signal,
  onUpdate,
}: RunOptions): Promise<RunSummary> {
  const header = [
    `=== iOS Sideload Run (${new Date().toISOString()}) ===`,
    `Device UDID: ${device.udid} (${device.name})`,
    `Team ID:     ${teamId}`,
    `Log file:    ${LOG_FILE_PATH}`,
    "",
  ].join("\n");
  await writeFile(LOG_FILE_PATH, header, "utf8");

  const shim = await createShimEnv(teamId);
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let cancelled = false;

  try {
    for (const plan of plans) {
      const id = plan.project.id;

      if (signal.aborted) {
        cancelled = true;
        break;
      }

      if (plan.action === "skip" || plan.action === "blocked") {
        skipped += 1;
        onUpdate(id, {
          status: plan.action === "blocked" ? "failed" : "skipped",
          didBuild: false,
          didRenew: false,
          didInstall: false,
          log: plan.reason,
          error: plan.action === "blocked" ? plan.reason : undefined,
        });
        if (plan.action === "blocked") failed += 1;
        continue;
      }

      const startedAt = Date.now();
      let log = "";
      let didBuild = false;
      let didRenew = false;
      let didInstall = false;

      const appendLog = (chunk: string) => {
        log += chunk;
        if (log.length > 24_000) {
          log = log.slice(log.length - 24_000);
        }
      };

      const emit = (patch: Partial<ProjectRunState>) => {
        onUpdate(id, {
          status: "running",
          startedAt,
          didBuild,
          didRenew,
          didInstall,
          log,
          ...patch,
        });
      };

      const stepBanner = `\n=== ${plan.project.name} (${plan.action}) ===\n`;
      appendLog(stepBanner);
      await appendFile(LOG_FILE_PATH, stepBanner, "utf8").catch(() => {});

      const extraEnv: NodeJS.ProcessEnv = {
        DEVICE_ID: device.udid,
        TEAM_ID: teamId,
        APP_PATH: plan.project.appPath ?? "",
      };

      try {
        if (plan.action === "build-and-install") {
          if (plan.project.bundleId) {
            await evictStaleCachedProfiles(plan.project.bundleId, teamId, 60 * 60 * 1000, (msg) => {
              appendLog(msg);
              void appendFile(LOG_FILE_PATH, msg, "utf8").catch(() => {});
              emit({ phase: "provisioning" });
            });
          }

          if (plan.needsXcodegen && !plan.project.customBuildCommand) {
            emit({ phase: "xcodegen" });
            const msg = ">>> [xcodegen] xcodegen generate\n";
            appendLog(msg);
            await appendFile(LOG_FILE_PATH, msg, "utf8").catch(() => {});
            const genRes = await runCommand("xcodegen", ["generate"], {
              cwd: plan.project.dir,
              env: shim.env,
              extraEnv,
              signal,
              logFile: LOG_FILE_PATH,
              onOutput: (chunk) => {
                appendLog(chunk);
                emit({ phase: "xcodegen" });
              },
            });
            if (genRes.code !== 0) {
              throw new Error(`xcodegen failed (exit ${genRes.code})`);
            }
          }

          emit({ phase: "build" });
          const buildRes = await runBuildStep(plan, device.udid, teamId, shim.env, extraEnv, signal, (chunk) => {
            appendLog(chunk);
            emit({ phase: "build" });
          });
          if (buildRes.code !== 0) {
            throw new Error(`Build failed (exit ${buildRes.code})`);
          }
          didBuild = true;
          didRenew = true;
        } else if (plan.action === "renew-and-install") {
          if (!plan.project.appPath || !plan.project.bundleId) {
            throw new Error(`Cannot renew provisioning for ${plan.project.name}: missing .app path or bundle ID`);
          }
          emit({ phase: "provisioning" });
          await renewAppProvisioning({
            appPath: plan.project.appPath,
            bundleId: plan.project.bundleId,
            teamId,
            deviceUdid: device.udid,
            env: shim.env,
            signal,
            onOutput: (chunk) => {
              appendLog(chunk);
              emit({ phase: "provisioning" });
            },
          });
          didRenew = true;
        }

        emit({ phase: "install" });
        const installRes = await runInstallStep(plan, device.udid, shim.env, extraEnv, signal, (chunk) => {
          appendLog(chunk);
          emit({ phase: "install" });
        });
        if (installRes.code !== 0) {
          throw new Error(`Install failed (exit ${installRes.code}) — check USB/Wi-Fi connection & unlock iPhone`);
        }
        didInstall = true;

        if (launchAfterInstall && plan.project.bundleId) {
          emit({ phase: "launch" });
          const launchMsg = `>>> [launch] xcrun devicectl device process launch --device ${device.udid} ${plan.project.bundleId}\n`;
          appendLog(launchMsg);
          await appendFile(LOG_FILE_PATH, launchMsg, "utf8").catch(() => {});
          await runCommand(
            "xcrun",
            ["devicectl", "device", "process", "launch", "--device", device.udid, plan.project.bundleId],
            {
              cwd: plan.project.dir,
              env: shim.env,
              extraEnv,
              signal,
              logFile: LOG_FILE_PATH,
              onOutput: (chunk) => {
                appendLog(chunk);
                emit({ phase: "launch" });
              },
            },
          );
        }

        const finishedAt = Date.now();
        succeeded += 1;
        onUpdate(id, {
          status: "success",
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
          didBuild,
          didRenew,
          didInstall,
          log,
        });
      } catch (error) {
        const finishedAt = Date.now();
        if (signal.aborted) {
          cancelled = true;
          onUpdate(id, {
            status: "failed",
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt,
            didBuild,
            didRenew,
            didInstall,
            log,
            error: "Cancelled",
          });
          break;
        }
        failed += 1;
        onUpdate(id, {
          status: "failed",
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
          didBuild,
          didRenew,
          didInstall,
          log,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await shim.cleanup();
  }

  return {
    total: plans.length,
    succeeded,
    failed,
    skipped,
    cancelled,
  };
}

async function runBuildStep(
  plan: ProjectPlan,
  deviceUdid: string,
  teamId: string,
  env: NodeJS.ProcessEnv,
  extraEnv: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onOutput: (chunk: string) => void,
) {
  const { project } = plan;
  const header = `>>> [build] ${plan.buildCommandLabel}\n`;
  onOutput(header);
  await appendFile(LOG_FILE_PATH, header, "utf8").catch(() => {});

  if (project.customBuildCommand) {
    return runShellCommand(project.customBuildCommand, {
      cwd: project.dir,
      env,
      extraEnv,
      signal,
      logFile: LOG_FILE_PATH,
      onOutput,
    });
  }

  if (project.kind === "tauri-ios") {
    return runCommand("pnpm", ["tauri", "ios", "build", "--ci", "--archive-only"], {
      cwd: project.dir,
      env,
      extraEnv,
      signal,
      logFile: LOG_FILE_PATH,
      onOutput,
    });
  }

  if (project.kind === "makefile" && project.makefileTargets?.build) {
    return runCommand("make", [project.makefileTargets.build], {
      cwd: project.dir,
      env,
      extraEnv,
      signal,
      logFile: LOG_FILE_PATH,
      onOutput,
    });
  }

  if (!project.xcodeprojPath || !project.scheme) {
    throw new Error(`No Xcode project or custom build command found for ${project.name}`);
  }

  const projArg = relative(project.dir, project.xcodeprojPath) || project.xcodeprojPath;
  const ddArg = project.derivedDataPath
    ? relative(project.dir, project.derivedDataPath) || project.derivedDataPath
    : "DerivedData";

  const buildArgs = [
    "-project",
    projArg,
    "-scheme",
    project.scheme,
    "-configuration",
    "Debug",
    "-destination",
    `id=${deviceUdid}`,
    "-derivedDataPath",
    ddArg,
    "-allowProvisioningUpdates",
    ...(teamId ? [`DEVELOPMENT_TEAM=${teamId}`] : []),
    "build",
  ];

  return runCommand(
    "xcodebuild",
    buildArgs,
    {
      cwd: project.dir,
      env,
      extraEnv,
      signal,
      logFile: LOG_FILE_PATH,
      onOutput,
    },
  );
}

async function runInstallStep(
  plan: ProjectPlan,
  deviceUdid: string,
  env: NodeJS.ProcessEnv,
  extraEnv: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onOutput: (chunk: string) => void,
) {
  const { project } = plan;
  const header = `>>> [install] ${plan.installCommandLabel}\n`;
  onOutput(header);
  await appendFile(LOG_FILE_PATH, header, "utf8").catch(() => {});

  if (project.customInstallCommand) {
    return runShellCommand(project.customInstallCommand, {
      cwd: project.dir,
      env,
      extraEnv,
      signal,
      logFile: LOG_FILE_PATH,
      onOutput,
    });
  }

  if (project.kind === "makefile" && project.makefileTargets?.install) {
    return runCommand("make", [project.makefileTargets.install], {
      cwd: project.dir,
      env,
      extraEnv,
      signal,
      logFile: LOG_FILE_PATH,
      onOutput,
    });
  }

  if (!project.appPath) {
    throw new Error(`No .app bundle path configured or detected for ${project.name}`);
  }

  const appArg = relative(project.dir, project.appPath) || basename(project.appPath);
  return runCommand("xcrun", ["devicectl", "device", "install", "app", "--device", deviceUdid, appArg], {
    cwd: project.dir,
    env,
    extraEnv,
    signal,
    logFile: LOG_FILE_PATH,
    onOutput,
  });
}
