import { describe, expect, it } from 'vitest';
import { BoundedText, readCursor } from './buffer.js';

describe('BoundedText', () => {
  it('keeps the UTF-8-safe tail and reports truncation', () => {
    const buffer = new BoundedText(4);
    buffer.append('你好');
    expect(buffer.snapshot()).toEqual({
      text: '好',
      truncated: true,
      baseBytes: 3,
      endBytes: 6,
      generation: 1,
    });
  });

  it('invalidates cursors that point before the retained byte range', () => {
    const buffer = new BoundedText(4);
    buffer.append('abcdef');
    expect(() => readCursor(buffer.snapshot(), 0, 2)).toThrow('INVALID_CURSOR');
  });
});

describe('readCursor', () => {
  it('allows a zero-byte buffer while advancing the absolute end cursor', () => {
    const buffer = new BoundedText(0);
    buffer.append('你好');
    expect(buffer.snapshot()).toMatchObject({
      text: '',
      truncated: true,
      baseBytes: 6,
      endBytes: 6,
    });
    expect(readCursor(buffer.snapshot(), 6, 0)).toMatchObject({
      text: '',
      cursor: 6,
      truncated: true,
    });
  });

  it('does not split a UTF-8 character when the byte limit ends inside it', () => {
    const buffer = new BoundedText(64);
    buffer.append('你好');
    expect(readCursor(buffer.snapshot(), 0, 2)).toEqual({
      text: '',
      cursor: 0,
      truncated: true,
      generation: 0,
    });
    expect(readCursor(buffer.snapshot(), 0, 3)).toEqual({
      text: '你',
      cursor: 3,
      truncated: true,
      generation: 0,
    });
    expect(() => readCursor(buffer.snapshot(), 1, 3)).toThrow('INVALID_CURSOR');
  });

  it('reads from an absolute byte cursor and advances by returned bytes', () => {
    const buffer = new BoundedText(64);
    buffer.append('abcdef');
    expect(readCursor(buffer.snapshot(), 2, 3)).toEqual({
      text: 'cde',
      cursor: 5,
      truncated: true,
      generation: 0,
    });
  });

  it('propagates head-drop truncation into the read result', () => {
    const buffer = new BoundedText(4);
    buffer.append('你好');
    const snapshot = buffer.snapshot();
    expect(snapshot.truncated).toBe(true);
    expect(readCursor(snapshot, snapshot.baseBytes, 64)).toMatchObject({
      text: '好',
      truncated: true,
    });
  });
});
