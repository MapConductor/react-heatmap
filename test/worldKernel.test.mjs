import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSources } from './buildSources.mjs';

// 世界座標の計算（Web メルカトル）、日付変更線をまたぐタイルの x 範囲分割、空間インデックス、
// ズームごとの強度上限、ガウシアンカーネルと疎な畳み込み。畳み込みは素朴な 2 次元の
// 総和と一致することで、縦横分割と「非 0 セルだけ走査」が結果を変えていないことを見る。
const { world: W, kernel: K } = await buildSources('world-tests', {
    world: 'src/HeatmapWorld.ts',
    kernel: 'src/HeatmapKernel.ts',
});

const close = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} ≈ ${b}`);

test('toWorldPoint maps lat/lng to the unit Web Mercator square, y growing southward', () => {
    const o = W.toWorldPoint({ latitude: 0, longitude: 0 });
    close(o.x, 0.5); close(o.y, 0.5);
    close(W.toWorldPoint({ latitude: 0, longitude: -180 }).x, 0);
    close(W.toWorldPoint({ latitude: 0, longitude: 180 }).x, 1);
    close(W.toWorldPoint({ latitude: 0, longitude: 90 }).x, 0.75);
    // 85.0511° が正方形の上端（y = 0）
    close(W.toWorldPoint({ latitude: 85.0511287798, longitude: 0 }).y, 0, 1e-6);
    const north = W.toWorldPoint({ latitude: 35, longitude: 139 });
    const south = W.toWorldPoint({ latitude: -35, longitude: 139 });
    assert.ok(north.y < 0.5 && south.y > 0.5);
    close(north.y + south.y, 1, 1e-12, 'symmetric about the equator');
});

test('toWorldPoint clamps the poles instead of returning ±Infinity', () => {
    const n = W.toWorldPoint({ latitude: 90, longitude: 0 });
    const s = W.toWorldPoint({ latitude: -90, longitude: 0 });
    assert.ok(Number.isFinite(n.y) && Number.isFinite(s.y));
    assert.ok(n.y < 0 && s.y > 1, 'clamped slightly beyond the square, as on android');
    close(n.y + s.y, 1, 1e-12);
});

test('buildTileXRanges splits a padded tile that crosses the antimeridian', () => {
    assert.deepEqual(W.buildTileXRanges(0.2, 0.3), [{ min: 0.2, max: 0.3, offset: 0 }]);
    assert.deepEqual(W.buildTileXRanges(-0.1, 1.1), [{ min: 0, max: 1, offset: 0 }]);
    assert.deepEqual(W.buildTileXRanges(-0.05, 0.5), [
        { min: 0, max: 0.5, offset: 0 },
        { min: 0.95, max: 1, offset: -1 },
    ]);
    const r = W.buildTileXRanges(0.5, 1.05);
    assert.deepEqual(r.map(({ min, offset }) => [min, offset]), [[0.5, 0], [0, 1]]);
    close(r[0].max, 1); close(r[1].max, 0.05, 1e-12);
});

test('buildPointIndex buckets each point into a 128x128 linked list', () => {
    const pts = [
        { x: 0.001, y: 0.001, intensity: 1 },
        { x: 0.002, y: 0.003, intensity: 1 },   // 同じセル (0,0)
        { x: 0.999, y: 0.5, intensity: 1 },     // (127,64)
        { x: 1.2, y: -0.3, intensity: 1 },      // 範囲外は端のセルへ (127,0)
    ];
    const idx = W.buildPointIndex(pts);
    assert.equal(idx.gridSize, 128);
    assert.equal(idx.nonEmptyBuckets, 3);
    assert.equal(idx.maxBucketSize, 2);
    const walk = (cx, cy) => {
        const out = [];
        for (let i = idx.heads[cy * 128 + cx]; i !== -1; i = idx.next[i]) out.push(i);
        return out.sort();
    };
    assert.deepEqual(walk(0, 0), [0, 1]);
    assert.deepEqual(walk(127, 64), [2]);
    assert.deepEqual(walk(127, 0), [3]);
    assert.deepEqual(walk(5, 5), []);
});

test('getMaxIntensities uses a custom max everywhere, except 0 which means "auto"', () => {
    const pts = [{ x: 0.1, y: 0.1, intensity: 2 }, { x: 0.2, y: 0.2, intensity: 7 }];
    const bounds = { minX: 0.1, maxX: 0.2, minY: 0.1, maxY: 0.2 };
    const custom = W.getMaxIntensities(pts, bounds, 20, 5);
    assert.equal(custom.length, 22);
    assert.ok(custom.every(v => v === 5));
    const auto = W.getMaxIntensities(pts, bounds, 20, 0);
    assert.ok(auto.every(v => v === 7));
});

test('getMaxIntensities sums points sharing a screen bucket and flattens outside zoom 5..10', () => {
    // 2 点は同じ位置、1 点は範囲の反対側。どのズームでも同じバケットの 2 点が合算される。
    const pts = [
        { x: 0.3, y: 0.3, intensity: 2 },
        { x: 0.3, y: 0.3, intensity: 3 },
        { x: 0.4, y: 0.4, intensity: 4 },
    ];
    const arr = W.getMaxIntensities(pts, { minX: 0.3, maxX: 0.4, minY: 0.3, maxY: 0.4 }, 20, null);
    assert.ok(arr.every(v => v === 5), `${[...arr]}`);
});

test('getMaxIntensities: coarser buckets at low zoom merge neighbours, finer ones do not', () => {
    // 近い 2 点（間隔は範囲の 1/50）は、粗い z5 では同じバケット、細かい z10 では別バケット。
    const pts = [
        { x: 0.5, y: 0.5, intensity: 1 },
        { x: 0.502, y: 0.5, intensity: 1 },
        { x: 0.6, y: 0.6, intensity: 1 },
    ];
    const bounds = { minX: 0.5, maxX: 0.6, minY: 0.5, maxY: 0.6 };
    // radius 640: z5 は screenDim 5120 → 4 バケット、z10 は 163840 → 128 バケット
    const arr = W.getMaxIntensities(pts, bounds, 640, null);
    assert.equal(arr[5], 2);
    assert.equal(arr[10], 1);
    for (let z = 0; z < 5; z++) assert.equal(arr[z], arr[5], `z${z} copies z5`);
    for (let z = 11; z < 22; z++) assert.equal(arr[z], arr[10], `z${z} copies z10`);
});

test('resolveKernel is a cached, symmetric Gaussian with sd = radius / 3', () => {
    const k = K.resolveKernel(6);
    assert.equal(k.length, 13);
    assert.equal(k[6], 1);
    for (let i = 0; i < 6; i++) assert.equal(k[i], k[12 - i]);
    close(k[0], Math.exp(-4.5), 1e-7);
    close(k[3], Math.exp(-9 / (2 * 4)), 1e-7);
    assert.equal(K.resolveKernel(6), k, 'same array returned for the same radius');
    assert.notEqual(K.resolveKernel(7), k);
});

test('convolveSparseToOutput equals a dense 2D Gaussian sum over the unpadded tile', () => {
    const tileSize = 8, radius = 2, gridDim = tileSize + 2 * radius;
    const kernel = K.resolveKernel(radius);
    const intensity = new Float32Array(gridDim * gridDim);
    // タイル内・パディング内（左上角・右端）に点を置く
    const cells = [[5, 5, 1], [6, 5, 2], [0, 0, 3], [11, 7, 1.5], [3, 10, 0.5]];
    const nonZero = new Int32Array(gridDim * gridDim);
    let nz = 0;
    for (const [x, y, v] of cells) {
        const idx = y * gridDim + x;
        intensity[idx] = v;
        nonZero[nz++] = idx;
    }
    const intermediate = new Float32Array(gridDim * gridDim);
    const output = new Float32Array(tileSize * tileSize);
    const nzInter = new Int32Array(gridDim * gridDim);
    let reported = -1;
    K.convolveSparseToOutput(intensity, intermediate, output, kernel, gridDim, radius, tileSize,
        nonZero, nz, nzInter, n => { reported = n; });

    const expected = new Float64Array(tileSize * tileSize);
    for (let ty = 0; ty < tileSize; ty++) {
        for (let tx = 0; tx < tileSize; tx++) {
            const gx = tx + radius, gy = ty + radius;
            let sum = 0;
            for (const [x, y, v] of cells) {
                if (Math.abs(gx - x) <= radius && Math.abs(gy - y) <= radius) {
                    sum += v * kernel[gx - x + radius] * kernel[gy - y + radius];
                }
            }
            expected[ty * tileSize + tx] = sum;
        }
    }
    for (let i = 0; i < output.length; i++) close(output[i], expected[i], 1e-5, `pixel ${i}`);
    // (0,0) の点は横方向で x=2 まで届くので出力の左上だけに効いている
    assert.ok(output[0] > 0);
    // 中間バッファに書かれたセルの数が報告され、その添字が全部列挙されている
    const written = [...intermediate.keys()].filter(i => intermediate[i] !== 0).sort((a, b) => a - b);
    assert.equal(reported, written.length);
    assert.deepEqual([...nzInter.subarray(0, reported)].sort((a, b) => a - b), written);
});
