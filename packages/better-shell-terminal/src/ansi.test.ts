import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansi.js';

describe('stripAnsi', () => {
  it('removes SGR color sequences', () => {
    expect(stripAnsi('\u001b[32;1mPath\u001b[0m')).toBe('Path');
  });

  it('removes cursor positioning and clear-screen sequences', () => {
    expect(stripAnsi('\u001b[2J\u001b[1;21HE:\\>echo hi')).toBe('E:\\>echo hi');
  });

  it('removes OSC title sequences terminated by BEL', () => {
    expect(stripAnsi('\u001b]0;title\u0007prompt>')).toBe('prompt>');
  });

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('BETTER_SHELL_OK\r\n')).toBe('BETTER_SHELL_OK\r\n');
  });
});
