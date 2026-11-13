import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSources } from './buildSources.mjs';

// グラデーション定義と強度→色の表。ARGB 整数の組み立て・分解、停止点の検証と並べ替え、
// HSV 補間（青→赤の中間が灰色に濁らず紫になる）、色表の先頭に透明からのランプが入ること、
// 末尾が最後の停止点の色で埋まることを確かめる。
const { gradient: G, colorMap: CM } = await buildSources('gradient-tests', {
    gradient: 'src/HeatmapGradient.ts',
    colorMap: 'src/HeatmapColorMap.ts',
});

const argb = (c) => [G.colorAlpha(c), G.colorRed(c), G.colorGreen(c), G.colorBlue(c)];

test('ARGB helpers round-trip each channel, including alpha above 0x7f', () => {
    const c = G.colorArgb(0xc8, 0x12, 0x34, 0x56);
    assert.deepEqual(argb(c), [0xc8, 0x12, 0x34, 0x56]);
    assert.ok(Number.isInteger(c) && c < 0, 'stored as a signed 32-bit int like android.graphics.Color');
    assert.deepEqual(argb(G.colorRgb(1, 2, 3)), [255, 1, 2, 3]);
    assert.equal(G.COLOR_TRANSPARENT, 0);
});

test('gradient stops are sorted by position and validated', () => {
    const g = new G.HeatmapGradient([
        { position: 1, color: G.colorRgb(255, 0, 0) },
        { position: 0, color: G.colorRgb(0, 0, 255) },
        { position: 0.5, color: G.colorRgb(0, 255, 0) },
    ]);
    assert.deepEqual(g.stops.map(s => s.position), [0, 0.5, 1]);
    assert.throws(() => new G.HeatmapGradient([]), /at least one stop/);
    assert.throws(() => new G.HeatmapGradient([{ position: 1.5, color: 0 }]), /\[0, 1\]/);
    assert.throws(() => new G.HeatmapGradient([{ position: -0.1, color: 0 }]), /\[0, 1\]/);
});

test('the default gradient and defaults match android/ios', () => {
    assert.deepEqual(G.HeatmapGradient.DEFAULT.stops.map(s => [s.position, ...argb(s.color)]), [
        [0.2, 255, 102, 225, 0],
        [1.0, 255, 255, 0, 0],
    ]);
    assert.deepEqual({ ...G.HeatmapDefaults }, { DEFAULT_RADIUS_PX: 20, DEFAULT_OPACITY: 0.7, DEFAULT_MAX_ZOOM: 22 });
});

test('interpolateColor hits both ends exactly', () => {
    const a = G.colorArgb(10, 0, 0, 255), b = G.colorArgb(250, 255, 0, 0);
    assert.deepEqual(argb(CM.interpolateColor(a, b, 0)), argb(a));
    assert.deepEqual(argb(CM.interpolateColor(a, b, 1)), argb(b));
});

test('interpolateColor goes through hue (HSV), not through gray', () => {
    const blue = G.colorRgb(0, 0, 255), red = G.colorRgb(255, 0, 0);
    // 240° → 360° の短い側を回るので中間は 300°（マゼンタ）。RGB 補間なら (128,0,128)。
    assert.deepEqual(argb(CM.interpolateColor(blue, red, 0.5)), [255, 255, 0, 255]);
    // 赤 → 緑 は 0° → 120° なので中間は 60°（黄）。
    assert.deepEqual(argb(CM.interpolateColor(red, G.colorRgb(0, 255, 0), 0.5)), [255, 255, 255, 0]);
    // 透明度は線形。
    assert.equal(G.colorAlpha(CM.interpolateColor(G.colorArgb(0, 255, 0, 0), red, 0.5)), 128);
});

test('interpolating between grays keeps saturation 0', () => {
    const c = CM.interpolateColor(G.colorRgb(0, 0, 0), G.colorRgb(200, 200, 200), 0.5);
    assert.deepEqual(argb(c), [255, 100, 100, 100]);
});

test('buildColorMap ramps in from transparent before the first stop', () => {
    const map = CM.buildColorMap(G.HeatmapGradient.DEFAULT);
    assert.equal(map.length, CM.COLOR_MAP_SIZE);
    assert.equal(CM.COLOR_MAP_SIZE, 1000);
    // 0..199 は「透明の緑 → 緑」
    assert.deepEqual(argb(map[0]), [0, 102, 225, 0]);
    assert.deepEqual(argb(map[100]), [128, 102, 225, 0]);
    for (let i = 1; i < 200; i++) {
        assert.ok(G.colorAlpha(map[i]) >= G.colorAlpha(map[i - 1]), `alpha non-decreasing at ${i}`);
    }
    // 200 で最初の停止点の色そのもの
    assert.deepEqual(argb(map[200]), [255, 102, 225, 0]);
    // 200..999 は緑 → 赤。不透明のまま、青は 0 のまま（色相だけ動く）
    for (let i = 200; i < 1000; i++) {
        assert.equal(G.colorAlpha(map[i]), 255);
        assert.equal(G.colorBlue(map[i]), 0);
    }
    // 最後の段は赤にほぼ到達している（ratio = 799/800）
    const last = argb(map[999]);
    assert.equal(last[1], 255);
    assert.ok(last[2] < 5, `green almost gone: ${last[2]}`);
});

test('a single stop at 0 fills the whole map with that color', () => {
    const c = G.colorArgb(200, 10, 20, 30);
    const map = CM.buildColorMap(new G.HeatmapGradient([{ position: 0, color: c }]));
    assert.ok(map.every(v => v === c));
});

test('the tail after the last stop holds the last color', () => {
    const red = G.colorRgb(255, 0, 0);
    const map = CM.buildColorMap(new G.HeatmapGradient([
        { position: 0, color: G.colorRgb(0, 0, 255) },
        { position: 0.5, color: red },
    ]));
    assert.deepEqual(argb(map[0]), [255, 0, 0, 255]);
    for (let i = 500; i < 1000; i++) assert.equal(map[i], red);
    // 250 は青 → 赤の中間（マゼンタ）
    assert.deepEqual(argb(map[250]), [255, 255, 0, 255]);
});
