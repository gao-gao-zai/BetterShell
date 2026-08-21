import type { ShellProfile } from './types.js';

export const DEFAULT_PROFILES: Readonly<Record<string, ShellProfile>> = {
  pwsh7: {
    kind: 'powershell',
    executable: 'pwsh.exe',
    args: ['-NoLogo', '-NoProfile', '-NoExit'],
    singleArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
    allowSingle: true,
    allowPty: true,
    encoding: 'utf-8',
  },
  windowsPowerShell: {
    kind: 'powershell',
    executable: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NoExit'],
    singleArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
    allowSingle: true,
    allowPty: true,
    encoding: 'utf-8',
  },
  cmd: {
    kind: 'cmd',
    executable: 'cmd.exe',
    args: ['/Q'],
    singleArgs: ['/Q', '/D', '/S', '/C'],
    allowSingle: true,
    allowPty: true,
    encoding: 'gb18030',
  },
};

export function resolveSingleProfile(
  profiles: Readonly<Record<string, ShellProfile>>,
  name: string,
): ShellProfile {
  const profile = profiles[name];
  if (profile === undefined) throw new Error(`unknown shell profile: ${name}`);
  if (profile.allowSingle === false || profile.singleArgs === undefined) {
    throw new Error(`single execution is disabled for shell profile: ${name}`);
  }
  return profile;
}

export function resolveProfile(
  profiles: Readonly<Record<string, ShellProfile>>,
  name: string,
): ShellProfile {
  const profile = profiles[name];
  if (profile === undefined) throw new Error(`unknown shell profile: ${name}`);
  if (profile.allowPty === false) throw new Error(`PTY is disabled for shell profile: ${name}`);
  return profile;
}
