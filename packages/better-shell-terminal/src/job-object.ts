import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type GuardianState = 'pending' | 'ready' | 'failed' | 'closed';

export interface ProcessGuardian {
  readonly helperPid: number | undefined;
  readonly state: GuardianState;
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

const POWERSHELL_JOB_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
function Publish-DshStatus([string]$status) { [Console]::Out.WriteLine($status); [Console]::Out.Flush() }
function Stop-DshGuardian([int]$code) { Publish-DshStatus ('ERROR:' + $code); exit $code }
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshJobApi {
  [StructLayout(LayoutKind.Sequential)] public struct IoCounters {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] public struct BasicLimitInformation {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct ExtendedLimitInformation {
    public BasicLimitInformation BasicLimitInformation; public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimitInformation info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
}
'@
$job = [DshJobApi]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { Stop-DshGuardian 21 }
$limits = New-Object DshJobApi+ExtendedLimitInformation
$limits.BasicLimitInformation.LimitFlags = 0x2000
if (-not [DshJobApi]::SetInformationJobObject($job, 9, [ref]$limits, [uint32][Runtime.InteropServices.Marshal]::SizeOf($limits))) { [DshJobApi]::CloseHandle($job); Stop-DshGuardian 22 }
$target = [DshJobApi]::OpenProcess(0x001F0FFF, $false, [uint32]__DSH_PID__)
if ($target -eq [IntPtr]::Zero) { [DshJobApi]::CloseHandle($job); Stop-DshGuardian 23 }
if (-not [DshJobApi]::AssignProcessToJobObject($job, $target)) {
  [DshJobApi]::CloseHandle($target) | Out-Null
  [DshJobApi]::CloseHandle($job) | Out-Null
  Publish-DshStatus 'READY:FALLBACK'
  while (Get-Process -Id __DSH_PARENT_PID__ -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 100 }
  & taskkill.exe /PID __DSH_PID__ /T /F 2>$null | Out-Null
  exit 0
}
[DshJobApi]::CloseHandle($target) | Out-Null
Publish-DshStatus 'READY:JOB'
while (Get-Process -Id __DSH_PARENT_PID__ -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 100 }
[DshJobApi]::CloseHandle($job) | Out-Null
} catch {
  Publish-DshStatus 'ERROR:26'
  exit 26
}
`;

function helperScript(pid: number): string {
  return POWERSHELL_JOB_HELPER.replaceAll('__DSH_PID__', String(pid)).replaceAll(
    '__DSH_PARENT_PID__',
    String(process.pid),
  );
}

function noopGuardian(): ProcessGuardian {
  return {
    helperPid: undefined,
    state: 'ready',
    ready: Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

function killTree(pid: number): void {
  if (pid <= 0 || process.platform !== 'win32') return;
  try {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.unref();
  } catch {
    // The target may already have exited.
  }
}

export function startProcessGuardian(pid: number, readinessTimeoutMs = 30_000): ProcessGuardian {
  if (process.platform !== 'win32' || pid === 0) return noopGuardian();
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('JOB_OBJECT_ASSIGNMENT_FAILED');

  const scriptPath = join(tmpdir(), `better-shell-guardian-${randomUUID()}.ps1`);
  writeFileSync(scriptPath, helperScript(pid), 'utf8');
  const helper = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  ) as unknown as ChildProcessWithoutNullStreams;
  let state: GuardianState = 'pending';
  let closePromise: Promise<void> | undefined;
  let stderr = '';

  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error('JOB_OBJECT_ASSIGNMENT_FAILED: timeout'));
    }, readinessTimeoutMs);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(scriptPath, { force: true });
      if (error === undefined) {
        state = 'ready';
        helper.stdout.destroy();
        helper.stderr.destroy();
        helper.unref();
        resolve();
      } else {
        state = 'failed';
        reject(error);
      }
    };
    helper.stderr.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 16 * 1024)
        stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    let protocolBuffer = '';
    helper.stdout.on('data', (chunk: Buffer | string) => {
      protocolBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const readyIndex = protocolBuffer.indexOf('READY:');
      const errorIndex = protocolBuffer.indexOf('ERROR:');
      if (readyIndex >= 0 && (errorIndex < 0 || readyIndex < errorIndex)) {
        finish();
        return;
      }
      if (errorIndex >= 0) {
        const line = protocolBuffer.slice(errorIndex).split(/\r?\n/, 1)[0] ?? 'ERROR:unknown';
        finish(new Error(`JOB_OBJECT_ASSIGNMENT_FAILED: ${line}`));
      }
    });
    helper.once('error', (error) => {
      finish(new Error(`JOB_OBJECT_ASSIGNMENT_FAILED: ${error.message}`));
    });
    helper.once('close', (code) => {
      if (!settled) {
        const detail = `${stderr.trim().slice(0, 512)} ${protocolBuffer.slice(0, 128)}`.trim();
        finish(
          new Error(
            `JOB_OBJECT_ASSIGNMENT_FAILED: helper exit ${String(code)}${detail.length === 0 ? '' : `: ${detail}`}`,
          ),
        );
      }
    });
  });

  return {
    get helperPid() {
      return helper.pid;
    },
    get state() {
      return state;
    },
    ready,
    close() {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async () => {
        killTree(pid);
        if (helper.exitCode === null) helper.kill();
        await new Promise<void>((resolve) => {
          if (helper.exitCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, 3_000);
          helper.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        rmSync(scriptPath, { force: true });
        state = 'closed';
      })();
      return closePromise;
    },
  };
}
