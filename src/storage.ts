import { LocalStorage } from "@raycast/api";
import type { ProjectOverride } from "./types";

const OVERRIDES_KEY = "ios-sideload-project-overrides-v1";

export async function loadProjectOverrides(): Promise<Record<string, ProjectOverride>> {
  try {
    const raw = await LocalStorage.getItem<string>(OVERRIDES_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, ProjectOverride>;
  } catch {
    return {};
  }
}

export async function saveProjectOverride(override: ProjectOverride): Promise<Record<string, ProjectOverride>> {
  const current = await loadProjectOverrides();
  current[override.dir] = override;
  await LocalStorage.setItem(OVERRIDES_KEY, JSON.stringify(current));
  return current;
}

export async function clearProjectOverride(dir: string): Promise<Record<string, ProjectOverride>> {
  const current = await loadProjectOverrides();
  delete current[dir];
  await LocalStorage.setItem(OVERRIDES_KEY, JSON.stringify(current));
  return current;
}
