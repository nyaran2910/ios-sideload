import { execFile } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { expandHome, shortenHome, splitSemicolonList } from "./env";
import { parseMobileProvision } from "./provisioning";
import type {
  DetectedProject,
  ExtensionSettings,
  ProjectOverride,
  ProjectPlan,
  ProvisioningInfo,
  RunMode,
} from "./types";

const execFileAsync = promisify(execFile);

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".build",
  "DerivedData",
  "dist",
  "build",
  "node_modules",
  "target",
  "artifacts",
  "Pods",
  ".swiftpm",
  ".tauri",
  "Externals",
]);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseProjectYml(content: string): { name?: string; productName?: string; scheme?: string } {
  const nameMatch = content.match(/^name:\s*['"]?([^\s'"#]+)['"]?/m);
  const productMatch = content.match(/^\s*PRODUCT_NAME:\s*['"]?([^\n'"#]+)['"]?/m);
  const schemesBlock = content.match(/^schemes:\s*\n((?:\s+.*\n?)*)/m);
  let scheme: string | undefined;
  if (schemesBlock) {
    const firstScheme = schemesBlock[1].match(/^\s{2}([A-Za-z0-9_.-]+):/m);
    if (firstScheme) scheme = firstScheme[1];
  }
  return {
    name: nameMatch?.[1]?.trim(),
    productName: productMatch?.[1]?.trim(),
    scheme,
  };
}

async function findXcodeproj(dir: string): Promise<string | undefined> {
  const candidates = [dir, join(dir, "iOS")];
  for (const candidateDir of candidates) {
    if (!(await exists(candidateDir))) continue;
    const entries = await readdir(candidateDir, { withFileTypes: true }).catch(() => []);
    const proj = entries.find((e) => e.isDirectory() && e.name.endsWith(".xcodeproj"));
    if (proj) return join(candidateDir, proj.name);
  }
  return undefined;
}

async function findSchemeInXcodeproj(xcodeprojPath: string, preferredName: string): Promise<string> {
  const schemesDir = join(xcodeprojPath, "xcshareddata", "xcschemes");
  const entries = await readdir(schemesDir).catch(() => []);
  const schemes = entries
    .filter((f) => f.endsWith(".xcscheme"))
    .map((f) => f.replace(/\.xcscheme$/, ""))
    .filter((name) => !name.endsWith("Tests") && !name.endsWith("UITests"));
  if (schemes.includes(preferredName)) return preferredName;
  const nonUi = schemes.find((s) => !s.endsWith("UI"));
  return nonUi ?? schemes[0] ?? preferredName;
}

async function findBuiltTauriApp(dir: string, fallbackProductName: string): Promise<string> {
  const appleBuildDir = join(dir, "src-tauri", "gen", "apple", "build");
  const entries = await readdir(appleBuildDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".xcarchive")) continue;
    const appsDir = join(appleBuildDir, entry.name, "Products", "Applications");
    const apps = await readdir(appsDir, { withFileTypes: true }).catch(() => []);
    const appEntry = apps.find((a) => a.isDirectory() && a.name.endsWith(".app"));
    if (appEntry) return join(appsDir, appEntry.name);
  }
  const projectYml = await readFile(join(dir, "src-tauri", "gen", "apple", "project.yml"), "utf8").catch(() => "");
  const parsed = parseProjectYml(projectYml);
  const archiveBase = parsed.name ?? basename(dir);
  const productName = parsed.productName ?? fallbackProductName;
  return join(appleBuildDir, `${archiveBase}_iOS.xcarchive`, "Products", "Applications", `${productName}.app`);
}

async function detectMakefileTargets(dir: string): Promise<{ path?: string; build?: string; install?: string }> {
  for (const filename of ["Makefile", "makefile", "GNUmakefile"]) {
    const candidate = join(dir, filename);
    if (!(await exists(candidate))) continue;
    const content = await readFile(candidate, "utf8").catch(() => "");
    const targets = new Set<string>();
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_.-]+):(?:\s|$)/);
      if (match) targets.add(match[1]);
    }
    const build = ["build", "ios-build", "app"].find((t) => targets.has(t));
    const install = ["sideload", "install", "ios-install", "deploy"].find((t) => targets.has(t));
    if (build || install) {
      return { path: candidate, build, install };
    }
  }
  return {};
}

export async function detectProject(
  rawDir: string,
  override?: ProjectOverride,
): Promise<DetectedProject> {
  const dir = expandHome(rawDir);
  const dirExists = await exists(dir);
  const enabled = override?.enabled ?? true;
  const modeOverride = override?.mode ?? "inherit";

  const base: Pick<
    DetectedProject,
    | "id"
    | "dir"
    | "exists"
    | "enabled"
    | "modeOverride"
    | "customBuildCommand"
    | "customInstallCommand"
    | "customSourcePaths"
  > = {
    id: dir,
    dir,
    exists: dirExists,
    enabled,
    modeOverride,
    customBuildCommand: override?.buildCommand?.trim() || undefined,
    customInstallCommand: override?.installCommand?.trim() || undefined,
    customSourcePaths: override?.sourcePaths?.trim() || undefined,
  };

  if (!dirExists) {
    return {
      ...base,
      name: override?.name?.trim() || basename(dir),
      kind: "custom",
      sourceRoots: [],
      excludeDirs: [],
      appPath: override?.appPath ? expandHome(override.appPath) : undefined,
      bundleId: override?.bundleId?.trim() || undefined,
    };
  }

  // 1. Tauri iOS project
  const tauriConfPath = join(dir, "src-tauri", "tauri.conf.json");
  const appleDir = join(dir, "src-tauri", "gen", "apple");
  if ((await exists(tauriConfPath)) && (await exists(appleDir))) {
    const tauriConfRaw = await readFile(tauriConfPath, "utf8").catch(() => "{}");
    const tauriConf = JSON.parse(tauriConfRaw) as { productName?: string; identifier?: string };
    const appleYml = await readFile(join(appleDir, "project.yml"), "utf8").catch(() => "");
    const yml = parseProjectYml(appleYml);
    const defaultName = yml.productName ?? tauriConf.productName ?? basename(dir);
    const detectedAppPath = await findBuiltTauriApp(dir, defaultName);

    const tauriSources = [
      "src",
      "index.html",
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
      "vite.config.ts",
      "vite.config.mts",
      "vite.config.js",
      "src-tauri/src",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
      "src-tauri/build.rs",
      "src-tauri/tauri.conf.json",
      "src-tauri/capabilities",
      "src-tauri/icons",
      "src-tauri/gen/apple/Sources",
      "src-tauri/gen/apple/project.yml",
      "src-tauri/gen/apple/ExportOptions.plist",
    ].map((rel) => join(dir, rel));

    return {
      ...base,
      name: override?.name?.trim() || defaultName,
      kind: override?.buildCommand ? "custom" : "tauri-ios",
      appPath: override?.appPath ? expandHome(override.appPath) : detectedAppPath,
      bundleId: override?.bundleId?.trim() || tauriConf.identifier,
      sourceRoots: base.customSourcePaths ? resolveCustomSourceRoots(dir, base.customSourcePaths) : tauriSources,
      excludeDirs: ["node_modules", "target", "dist", ".git", "build", ".tauri", "Externals"],
    };
  }

  // 2. XcodeGen / Xcode project
  const rootYmlPath = join(dir, "project.yml");
  const iosYmlPath = join(dir, "iOS", "project.yml");
  const projectYmlPath = (await exists(rootYmlPath))
    ? rootYmlPath
    : (await exists(iosYmlPath))
      ? iosYmlPath
      : undefined;

  const xcodeprojPath = await findXcodeproj(dir);

  if (projectYmlPath || xcodeprojPath) {
    const ymlContent = projectYmlPath ? await readFile(projectYmlPath, "utf8").catch(() => "") : "";
    const yml = parseProjectYml(ymlContent);
    const fallbackName = xcodeprojPath ? basename(xcodeprojPath, ".xcodeproj") : basename(dir);
    const projectName = yml.productName ?? yml.name ?? fallbackName;
    const scheme = yml.scheme ?? (xcodeprojPath ? await findSchemeInXcodeproj(xcodeprojPath, projectName) : projectName);

    const hasDotBuildPhone = await exists(join(dir, ".build", "phone"));
    const hasDerivedData = await exists(join(dir, "DerivedData"));
    const isNestedIos = xcodeprojPath ? xcodeprojPath.startsWith(join(dir, "iOS")) : false;
    const derivedDataRel = hasDotBuildPhone
      ? ".build/phone"
      : hasDerivedData
        ? "DerivedData"
        : isNestedIos
          ? ".build/phone"
          : "DerivedData";
    const derivedDataPath = join(dir, derivedDataRel);
    const defaultAppPath = join(derivedDataPath, "Build", "Products", "Debug-iphoneos", `${projectName}.app`);

    const xcodeBaseDir = xcodeprojPath
      ? dirname(xcodeprojPath)
      : projectYmlPath
        ? dirname(projectYmlPath)
        : dir;
    const defaultSourceRoots = [xcodeBaseDir];
    const configDir = join(xcodeBaseDir, "Config");
    if (xcodeBaseDir !== dir && (await exists(join(dir, "Config")))) {
      defaultSourceRoots.push(join(dir, "Config"));
    } else if (await exists(configDir)) {
      // already covered by xcodeBaseDir
    }

    const extraIgnores = ["Tests", "UITests", "backend-tests", "supabase", "docs", "scripts", "catalog"];

    return {
      ...base,
      name: override?.name?.trim() || projectName,
      kind: override?.buildCommand ? "custom" : projectYmlPath ? "xcodegen" : "xcode",
      xcodeprojPath,
      projectYmlPath,
      scheme,
      derivedDataPath,
      appPath: override?.appPath ? expandHome(override.appPath) : defaultAppPath,
      bundleId: override?.bundleId?.trim() || undefined,
      sourceRoots: base.customSourcePaths ? resolveCustomSourceRoots(dir, base.customSourcePaths) : defaultSourceRoots,
      excludeDirs: projectYmlPath
        ? [...DEFAULT_IGNORED_DIRS, ...extraIgnores, ...(xcodeprojPath ? [basename(xcodeprojPath)] : [])]
        : [...DEFAULT_IGNORED_DIRS, ...extraIgnores],
    };
  }

  // 3. Makefile-based project
  const makefile = await detectMakefileTargets(dir);
  if (makefile.path) {
    return {
      ...base,
      name: override?.name?.trim() || basename(dir),
      kind: override?.buildCommand ? "custom" : "makefile",
      makefilePath: makefile.path,
      makefileTargets: { build: makefile.build, install: makefile.install },
      appPath: override?.appPath ? expandHome(override.appPath) : undefined,
      bundleId: override?.bundleId?.trim() || undefined,
      sourceRoots: base.customSourcePaths ? resolveCustomSourceRoots(dir, base.customSourcePaths) : [dir],
      excludeDirs: [...DEFAULT_IGNORED_DIRS],
    };
  }

  return {
    ...base,
    name: override?.name?.trim() || basename(dir),
    kind: "custom",
    appPath: override?.appPath ? expandHome(override.appPath) : undefined,
    bundleId: override?.bundleId?.trim() || undefined,
    sourceRoots: base.customSourcePaths ? resolveCustomSourceRoots(dir, base.customSourcePaths) : [dir],
    excludeDirs: [...DEFAULT_IGNORED_DIRS],
  };
}

function resolveCustomSourceRoots(projectDir: string, raw: string): string[] {
  return splitSemicolonList(raw).map((entry) => (entry.startsWith("/") ? entry : join(projectDir, entry)));
}

async function readAppInfoPlist(appPath: string): Promise<{ executable?: string; bundleId?: string; displayName?: string }> {
  const plistPath = join(appPath, "Info.plist");
  if (!(await exists(plistPath))) return {};
  try {
    const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", plistPath]);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      executable: typeof parsed.CFBundleExecutable === "string" ? parsed.CFBundleExecutable : undefined,
      bundleId: typeof parsed.CFBundleIdentifier === "string" ? parsed.CFBundleIdentifier : undefined,
      displayName: typeof parsed.CFBundleDisplayName === "string" ? parsed.CFBundleDisplayName : undefined,
    };
  } catch {
    return {};
  }
}

async function readAppBuildTime(appPath: string, executable?: string): Promise<number | undefined> {
  if (!(await exists(appPath))) return undefined;
  const targets = [appPath, join(appPath, "Info.plist")];
  if (executable) targets.push(join(appPath, executable));

  let latest = 0;
  for (const target of targets) {
    const st = await stat(target).catch(() => undefined);
    if (st && st.mtimeMs > latest) latest = st.mtimeMs;
  }
  return latest > 0 ? latest : undefined;
}

async function readProvisioningInfo(appPath: string): Promise<ProvisioningInfo | undefined> {
  return parseMobileProvision(join(appPath, "embedded.mobileprovision"));
}

function shouldRenewProvisioning(
  provisioning: ProvisioningInfo | undefined,
  settings: ExtensionSettings,
): boolean {
  if (settings.alwaysRenewProvisioning !== false) {
    if (!provisioning || provisioning.creationDate === undefined) return true;
    return Date.now() - provisioning.creationDate >= 60 * 60 * 1000;
  }
  if (settings.profileExpiryHours !== "off" && provisioning?.hoursRemaining !== undefined) {
    return provisioning.hoursRemaining <= Number(settings.profileExpiryHours);
  }
  return false;
}

async function scanLatestSource(
  projectDir: string,
  roots: string[],
  excludeDirs: string[],
): Promise<{ latestMtimeMs?: number; latestFile?: string }> {
  const excluded = new Set(excludeDirs);
  let latestMtimeMs = 0;
  let latestFile: string | undefined;

  async function walk(targetPath: string) {
    const st = await stat(targetPath).catch(() => undefined);
    if (!st) return;
    if (st.isFile()) {
      if (st.mtimeMs > latestMtimeMs) {
        latestMtimeMs = st.mtimeMs;
        latestFile = relative(projectDir, targetPath) || basename(targetPath);
      }
      return;
    }
    if (!st.isDirectory()) return;

    const base = basename(targetPath);
    if (base.endsWith(".xcresult") || base.endsWith(".xcarchive")) return;
    // Ignore xcuserdata inside xcodeproj when watching xcodeproj
    if (base === "xcuserdata") return;

    const entries = await readdir(targetPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue;
      if (entry.name === ".DS_Store" || entry.name.endsWith(".md")) continue;
      const childPath = join(targetPath, entry.name);
      if (entry.isDirectory()) {
        await walk(childPath);
      } else if (entry.isFile()) {
        const childStat = await stat(childPath).catch(() => undefined);
        if (childStat && childStat.mtimeMs > latestMtimeMs) {
          latestMtimeMs = childStat.mtimeMs;
          latestFile = relative(projectDir, childPath) || entry.name;
        }
      }
    }
  }

  for (const root of roots) {
    await walk(root);
  }

  return latestMtimeMs > 0 ? { latestMtimeMs, latestFile } : {};
}

async function checkNeedsXcodegen(project: DetectedProject): Promise<boolean> {
  if (!project.projectYmlPath) return false;
  if (!project.xcodeprojPath) return true;
  const pbxprojPath = join(project.xcodeprojPath, "project.pbxproj");
  if (!(await exists(pbxprojPath))) return true;
  const [ymlStat, pbxStat] = await Promise.all([
    stat(project.projectYmlPath).catch(() => undefined),
    stat(pbxprojPath).catch(() => undefined),
  ]);
  if (!ymlStat || !pbxStat) return true;
  return ymlStat.mtimeMs > pbxStat.mtimeMs;
}

function buildCommandSummary(project: DetectedProject, deviceUdid: string, teamId: string): {
  buildCommandLabel: string;
  installCommandLabel: string;
} {
  let buildCommandLabel = "(none)";
  if (project.customBuildCommand) {
    buildCommandLabel = project.customBuildCommand;
  } else if (project.kind === "tauri-ios") {
    buildCommandLabel = "pnpm tauri ios build --ci --archive-only";
  } else if (project.kind === "makefile" && project.makefileTargets?.build) {
    buildCommandLabel = `make ${project.makefileTargets.build}`;
  } else if (project.xcodeprojPath && project.scheme) {
    const projRel = relative(project.dir, project.xcodeprojPath) || project.xcodeprojPath;
    const ddRel = project.derivedDataPath ? relative(project.dir, project.derivedDataPath) : "DerivedData";
    buildCommandLabel = `xcodebuild -project ${projRel} -scheme ${project.scheme} -configuration Debug -destination id=${deviceUdid} -derivedDataPath ${ddRel} -allowProvisioningUpdates DEVELOPMENT_TEAM=${teamId} build`;
  }

  let installCommandLabel = "(none)";
  if (project.customInstallCommand) {
    installCommandLabel = project.customInstallCommand;
  } else if (project.kind === "makefile" && project.makefileTargets?.install) {
    installCommandLabel = `make ${project.makefileTargets.install}`;
  } else if (project.appPath) {
    const appRel = relative(project.dir, project.appPath) || project.appPath;
    installCommandLabel = `xcrun devicectl device install app --device ${deviceUdid} ${appRel}`;
  }

  return { buildCommandLabel, installCommandLabel };
}

export async function evaluateProjectPlan(
  project: DetectedProject,
  settings: ExtensionSettings,
  deviceUdid: string,
): Promise<ProjectPlan> {
  const effectiveMode: RunMode = project.modeOverride === "inherit" ? settings.defaultMode : project.modeOverride;
  const { buildCommandLabel, installCommandLabel } = buildCommandSummary(
    project,
    deviceUdid,
    settings.teamId?.trim() || "<TEAM_ID>",
  );

  if (!project.exists) {
    return {
      project,
      effectiveMode,
      action: "blocked",
      reason: `Directory not found: ${shortenHome(project.dir)}`,
      appExists: false,
      needsXcodegen: false,
      buildCommandLabel,
      installCommandLabel,
    };
  }

  const appPath = project.appPath;
  const plistInfo = appPath ? await readAppInfoPlist(appPath) : {};
  const enrichedProject: DetectedProject = {
    ...project,
    bundleId: project.bundleId ?? plistInfo.bundleId,
  };

  const appBuiltAt = appPath ? await readAppBuildTime(appPath, plistInfo.executable) : undefined;
  const appExists = appBuiltAt !== undefined;
  const provisioning = appPath && appExists ? await readProvisioningInfo(appPath) : undefined;
  const needsXcodegen = await checkNeedsXcodegen(enrichedProject);
  const { latestMtimeMs, latestFile } = await scanLatestSource(
    enrichedProject.dir,
    enrichedProject.sourceRoots,
    enrichedProject.excludeDirs,
  );

  if (!enrichedProject.enabled) {
    return {
      project: enrichedProject,
      effectiveMode,
      action: "skip",
      reason: "Disabled for this run",
      appExists,
      appBuiltAt,
      latestSourceAt: latestMtimeMs,
      latestSourceFile: latestFile,
      needsXcodegen,
      provisioning,
      buildCommandLabel,
      installCommandLabel,
    };
  }

  if (effectiveMode === "install") {
    if (!appPath && enrichedProject.kind === "makefile" && enrichedProject.makefileTargets?.install) {
      return {
        project: enrichedProject,
        effectiveMode,
        action: "install-only",
        reason: `Update only (make ${enrichedProject.makefileTargets.install})`,
        appExists: true,
        latestSourceAt: latestMtimeMs,
        latestSourceFile: latestFile,
        needsXcodegen,
        buildCommandLabel,
        installCommandLabel,
      };
    }
    if (!appExists) {
      return {
        project: enrichedProject,
        effectiveMode,
        action: "blocked",
        reason: "Cannot install only: built .app not found yet",
        appExists: false,
        latestSourceAt: latestMtimeMs,
        latestSourceFile: latestFile,
        needsXcodegen,
        buildCommandLabel,
        installCommandLabel,
      };
    }
    if (appPath && enrichedProject.bundleId && shouldRenewProvisioning(provisioning, settings)) {
      return {
        project: enrichedProject,
        effectiveMode,
        action: "renew-and-install",
        reason: provisioning?.expired
          ? "Provisioning expired — renew 7d profile & install"
          : "Update only — renew 7d profile & install",
        appExists,
        appBuiltAt,
        latestSourceAt: latestMtimeMs,
        latestSourceFile: latestFile,
        needsXcodegen,
        provisioning,
        buildCommandLabel,
        installCommandLabel,
      };
    }
    return {
      project: enrichedProject,
      effectiveMode,
      action: "install-only",
      reason: "Update only (skipping build per mode)",
      appExists,
      appBuiltAt,
      latestSourceAt: latestMtimeMs,
      latestSourceFile: latestFile,
      needsXcodegen,
      provisioning,
      buildCommandLabel,
      installCommandLabel,
    };
  }

  if (effectiveMode === "build") {
    return {
      project: enrichedProject,
      effectiveMode,
      action: "build-and-install",
      reason: "Forced rebuild & install",
      appExists,
      appBuiltAt,
      latestSourceAt: latestMtimeMs,
      latestSourceFile: latestFile,
      needsXcodegen,
      provisioning,
      buildCommandLabel,
      installCommandLabel,
    };
  }

  // Auto (Makefile-style) mode
  if (!appExists) {
    if (enrichedProject.kind === "makefile" && enrichedProject.makefileTargets?.install && !enrichedProject.makefileTargets?.build) {
      return {
        project: enrichedProject,
        effectiveMode,
        action: "install-only",
        reason: `Makefile target (${enrichedProject.makefileTargets.install})`,
        appExists: false,
        latestSourceAt: latestMtimeMs,
        latestSourceFile: latestFile,
        needsXcodegen,
        buildCommandLabel,
        installCommandLabel,
      };
    }
    return {
      project: enrichedProject,
      effectiveMode,
      action: "build-and-install",
      reason: "Built .app missing — build required",
      appExists: false,
      latestSourceAt: latestMtimeMs,
      latestSourceFile: latestFile,
      needsXcodegen,
      buildCommandLabel,
      installCommandLabel,
    };
  }

  if (needsXcodegen) {
    return {
      project: enrichedProject,
      effectiveMode,
      action: "build-and-install",
      reason: "project.yml updated — regenerate & rebuild",
      appExists,
      appBuiltAt,
      latestSourceAt: latestMtimeMs,
      latestSourceFile: latestFile,
      needsXcodegen,
      provisioning,
      buildCommandLabel,
      installCommandLabel,
    };
  }

  if (latestMtimeMs !== undefined && appBuiltAt !== undefined && latestMtimeMs > appBuiltAt) {
    return {
      project: enrichedProject,
      effectiveMode,
      action: "build-and-install",
      reason: `Source changed: ${latestFile ?? "files"}`,
      appExists,
      appBuiltAt,
      latestSourceAt: latestMtimeMs,
      latestSourceFile: latestFile,
      needsXcodegen,
      provisioning,
      buildCommandLabel,
      installCommandLabel,
    };
  }

  if (appPath && enrichedProject.bundleId && shouldRenewProvisioning(provisioning, settings)) {
    return {
      project: enrichedProject,
      effectiveMode,
      action: "renew-and-install",
      reason: provisioning?.expired
        ? "Provisioning expired — renew 7d profile & install"
        : "Sources unchanged — renew 7d profile & install",
      appExists,
      appBuiltAt,
      latestSourceAt: latestMtimeMs,
      latestSourceFile: latestFile,
      needsXcodegen,
      provisioning,
      buildCommandLabel,
      installCommandLabel,
    };
  }

  return {
    project: enrichedProject,
    effectiveMode,
    action: "install-only",
    reason: "Up to date (profile fresh) — install only",
    appExists,
    appBuiltAt,
    latestSourceAt: latestMtimeMs,
    latestSourceFile: latestFile,
    needsXcodegen,
    provisioning,
    buildCommandLabel,
    installCommandLabel,
  };
}
