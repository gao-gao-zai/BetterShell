import { writeFileSync } from 'node:fs';
import { spawn } from 'node-pty';
import { startProcessGuardian } from './job-object.js';

const outputFile = process.argv[2];
if (outputFile === undefined) throw new Error('output file argument is required');

const terminal = spawn('cmd.exe', ['/Q'], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
});
let initialized = false;
terminal.onData(async () => {
  if (initialized || terminal.pid <= 0) return;
  initialized = true;
  const guardian = startProcessGuardian(terminal.pid);
  await guardian.ready;
  writeFileSync(
    outputFile,
    JSON.stringify({ terminalPid: terminal.pid, guardianPid: guardian.helperPid }),
    'utf8',
  );
  terminal.write('ping -t 127.0.0.1\r');
  setTimeout(() => process.exit(17), 4_000);
});
