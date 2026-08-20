import { spawn, type IPty } from 'node-pty';
import type { PtyFactory, PtyProcess, PtySpawnRequest } from './types.js';

function wrapPty(pty: IPty): PtyProcess {
  return {
    get pid() {
      return pty.pid;
    },
    supportsJobObject: true as const,
    onData(listener) {
      const disposable = pty.onData(listener);
      return () => {
        disposable.dispose();
      };
    },
    onExit(listener) {
      const disposable = pty.onExit(listener);
      return () => {
        disposable.dispose();
      };
    },
    write(data) {
      pty.write(data);
    },
    resize(cols, rows) {
      pty.resize(cols, rows);
    },
    kill() {
      pty.kill();
    },
  };
}

export const nodePtyFactory: PtyFactory = ({ profile, cwd, env, rows, cols }: PtySpawnRequest) => {
  if (process.platform !== 'win32') {
    throw new Error('better-shell-terminal currently requires Windows ConPTY');
  }
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) childEnv[key] = value;
  }
  const options = {
    name: 'xterm-256color',
    env: childEnv,
    rows,
    cols,
    ...(cwd === undefined ? {} : { cwd }),
  };
  return wrapPty(spawn(profile.executable, [...profile.args], options));
};
