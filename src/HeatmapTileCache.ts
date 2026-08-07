/**
 * タイルのバイト列を KB 単位で上限管理する LRU。
 *
 * 空タイルは透明 PNG の実体ではなく `SENTINEL` で覚える。何百枚ぶんも同じ
 * バイト列を持つ意味がないため、返すときに実体へ差し替える。
 *
 * android-sdk は `HeatmapTilePipeline` が同じ役割を持つ（あちらはワーカーも抱える）。
 */

// ─── LRU cache ───────────────────────────────────────────────────────────────

export const SENTINEL: Uint8Array = new Uint8Array(0); // marks "empty tile"

export class LruCache {
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
