import type { HeatmapGradient } from './HeatmapGradient';
import {
    colorAlpha, colorRed, colorGreen, colorBlue,
    colorArgb,
} from './HeatmapGradient';

/**
 * グラデーション定義から、強度 → 色の引き当て表を作る部分。
 *
 * 描画のたびに補間すると重いので、`COLOR_MAP_SIZE` 段の表へ一度だけ展開しておき、
 * タイル描画では配列の添字を引くだけにする。
 *
 * **補間は HSV で行う。** RGB で補間すると青→赤のような組み合わせで中間が
 * 濁った灰色になり、ヒートマップとして意図した色相の変化にならない。
 *
 * android-sdk の `HeatmapColorMap.kt` / ios-sdk の同名ファイルと同じ式。
 */

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

export function interpolateColor(c1: number, c2: number, ratio: number): number {
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

export const COLOR_MAP_SIZE = 1000;

export function buildColorMap(gradient: HeatmapGradient): Int32Array {
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
