import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

/**
 * Reads only what has been appended to a file since the last read.
 *
 * The quota poller runs once a second for up to an hour against a log that
 * grows continuously; re-reading the whole file each time makes the scan cost
 * grow with run length for no benefit.
 *
 * A read can land mid-line, which would hide the very 429 line the poller is
 * looking for, so an incomplete trailing line is carried into the next read
 * rather than returned. `flush` returns it when there will be no next read.
 */
export class LogTail {
  private offset = 0;
  private carry = "";
  private decoder = new StringDecoder("utf8");

  constructor(private readonly path: string) {}

  private async append(): Promise<void> {
    let handle;
    try {
      handle = await open(this.path, "r");
    } catch {
      return;
    }
    try {
      const { size } = await handle.stat();
      // Truncated or rotated underneath us — start over rather than read garbage.
      if (size < this.offset) {
        this.offset = 0;
        this.carry = "";
        this.decoder = new StringDecoder("utf8");
      }
      if (size <= this.offset) return;
      const length = size - this.offset;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buf, 0, length, this.offset);
      this.offset += bytesRead;
      // StringDecoder, not toString: a codepoint straddling this read's end
      // would otherwise be corrupted into U+FFFD instead of joining the next.
      this.carry += this.decoder.write(buf.subarray(0, bytesRead));
    } catch {
      // unreadable this tick; the next one retries from the same offset
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /** Complete lines appended since the previous call. */
  async read(): Promise<string> {
    await this.append();
    const cut = this.carry.lastIndexOf("\n");
    if (cut === -1) return "";
    const out = this.carry.slice(0, cut + 1);
    this.carry = this.carry.slice(cut + 1);
    return out;
  }

  /** Everything still unread, including a final line with no newline. */
  async flush(): Promise<string> {
    await this.append();
    const out = this.carry;
    this.carry = "";
    return out;
  }
}
