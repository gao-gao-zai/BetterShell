import { Context } from '@deepseek-ai/cordis';
import { installSettingsSection } from '@deepseek-ai/dsh-settings';
import {
  Config,
  DEFAULT_SETTINGS,
  SETTINGS_NAMESPACE,
  type BetterShellSettings,
} from './config.js';
import { createDefaultConfig, LocalBetterShellService } from './service.js';
import type { BetterShellService, PtyFactory, TerminalConfig } from './types.js';

export {
  Config,
  DEFAULT_SETTINGS,
  HARD_LIMITS,
  SETTINGS_NAMESPACE,
  type BetterShellSettings,
} from './config.js';
export type {
  BetterShellService,
  CommandId,
  CommandOperation,
  CommandSnapshot,
  CleanupSummary,
  CreateSessionRequest,
  PtyFactory,
  PtyProcess,
  ReadRequest,
  ReadResult,
  SessionId,
  SessionSnapshot,
  ShellKind,
  SingleProcess,
  StartSingleRequest,
  ShellProfile,
  TerminalConfig,
  WriteRequest,
  WriteResult,
} from './types.js';
export { BoundedText, readCursor } from './buffer.js';
export { DEFAULT_PROFILES, resolveProfile, resolveSingleProfile } from './profiles.js';
export { LocalBetterShellService, createDefaultConfig } from './service.js';
export { nodePtyFactory } from './node-pty-factory.js';
export { startSingleProcess } from './single-process.js';

export const name = 'better-shell-terminal';
export const inject: readonly string[] = [];

export type PluginConfig = Omit<Partial<TerminalConfig>, 'writeTimeoutMs'> &
  Partial<BetterShellSettings> & {
    readonly factory?: PtyFactory;
  };

declare module '@deepseek-ai/cordis' {
  interface Context {
    betterShell: BetterShellService;
  }
}

export function apply(ctx: Context, config: PluginConfig = {}): void {
  const entrySettings: BetterShellSettings = Config({
    maxRuntimeMs: config.maxRuntimeMs ?? DEFAULT_SETTINGS.maxRuntimeMs,
    backgroundTimeoutMs: config.backgroundTimeoutMs ?? DEFAULT_SETTINGS.backgroundTimeoutMs,
    waitTimeoutMs: config.waitTimeoutMs ?? DEFAULT_SETTINGS.waitTimeoutMs,
    readWaitMs: config.readWaitMs ?? DEFAULT_SETTINGS.readWaitMs,
    writeTimeoutMs: config.writeTimeoutMs ?? DEFAULT_SETTINGS.writeTimeoutMs,
    outputBytes: config.outputBytes ?? DEFAULT_SETTINGS.outputBytes,
    maxSessions: config.maxSessions ?? DEFAULT_SETTINGS.maxSessions,
    maxCommandHistory: config.maxCommandHistory ?? DEFAULT_SETTINGS.maxCommandHistory,
    maxWriteBytes: config.maxWriteBytes ?? DEFAULT_SETTINGS.maxWriteBytes,
    maxConcurrentJobs: config.maxConcurrentJobs ?? DEFAULT_SETTINGS.maxConcurrentJobs,
  });
  let currentSettings = (): BetterShellSettings => entrySettings;
  installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, entrySettings, {
    setSource(source) {
      currentSettings = source;
    },
    onChange() {
      // Service operations read the current settings source on every call.
    },
  });
  const service = new LocalBetterShellService(createDefaultConfig(config), config.factory, () =>
    currentSettings(),
  );
  ctx.provide('betterShell', service);
  ctx.effect(
    () => async () => {
      await service.closeAll();
    },
    'better-shell-terminal teardown',
  );
}

export default { name, inject, apply };
