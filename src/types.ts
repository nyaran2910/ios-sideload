export type RunMode = "auto" | "install" | "build";
export type ProjectKind = "xcode" | "xcodegen" | "tauri-ios" | "makefile" | "custom";
export type PlannedAction = "build-and-install" | "renew-and-install" | "install-only" | "skip" | "blocked";

export interface ExtensionSettings {
  projectDirs?: string;
  defaultMode: RunMode;
  teamId?: string;
  deviceId?: string;
  alwaysRenewProvisioning?: boolean;
  profileExpiryHours: "off" | "0" | "24" | "48" | "72";
  launchAfterInstall: boolean;
}

export interface ProjectOverride {
  dir: string;
  enabled: boolean;
  mode: RunMode | "inherit";
  name?: string;
  appPath?: string;
  buildCommand?: string;
  installCommand?: string;
  sourcePaths?: string;
  bundleId?: string;
}

export interface DetectedProject {
  id: string;
  dir: string;
  name: string;
  kind: ProjectKind;
  exists: boolean;
  enabled: boolean;
  modeOverride: RunMode | "inherit";
  xcodeprojPath?: string;
  projectYmlPath?: string;
  scheme?: string;
  derivedDataPath?: string;
  makefilePath?: string;
  makefileTargets?: { build?: string; install?: string };
  appPath?: string;
  bundleId?: string;
  sourceRoots: string[];
  excludeDirs: string[];
  customBuildCommand?: string;
  customInstallCommand?: string;
  customSourcePaths?: string;
}

export interface ProvisioningInfo {
  name?: string;
  teamId?: string;
  creationDate?: number;
  expirationDate?: number;
  hoursRemaining?: number;
  expired: boolean;
}

export interface ProjectPlan {
  project: DetectedProject;
  effectiveMode: RunMode;
  action: PlannedAction;
  reason: string;
  appExists: boolean;
  appBuiltAt?: number;
  latestSourceAt?: number;
  latestSourceFile?: string;
  needsXcodegen: boolean;
  provisioning?: ProvisioningInfo;
  buildCommandLabel: string;
  installCommandLabel: string;
}

export interface DeviceInfo {
  udid: string;
  name: string;
  model?: string;
  osVersion?: string;
  transport?: string;
  connected: boolean;
  isFallback: boolean;
}

export type RunStepStatus = "idle" | "queued" | "running" | "success" | "failed" | "skipped";

export interface ProjectRunState {
  status: RunStepStatus;
  phase?: "xcodegen" | "build" | "provisioning" | "install" | "launch";
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  didBuild: boolean;
  didRenew: boolean;
  didInstall: boolean;
  log: string;
  error?: string;
}
