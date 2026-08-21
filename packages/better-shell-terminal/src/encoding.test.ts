import { describe, expect, it } from 'vitest';
import { ShellOutputDecoder } from './encoding.js';

// GB18030/GBK bytes for "中文编码": 中 D6D0 文 CEC4 编 B1E0 码 C2EB.
const GB_BYTES = Buffer.from('d6d0cec4b1e0c2eb', 'hex');

describe('ShellOutputDecoder', () => {
  it('decodes UTF-8 output', () => {
    const decoder = new ShellOutputDecoder('utf-8');
    expect(decoder.decode(Buffer.from('中文编码', 'utf8')) + decoder.flush()).toBe('中文编码');
  });

  it('decodes Windows GB18030 output without replacement characters', () => {
    const decoder = new ShellOutputDecoder('gb18030');
    expect(decoder.decode(GB_BYTES) + decoder.flush()).toBe('中文编码');
  });

  it('handles a multibyte sequence split across chunks', () => {
    const decoder = new ShellOutputDecoder('gb18030');
    const first = decoder.decode(GB_BYTES.subarray(0, 1));
    const second = decoder.decode(GB_BYTES.subarray(1));
    expect(first + second + decoder.flush()).toBe('中文编码');
  });
});
