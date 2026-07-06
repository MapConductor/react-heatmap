// ARGB integer color helpers (mirrors android.graphics.Color)
export function colorArgb(a: number, r: number, g: number, b: number): number {
    return ((a << 24) | (r << 16) | (g << 8) | b) | 0;
}

export function colorRgb(r: number, g: number, b: number): number {
    return (0xff000000 | (r << 16) | (g << 8) | b) | 0;
}

export function colorAlpha(c: number): number { return (c >>> 24) & 0xff; }
export function colorRed(c: number): number { return (c >>> 16) & 0xff; }
export function colorGreen(c: number): number { return (c >>> 8) & 0xff; }
export function colorBlue(c: number): number { return c & 0xff; }
export const COLOR_TRANSPARENT = 0;

export interface HeatmapGradientStop {
    /** Position in [0, 1] */
    position: number;
    /** ARGB color integer (use colorRgb() or colorArgb() helpers) */
    color: number;
}

export class HeatmapGradient {
    readonly stops: readonly HeatmapGradientStop[];

    constructor(stops: HeatmapGradientStop[]) {
        const sorted = [...stops].sort((a, b) => a.position - b.position);
        if (sorted.length === 0) {
            throw new Error('HeatmapGradient requires at least one stop.');
        }
        for (const stop of sorted) {
            if (stop.position < 0 || stop.position > 1) {
                throw new Error('HeatmapGradient stop position must be in [0, 1].');
            }
        }
        this.stops = sorted;
    }

    static readonly DEFAULT = new HeatmapGradient([
        { position: 0.2, color: colorRgb(102, 225, 0) },
        { position: 1.0, color: colorRgb(255, 0, 0) },
    ]);
}

export const HeatmapDefaults = {
    DEFAULT_RADIUS_PX: 20,
    DEFAULT_OPACITY: 0.7,
    DEFAULT_MAX_ZOOM: 22,
} as const;
