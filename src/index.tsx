import {
  Action,
  ActionPanel,
  Color,
  getPreferenceValues,
  Icon,
  List,
  open,
  openExtensionPreferences,
  showToast,
  Toast,
} from "@raycast/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONFIG_FILE_PATH, ensureConfigFileExists, loadFileConfig, normalizeProjectDirsValue, type SideloadFileConfig } from "./config";
import { resolveTargetDevice } from "./device";
import { LOG_FILE_PATH, shortenHome, splitSemicolonList } from "./env";
import { ProjectForm } from "./ProjectForm";
import {
  detectProject,
  evaluateProjectPlan,
} from "./projects";
import { loadProjectOverrides, saveProjectOverride } from "./storage";
import { executePlans } from "./runner";
import type {
  DeviceInfo,
  ExtensionSettings,
  PlannedAction,
  ProjectOverride,
  ProjectPlan,
  ProjectRunState,
  RunMode,
} from "./types";

const MODE_LABELS: Record<RunMode, string> = {
  auto: "Auto (Makefile)",
  install: "Update Only",
  build: "Force Rebuild",
};

const ACTION_BADGES: Record<PlannedAction, { text: string; color: Color; icon: Icon }> = {
  "build-and-install": { text: "Build + Install", color: Color.Orange, icon: Icon.Hammer },
  "renew-and-install": { text: "Renew 7d + Install", color: Color.Blue, icon: Icon.ArrowClockwise },
  "install-only": { text: "Install Only", color: Color.Green, icon: Icon.ArrowDownCircle },
  skip: { text: "Skipped", color: Color.SecondaryText, icon: Icon.CircleDisabled },
  blocked: { text: "Blocked", color: Color.Red, icon: Icon.ExclamationMark },
};

function formatDateTime(ms?: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatExpiry(hoursRemaining?: number): string {
  if (hoursRemaining === undefined) return "Unknown";
  if (hoursRemaining <= 0) return "Expired";
  const totalHours = Math.round(hoursRemaining);
  if (totalHours < 24) return `${totalHours}h left`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days}d ${hours}h left` : `${days}d left`;
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function nextMode(current: RunMode | "inherit"): RunMode | "inherit" {
  const order: Array<RunMode | "inherit"> = ["inherit", "auto", "install", "build"];
  const idx = order.indexOf(current);
  return order[(idx + 1) % order.length];
}

export default function Command() {
  const [settings] = useState<ExtensionSettings>(() => getPreferenceValues<ExtensionSettings>());
  const [fileConfig, setFileConfig] = useState<SideloadFileConfig>({});
  const [sessionMode, setSessionMode] = useState<RunMode | "settings">("settings");
  const [loading, setLoading] = useState(true);
  const [device, setDevice] = useState<DeviceInfo>();
  const [overrides, setOverrides] = useState<Record<string, ProjectOverride>>({});
  const [plans, setPlans] = useState<ProjectPlan[]>([]);
  const [running, setRunning] = useState(false);
  const [runStates, setRunStates] = useState<Record<string, ProjectRunState>>({});
  const [hasFinishedRun, setHasFinishedRun] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const runAbortRef = useRef<AbortController | null>(null);

  const buildEffectiveSettings = useCallback(
    (loadedFileConfig: SideloadFileConfig): ExtensionSettings => {
      const normalized: ExtensionSettings = {
        projectDirs: settings.projectDirs?.trim() || normalizeProjectDirsValue(loadedFileConfig.projectDirs),
        defaultMode: settings.defaultMode ?? loadedFileConfig.defaultMode ?? "auto",
        teamId: settings.teamId?.trim() || loadedFileConfig.teamId?.trim() || "",
        deviceId: settings.deviceId?.trim() || loadedFileConfig.deviceId?.trim() || "",
        profileExpiryHours: settings.profileExpiryHours ?? loadedFileConfig.profileExpiryHours ?? "24",
        alwaysRenewProvisioning: Boolean(
          settings.alwaysRenewProvisioning ?? loadedFileConfig.alwaysRenewProvisioning ?? true,
        ),
        launchAfterInstall: Boolean(settings.launchAfterInstall ?? loadedFileConfig.launchAfterInstall ?? false),
      };
      if (sessionMode === "settings") return normalized;
      return { ...normalized, defaultMode: sessionMode };
    },
    [settings, sessionMode],
  );

  const effectiveSettings = useMemo<ExtensionSettings>(
    () => buildEffectiveSettings(fileConfig),
    [buildEffectiveSettings, fileConfig],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const loadedFileConfig = await loadFileConfig();
      const resolvedSettings = buildEffectiveSettings(loadedFileConfig);
      const [loadedOverrides, resolvedDevice] = await Promise.all([
        loadProjectOverrides(),
        resolveTargetDevice(resolvedSettings.deviceId ?? ""),
      ]);
      const dirs = splitSemicolonList(resolvedSettings.projectDirs);
      const detected = await Promise.all(
        dirs.map((dir) => detectProject(dir, loadedOverrides[dir])),
      );
      const evaluated = await Promise.all(
        detected.map((project) => evaluateProjectPlan(project, resolvedSettings, resolvedDevice.udid)),
      );
      setFileConfig(loadedFileConfig);
      setOverrides(loadedOverrides);
      setDevice(resolvedDevice);
      setPlans(evaluated);
    } finally {
      setLoading(false);
    }
  }, [buildEffectiveSettings]);

  useEffect(() => {
    void reload();
  }, [reload, refreshTick]);

  useEffect(() => {
    return () => {
      runAbortRef.current?.abort();
    };
  }, []);

  const counts = useMemo(() => {
    let build = 0;
    let renew = 0;
    let install = 0;
    let skip = 0;
    let blocked = 0;
    for (const plan of plans) {
      if (plan.action === "build-and-install") build += 1;
      else if (plan.action === "renew-and-install") renew += 1;
      else if (plan.action === "install-only") install += 1;
      else if (plan.action === "skip") skip += 1;
      else blocked += 1;
    }
    return { build, renew, install, skip, blocked };
  }, [plans]);

  const startRun = useCallback(
    async (targetPlans: ProjectPlan[]) => {
      if (running || !device) return;
      const runnable = targetPlans.filter(
        (p) => p.action === "build-and-install" || p.action === "renew-and-install" || p.action === "install-only",
      );
      if (runnable.length === 0) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Nothing to Sideload",
          message: "Enable at least one valid project or resolve blocked projects.",
        });
        return;
      }

      const controller = new AbortController();
      runAbortRef.current = controller;
      setRunning(true);
      setHasFinishedRun(false);

      const initialStates: Record<string, ProjectRunState> = {};
      for (const p of targetPlans) {
        initialStates[p.project.id] = {
          status: p.action === "skip" ? "skipped" : p.action === "blocked" ? "failed" : "queued",
          didBuild: false,
          didRenew: false,
          didInstall: false,
          log: p.action === "skip" || p.action === "blocked" ? p.reason : "Queued…",
          error: p.action === "blocked" ? p.reason : undefined,
        };
      }
      setRunStates(initialStates);

      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "Running iOS Sideload…",
        message: `${runnable.length} app${runnable.length === 1 ? "" : "s"}`,
      });

      const summary = await executePlans({
        plans: targetPlans,
        device,
        teamId: (effectiveSettings.teamId ?? "").trim(),
        launchAfterInstall: effectiveSettings.launchAfterInstall,
        signal: controller.signal,
        onUpdate: (projectId, nextState) => {
          setRunStates((prev) => ({ ...prev, [projectId]: nextState }));
        },
      });

      setRunning(false);
      setHasFinishedRun(true);
      runAbortRef.current = null;

      if (summary.cancelled) {
        toast.style = Toast.Style.Failure;
        toast.title = "Sideload Cancelled";
        toast.message = `${summary.succeeded} succeeded before cancellation`;
      } else if (summary.failed > 0) {
        toast.style = Toast.Style.Failure;
        toast.title = `Sideload Finished (${summary.failed} Failed)`;
        toast.message = `${summary.succeeded} succeeded · see log for details`;
      } else {
        toast.style = Toast.Style.Success;
        toast.title = runnable.length === 1 ? `${runnable[0].project.name} Sideloaded` : "All Apps Sideloaded";
        toast.message = `${summary.succeeded} updated on ${device.name}`;
      }

      await reload();
    },
    [device, effectiveSettings.launchAfterInstall, effectiveSettings.teamId, reload, running],
  );

  const runSingleProject = useCallback(
    async (plan: ProjectPlan) => {
      if (running || !device) return;
      const targetPlan =
        plan.action === "skip"
          ? await evaluateProjectPlan({ ...plan.project, enabled: true }, effectiveSettings, device.udid)
          : plan;
      await startRun([targetPlan]);
    },
    [device, effectiveSettings, running, startRun],
  );

  const toggleProjectEnabled = useCallback(
    async (plan: ProjectPlan) => {
      if (running) return;
      const current = overrides[plan.project.dir];
      const nextEnabled = !(current?.enabled ?? plan.project.enabled);
      await saveProjectOverride({
        dir: plan.project.dir,
        enabled: nextEnabled,
        mode: current?.mode ?? "inherit",
        name: current?.name,
        appPath: current?.appPath,
        buildCommand: current?.buildCommand,
        installCommand: current?.installCommand,
        sourcePaths: current?.sourcePaths,
        bundleId: current?.bundleId,
      });
      setRefreshTick((v) => v + 1);
    },
    [overrides, running],
  );

  const cycleProjectMode = useCallback(
    async (plan: ProjectPlan) => {
      if (running) return;
      const current = overrides[plan.project.dir];
      const next = nextMode(current?.mode ?? "inherit");
      await saveProjectOverride({
        dir: plan.project.dir,
        enabled: current?.enabled ?? plan.project.enabled,
        mode: next,
        name: current?.name,
        appPath: current?.appPath,
        buildCommand: current?.buildCommand,
        installCommand: current?.installCommand,
        sourcePaths: current?.sourcePaths,
        bundleId: current?.bundleId,
      });
      await showToast({
        style: Toast.Style.Success,
        title: `${plan.project.name} Mode`,
        message: next === "inherit" ? "Using Global Setting" : MODE_LABELS[next],
      });
      setRefreshTick((v) => v + 1);
    },
    [overrides, running],
  );

  const cancelRun = useCallback(() => {
    runAbortRef.current?.abort();
  }, []);

  const summarySubtitle = useMemo(() => {
    if (loading && plans.length === 0) return "Inspecting projects and devices…";
    if (running) {
      const activeEntry = plans.find((p) => runStates[p.project.id]?.status === "running");
      if (activeEntry) {
        const st = runStates[activeEntry.project.id];
        return `${st.phase ?? "working"}: ${activeEntry.project.name}`;
      }
      return "Executing sideload pipeline…";
    }
    const parts: string[] = [];
    if (counts.renew > 0) parts.push(`${counts.renew} renew`);
    if (counts.install > 0) parts.push(`${counts.install} install`);
    if (counts.build > 0) parts.push(`${counts.build} build`);
    if (counts.skip > 0) parts.push(`${counts.skip} skipped`);
    if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
    const devicePart = device ? `${device.name}${device.connected ? "" : " (offline/fallback)"}` : "Detecting device…";
    return `${parts.join(", ") || "No projects"} · ${devicePart}`;
  }, [counts, device, loading, plans, runStates, running]);

  const summaryMarkdown = useMemo(() => {
    const lines: string[] = [];
    lines.push(running ? "## Running Sideload" : hasFinishedRun ? "## Sideload Summary" : "## Confirm iOS Sideload");
    lines.push("");
    lines.push(`- **Device:** ${device ? `${device.name} (\`${device.udid}\`)` : "Detecting…"}`);
    if (device) {
      lines.push(
        `- **Connection:** ${device.connected ? `Connected (${device.transport ?? "paired"})` : "Not currently detected (will use UDID directly)"}`,
      );
    }
    lines.push(`- **Team ID:** ${effectiveSettings.teamId ? `\`${effectiveSettings.teamId}\`` : "_Not configured_"}`);
    lines.push(`- **Mode:** ${MODE_LABELS[effectiveSettings.defaultMode]}`);
    lines.push(`- **Config File:** \`${shortenHome(CONFIG_FILE_PATH)}\``);
    lines.push("");
    lines.push("### Plan");
    lines.push("");
    lines.push("| App | Action | Reason |");
    lines.push("| --- | --- | --- |");
    for (const plan of plans) {
      const state = runStates[plan.project.id];
      const badge = state
        ? state.status === "success"
          ? `Done (${state.didBuild ? "Built + Installed" : state.didRenew ? "Renewed 7d + Installed" : "Installed"})`
          : state.status === "failed"
            ? `Failed: ${state.error ?? "error"}`
            : state.status === "running"
              ? `Running (${state.phase ?? "step"})…`
              : state.status
        : ACTION_BADGES[plan.action].text;
      lines.push(`| ${plan.project.name} | ${badge} | ${plan.reason} |`);
    }
    lines.push("");
    lines.push(`Press **Enter** to ${running ? "wait for completion" : "start sideload"}.`);
    return lines.join("\n");
  }, [device, effectiveSettings.defaultMode, effectiveSettings.teamId, hasFinishedRun, plans, runStates, running]);

  const sharedActions = (
    <>
      <Action
        title="Re-Check Projects & Device"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ["cmd"], key: "r" }}
        onAction={() => setRefreshTick((v) => v + 1)}
      />
      <Action
        title="Open Config File"
        icon={Icon.Code}
        shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
        onAction={async () => {
          const configPath = await ensureConfigFileExists();
          await open(configPath);
        }}
      />
      <Action
        title="Open Log File"
        icon={Icon.Document}
        shortcut={{ modifiers: ["cmd"], key: "l" }}
        onAction={() => open(LOG_FILE_PATH)}
      />
      <Action
        title="Open Extension Settings"
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
    </>
  );

  return (
    <List
      isLoading={loading || running}
      isShowingDetail
      navigationTitle="Renew iOS Sideloads"
      searchBarPlaceholder="Filter projects…"
      searchBarAccessory={
        <List.Dropdown
          tooltip="Override Mode for This Session"
          value={sessionMode}
          onChange={(val) => setSessionMode(val as RunMode | "settings")}
        >
          <List.Dropdown.Item title={`From Settings (${MODE_LABELS[settings.defaultMode]})`} value="settings" />
          <List.Dropdown.Item title="Auto (Makefile: Build if changed)" value="auto" />
          <List.Dropdown.Item title="Update Only (Install existing .app)" value="install" />
          <List.Dropdown.Item title="Force Rebuild & Install" value="build" />
        </List.Dropdown>
      }
    >
      <List.Section title="Confirmation">
        <List.Item
          id="confirm-run"
          title={running ? "Sideload Running…" : hasFinishedRun ? "Run Sideload Again" : "Confirm & Run Sideload"}
          subtitle={summarySubtitle}
          icon={{
            source: running ? Icon.Clock : hasFinishedRun ? Icon.RotateClockwise : Icon.PlayFilled,
            tintColor: running ? Color.Blue : Color.Green,
          }}
          detail={<List.Item.Detail markdown={summaryMarkdown} />}
          actions={
            <ActionPanel>
              {!running ? (
                <Action title="Run Sideload" icon={Icon.Play} onAction={() => startRun(plans)} />
              ) : (
                <Action title="Cancel Run" icon={Icon.Stop} style={Action.Style.Destructive} onAction={cancelRun} />
              )}
              {sharedActions}
            </ActionPanel>
          }
        />
      </List.Section>

      <List.Section title="Configured iOS Projects">
        {plans.map((plan) => {
          const runState = runStates[plan.project.id];
          const badge = ACTION_BADGES[plan.action];

          let itemIcon: { source: Icon; tintColor: Color } = { source: badge.icon, tintColor: badge.color };
          let statusTag: { value: string; color: Color } = { value: badge.text, color: badge.color };

          if (runState) {
            if (runState.status === "running") {
              itemIcon = { source: Icon.Clock, tintColor: Color.Blue };
              statusTag = { value: `${runState.phase ?? "running"}…`, color: Color.Blue };
            } else if (runState.status === "success") {
              itemIcon = { source: Icon.CheckCircle, tintColor: Color.Green };
              statusTag = {
                value: `${runState.didBuild ? "Built + Installed" : runState.didRenew ? "Renewed 7d + Installed" : "Installed"} ${formatDuration(runState.durationMs)}`.trim(),
                color: Color.Green,
              };
            } else if (runState.status === "failed") {
              itemIcon = { source: Icon.XMarkCircle, tintColor: Color.Red };
              statusTag = { value: "Failed", color: Color.Red };
            } else if (runState.status === "queued") {
              itemIcon = { source: Icon.Circle, tintColor: Color.SecondaryText };
              statusTag = { value: "Queued", color: Color.SecondaryText };
            } else if (runState.status === "skipped") {
              itemIcon = { source: Icon.CircleDisabled, tintColor: Color.SecondaryText };
              statusTag = { value: "Skipped", color: Color.SecondaryText };
            }
          }

          const accessories: List.Item.Accessory[] = [];
          if (!runState && plan.provisioning) {
            accessories.push({
              tag: {
                value: formatExpiry(plan.provisioning.hoursRemaining),
                color: plan.provisioning.expired
                  ? Color.Red
                  : (plan.provisioning.hoursRemaining ?? 999) <= 24
                    ? Color.Orange
                    : Color.SecondaryText,
              },
            });
          }
          accessories.push({ tag: statusTag });

          const detailLines: string[] = [
            `### ${plan.project.name}`,
            "",
            `**Decision:** ${badge.text} — ${plan.reason}`,
            "",
          ];

          if (runState) {
            detailLines.push("```text");
            detailLines.push(runState.log.trim() || "(no output yet)");
            detailLines.push("```");
            if (runState.error) {
              detailLines.push("");
              detailLines.push(`> **Error:** ${runState.error}`);
            }
          } else {
            detailLines.push(`- **Project Dir:** \`${shortenHome(plan.project.dir)}\``);
            detailLines.push(`- **Type:** ${plan.project.kind}`);
            detailLines.push(
              `- **App Bundle:** ${plan.project.appPath ? `\`${shortenHome(plan.project.appPath)}\`` : "Not configured"}`,
            );
            detailLines.push(`- **Last Built:** ${formatDateTime(plan.appBuiltAt)}`);
            detailLines.push(
              `- **Latest Source:** ${formatDateTime(plan.latestSourceAt)}${plan.latestSourceFile ? ` (\`${plan.latestSourceFile}\`)` : ""}`,
            );
            if (plan.provisioning) {
              detailLines.push(
                `- **Provisioning:** ${formatExpiry(plan.provisioning.hoursRemaining)} (expires ${formatDateTime(plan.provisioning.expirationDate)})`,
              );
            }
            detailLines.push("");
            detailLines.push("**Commands:**");
            if (plan.action === "build-and-install") {
              if (plan.needsXcodegen) detailLines.push("1. `xcodegen generate`");
              detailLines.push(`${plan.needsXcodegen ? "2" : "1"}. \`${plan.buildCommandLabel}\``);
              detailLines.push(`${plan.needsXcodegen ? "3" : "2"}. \`${plan.installCommandLabel}\``);
            } else if (plan.action === "renew-and-install") {
              detailLines.push("1. Refresh 7d provisioning profile & re-sign `.app`");
              detailLines.push(`2. \`${plan.installCommandLabel}\``);
            } else if (plan.action === "install-only") {
              detailLines.push(`1. \`${plan.installCommandLabel}\``);
            } else {
              detailLines.push("_No commands will run._");
            }
          }

          return (
            <List.Item
              key={plan.project.id}
              title={plan.project.name}
              subtitle={plan.reason}
              icon={itemIcon}
              accessories={accessories}
              detail={<List.Item.Detail markdown={detailLines.join("\n")} />}
              actions={
                <ActionPanel>
                  {!running ? (
                    <>
                      <Action
                        title={`Run ${plan.project.name} Only`}
                        icon={Icon.PlayFilled}
                        onAction={() => runSingleProject(plan)}
                      />
                      <Action
                        title="Run All Enabled Apps"
                        icon={Icon.Play}
                        shortcut={{ modifiers: ["cmd"], key: "return" }}
                        onAction={() => startRun(plans)}
                      />
                      <Action
                        title={plan.project.enabled ? "Disable for Run" : "Enable for Run"}
                        icon={plan.project.enabled ? Icon.CircleDisabled : Icon.CheckCircle}
                        shortcut={{ modifiers: ["cmd"], key: "e" }}
                        onAction={() => toggleProjectEnabled(plan)}
                      />
                      <Action
                        title="Cycle Project Mode"
                        icon={Icon.Switch}
                        shortcut={{ modifiers: ["cmd"], key: "m" }}
                        onAction={() => cycleProjectMode(plan)}
                      />
                      <Action.Push
                        title="Configure Project…"
                        icon={Icon.Pencil}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "e" }}
                        target={
                          <ProjectForm
                            project={plan.project}
                            override={overrides[plan.project.dir]}
                            onSaved={() => setRefreshTick((v) => v + 1)}
                          />
                        }
                      />
                    </>
                  ) : (
                    <Action
                      title="Cancel Run"
                      icon={Icon.Stop}
                      style={Action.Style.Destructive}
                      onAction={cancelRun}
                    />
                  )}
                  <Action.ShowInFinder path={plan.project.dir} />
                  {sharedActions}
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}
