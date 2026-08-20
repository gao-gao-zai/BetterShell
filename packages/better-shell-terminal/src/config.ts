import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';

export const HARD_LIMITS = {
  maxRuntimeMs: 24 * 60 * 60 * 1000,
  backgroundTimeoutMs: 10 * 60 * 1000,
  waitTimeoutMs: 30_000,
  readWaitMs: 30_000,
  writeTimeoutMs: 10_000,
  outputBytes: 1024 * 1024,
  maxSessions: 64,
  maxCommandHistory: 1024,
  maxWriteBytes: 64 * 1024,
  maxConcurrentJobs: 32,
} as const;

export const Config = z.object({
  maxRuntimeMs: z
    .natural()
    .min(1)
    .max(HARD_LIMITS.maxRuntimeMs)
    .default(HARD_LIMITS.maxRuntimeMs)
    .description('Absolute command runtime limit in milliseconds.'),
  backgroundTimeoutMs: z
    .natural()
    .min(1)
    .max(HARD_LIMITS.backgroundTimeoutMs)
    .default(HARD_LIMITS.backgroundTimeoutMs)
    .description('Maximum inactivity time for a background command in milliseconds.'),
  waitTimeoutMs: z
    .natural()
    .min(0)
    .max(HARD_LIMITS.waitTimeoutMs)
    .default(HARD_LIMITS.waitTimeoutMs)
    .description('Maximum foreground wait time in milliseconds.'),
  readWaitMs: z
    .natural()
    .min(0)
    .max(HARD_LIMITS.readWaitMs)
    .default(HARD_LIMITS.readWaitMs)
    .description('Maximum shell_read wait time in milliseconds.'),
  writeTimeoutMs: z
    .natural()
    .min(1)
    .max(HARD_LIMITS.writeTimeoutMs)
    .default(5_000)
    .description('Maximum PTY write timeout in milliseconds.'),
  outputBytes: z
    .natural()
    .min(0)
    .max(HARD_LIMITS.outputBytes)
    .default(16 * 1024)
    .description('Maximum UTF-8 output bytes returned by one tool call.'),
  maxSessions: z
    .natural()
    .min(1)
    .max(HARD_LIMITS.maxSessions)
    .default(32)
    .description('Maximum PTY sessions owned by one Agent.'),
  maxCommandHistory: z
    .natural()
    .min(1)
    .max(HARD_LIMITS.maxCommandHistory)
    .default(256)
    .description('Maximum retained command records per PTY session.'),
  maxWriteBytes: z
    .natural()
    .min(1)
    .max(HARD_LIMITS.maxWriteBytes)
    .default(HARD_LIMITS.maxWriteBytes)
    .description('Maximum UTF-8 bytes accepted by one PTY write.'),
  maxConcurrentJobs: z
    .natural()
    .min(1)
    .max(HARD_LIMITS.maxConcurrentJobs)
    .default(8)
    .description('Maximum concurrent BetterShell jobs owned by one Agent.'),
});

export type BetterShellSettings = Schemastery.TypeT<typeof Config>;

export const DEFAULT_SETTINGS: BetterShellSettings = Config({});
export const SETTINGS_NAMESPACE = settingsNamespace('better-shell-terminal');
