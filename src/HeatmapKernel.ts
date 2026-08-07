/**
 * ガウシアンカーネルの生成と、それを使った畳み込み。
 *
 * **2 次元の畳み込みを縦横 2 回の 1 次元に分けている。** ガウシアンは可分なので
 * 結果は同じで、計算量が O(r^2) から O(r) に落ちる。
 *
 * さらに**値が入っているセルだけを走査する**（nonZero の添字配列）。ヒートマップの
 * 格子はほとんどが 0 なので、全セルを回すと点の数に関係なく格子サイズぶんの
 * 時間がかかってしまう。
 *
 * android-sdk / ios-sdk の同名ファイルと同じ式。
 */

// ─── Gaussian kernel ─────────────────────────────────────────────────────────

const kernelCache = new Map<number, Float32Array>();

export function resolveKernel(radius: number): Float32Array {
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

export function convolveSparseToOutput(
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
