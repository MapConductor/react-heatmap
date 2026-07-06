import type { TileProvider, TileRequest } from '@mapconductor/js-sdk-core';
import type { GeoPointInterface } from '@mapconductor/js-sdk-core';
import type { HeatmapGradient } from './HeatmapGradient';
import {
    colorAlpha, colorRed, colorGreen, colorBlue,
    colorArgb, COLOR_TRANSPARENT,
} from './HeatmapGradient';
import type { HeatmapPointData } from './HeatmapPoint';

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

class DynamicBuffer {
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
function encodePngFromIntensity(
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
function encodeTransparentPng(tileSize: number): Uint8Array {
    const colorMap = new Int32Array(1); // all transparent
    const intensity = new Float32Array(tileSize * tileSize);
    const buf = new DynamicBuffer(1024);
    const rowBuf = new Uint8Array(1 + tileSize * 4);
    const ihdrBuf = new Uint8Array(13);
    const adlerBuf = new Uint8Array(4);
    const sbhBuf = new Uint8Array(5);
    return encodePngFromIntensity(intensity, colorMap, 1, tileSize, buf, rowBuf, ihdrBuf, adlerBuf, sbhBuf);
}

// ─── Color map ───────────────────────────────────────────────────────────────

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
    const rf = r / 255, gf = g / 255, bf = b / 255;
    const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === rf) h = 60 * (((gf - bf) / d) % 6);
        else if (max === gf) h = 60 * ((bf - rf) / d + 2);
        else h = 60 * ((rf - gf) / d + 4);
        if (h < 0) h += 360;
    }
    return [h, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    if (s === 0) { const g = Math.round(v * 255); return [g, g, g]; }
    const hi = Math.floor(h / 60) % 6;
    const f = h / 60 - Math.floor(h / 60);
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const table: [number, number, number][] = [
        [v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q],
    ];
    const [r, g, b] = table[hi];
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function interpolateColor(c1: number, c2: number, ratio: number): number {
    const a1 = colorAlpha(c1), a2 = colorAlpha(c2);
    const alpha = Math.round((a2 - a1) * ratio + a1);
    const hsv1 = rgbToHsv(colorRed(c1), colorGreen(c1), colorBlue(c1));
    const hsv2 = rgbToHsv(colorRed(c2), colorGreen(c2), colorBlue(c2));
    if (hsv1[0] - hsv2[0] > 180) hsv2[0] += 360;
    else if (hsv2[0] - hsv1[0] > 180) hsv1[0] += 360;
    const h = (hsv2[0] - hsv1[0]) * ratio + hsv1[0];
    const s = (hsv2[1] - hsv1[1]) * ratio + hsv1[1];
    const v = (hsv2[2] - hsv1[2]) * ratio + hsv1[2];
    const [r, g, b] = hsvToRgb(((h % 360) + 360) % 360, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, v)));
    return colorArgb(alpha, r, g, b);
}

const COLOR_MAP_SIZE = 1000;

function buildColorMap(gradient: HeatmapGradient): Int32Array {
    const stops = gradient.stops;
    const colors = stops.map(s => s.color);
    const positions = stops.map(s => s.position);

    interface Interval { c1: number; c2: number; duration: number }
    const intervals = new Map<number, Interval>();

    if (positions[0] !== 0) {
        const c = colors[0];
        intervals.set(0, {
            c1: colorArgb(0, colorRed(c), colorGreen(c), colorBlue(c)),
            c2: c,
            duration: COLOR_MAP_SIZE * positions[0],
        });
    }
    for (let i = 1; i < colors.length; i++) {
        intervals.set((COLOR_MAP_SIZE * positions[i - 1]) | 0, {
            c1: colors[i - 1],
            c2: colors[i],
            duration: COLOR_MAP_SIZE * (positions[i] - positions[i - 1]),
        });
    }
    const last = positions.length - 1;
    if (positions[last] !== 1) {
        intervals.set((COLOR_MAP_SIZE * positions[last]) | 0, {
            c1: colors[last], c2: colors[last],
            duration: COLOR_MAP_SIZE * (1 - positions[last]),
        });
    }

    const map = new Int32Array(COLOR_MAP_SIZE);
    let interval: Interval = intervals.get(0) ?? { c1: colors[0], c2: colors[0], duration: 1 };
    let start = 0;
    for (let i = 0; i < COLOR_MAP_SIZE; i++) {
        const iv = intervals.get(i);
        if (iv) { interval = iv; start = i; }
        const ratio = interval.duration === 0 ? 0 : (i - start) / interval.duration;
        map[i] = interpolateColor(interval.c1, interval.c2, ratio);
    }
    return map;
}

// ─── Gaussian kernel ─────────────────────────────────────────────────────────

const kernelCache = new Map<number, Float32Array>();

function resolveKernel(radius: number): Float32Array {
    const cached = kernelCache.get(radius);
    if (cached) return cached;
    const sd = radius / 3;
    const k = new Float32Array(radius * 2 + 1);
    for (let i = -radius; i <= radius; i++) {
        k[i + radius] = Math.exp(-(i * i) / (2 * sd * sd));
    }
    kernelCache.set(radius, k);
    return k;
}

// ─── Convolution ─────────────────────────────────────────────────────────────

function convolveSparseToOutput(
    intensity: Float32Array, intermediate: Float32Array, output: Float32Array,
    kernel: Float32Array, gridDim: number, radius: number, tileSize: number,
    nonZeroInput: Int32Array, nonZeroInputCount: number,
    nonZeroIntermediate: Int32Array,
    nonZeroIntermediateCountOut: (n: number) => void,
): void {
    const lower = radius, upper = radius + tileSize - 1;
    let nzCount = 0;

    // Horizontal pass
    for (let ii = 0; ii < nonZeroInputCount; ii++) {
        const idx = nonZeroInput[ii];
        const y = (idx / gridDim) | 0;
        const x = idx - y * gridDim;
        const val = intensity[idx];
        const rowBase = y * gridDim;
        const xStart = Math.max(lower, x - radius);
        const xEnd = Math.min(upper, x + radius);
        for (let x2 = xStart; x2 <= xEnd; x2++) {
            const j = rowBase + x2;
            const prev = intermediate[j];
            if (prev === 0) nonZeroIntermediate[nzCount++] = j;
            intermediate[j] = prev + val * kernel[x2 - x + radius];
        }
    }
    nonZeroIntermediateCountOut(nzCount);

    // Vertical pass
    for (let ii = 0; ii < nzCount; ii++) {
        const idx = nonZeroIntermediate[ii];
        const y = (idx / gridDim) | 0;
        const x = idx - y * gridDim;
        const val = intermediate[idx];
        const yStart = Math.max(lower, y - radius);
        const yEnd = Math.min(upper, y + radius);
        const xOut = x - radius;
        for (let y2 = yStart; y2 <= yEnd; y2++) {
            output[(y2 - radius) * tileSize + xOut] += val * kernel[y2 - y + radius];
        }
    }
}

// ─── World-space types and helpers ───────────────────────────────────────────

interface WeightedPoint { x: number; y: number; intensity: number }
interface Bounds { minX: number; maxX: number; minY: number; maxY: number }
interface PointIndex {
    gridSize: number;
    heads: Int32Array;
    next: Int32Array;
    nonEmptyBuckets: number;
    maxBucketSize: number;
}
interface XRange { min: number; max: number; offset: number }

const WORLD_WIDTH = 1.0;

function toWorldPoint(pos: GeoPointInterface): { x: number; y: number } {
    const x = pos.longitude / 360 + 0.5;
    const siny = Math.sin(pos.latitude * Math.PI / 180);
    const clampedSiny = Math.max(-0.9999, Math.min(0.9999, siny));
    const y = 0.5 * Math.log((1 + clampedSiny) / (1 - clampedSiny)) / -(2 * Math.PI) + 0.5;
    return { x, y };
}

function buildPointIndex(points: WeightedPoint[]): PointIndex {
    const GRID_SIZE = 128;
    const heads = new Int32Array(GRID_SIZE * GRID_SIZE).fill(-1);
    const next = new Int32Array(points.length).fill(-1);
    const counts = new Int32Array(GRID_SIZE * GRID_SIZE);
    let nonEmptyBuckets = 0, maxBucketSize = 0;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const cx = Math.min(GRID_SIZE - 1, Math.max(0, (p.x * GRID_SIZE) | 0));
        const cy = Math.min(GRID_SIZE - 1, Math.max(0, (p.y * GRID_SIZE) | 0));
        const idx = cy * GRID_SIZE + cx;
        next[i] = heads[idx];
        heads[idx] = i;
        const c = ++counts[idx];
        if (c === 1) nonEmptyBuckets++;
        if (c > maxBucketSize) maxBucketSize = c;
    }
    return { gridSize: GRID_SIZE, heads, next, nonEmptyBuckets, maxBucketSize };
}

function buildTileXRanges(minX: number, maxX: number): XRange[] {
    if (minX <= 0 && maxX >= WORLD_WIDTH) {
        return [{ min: 0, max: WORLD_WIDTH, offset: 0 }];
    }
    if (minX < 0) {
        return [
            { min: 0, max: maxX, offset: 0 },
            { min: minX + WORLD_WIDTH, max: WORLD_WIDTH, offset: -WORLD_WIDTH },
        ];
    }
    if (maxX > WORLD_WIDTH) {
        return [
            { min: minX, max: WORLD_WIDTH, offset: 0 },
            { min: 0, max: maxX - WORLD_WIDTH, offset: WORLD_WIDTH },
        ];
    }
    return [{ min: minX, max: maxX, offset: 0 }];
}

function getMaxIntensities(
    points: WeightedPoint[], bounds: Bounds, radius: number,
    customMax: number | null,
): Float64Array {
    const MAX_ZOOM = 22, MIN_ZOOM = 5, CAP_ZOOM = 11, SCREEN_SIZE = 1280;
    const arr = new Float64Array(MAX_ZOOM);

    if (customMax !== null && customMax !== 0) {
        arr.fill(customMax);
        return arr;
    }

    function maxForScreen(screenDim: number): number {
        if (bounds === null) return 0;
        const { minX, maxX, minY, maxY } = bounds;
        const boundsDim = Math.max(maxX - minX, maxY - minY);
        if (boundsDim === 0) {
            return points.reduce((m, p) => Math.max(m, p.intensity), 0);
        }
        const nBuckets = Math.max(1, ((screenDim / (2 * radius) + 0.5) | 0));
        const scale = nBuckets / boundsDim;
        const buckets = new Map<number, number>();
        let max = 0;
        for (const p of points) {
            const bx = ((p.x - minX) * scale) | 0;
            const by = ((p.y - minY) * scale) | 0;
            const k = bx * 100000 + by;
            const v = (buckets.get(k) ?? 0) + p.intensity;
            buckets.set(k, v);
            if (v > max) max = v;
        }
        return max;
    }

    for (let i = MIN_ZOOM; i < CAP_ZOOM; i++) {
        const screenDim = (SCREEN_SIZE * Math.pow(2, i - 3)) | 0;
        arr[i] = maxForScreen(screenDim);
        if (i === MIN_ZOOM) arr.fill(arr[i], 0, i);
    }
    arr.fill(arr[CAP_ZOOM - 1], CAP_ZOOM);
    return arr;
}

// ─── LRU cache ───────────────────────────────────────────────────────────────

const SENTINEL: Uint8Array = new Uint8Array(0); // marks "empty tile"

class LruCache {
    private readonly map = new Map<string, Uint8Array>();
    private sizeKb = 0;
    constructor(private maxKb: number) {}

    get(key: string): Uint8Array | undefined {
        const v = this.map.get(key);
        if (v === undefined) return undefined;
        this.map.delete(key);
        this.map.set(key, v);
        return v;
    }

    put(key: string, value: Uint8Array): void {
        if (this.map.has(key)) {
            const old = this.map.get(key)!;
            this.sizeKb -= Math.max(1, (old.length / 1024) | 0);
            this.map.delete(key);
        }
        const sz = Math.max(1, (value.length / 1024) | 0);
        while (this.sizeKb + sz > this.maxKb && this.map.size > 0) {
            const first = this.map.keys().next().value!;
            const v = this.map.get(first)!;
            this.sizeKb -= Math.max(1, (v.length / 1024) | 0);
            this.map.delete(first);
        }
        this.map.set(key, value);
        this.sizeKb += sz;
    }

    evictAll(): void { this.map.clear(); this.sizeKb = 0; }
}

// ─── Tile state ──────────────────────────────────────────────────────────────

interface TileState {
    points: WeightedPoint[];
    index: PointIndex | null;
    bounds: Bounds | null;
    radiusPx: number;
    colorMap: Int32Array;
    maxIntensities: Float64Array;
}

// ─── HeatmapTileRenderer ─────────────────────────────────────────────────────

export class HeatmapTileRenderer implements TileProvider {
    static readonly DEFAULT_TILE_SIZE = 512;
    private static readonly INDEX_BUILD_THRESHOLD = 1024;
    private static readonly CAMERA_ZOOM_KEY_SCALE = 4;
    private static readonly DEFAULT_CACHE_KB = 8 * 1024;

    readonly tileSize: number;
    private readonly cache: LruCache;
    private readonly transparentTileBytes: Uint8Array;

    private cameraZoomQuantized: number | null = null;
    private cameraZoomKey: number | null = null;
    private cacheEpoch = 0;

    private state: TileState = {
        points: [], index: null, bounds: null,
        radiusPx: 20,
        colorMap: new Int32Array(COLOR_MAP_SIZE).fill(COLOR_TRANSPARENT),
        maxIntensities: new Float64Array(22),
    };

    // Reusable render buffers (single-threaded, so instance-level is fine)
    private intensityBuf = new Float32Array(0);
    private intermediateBuf = new Float32Array(0);
    private outputBuf = new Float32Array(0);
    private nonZeroInputBuf = new Int32Array(0);
    private nonZeroIntermediateBuf = new Int32Array(0);
    private pngBuf = new DynamicBuffer(512 * 1024);
    private rowBuf = new Uint8Array(1 + HeatmapTileRenderer.DEFAULT_TILE_SIZE * 4);
    private ihdrBuf = new Uint8Array(13);
    private adlerBuf = new Uint8Array(4);
    private sbhBuf = new Uint8Array(5); // stored block header

    constructor(params: { tileSize?: number; cacheSizeKb?: number } = {}) {
        this.tileSize = params.tileSize ?? HeatmapTileRenderer.DEFAULT_TILE_SIZE;
        this.cache = new LruCache(params.cacheSizeKb ?? HeatmapTileRenderer.DEFAULT_CACHE_KB);
        this.transparentTileBytes = encodeTransparentPng(this.tileSize);
        this.rowBuf = new Uint8Array(1 + this.tileSize * 4);
    }

    update(params: {
        points: HeatmapPointData[];
        radiusPx: number;
        gradient: HeatmapGradient;
        maxIntensity: number | null;
    }): void {
        const { points, gradient, maxIntensity } = params;
        const radiusPx = Math.max(1, params.radiusPx);

        const weighted: WeightedPoint[] = [];
        for (const p of points) {
            const w = isNaN(p.weight) || p.weight < 0 ? 1 : p.weight;
            const wp = toWorldPoint(p.position);
            weighted.push({ x: wp.x, y: wp.y, intensity: w });
        }

        let bounds: Bounds | null = null;
        if (weighted.length > 0) {
            let minX = weighted[0].x, maxX = weighted[0].x;
            let minY = weighted[0].y, maxY = weighted[0].y;
            for (const p of weighted) {
                if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
            }
            bounds = { minX, maxX, minY, maxY };
        }

        const index = weighted.length >= HeatmapTileRenderer.INDEX_BUILD_THRESHOLD
            ? buildPointIndex(weighted) : null;
        const colorMap = buildColorMap(gradient);
        const maxIntensities = bounds
            ? getMaxIntensities(weighted, bounds, radiusPx, maxIntensity)
            : new Float64Array(22);

        this.state = { points: weighted, index, bounds, radiusPx, colorMap, maxIntensities };
        this.cacheEpoch++;
        this.cache.evictAll();
    }

    updateCameraZoom(zoom: number): void {
        const nextKey = Math.round(zoom * HeatmapTileRenderer.CAMERA_ZOOM_KEY_SCALE);
        if (nextKey === this.cameraZoomKey && this.cameraZoomQuantized !== null) return;
        this.cameraZoomKey = nextKey;
        this.cameraZoomQuantized = nextKey / HeatmapTileRenderer.CAMERA_ZOOM_KEY_SCALE;
    }

    renderTile(request: TileRequest): Uint8Array | null {
        const { x, y, z } = request;
        const epoch = this.cacheEpoch;
        const zoomKey = this.cameraZoomKey ?? (z * HeatmapTileRenderer.CAMERA_ZOOM_KEY_SCALE);
        const key = `${epoch}:${zoomKey}:${z}/${x}/${y}`;

        const cached = this.cache.get(key);
        if (cached !== undefined) {
            return cached === SENTINEL ? this.transparentTileBytes : cached;
        }

        const result = this.renderTileInternal(request, this.state);
        const toStore = result ?? SENTINEL;
        this.cache.put(key, toStore);
        return result ?? this.transparentTileBytes;
    }

    private ensureBuffers(gridDim: number): void {
        const gLen = gridDim * gridDim;
        if (this.intensityBuf.length < gLen) {
            this.intensityBuf = new Float32Array(gLen);
            this.intermediateBuf = new Float32Array(gLen);
            this.nonZeroInputBuf = new Int32Array(gLen);
            this.nonZeroIntermediateBuf = new Int32Array(gLen);
        }
        const tLen = this.tileSize * this.tileSize;
        if (this.outputBuf.length < tLen) {
            this.outputBuf = new Float32Array(tLen);
        }
    }

    private renderTileInternal(request: TileRequest, s: TileState): Uint8Array | null {
        if (!s.bounds || s.points.length === 0) return null;

        const { x, y, z } = request;
        const effectiveZoom = this.cameraZoomQuantized ?? z;
        const zoomScale = Math.pow(2, effectiveZoom - z);
        const radius = Math.max(1, Math.round(s.radiusPx / zoomScale));
        const kernel = resolveKernel(radius);
        const tileWidth = WORLD_WIDTH / Math.pow(2, z);
        const padding = tileWidth * radius / this.tileSize;
        const tileWidthPadded = tileWidth + 2 * padding;
        const gridDim = this.tileSize + radius * 2;
        const bucketWidth = tileWidthPadded / gridDim;

        const minX = x * tileWidth - padding;
        const maxX = (x + 1) * tileWidth + padding;
        const minY = y * tileWidth - padding;
        const maxY = (y + 1) * tileWidth + padding;

        // Quick intersection test with padded bounds
        const b = s.bounds;
        const padB = {
            minX: b.minX - padding, maxX: b.maxX + padding,
            minY: b.minY - padding, maxY: b.maxY + padding,
        };
        if (minX > padB.maxX || maxX < padB.minX || minY > padB.maxY || maxY < padB.minY) {
            return null;
        }

        this.ensureBuffers(gridDim);
        const gridLen = gridDim * gridDim;
        this.intensityBuf.fill(0, 0, gridLen);
        this.intermediateBuf.fill(0, 0, gridLen);
        this.outputBuf.fill(0, 0, this.tileSize * this.tileSize);
        let nzInputCount = 0;

        const intensityBuf = this.intensityBuf;
        const nonZeroInputBuf = this.nonZeroInputBuf;
        let hasPoints = false;
        const addPt = (ax: number, wy: number, w: number): void => {
            const bx = ((ax - minX) / bucketWidth) | 0;
            const by = ((wy - minY) / bucketWidth) | 0;
            if (bx < 0 || bx >= gridDim || by < 0 || by >= gridDim) return;
            const idx = by * gridDim + bx;
            const prev = intensityBuf[idx];
            if (prev === 0) nonZeroInputBuf[nzInputCount++] = idx;
            intensityBuf[idx] = prev + w;
            hasPoints = true;
        };

        if (!s.index) {
            for (const p of s.points) {
                if (p.y < minY || p.y > maxY) continue;
                if (p.x >= minX && p.x <= maxX) {
                    addPt(p.x, p.y, p.intensity);
                } else if (minX < 0 && p.x >= minX + WORLD_WIDTH) {
                    addPt(p.x - WORLD_WIDTH, p.y, p.intensity);
                } else if (maxX > WORLD_WIDTH && p.x <= maxX - WORLD_WIDTH) {
                    addPt(p.x + WORLD_WIDTH, p.y, p.intensity);
                }
            }
        } else {
            const { gridSize, heads, next } = s.index;
            const yMin = Math.max(0, minY), yMax = Math.min(WORLD_WIDTH, maxY);
            if (yMin <= yMax) {
                const cyStart = Math.max(0, Math.min(gridSize - 1, (yMin * gridSize) | 0));
                const cyEnd = Math.max(0, Math.min(gridSize - 1, (yMax * gridSize) | 0));
                const xRanges = buildTileXRanges(minX, maxX);
                for (const range of xRanges) {
                    const xMin2 = Math.max(0, range.min), xMax2 = Math.min(WORLD_WIDTH, range.max);
                    if (xMin2 > xMax2) continue;
                    const cxStart = Math.max(0, Math.min(gridSize - 1, (xMin2 * gridSize) | 0));
                    const cxEnd = Math.max(0, Math.min(gridSize - 1, (xMax2 * gridSize) | 0));
                    for (let cy = cyStart; cy <= cyEnd; cy++) {
                        for (let cx = cxStart; cx <= cxEnd; cx++) {
                            let i = heads[cy * gridSize + cx];
                            while (i !== -1) {
                                const p = s.points[i];
                                if (p.y >= minY && p.y <= maxY) {
                                    const xAdj = p.x + range.offset;
                                    if (xAdj >= minX && xAdj <= maxX) {
                                        addPt(xAdj, p.y, p.intensity);
                                    }
                                }
                                i = next[i];
                            }
                        }
                    }
                }
            }
        }

        if (!hasPoints) return null;

        let nzIntermCount = 0;
        convolveSparseToOutput(
            this.intensityBuf, this.intermediateBuf, this.outputBuf,
            kernel, gridDim, radius, this.tileSize,
            this.nonZeroInputBuf, nzInputCount,
            this.nonZeroIntermediateBuf,
            n => { nzIntermCount = n; },
        );
        void nzIntermCount; // used indirectly via nonZeroIntermediateBuf length tracking

        // Android parity: index max intensities by the (quantized) camera zoom,
        // not the tile z, so colors stay consistent while the camera is between
        // integer zoom levels.
        const intensityZoom = Math.min(
            Math.max(0, Math.floor(effectiveZoom)),
            s.maxIntensities.length - 1,
        );
        const maxInt = s.maxIntensities[intensityZoom];
        if (maxInt <= 0) return null;

        return encodePngFromIntensity(
            this.outputBuf, s.colorMap, maxInt, this.tileSize,
            this.pngBuf, this.rowBuf, this.ihdrBuf, this.adlerBuf, this.sbhBuf,
        );
    }
}
