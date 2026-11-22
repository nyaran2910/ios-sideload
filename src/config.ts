import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionSettings, RunMode } from "./types";

export const CONFIG_FILE_PATH = join(homedir(), ".config", "raycast", "ios-sideload.json");

export interface SideloadFileConfig {
  projectDirs?: string[] | string;
  teamId?: string;
  deviceId?: string;
  defaultMode?: RunMode;
  alwaysRenewProvisioning?: boolean;
  profileExpiryHours?: ExtensionSettings["profileExpiryHours"];
  launchAfterInstall?: boolean;
}

const VALID_MODES = new Set<RunMode>(["auto", "install", "build"]);
const VALID_EXPIRY = new Set<ExtensionSettings["profileExpiryHours"]>(["off", "0", "24", "48", "72"]);

export async function loadFileConfig(): Promise<SideloadFileConfig> {
  try {
    const raw = await readFile(CONFIG_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};

    const config: SideloadFileConfig = {};

    if (Array.isArray(parsed.projectDirs)) {
      config.projectDirs = parsed.projectDirs
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (typeof parsed.projectDirs === "string" && parsed.projectDirs.trim()) {
      config.projectDirs = parsed.projectDirs.trim();
    }

    if (typeof parsed.teamId === "string" && parsed.teamId.trim()) {
      config.teamId = parsed.teamId.trim();
    }

    if (typeof parsed.deviceId === "string" && parsed.deviceId.trim()) {
      config.deviceId = parsed.deviceId.trim();
    }

    if (typeof parsed.defaultMode === "string" && VALID_MODES.has(parsed.defaultMode as RunMode)) {
      config.defaultMode = parsed.defaultMode as RunMode;
    }

    if (
      typeof parsed.profileExpiryHours === "string" &&
      VALID_EXPIRY.has(parsed.profileExpiryHours as ExtensionSettings["profileExpiryHours"])
    ) {
      config.profileExpiryHours = parsed.profileExpiryHours as ExtensionSettings["profileExpiryHours"];
    }

    if (typeof parsed.alwaysRenewProvisioning === "boolean") {
      config.alwaysRenewProvisioning = parsed.alwaysRenewProvisioning;
    }

    if (typeof parsed.launchAfterInstall === "boolean") {
      config.launchAfterInstall = parsed.launchAfterInstall;
    }

    return config;
  } catch {
    return {};
  }
}

export async function ensureConfigFileExists(): Promise<string> {
  try {
    await readFile(CONFIG_FILE_PATH, "utf8");
    return CONFIG_FILE_PATH;
  } catch {
    await mkdir(dirname(CONFIG_FILE_PATH), { recursive: true });
    const template: SideloadFileConfig = {
      projectDirs: [],
      teamId: "",
      deviceId: "",
    };
    await writeFile(CONFIG_FILE_PATH, `${JSON.stringify(template, null, 2)}\n`, "utf8");
    return CONFIG_FILE_PATH;
  }
}

export function normalizeProjectDirsValue(value?: string[] | string): string {
  if (!value) return "";
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean).join("; ");
  }
  return value.trim();
}
