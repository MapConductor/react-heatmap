import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';

// テスト用の最小 PNG デコーダ。チャンクの CRC を確かめ、IDAT を zlib で展開して
// （Adler32 は inflate 側が検証する）RGBA 画素を返す。フィルタは None のみ対応で、
// PngEncoder はそれしか書かない。
export function decodePng(bytes) {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let off = 8;
    const chunks = [];
    while (off < buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        const crc = buf.readUInt32BE(off + 8 + len);
        assert.equal(crc, crc32(buf.subarray(off + 4, off + 8 + len)), `CRC of ${type}`);
        chunks.push({ type, data });
        off += 12 + len;
    }
    assert.deepEqual(chunks.map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
    const ihdr = chunks[0].data;
    const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
    assert.deepEqual([...ihdr.subarray(8)], [8, 6, 0, 0, 0]);
    const raw = inflateSync(chunks[1].data);
    const stride = 1 + width * 4;
    assert.equal(raw.length, stride * height);
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        assert.equal(raw[y * stride], 0, 'filter None');
        rgba.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * width * 4);
    }
    return { width, height, rgba };
}

export function pixel(img, x, y) {
    const i = (y * img.width + x) * 4;
    return [...img.rgba.subarray(i, i + 4)];
}

export function countOpaque(img) {
    let n = 0;
    for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] !== 0) n++;
    return n;
}
