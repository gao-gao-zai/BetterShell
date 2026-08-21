import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BoundedText, readCursor } from './buffer.js';
import { ShellOutputDecoder } from './encoding.js';
import { stripAnsi } from './ansi.js';
import { startProcessGuardian } from './job-object.js';
import type { ShellProfile, SingleProcess } from './types.js';

export interface SingleSpawnRequest {
  readonly name: string;
  readonly profile: ShellProfile;
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

function childEnvironment(
  overlay: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...overlay })) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function gatedCommand(profile: ShellProfile, command: string, gate: string): string {
  const quoted = gate.replaceAll("'", "''");
  if (profile.kind === 'powershell') {
    return `[Console]::OutputEncoding=[Text.Encoding]::UTF8; while (-not (Test-Path -LiteralPath '${quoted}')) { Start-Sleep -Milliseconds 10 }; ${command}`;
  }
  if (profile.kind === 'cmd') {
    const waitScript = `while (-not (Test-Path -LiteralPath '${quoted}')) { Start-Sleep -Milliseconds 10 }`;
    const encoded = Buffer.from(waitScript, 'utf16le').toString('base64');
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded} & ${command}`;
  }
  throw new Error(`single execution is disabled for shell profile kind: ${profile.kind}`);
}

function waitForClose(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => {
    child.once('close', (code) => {
      resolve(code);
    });
    child.once('error', () => {
      resolve(null);
    });
  });
}

export async function startSingleProcess(request: SingleSpawnRequest): Promise<SingleProcess> {
  if (process.platform !== 'win32')
    throw new Error('better-shell-terminal single execution currently requires Windows');
  if (request.command.trim().length === 0) throw new Error('command must be non-empty');
  if (request.profile.allowSingle === false || request.profile.singleArgs === undefined) {
    throw new Error(`single execution is disabled for shell profile: ${request.name}`);
  }

  const gate = join(tmpdir(), `better-shell-single-${randomUUID()}.gate`);
  const child: ChildProcessWithoutNullStreams = spawn(
    request.profile.executable,
    [...request.profile.singleArgs, gatedCommand(request.profile, request.command, gate)],
    {
      cwd: request.cwd,
      env: childEnvironment(request.env),
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ) as unknown as ChildProcessWithoutNullStreams;
  const output = new BoundedText(request.maxOutputBytes);
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let killed = false;
  const decoder = new ShellOutputDecoder(request.profile.encoding ?? 'utf-8');
  const append = (chunk: Buffer | string): void => {
    lastActivityAt = Date.now();
    output.append(stripAnsi(decoder.decode(typeof chunk === 'string' ? chunk : chunk)));
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  let guardian;
  try {
    guardian = startProcessGuardian(child.pid ?? 0);
  } catch (error) {
    child.kill();
    rmSync(gate, { force: true });
    await waitForClose(child);
    throw error;
  }
  const abort = () => {
    child.kill();
    void guardian.close();
    rmSync(gate, { force: true });
  };
  request.signal?.addEventListener('abort', abort, { once: true });
  try {
    await guardian.ready;
    if (request.signal?.aborted) throw new Error('COMMAND_CANCELLED');
    writeFileSync(gate, 'READY', 'utf8');
  } catch (error) {
    abort();
    await waitForClose(child);
    throw error;
  }

  const done = waitForClose(child).then(async (exitCode) => {
    request.signal?.removeEventListener('abort', abort);
    rmSync(gate, { force: true });
    await guardian.close();
    return { exitCode, finishedAt: Date.now() };
  });
  let readOffset = 0;
  return {
    profile: request.name,
    pid: child.pid ?? 0,
    startedAt,
    activityAt: () => lastActivityAt,
    done,
    readOutput: () => {
      const snapshot = output.snapshot();
      const resynchronized = readOffset < snapshot.baseBytes;
      const cursor = resynchronized ? snapshot.baseBytes : readOffset;
      const result = readCursor(snapshot, cursor, snapshot.endBytes - cursor);
      readOffset = result.cursor;
      return {
        delta: result.text,
        truncated: resynchronized || snapshot.truncated || result.truncated,
      };
    },
    kill: () => {
      if (killed) return;
      killed = true;
      abort();
    },
  };
}
