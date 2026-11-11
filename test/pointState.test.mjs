import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSources } from './buildSources.mjs';

// 点の状態とオーバーレイ設定の既定値。HeatmapPointState は位置・重みの変更を
// fingerprint で通知し、同じ値の再代入では通知しないこと、購読時に現在値を受け取ること、
// id が自動採番されることを確かめる。
const { pointState: PS, overlayState: OS, point: P } = await buildSources('state-tests', {
    pointState: 'src/HeatmapPointState.ts',
    overlayState: 'src/HeatmapOverlayState.ts',
    point: 'src/HeatmapPoint.ts',
});

const geo = (latitude, longitude) => ({ latitude, longitude });

test('createHeatmapPoint defaults the weight to 1', () => {
    const pos = geo(35, 139);
    assert.deepEqual(P.createHeatmapPoint({ position: pos }), { position: pos, weight: 1 });
    assert.equal(P.createHeatmapPoint({ position: pos, weight: 0 }).weight, 0);
});

test('HeatmapPointState ids are auto-assigned and unique unless given', () => {
    const a = new PS.HeatmapPointState({ position: geo(0, 0) });
    const b = new PS.HeatmapPointState({ position: geo(0, 0) });
    assert.match(a.id, /^heatmap-point-\d+$/);
    assert.notEqual(a.id, b.id);
    assert.equal(new PS.HeatmapPointState({ position: geo(0, 0), id: 'mine' }).id, 'mine');
    assert.match(new PS.HeatmapPointState({ position: geo(0, 0), id: null }).id, /^heatmap-point-/);
    assert.equal(a.weight, 1);
});

test('subscribers get the current fingerprint, then each real change', () => {
    const s = new PS.HeatmapPointState({ position: geo(1, 2), weight: 3 });
    assert.deepEqual(s.fingerPrint(), { positionLat: 1, positionLng: 2, weight: 3 });
    const seen = [];
    const unsubscribe = s.asObservable().subscribe(fp => seen.push(fp));
    s.weight = 4;
    s.position = geo(5, 6);
    assert.deepEqual(seen, [
        { positionLat: 1, positionLng: 2, weight: 3 },
        { positionLat: 1, positionLng: 2, weight: 4 },
        { positionLat: 5, positionLng: 6, weight: 4 },
    ]);
    assert.equal(s.weight, 4);
    assert.deepEqual(s.position, geo(5, 6));

    unsubscribe();
    s.weight = 10;
    assert.equal(seen.length, 3, 'no notifications after unsubscribe');
});

test('assigning an equal value (even a new object) does not notify', () => {
    const s = new PS.HeatmapPointState({ position: geo(1, 2), weight: 3 });
    const seen = [];
    s.asObservable().subscribe(fp => seen.push(fp));
    s.position = geo(1, 2);
    s.weight = 3;
    assert.equal(seen.length, 1);
});

test('HeatmapOverlayState falls back to the shared defaults', () => {
    const s = new OS.HeatmapOverlayState();
    assert.equal(s.radiusPx, 20);
    assert.equal(s.opacity, 0.7);
    assert.equal(s.maxIntensity, null);
    assert.deepEqual(s.gradient.stops.map(st => st.position), [0.2, 1]);
    assert.equal(s.weightProvider({ weight: 9 }), 9, 'default weight provider reads state.weight');
});

test('HeatmapOverlayState keeps explicit values, including 0 and a custom weight provider', () => {
    const gradient = { stops: [{ position: 0, color: 1 }] };
    const wp = () => 42;
    const s = new OS.HeatmapOverlayState({ radiusPx: 5, opacity: 0, gradient, maxIntensity: 0, weightProvider: wp });
    assert.equal(s.radiusPx, 5);
    assert.equal(s.opacity, 0);
    assert.equal(s.gradient, gradient);
    assert.equal(s.maxIntensity, 0);
    assert.equal(s.weightProvider, wp);
});
