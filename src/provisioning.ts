import { execFile } from "node:child_process";
import { access, copyFile, mkdtemp, readdir, readFile, rm, unlink, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LOG_FILE_PATH, runCommand } from "./env";
import type { ProvisioningInfo } from "./types";

const execFileAsync = promisify(execFile);

const XCODE_PROFILES_DIR = join(homedir(), "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles");

export interface ParsedMobileProvision extends ProvisioningInfo {
  applicationIdentifier?: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function parseMobileProvision(provisionPath: string): Promise<ParsedMobileProvision | undefined> {
  if (!(await fileExists(provisionPath))) return undefined;
  try {
    const raw = await readFile(provisionPath);
    const text = raw.toString("latin1");
    const start = text.indexOf("<plist");
    const end = text.indexOf("</plist>");
    if (start === -1 || end === -1) return undefined;
    const xml = text.slice(start, end + "</plist>".length);

    const extractTagAfterKey = (key: string, tag: string): string | undefined => {
      const keyPattern = new RegExp(`<key>${key}</key>\\s*<${tag}>([^<]+)</${tag}>`);
      return xml.match(keyPattern)?.[1]?.trim();
    };

    const creationStr = extractTagAfterKey("CreationDate", "date");
    const expirationStr = extractTagAfterKey("ExpirationDate", "date");
    const name = extractTagAfterKey("Name", "string");
    const appId = extractTagAfterKey("application-identifier", "string");
    const teamMatch = xml.match(/<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]+)<\/string>/);

    const creationDate = creationStr ? Date.parse(creationStr) : undefined;
    const expirationDate = expirationStr ? Date.parse(expirationStr) : undefined;
    const now = Date.now();
    const hoursRemaining = expirationDate !== undefined ? (expirationDate - now) / (1000 * 60 * 60) : undefined;

    return {
      name,
      teamId: teamMatch?.[1]?.trim(),
      applicationIdentifier: appId,
      creationDate: Number.isFinite(creationDate) ? creationDate : undefined,
      expirationDate: Number.isFinite(expirationDate) ? expirationDate : undefined,
      hoursRemaining,
      expired: hoursRemaining !== undefined ? hoursRemaining <= 0 : false,
    };
  } catch {
    return undefined;
  }
}

/**
 * Remove cached Xcode provisioning profiles for `bundleId` when older than `maxAgeMs`
 * so `xcodebuild -allowProvisioningUpdates` requests a fresh 7-day profile from Apple.
 */
export async function evictStaleCachedProfiles(
  bundleId: string,
  teamId: string,
  maxAgeMs: number,
  onLog?: (msg: string) => void,
): Promise<number> {
  if (!bundleId || !(await fileExists(XCODE_PROFILES_DIR))) return 0;
  const targetAppId = teamId ? `${teamId}.${bundleId}` : undefined;
  const entries = await readdir(XCODE_PROFILES_DIR).catch(() => []);
  const now = Date.now();
  let removed = 0;

  for (const entry of entries) {
    if (!entry.endsWith(".mobileprovision")) continue;
    const fullPath = join(XCODE_PROFILES_DIR, entry);
    const parsed = await parseMobileProvision(fullPath);
    if (!parsed) continue;

    const matchesBundle =
      (targetAppId && parsed.applicationIdentifier === targetAppId) ||
      (parsed.name?.endsWith(`: ${bundleId}`) ?? false);
    if (!matchesBundle) continue;

    const ageMs = parsed.creationDate !== undefined ? now - parsed.creationDate : Number.POSITIVE_INFINITY;
    if (ageMs >= maxAgeMs) {
      await unlink(fullPath).catch(() => {});
      removed += 1;
      onLog?.(`>>> [provisioning] Evicted cached profile ${entry} (age ${Math.round(ageMs / 3600000)}h)\n`);
    }
  }
  return removed;
}

async function resolveSigningIdentity(teamId: string): Promise<string> {
  const { stdout } = await execFileAsync("security", ["find-identity", "-v", "-p", "codesigning"]);
  const lines = stdout.split(/\r?\n/);
  const matches: Array<{ hash: string; label: string }> = [];
  for (const line of lines) {
    const m = line.match(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"/);
    if (m) matches.push({ hash: m[1], label: m[2] });
  }
  const preferred =
    matches.find((m) => m.label.includes("Apple Development")) ??
    matches.find((m) => (teamId ? m.label.includes(teamId) : false)) ??
    matches[0];
  if (!preferred) {
    throw new Error("No valid codesigning identity found in keychain");
  }
  return preferred.hash;
}

async function collectNestedSignables(appPath: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === "_CodeSignature") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".framework") || entry.name.endsWith(".appex")) {
          await walk(fullPath);
          results.push(fullPath);
        } else {
          await walk(fullPath);
        }
      } else if (entry.isFile() && entry.name.endsWith(".dylib")) {
        results.push(fullPath);
      }
    }
  }
  await walk(appPath);
  return results;
}

/**
 * Fetch a fresh 7-day provisioning profile using a minimal temporary Xcode project
 * and re-sign an existing .app bundle in place without recompiling app sources.
 */
export async function renewAppProvisioning(options: {
  appPath: string;
  bundleId: string;
  teamId: string;
  deviceUdid: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
}): Promise<void> {
  const { appPath, bundleId, teamId, deviceUdid, env, signal, onOutput } = options;

  await evictStaleCachedProfiles(bundleId, teamId, 60 * 60 * 1000, onOutput);

  const tmpDir = await mkdtemp(join(tmpdir(), "ios-sideload-renew-"));
  try {
    const stubSrcDir = join(tmpDir, "Stub");
    const stubProjDir = join(tmpDir, "Stub.xcodeproj");
    const symRoot = join(tmpDir, "sym");
    await mkdir(stubSrcDir, { recursive: true });
    await mkdir(stubProjDir, { recursive: true });

    await writeFile(join(stubSrcDir, "main.c"), "int main(void){return 0;}\n", "utf8");
    await writeFile(
      join(stubSrcDir, "Info.plist"),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict>',
        "<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>",
        "<key>CFBundleExecutable</key><string>Stub</string>",
        "<key>CFBundlePackageType</key><string>APPL</string>",
        "</dict></plist>",
        "",
      ].join("\n"),
      "utf8",
    );

    const pbxproj = [
      "// !$*UTF8*$!",
      "{",
      "  archiveVersion = 1;",
      "  classes = {};",
      "  objectVersion = 56;",
      "  objects = {",
      '    1000 = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.c; path = Stub/main.c; sourceTree = "<group>"; };',
      "    1001 = {isa = PBXBuildFile; fileRef = 1000; };",
      '    1002 = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = Stub.app; sourceTree = BUILT_PRODUCTS_DIR; };',
      '    1003 = {isa = PBXGroup; children = (1000, 1002); sourceTree = "<group>"; };',
      "    1004 = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (1001); runOnlyForDeploymentPostprocessing = 0; };",
      `    1005 = {isa = XCBuildConfiguration; buildSettings = { CODE_SIGN_STYLE = Automatic; DEVELOPMENT_TEAM = ${teamId}; INFOPLIST_FILE = Stub/Info.plist; PRODUCT_BUNDLE_IDENTIFIER = ${bundleId}; PRODUCT_NAME = Stub; SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 15.0; }; name = Debug; };`,
      "    1006 = {isa = XCConfigurationList; buildConfigurations = (1005); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };",
      '    1007 = {isa = PBXNativeTarget; buildConfigurationList = 1006; buildPhases = (1004); buildRules = (); dependencies = (); name = Stub; productName = Stub; productReference = 1002; productType = "com.apple.product-type.application"; };',
      "    1008 = {isa = XCBuildConfiguration; buildSettings = { SDKROOT = iphoneos; }; name = Debug; };",
      "    1009 = {isa = XCConfigurationList; buildConfigurations = (1008); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };",
      '    1010 = {isa = PBXProject; buildConfigurationList = 1009; compatibilityVersion = "Xcode 14.0"; mainGroup = 1003; targets = (1007); };',
      "  };",
      "  rootObject = 1010;",
      "}",
      "",
    ].join("\n");
    await writeFile(join(stubProjDir, "project.pbxproj"), pbxproj, "utf8");

    onOutput?.(`>>> [provisioning] Refreshing 7-day profile for ${bundleId}\n`);
    const stubBuild = await runCommand(
      "xcodebuild",
      [
        "-project",
        stubProjDir,
        "-target",
        "Stub",
        "-configuration",
        "Debug",
        "-destination",
        `id=${deviceUdid}`,
        `SYMROOT=${symRoot}`,
        "-allowProvisioningUpdates",
        `DEVELOPMENT_TEAM=${teamId}`,
        `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
        "build",
      ],
      {
        cwd: tmpDir,
        env,
        signal,
        logFile: LOG_FILE_PATH,
        onOutput,
      },
    );

    if (stubBuild.code !== 0) {
      throw new Error(`Failed to refresh provisioning profile (exit ${stubBuild.code})`);
    }

    const freshProvision = join(symRoot, "Debug-iphoneos", "Stub.app", "embedded.mobileprovision");
    if (!(await fileExists(freshProvision))) {
      throw new Error("Fresh embedded.mobileprovision was not generated by xcodebuild");
    }

    const entRes = await runCommand("codesign", ["-d", "--entitlements", ":-", appPath], { env, signal });
    const entPlist = join(tmpDir, "entitlements.plist");
    const hasEntitlements = entRes.code === 0 && entRes.output.includes("<plist");
    if (hasEntitlements) {
      const plistStart = entRes.output.indexOf("<?xml");
      const rawXml = plistStart !== -1 ? entRes.output.slice(plistStart) : entRes.output.slice(entRes.output.indexOf("<plist"));
      await writeFile(entPlist, rawXml, "utf8");
    }

    await copyFile(freshProvision, join(appPath, "embedded.mobileprovision"));

    const identity = await resolveSigningIdentity(teamId);
    const nested = await collectNestedSignables(appPath);
    for (const item of nested) {
      const nestedRes = await runCommand(
        "codesign",
        ["--force", "--sign", identity, "--timestamp=none", "--generate-entitlement-der", item],
        { env, signal, logFile: LOG_FILE_PATH, onOutput },
      );
      if (nestedRes.code !== 0) {
        throw new Error(`Failed to re-sign nested binary ${item}`);
      }
    }

    const signArgs = [
      "--force",
      "--sign",
      identity,
      ...(hasEntitlements ? ["--entitlements", entPlist] : []),
      "--timestamp=none",
      "--generate-entitlement-der",
      appPath,
    ];
    onOutput?.(`>>> [codesign] Re-signing ${appPath}\n`);
    const signRes = await runCommand("codesign", signArgs, {
      env,
      signal,
      logFile: LOG_FILE_PATH,
      onOutput,
    });
    if (signRes.code !== 0) {
      throw new Error(`codesign failed (exit ${signRes.code})`);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
