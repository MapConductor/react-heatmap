import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSources } from './buildSources.mjs';
import { countOpaque, decodePng, pixel } from './pngDecode.mjs';

// HeatmapTileRenderer を地図なしで直接タイル要求して動かす。点の無いタイルは透明 PNG、
// 点の真上は最大色、キャッシュはデータ更新とカメラのズームで切り替わる、
// 1024 点以上で使う空間インデックス経路と全走査経路が同じ画を出す、日付変更線の
// 向こう側の点がにじみ込む、を確かめる。カメラ用オーバーレイコントローラも偽の
// レンダラーで確かめる。
const { renderer: R, gradient: G, camera: Cam } = await buildSources('renderer-tests', {
    renderer: 'src/HeatmapTileRenderer.ts',
    gradient: 'src/HeatmapGradient.ts',
    camera: 'src/HeatmapCameraController.ts',
});

const RED = G.colorRgb(255, 0, 0);
const gradient = new G.HeatmapGradient([
    { position: 0, color: G.colorRgb(0, 0, 255) },
    { position: 1, color: RED },
]);
const pt = (latitude, longitude, weight = 1) => ({ position: { latitude, longitude }, weight });

function renderer(points, { tileSize = 64, radiusPx = 6, maxIntensity = null } = {}) {
    const r = new R.HeatmapTileRenderer({ tileSize });
    r.update({ points, radiusPx, gradient, maxIntensity });
    return r;
}

test('defaults: 512px tiles, and an empty renderer serves the transparent tile', () => {
    assert.equal(R.HeatmapTileRenderer.DEFAULT_TILE_SIZE, 512);
    const r = new R.HeatmapTileRenderer({ tileSize: 16 });
    const img = decodePng(r.renderTile({ x: 0, y: 0, z: 0 }));
    assert.equal(img.width, 16);
    assert.equal(countOpaque(img), 0);
});

test('a single point paints the max color on its pixel and fades out within the radius', () => {
    const r = renderer([pt(0, 0)], { tileSize: 64, radiusPx: 6 });
    const img = decodePng(r.renderTile({ x: 0, y: 0, z: 0 }));
    const [red, g, b, a] = pixel(img, 32, 32);
    assert.deepEqual([red, g, a], [255, 0, 255]);
    assert.ok(b <= 2, 'the last color-map entry (ratio 999/1000 of blue -> red)');
    assert.deepEqual(pixel(img, 0, 0), [0, 0, 0, 0]);
    assert.deepEqual(pixel(img, 32, 40), [0, 0, 0, 0], 'outside the radius');
    const n = countOpaque(img);
    assert.ok(n > 50 && n <= 13 * 13, `blob of ${n} px within the (2r+1)^2 square`);
    // 中心から離れるほど青寄り
    assert.ok(pixel(img, 35, 32)[2] > pixel(img, 33, 32)[2]);
});

test('tiles that do not touch the data serve the shared transparent tile', () => {
    const r = renderer([pt(0, 0)]);
    const far = r.renderTile({ x: 0, y: 0, z: 3 });
    assert.equal(countOpaque(decodePng(far)), 0);
    assert.equal(r.renderTile({ x: 7, y: 7, z: 3 }), far, 'same transparent bytes object');
});

test('negative or NaN weights count as 1', () => {
    const a = renderer([pt(0, 0, -5), pt(10, 10, NaN)], { maxIntensity: 1 });
    const b = renderer([pt(0, 0, 1), pt(10, 10, 1)], { maxIntensity: 1 });
    assert.deepEqual(a.renderTile({ x: 0, y: 0, z: 0 }), b.renderTile({ x: 0, y: 0, z: 0 }));
});

test('tiles are cached until update() replaces the data', () => {
    const r = renderer([pt(0, 0)]);
    const first = r.renderTile({ x: 0, y: 0, z: 0 });
    assert.equal(r.renderTile({ x: 0, y: 0, z: 0 }), first, 'served from the cache');
    r.update({ points: [pt(40, 40)], radiusPx: 6, gradient, maxIntensity: null });
    const second = r.renderTile({ x: 0, y: 0, z: 0 });
    assert.notEqual(second, first);
    assert.equal(pixel(decodePng(second), 32, 32)[3], 0, 'the old point is gone');
});

test('a camera zoomed past the tile z shrinks the blur radius, and is part of the cache key', () => {
    const r = renderer([pt(0, 0)], { radiusPx: 8 });
    const req = { x: 0, y: 0, z: 1 };
    const atZ = countOpaque(decodePng(r.renderTile(req)));
    r.updateCameraZoom(2); // タイル z=1 を 2 倍に拡大表示 → 半径 4px
    const zoomed = countOpaque(decodePng(r.renderTile(req)));
    assert.ok(zoomed < atZ / 2, `${zoomed} < ${atZ}/2`);
    // 1/4 未満の差は同じ量子化キーに丸められる
    const cached = r.renderTile(req);
    r.updateCameraZoom(2.1);
    assert.equal(r.renderTile(req), cached);
});

test('the spatial-index path (>= 1024 points) draws the same tile as the linear scan', () => {
    const cluster = [];
    for (let i = 0; i < 1023; i++) {
        cluster.push(pt(10 + (i % 37) * 0.05, 20 + Math.floor(i / 37) * 0.05, 1 + (i % 3)));
    }
    const opts = { tileSize: 64, radiusPx: 5, maxIntensity: 10 };
    const linear = renderer(cluster, opts);
    const indexed = renderer([...cluster, pt(-60, -120)], opts); // 遠い 1 点で閾値を越える
    // z0 は遠い 1 点も写るので比べない。比べるのはクラスタだけが載るタイル。
    for (const req of [{ x: 1, y: 0, z: 1 }, { x: 8, y: 7, z: 4 }, { x: 17, y: 15, z: 5 }]) {
        const a = linear.renderTile(req), b = indexed.renderTile(req);
        assert.deepEqual(b, a, `tile ${req.z}/${req.x}/${req.y}`);
    }
    assert.ok(countOpaque(decodePng(linear.renderTile({ x: 8, y: 7, z: 4 }))) > 0, 'the compared tile is not empty');
});

test('points just across the antimeridian bleed into the tile on the other side', () => {
    // 点が日付変更線のすぐ東側にしか無くても、西隣のタイルを範囲判定で先に弾かない。
    // 経度方向に広がったデータ（西経 60 度の点を足す）でも同じ画になる。
    for (const [count, extra] of [[1, []], [1100, []], [1, [pt(0, -60)]], [1100, [pt(0, -60)]]]) {
        const points = [...Array.from({ length: count }, () => pt(0, 179.9)), ...extra];
        const r = renderer(points, { tileSize: 64, radiusPx: 10 });
        // z1 の西半球タイル (x=0) の左端
        const west = decodePng(r.renderTile({ x: 0, y: 1, z: 1 }));
        assert.ok(pixel(west, 0, 0)[3] > 0, `left edge painted (${count} points)`);
        assert.equal(pixel(west, 20, 0)[3], 0);
    }
});

test('HeatmapCameraController forwards only the camera zoom and is otherwise inert', async () => {
    const zooms = [];
    const c = new Cam.HeatmapCameraController({ updateCameraZoom: (z) => zooms.push(z) });
    assert.equal(c.zIndex, 0);
    assert.equal(c.clickListener, null);
    await c.add([]);
    await c.update();
    await c.clear();
    assert.equal(c.find({ latitude: 0, longitude: 0 }), null);
    c.onCameraChanged({ zoom: 7.5, position: { latitude: 1, longitude: 2 } });
    c.onCameraChanged({ zoom: 8 });
    c.destroy();
    assert.deepEqual(zooms, [7.5, 8]);
});
