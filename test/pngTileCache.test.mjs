import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSources } from './buildSources.mjs';
import { decodePng, pixel } from './pngDecode.mjs';

// canvas を使わない PNG 書き出しと、タイルの LRU。PNG は Node の zlib で展開できること
// （CRC と Adler32 が正しい）、強度→色表の引き方（0 は透明、上限以上は最後の色）、
// LRU は KB 単位で古いものから追い出し、参照で順位が上がることを確かめる。
const { png: P, cache: C, gradient: G } = await buildSources('png-tests', {
    png: 'src/PngEncoder.ts',
    cache: 'src/HeatmapTileCache.ts',
    gradient: 'src/HeatmapGradient.ts',
});

function encode(intensity, colorMap, maxIntensity, tileSize, buf = new P.DynamicBuffer(16)) {
    return P.encodePngFromIntensity(intensity, colorMap, maxIntensity, tileSize, buf,
        new Uint8Array(1 + tileSize * 4), new Uint8Array(13), new Uint8Array(4), new Uint8Array(5));
}

test('encodeTransparentPng is a valid, fully transparent RGBA PNG of the tile size', () => {
    const img = decodePng(P.encodeTransparentPng(32));
    assert.equal(img.width, 32);
    assert.equal(img.height, 32);
    assert.ok(img.rgba.every(v => v === 0));
});

test('intensities are mapped through the color table, zero stays transparent, overflow takes the last color', () => {
    const colorMap = new Int32Array([
        G.colorArgb(10, 1, 1, 1),
        G.colorArgb(20, 2, 2, 2),
        G.colorArgb(30, 3, 3, 3),
        G.colorArgb(255, 200, 100, 50),
    ]);
    // lastIdx = 3, maxIntensity = 3 → index = floor(v)
    const intensity = new Float32Array([
        0, 0.5, 1.2, 2.9,
        3, 100, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 1,
    ]);
    const img = decodePng(encode(intensity, colorMap, 3, 4));
    assert.deepEqual(pixel(img, 0, 0), [0, 0, 0, 0]);
    assert.deepEqual(pixel(img, 1, 0), [1, 1, 1, 10]);
    assert.deepEqual(pixel(img, 2, 0), [2, 2, 2, 20]);
    assert.deepEqual(pixel(img, 3, 0), [3, 3, 3, 30]);
    assert.deepEqual(pixel(img, 0, 1), [200, 100, 50, 255]);
    assert.deepEqual(pixel(img, 1, 1), [200, 100, 50, 255]);
    assert.deepEqual(pixel(img, 2, 1), [0, 0, 0, 0]);
    assert.deepEqual(pixel(img, 3, 3), [2, 2, 2, 20]);
});

test('the shared DynamicBuffer grows from a tiny capacity and is reusable across tiles', () => {
    const buf = new P.DynamicBuffer(16);
    const colorMap = new Int32Array([0, G.colorRgb(255, 0, 0)]);
    const a = encode(new Float32Array(64 * 64).fill(1), colorMap, 1, 64, buf);
    const b = encode(new Float32Array(8 * 8), colorMap, 1, 8, buf);
    assert.equal(decodePng(a).width, 64);
    assert.ok(decodePng(a).rgba.every((v, i) => v === [255, 0, 0, 255][i % 4]));
    assert.equal(decodePng(b).width, 8);
    assert.ok(b.length < a.length, 'the second encode does not carry bytes from the first');
});

test('DynamicBuffer writes big-endian ints and patches them in place', () => {
    const buf = new P.DynamicBuffer(0);
    buf.writeByte(0x1ff);
    buf.writeInt32BE(0xdeadbeef | 0);
    buf.writeBytes(new Uint8Array([9, 8, 7, 6]), 1, 2);
    buf.setInt32BE(1, 0x01020304);
    assert.equal(buf.position(), 7);
    assert.deepEqual([...buf.toUint8Array()], [0xff, 1, 2, 3, 4, 8, 7]);
    buf.reset();
    assert.equal(buf.toUint8Array().length, 0);
});

test('LruCache evicts the least recently used entries once the KB budget is exceeded', () => {
    const cache = new C.LruCache(3);
    const kb = (n) => new Uint8Array(n * 1024);
    cache.put('a', kb(1));
    cache.put('b', kb(1));
    cache.put('c', kb(1));
    assert.ok(cache.get('a'), 'a is now most recent');
    cache.put('d', kb(1));
    assert.equal(cache.get('b'), undefined, 'b was the oldest');
    assert.ok(cache.get('a') && cache.get('c') && cache.get('d'));
    cache.put('big', kb(2));
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('c'), undefined);
    assert.ok(cache.get('d') && cache.get('big'));
});

test('LruCache counts tiny and empty entries as 1 KB and replacing a key frees its old size', () => {
    const cache = new C.LruCache(2);
    cache.put('x', C.SENTINEL);
    cache.put('y', new Uint8Array(10));
    assert.equal(cache.get('x'), C.SENTINEL);
    cache.put('y', new Uint8Array(20)); // 置き換えは x を追い出さない
    assert.equal(cache.get('x'), C.SENTINEL);
    assert.equal(cache.get('y').length, 20);
    cache.put('z', new Uint8Array(1));
    assert.equal(cache.get('x'), undefined);
    cache.evictAll();
    assert.equal(cache.get('y'), undefined);
    assert.equal(cache.get('z'), undefined);
    cache.put('p', new Uint8Array(1));
    cache.put('q', new Uint8Array(1));
    assert.ok(cache.get('p') && cache.get('q'), 'budget is fully available after evictAll');
});

test('an entry larger than the whole budget is still stored, alone', () => {
    const cache = new C.LruCache(1);
    cache.put('a', new Uint8Array(1));
    cache.put('huge', new Uint8Array(5 * 1024));
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('huge').length, 5 * 1024);
});
