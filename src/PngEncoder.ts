import { colorAlpha, colorBlue, colorGreen, colorRed } from './HeatmapGradient';

/**
 * 強度の配列を RGBA の PNG へ書き出す部分。
 *
 * **canvas を使わない。** タイルは Web Worker でも Node でも作られるうえ、
 * canvas 経由だと 1 枚ごとに ImageData と Blob を作ることになり、
 * 1 画面数十枚のヒートマップでは確保と GC が支配的になる。
 *
 * 圧縮はせず、zlib の**格納（無圧縮）ブロック**をそのまま並べる。
 * 展開はブラウザ側の PNG デコーダが行うので、こちらで縮める意味が薄く、
 * pako 等を持ち込むと依存が増える。
 *
 * android-sdk の `PngEncoder.kt` / `PngByteBuffer.kt` と同じ構成。
 * ios-sdk は CoreGraphics で画像を作るのでこの相当物を持たない。
 */
// ─── CRC32 ───────────────────────────────────────────────────────────────────

const CRC32_TABLE = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? ((0xedb88320 ^ (c >>> 1)) | 0) : (c >>> 1);
        }
        t[i] = c;
    }
    return t;
})();

function crc32Init(): number { return -1; }
function crc32Update(crc: number, data: Uint8Array, offset: number, len: number): number {
    for (let i = offset; i < offset + len; i++) {
        crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return crc;
}
function crc32Finalize(crc: number): number { return (crc ^ -1) >>> 0; }

// ─── Adler32 ─────────────────────────────────────────────────────────────────

const ADLER_MOD = 65521;

function adler32Update(s: number, data: Uint8Array, offset: number, len: number): number {
    let s1 = s & 0xffff;
    let s2 = (s >>> 16) & 0xffff;
    for (let i = offset; i < offset + len; i++) {
        s1 = (s1 + data[i]) % ADLER_MOD;
        s2 = (s2 + s1) % ADLER_MOD;
    }
    return ((s2 << 16) | s1) >>> 0;
}

// ─── DynamicBuffer ───────────────────────────────────────────────────────────

export class DynamicBuffer {
    private buf: Uint8Array;
    private count = 0;

    constructor(initialCapacity = 4096) {
        this.buf = new Uint8Array(Math.max(initialCapacity, 16));
    }

    position(): number { return this.count; }

    reset(): void { this.count = 0; }

    private grow(minCapacity: number): void {
        if (this.buf.length >= minCapacity) return;
        let n = this.buf.length;
        while (n < minCapacity) n = (n * 2) | 0;
        const next = new Uint8Array(n);
        next.set(this.buf.subarray(0, this.count));
        this.buf = next;
    }

    writeByte(v: number): void {
        this.grow(this.count + 1);
        this.buf[this.count++] = v & 0xff;
    }

    writeInt32BE(v: number): void {
        this.grow(this.count + 4);
        this.buf[this.count++] = (v >>> 24) & 0xff;
        this.buf[this.count++] = (v >>> 16) & 0xff;
        this.buf[this.count++] = (v >>> 8) & 0xff;
        this.buf[this.count++] = v & 0xff;
    }

    setInt32BE(offset: number, v: number): void {
        this.buf[offset] = (v >>> 24) & 0xff;
        this.buf[offset + 1] = (v >>> 16) & 0xff;
        this.buf[offset + 2] = (v >>> 8) & 0xff;
        this.buf[offset + 3] = v & 0xff;
    }

    writeBytes(src: Uint8Array, offset = 0, len = src.length): void {
        if (len <= 0) return;
        this.grow(this.count + len);
        this.buf.set(src.subarray(offset, offset + len), this.count);
        this.count += len;
    }

    toUint8Array(): Uint8Array {
        return this.buf.slice(0, this.count);
    }
}

// ─── PNG helpers ─────────────────────────────────────────────────────────────

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR = new Uint8Array([0x49, 0x48, 0x44, 0x52]);
const PNG_IDAT = new Uint8Array([0x49, 0x44, 0x41, 0x54]);
const PNG_IEND = new Uint8Array([0x49, 0x45, 0x4e, 0x44]);
// zlib header: CMF=0x78 (deflate, window size 32K), FLG=0x01 (check bits, no dict, level 0)
const ZLIB_HEADER = new Uint8Array([0x78, 0x01]);
// Final empty stored block: BFINAL=1, BTYPE=00, LEN=0, NLEN=0xFFFF
const ZLIB_FINAL_EMPTY_BLOCK = new Uint8Array([0x01, 0x00, 0x00, 0xff, 0xff]);
const EMPTY_BYTES = new Uint8Array(0);

function writeIhdr(out: Uint8Array, width: number, height: number): void {
    out[0] = (width >>> 24) & 0xff; out[1] = (width >>> 16) & 0xff;
    out[2] = (width >>> 8) & 0xff;  out[3] = width & 0xff;
    out[4] = (height >>> 24) & 0xff; out[5] = (height >>> 16) & 0xff;
    out[6] = (height >>> 8) & 0xff;  out[7] = height & 0xff;
    out[8] = 8;  // bit depth
    out[9] = 6;  // color type: RGBA
    out[10] = 0; // compression
    out[11] = 0; // filter
    out[12] = 0; // interlace
}

function writePngChunk(
    buf: DynamicBuffer,
    type: Uint8Array,
    data: Uint8Array,
    offset: number,
    len: number,
): void {
    buf.writeInt32BE(len);
    buf.writeBytes(type);
    if (len > 0) buf.writeBytes(data, offset, len);
    let crc = crc32Init();
    crc = crc32Update(crc, type, 0, type.length);
    if (len > 0) crc = crc32Update(crc, data, offset, len);
    buf.writeInt32BE(crc32Finalize(crc));
}

// Encodes tileSize x tileSize RGBA pixels as a PNG using zlib stored blocks.
export function encodePngFromIntensity(
    intensity: Float32Array,
    colorMap: Int32Array,
    maxIntensity: number,
    tileSize: number,
    buf: DynamicBuffer,
    rowBuf: Uint8Array,
    ihdrBuf: Uint8Array,
    adlerBuf: Uint8Array,
    storedBlockHeaderBuf: Uint8Array,
): Uint8Array {
    buf.reset();
    buf.writeBytes(PNG_SIGNATURE);

    writeIhdr(ihdrBuf, tileSize, tileSize);
    writePngChunk(buf, PNG_IHDR, ihdrBuf, 0, ihdrBuf.length);

    // IDAT: length placeholder, then type for CRC
    const idatLenPos = buf.position();
    buf.writeInt32BE(0); // placeholder
    buf.writeBytes(PNG_IDAT);
    let crc = crc32Init();
    crc = crc32Update(crc, PNG_IDAT, 0, 4);
    const idatDataStart = buf.position();

    // Zlib header (inside IDAT CRC)
    crc = crc32Update(crc, ZLIB_HEADER, 0, ZLIB_HEADER.length);
    buf.writeBytes(ZLIB_HEADER);

    let adler = 1; // Adler32 initial value = 1 (s1=1, s2=0)
    const lastIdx = colorMap.length - 1;
    const maxColor = colorMap[lastIdx];
    const scaling = lastIdx / maxIntensity;

    for (let y = 0; y < tileSize; y++) {
        // Build row: filter byte 0, then RGBA for each pixel
        rowBuf[0] = 0; // filter type None
        let p = 1;
        const srcBase = y * tileSize;
        let x = 0;
        while (x < tileSize) {
            const v = intensity[srcBase + x];
            if (v === 0) {
                // Run of transparent pixels
                let run = 1;
                while (x + run < tileSize && intensity[srcBase + x + run] === 0) run++;
                rowBuf.fill(0, p, p + run * 4);
                p += run * 4;
                x += run;
                continue;
            }
            const ciF = v * scaling;
            const c = ciF < lastIdx + 1 ? colorMap[ciF | 0] : maxColor;
            rowBuf[p++] = colorRed(c);
            rowBuf[p++] = colorGreen(c);
            rowBuf[p++] = colorBlue(c);
            rowBuf[p++] = colorAlpha(c);
            x++;
        }
        const rowLen = p; // 1 + tileSize * 4

        // Adler32 over uncompressed row
        adler = adler32Update(adler, rowBuf, 0, rowLen);

        // Zlib stored block (BFINAL=0, BTYPE=00)
        const nlen = (~rowLen) & 0xffff;
        storedBlockHeaderBuf[0] = 0x00;
        storedBlockHeaderBuf[1] = rowLen & 0xff;
        storedBlockHeaderBuf[2] = (rowLen >>> 8) & 0xff;
        storedBlockHeaderBuf[3] = nlen & 0xff;
        storedBlockHeaderBuf[4] = (nlen >>> 8) & 0xff;
        crc = crc32Update(crc, storedBlockHeaderBuf, 0, 5);
        buf.writeBytes(storedBlockHeaderBuf, 0, 5);
        crc = crc32Update(crc, rowBuf, 0, rowLen);
        buf.writeBytes(rowBuf, 0, rowLen);
    }

    // Final empty block
    crc = crc32Update(crc, ZLIB_FINAL_EMPTY_BLOCK, 0, ZLIB_FINAL_EMPTY_BLOCK.length);
    buf.writeBytes(ZLIB_FINAL_EMPTY_BLOCK);

    // Adler32 checksum (big-endian)
    adlerBuf[0] = (adler >>> 24) & 0xff;
    adlerBuf[1] = (adler >>> 16) & 0xff;
    adlerBuf[2] = (adler >>> 8) & 0xff;
    adlerBuf[3] = adler & 0xff;
    crc = crc32Update(crc, adlerBuf, 0, 4);
    buf.writeBytes(adlerBuf);

    // Patch IDAT length and write CRC
    const idatLen = buf.position() - idatDataStart;
    buf.setInt32BE(idatLenPos, idatLen);
    buf.writeInt32BE(crc32Finalize(crc));

    writePngChunk(buf, PNG_IEND, EMPTY_BYTES, 0, 0);
    return buf.toUint8Array();
}

// Pre-render a W x H fully-transparent PNG (for "empty tile" sentinel)
export function encodeTransparentPng(tileSize: number): Uint8Array {
    const colorMap = new Int32Array(1); // all transparent
    const intensity = new Float32Array(tileSize * tileSize);
    const buf = new DynamicBuffer(1024);
    const rowBuf = new Uint8Array(1 + tileSize * 4);
    const ihdrBuf = new Uint8Array(13);
    const adlerBuf = new Uint8Array(4);
    const sbhBuf = new Uint8Array(5);
    return encodePngFromIntensity(intensity, colorMap, 1, tileSize, buf, rowBuf, ihdrBuf, adlerBuf, sbhBuf);
}
