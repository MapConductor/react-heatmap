import { GeoPointInterface, TileProvider, TileRequest, OverlayController, GeoPoint, MapCameraPosition } from '@mapconductor/js-sdk-core';
import React from 'react';

declare function colorArgb(a: number, r: number, g: number, b: number): number;
declare function colorRgb(r: number, g: number, b: number): number;
declare function colorAlpha(c: number): number;
declare function colorRed(c: number): number;
declare function colorGreen(c: number): number;
declare function colorBlue(c: number): number;
declare const COLOR_TRANSPARENT = 0;
interface HeatmapGradientStop {
    /** Position in [0, 1] */
    position: number;
    /** ARGB color integer (use colorRgb() or colorArgb() helpers) */
    color: number;
}
declare class HeatmapGradient {
    readonly stops: readonly HeatmapGradientStop[];
    constructor(stops: HeatmapGradientStop[]);
    static readonly DEFAULT: HeatmapGradient;
}
declare const HeatmapDefaults: {
    readonly DEFAULT_RADIUS_PX: 20;
    readonly DEFAULT_OPACITY: 0.7;
    readonly DEFAULT_MAX_ZOOM: 22;
};

interface HeatmapPointData {
    readonly position: GeoPointInterface;
    readonly weight: number;
}
declare function createHeatmapPoint(params: {
    position: GeoPointInterface;
    weight?: number;
}): HeatmapPointData;

interface HeatmapPointFingerPrint {
    positionLat: number;
    positionLng: number;
    weight: number;
}
declare class HeatmapPointState {
    readonly id: string;
    private _position;
    private _weight;
    private readonly subject;
    constructor(params: {
        position: GeoPointInterface;
        weight?: number;
        id?: string | null;
    });
    get position(): GeoPointInterface;
    set position(v: GeoPointInterface);
    get weight(): number;
    set weight(v: number);
    fingerPrint(): HeatmapPointFingerPrint;
    asObservable(): {
        subscribe: (fn: (fp: HeatmapPointFingerPrint) => void) => () => void;
    };
}

declare class HeatmapOverlayState {
    radiusPx: number;
    opacity: number;
    gradient: HeatmapGradient;
    maxIntensity: number | null;
    weightProvider: (state: HeatmapPointState) => number;
    constructor(params?: {
        radiusPx?: number;
        opacity?: number;
        gradient?: HeatmapGradient;
        maxIntensity?: number | null;
        weightProvider?: (state: HeatmapPointState) => number;
    });
}

interface HeatmapOverlayStateProps {
    state: HeatmapOverlayState;
    radiusPx?: never;
    opacity?: never;
    gradient?: never;
    maxIntensity?: never;
    weightProvider?: never;
}
interface HeatmapOverlayParamsProps {
    state?: never;
    radiusPx?: number;
    opacity?: number;
    gradient?: HeatmapGradient;
    maxIntensity?: number | null;
    weightProvider?: (state: HeatmapPointState) => number;
}
type HeatmapOverlayProps = (HeatmapOverlayStateProps | HeatmapOverlayParamsProps) & {
    /** Provide points directly instead of (or in addition to) child HeatmapPoint components. */
    points?: HeatmapPointState[];
    tileSize?: number;
    trackPointUpdates?: boolean;
    disableTileServerCache?: boolean;
    children?: React.ReactNode;
};
declare function HeatmapOverlay(props: HeatmapOverlayProps): React.ReactElement | null;
interface HeatmapPointStateProps {
    state: HeatmapPointState;
    position?: never;
}
interface HeatmapPointPositionProps {
    state?: never;
    position: GeoPointInterface;
    weight?: number;
    id?: string | null;
}
type HeatmapPointProps = HeatmapPointStateProps | HeatmapPointPositionProps;
declare function HeatmapPoint(props: HeatmapPointStateProps): null;
declare function HeatmapPoint(props: HeatmapPointPositionProps): React.ReactElement | null;
interface HeatmapPointsProps {
    states: HeatmapPointState[];
}
declare function HeatmapPoints({ states }: HeatmapPointsProps): null;

declare class HeatmapTileRenderer implements TileProvider {
    static readonly DEFAULT_TILE_SIZE = 512;
    private static readonly INDEX_BUILD_THRESHOLD;
    private static readonly CAMERA_ZOOM_KEY_SCALE;
    private static readonly DEFAULT_CACHE_KB;
    readonly tileSize: number;
    private readonly cache;
    private readonly transparentTileBytes;
    private cameraZoomQuantized;
    private cameraZoomKey;
    private cacheEpoch;
    private state;
    private intensityBuf;
    private intermediateBuf;
    private outputBuf;
    private nonZeroInputBuf;
    private nonZeroIntermediateBuf;
    private pngBuf;
    private rowBuf;
    private ihdrBuf;
    private adlerBuf;
    private sbhBuf;
    constructor(params?: {
        tileSize?: number;
        cacheSizeKb?: number;
    });
    update(params: {
        points: HeatmapPointData[];
        radiusPx: number;
        gradient: HeatmapGradient;
        maxIntensity: number | null;
    }): void;
    updateCameraZoom(zoom: number): void;
    renderTile(request: TileRequest): Uint8Array | null;
    private ensureBuffers;
    private renderTileInternal;
}

/**
 * ヒートマップのタイル描画へカメラのズームを伝えるだけのオーバーレイコントローラ。
 *
 * android-heatmap の `HeatmapCameraController.kt` / ios-heatmap の
 * `HeatmapCameraController.swift` の移植。マップコントローラへ
 * `registerOverlayController` で登録すると、他のオーバーレイと同じ経路で
 * `onCameraChanged` が届く。
 *
 * これ以前の web 実装は `controller` を `{ cameraMoveEndCallback?: ... }` へキャストして
 * protected なフィールドを覗き、`setCameraMoveEndListener` の単一スロットに既存リスナーを
 * 退避・連結してから復元していた。内部実装への依存であるうえ、同じ手を使う拡張が
 * 2 つ載る／アプリ自身がカメラリスナーを設定すると互いに上書きし合う。
 */
declare class HeatmapCameraController implements OverlayController<void, void, void> {
    private readonly renderer;
    readonly zIndex = 0;
    clickListener: ((event: void) => void) | null;
    constructor(renderer: HeatmapTileRenderer);
    add(_data: void[]): Promise<void>;
    update(_state: void): Promise<void>;
    clear(): Promise<void>;
    find(_position: GeoPoint): void | null;
    onCameraChanged(mapCameraPosition: MapCameraPosition): void;
    destroy(): void;
}

export { COLOR_TRANSPARENT, HeatmapCameraController, HeatmapDefaults, HeatmapGradient, type HeatmapGradientStop, HeatmapOverlay, type HeatmapOverlayProps, HeatmapOverlayState, HeatmapPoint, type HeatmapPointData, type HeatmapPointFingerPrint, type HeatmapPointProps, HeatmapPointState, HeatmapPoints, HeatmapTileRenderer, colorAlpha, colorArgb, colorBlue, colorGreen, colorRed, colorRgb, createHeatmapPoint };
