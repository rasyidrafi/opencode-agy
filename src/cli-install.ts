import { spawn } from "node:child_process";
import { AgyProcessError } from "./errors.js";

export const OFFICIAL_MAC_LINUX_INSTALL_COMMAND =
  "curl -fsSL https://antigravity.google/cli/install.sh | bash";
export const OFFICIAL_WINDOWS_POWERSHELL_INSTALL_COMMAND =
  "irm https://antigravity.google/cli/install.ps1 | iex";
export const OFFICIAL_WINDOWS_CMD_INSTALL_COMMAND =
  "curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd";

export function officialAgyInstallInstructions(): string {
  return process.platform === "win32"
    ? `PowerShell: ${OFFICIAL_WINDOWS_POWERSHELL_INSTALL_COMMAND}\nCMD: ${OFFICIAL_WINDOWS_CMD_INSTALL_COMMAND}`
    : OFFICIAL_MAC_LINUX_INSTALL_COMMAND;
}

/**
 * Run Google's fixed official installer. This is never called during normal
 * provider loading; callers must invoke it as an explicit user action.
 */
export async function installOfficialAgy(): Promise<void> {
  let executable: string;
  let args: string[];
  if (process.platform === "win32") {
    executable = "powershell.exe";
    args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", OFFICIAL_WINDOWS_POWERSHELL_INSTALL_COMMAND];
  } else {
    executable = "bash";
    args = ["-lc", OFFICIAL_MAC_LINUX_INSTALL_COMMAND];
  }
  const child = spawn(executable, args, {
    env: process.env,
    stdio: "inherit",
    windowsHide: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", (error: Error) => reject(new AgyProcessError("The official agy installer could not be started", error)));
    child.once("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new AgyProcessError(`The official agy installer exited with code ${code ?? "unknown"}`));
    });
  });
}
