import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShimEnv, runCommand } from "./env";
import type { DeviceInfo } from "./types";

interface DevicectlDevice {
  hardwareProperties?: {
    reality?: string;
    udid?: string;
    marketingName?: string;
    productType?: string;
  };
  deviceProperties?: {
    name?: string;
    osVersionNumber?: string;
  };
  connectionProperties?: {
    pairingState?: string;
    transportType?: string;
    tunnelState?: string;
  };
}

interface DevicectlOutput {
  result?: {
    devices?: DevicectlDevice[];
  };
}

export async function resolveTargetDevice(
  fallbackUdid: string,
  signal?: AbortSignal,
): Promise<DeviceInfo> {
  const cleanFallback = fallbackUdid.trim();
  const tempDir = await mkdtemp(join(tmpdir(), "devicectl-"));
  const jsonFile = join(tempDir, "devices.json");
  const shim = await createShimEnv();

  try {
    const result = await runCommand(
      "xcrun",
      ["devicectl", "list", "devices", "--json-output", jsonFile],
      { env: shim.env, signal },
    );

    if (result.code === 0) {
      const raw = await readFile(jsonFile, "utf8");
      const parsed = JSON.parse(raw) as DevicectlOutput;
      const devices = parsed.result?.devices ?? [];
      const physical = devices.filter(
        (d) =>
          d.hardwareProperties?.reality === "physical" &&
          d.connectionProperties?.pairingState === "paired" &&
          Boolean(d.hardwareProperties?.udid),
      );

      const preferred =
        (cleanFallback
          ? physical.find((d) => d.hardwareProperties?.udid === cleanFallback)
          : undefined) ?? physical[0];

      if (preferred?.hardwareProperties?.udid) {
        const transport = preferred.connectionProperties?.transportType;
        const tunnelState = preferred.connectionProperties?.tunnelState;
        const connected =
          tunnelState === "connected" ||
          transport === "wired" ||
          transport === "localNetwork";
        return {
          udid: preferred.hardwareProperties.udid,
          name: preferred.deviceProperties?.name ?? preferred.hardwareProperties.marketingName ?? "iPhone",
          model: preferred.hardwareProperties.marketingName ?? preferred.hardwareProperties.productType,
          osVersion: preferred.deviceProperties?.osVersionNumber,
          transport,
          connected,
          isFallback: false,
        };
      }
    }
  } catch {
    // Fall back to configured UDID below
  } finally {
    await Promise.all([
      rm(tempDir, { recursive: true, force: true }),
      shim.cleanup(),
    ]);
  }

  return {
    udid: cleanFallback || "UNKNOWN",
    name: cleanFallback ? "Fallback iPhone" : "No Device Configured",
    connected: false,
    isFallback: true,
  };
}
