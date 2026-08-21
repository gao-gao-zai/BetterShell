/** Decodes raw PTY bytes using the profile's declared Windows encoding. */
export class ShellOutputDecoder {
  private readonly decoder: TextDecoder;

  public constructor(encoding = 'utf-8') {
    this.decoder = new TextDecoder(encoding);
  }

  public decode(data: string | Uint8Array): string {
    if (typeof data === 'string') return data;
    return this.decoder.decode(data, { stream: true });
  }

  public flush(): string {
    return this.decoder.decode();
  }
}
