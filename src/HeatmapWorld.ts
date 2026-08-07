import type { GeoPointInterface } from '@mapconductor/js-sdk-core';

/**
 * 緯度経度を世界座標へ移し、範囲・空間インデックス・ズームごとの強度上限を
 * 組み立てる部分。すべて副作用のない計算で、タイルにもキャッシュにも触らない。
 *
 * android-sdk の `HeatmapWorld.kt` + `HeatmapIntensity.kt` /
 * ios-sdk の同名ファイルと同じ式。
 */

// ─── World-space types and helpers ───────────────────────────────────────────

export interface WeightedPoint { x: number; y: number; intensity: number }
export interface Bounds { minX: number; maxX: number; minY: number; maxY: number }
export interface PointIndex {
    gridSize: number;
    heads: Int32Array;
    next: Int32Array;
    nonEmptyBuckets: number;
    maxBucketSize: number;
}
export interface XRange { min: number; max: number; offset: number }

export const WORLD_WIDTH = 1.0;

export function toWorldPoint(pos: GeoPointInterface): { x: number; y: number } {
    const x = pos.longitude / 360 + 0.5;
    const siny = Math.sin(pos.latitude * Math.PI / 180);
    const clampedSiny = Math.max(-0.9999, Math.min(0.9999, siny));
    const y = 0.5 * Math.log((1 + clampedSiny) / (1 - clampedSiny)) / -(2 * Math.PI) + 0.5;
    return { x, y };
}

export function buildPointIndex(points: WeightedPoint[]): PointIndex {
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

export function buildTileXRanges(minX: number, maxX: number): XRange[] {
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

export function getMaxIntensities(
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
