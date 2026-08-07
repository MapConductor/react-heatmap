import type { TileProvider, TileRequest } from '@mapconductor/js-sdk-core';
import type { HeatmapGradient } from './HeatmapGradient';
import { COLOR_TRANSPARENT } from './HeatmapGradient';
import type { HeatmapPointData } from './HeatmapPoint';
import { buildColorMap, COLOR_MAP_SIZE } from './HeatmapColorMap';
import { convolveSparseToOutput, resolveKernel } from './HeatmapKernel';
import { LruCache, SENTINEL } from './HeatmapTileCache';
import { encodePngFromIntensity, encodeTransparentPng, DynamicBuffer } from './PngEncoder';
import {
    buildPointIndex,
    buildTileXRanges,
    getMaxIntensities,
    toWorldPoint,
    WORLD_WIDTH,
    type Bounds,
    type PointIndex,
    type WeightedPoint,
} from './HeatmapWorld';

/**
 * ヒートマップのタイルを描くタイルプロバイダ。
 *
 * このファイルが持つのは**元データの保持とタイル要求の段取り**だけで、
 * 実際の計算は責務ごとのファイルにある:
 *
 * | ファイル             | 担当                                      |
 * |----------------------|-------------------------------------------|
 * | `HeatmapWorld`       | 緯度経度→世界座標、範囲、空間インデックス |
 * | `HeatmapColorMap`    | グラデーション→強度別の色表               |
 * | `HeatmapKernel`      | ガウシアンカーネルと畳み込み              |
 * | `PngEncoder`         | 強度配列→PNG                              |
 * | `HeatmapTileCache`   | タイルの LRU と空タイルの目印             |
 *
 * android-sdk / ios-sdk も同じ責務分けのファイル構成にしてある。
 */

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
