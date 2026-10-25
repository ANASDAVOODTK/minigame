// Little-endian binary writer/reader over a reusable ArrayBuffer (no per-packet allocation).

export class ByteWriter {
  readonly buf: ArrayBuffer;
  private dv: DataView;
  private u8a: Uint8Array;
  pos = 0;

  constructor(capacity = 2048) {
    this.buf = new ArrayBuffer(capacity);
    this.dv = new DataView(this.buf);
    this.u8a = new Uint8Array(this.buf);
  }

  reset(): this {
    this.pos = 0;
    return this;
  }

  private ensure(n: number): void {
    if (this.pos + n > this.buf.byteLength) throw new RangeError('ByteWriter overflow');
  }

  u8(v: number): this {
    this.ensure(1);
    this.dv.setUint8(this.pos, v);
    this.pos += 1;
    return this;
  }
  i8(v: number): this {
    this.ensure(1);
    this.dv.setInt8(this.pos, v);
    this.pos += 1;
    return this;
  }
  u16(v: number): this {
    this.ensure(2);
    this.dv.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }
  i16(v: number): this {
    this.ensure(2);
    this.dv.setInt16(this.pos, v, true);
    this.pos += 2;
    return this;
  }
  u32(v: number): this {
    this.ensure(4);
    this.dv.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }
  /** Writes a u8 placeholder and returns its offset (patch later with setU8). */
  mark(): number {
    const at = this.pos;
    this.u8(0);
    return at;
  }
  setU8(at: number, v: number): void {
    this.dv.setUint8(at, v);
  }
  /** View of the written bytes (no copy; valid until the next reset). */
  bytes(): Uint8Array {
    return this.u8a.subarray(0, this.pos);
  }
}

export class ByteReader {
  private dv: DataView;
  pos = 0;
  readonly length: number;

  constructor(buf: ArrayBuffer | Uint8Array) {
    if (buf instanceof Uint8Array) {
      this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      this.length = buf.byteLength;
    } else {
      this.dv = new DataView(buf);
      this.length = buf.byteLength;
    }
  }

  get remaining(): number {
    return this.length - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.length) throw new RangeError('ByteReader underflow');
  }

  u8(): number {
    this.need(1);
    return this.dv.getUint8(this.pos++);
  }
  i8(): number {
    this.need(1);
    return this.dv.getInt8(this.pos++);
  }
  u16(): number {
    this.need(2);
    const v = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.dv.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
}
