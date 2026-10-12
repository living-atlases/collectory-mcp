import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Just enough of the zip format to read the small files of a Darwin Core Archive (meta.xml, eml.xml) without a
 * dependency: the central directory, then stored or deflated entries. No zip64, no encryption.
 */
export interface ZipEntry {
  name: string;
  size: number;
  read(): Buffer;
}

/** Reads `length` bytes at `offset` of the archive. */
export type ZipSource = { size: number; read(offset: number, length: number): Buffer };

export const bufferSource = (buf: Buffer): ZipSource => ({ size: buf.length, read: (o, l) => buf.subarray(o, o + l) });

export function fileSource(path: string): ZipSource & { close(): void } {
  const fd = openSync(path, "r");
  const size = fstatSync(fd).size;
  return {
    size,
    read(offset, length) {
      const b = Buffer.alloc(length);
      readSync(fd, b, 0, length, offset);
      return b;
    },
    close: () => closeSync(fd),
  };
}

export function readZip(src: ZipSource | Buffer): ZipEntry[] {
  const z = Buffer.isBuffer(src) ? bufferSource(src) : src;
  const tailLen = Math.min(z.size, 65_557);
  const tail = z.read(z.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory)");
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("zip64 archives (over 4 GB or 65535 files) are not supported here");
  const cd = z.read(cdOffset, cdSize);
  let p = 0;
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = cd.readUInt16LE(p + 10);
    const csize = cd.readUInt32LE(p + 20);
    const size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const local = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (csize === 0xffffffff || local === 0xffffffff) throw new Error(`zip64 entry ${name} is not supported here`);
    out.push({
      name,
      size,
      read() {
        const h = z.read(local, 30);
        if (h.readUInt32LE(0) !== 0x04034b50) throw new Error(`corrupt zip entry ${name}`);
        const data = z.read(local + 30 + h.readUInt16LE(26) + h.readUInt16LE(28), csize);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return inflateRawSync(data);
        throw new Error(`${name}: unsupported zip compression method ${method}`);
      },
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** A zip of stored (or deflated) entries, for tests and fixtures. CRCs are left at 0: readZip does not check them. */
export function writeZip(files: Record<string, string | Buffer>, o: { deflate?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const plain = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const data = o.deflate ? deflateRawSync(plain) : plain;
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(o.deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(o.deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
