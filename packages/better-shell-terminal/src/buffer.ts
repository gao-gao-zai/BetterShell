import { Buffer } from 'node:buffer';

export interface BoundedTextSnapshot {
  readonly text: string;
  readonly truncated: boolean;
  readonly baseBytes: number;
  readonly endBytes: number;
  readonly generation: number;
}

export class BoundedText {
  private value = '';
  private dropped = false;
  private baseBytes = 0;
  private generation = 0;

  public constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new Error('maxBytes must be non-negative');
  }

  public append(text: string): void {
    if (text.length === 0) return;
    if (this.maxBytes === 0) {
      this.baseBytes += Buffer.byteLength(text, 'utf8');
      this.dropped = true;
      this.generation += 1;
      return;
    }
    this.value += text;
    if (Buffer.byteLength(this.value, 'utf8') <= this.maxBytes) return;
    const chars = Array.from(this.value);
    let bytes = 0;
    let start = chars.length;
    while (start > 0) {
      const next = Buffer.byteLength(chars[start - 1] ?? '', 'utf8');
      if (bytes + next > this.maxBytes) break;
      bytes += next;
      start -= 1;
    }
    const removed = chars.slice(0, start).join('');
    this.baseBytes += Buffer.byteLength(removed, 'utf8');
    this.value = chars.slice(start).join('');
    this.dropped = true;
    this.generation += 1;
  }

  public snapshot(): BoundedTextSnapshot {
    return {
      text: this.value,
      truncated: this.dropped,
      baseBytes: this.baseBytes,
      endBytes: this.baseBytes + Buffer.byteLength(this.value, 'utf8'),
      generation: this.generation,
    };
  }
}

export function readCursor(
  snapshot: BoundedTextSnapshot,
  cursor = snapshot.baseBytes,
  maxBytes = 64 * 1024,
): { text: string; cursor: number; truncated: boolean; generation: number } {
  if (!Number.isSafeInteger(cursor) || cursor < snapshot.baseBytes || cursor > snapshot.endBytes) {
    throw new Error('INVALID_CURSOR');
  }
  const localOffset = cursor - snapshot.baseBytes;
  const encoded = Buffer.from(snapshot.text, 'utf8');
  const prefix = encoded.subarray(0, localOffset).toString('utf8');
  if (Buffer.byteLength(prefix, 'utf8') !== localOffset) throw new Error('INVALID_CURSOR');
  const source = encoded.subarray(localOffset);
  let selectedLength = Math.min(Math.max(0, maxBytes), source.length);
  while (selectedLength > 0) {
    const decoded = source.subarray(0, selectedLength).toString('utf8');
    if (Buffer.byteLength(decoded, 'utf8') === selectedLength) break;
    selectedLength -= 1;
  }
  const decoded = source.subarray(0, selectedLength).toString('utf8');
  const returnedBytes = Buffer.byteLength(decoded, 'utf8');
  return {
    text: decoded,
    cursor: cursor + returnedBytes,
    truncated: returnedBytes < source.length,
    generation: snapshot.generation,
  };
}
