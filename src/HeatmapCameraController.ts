import type { GeoPoint, MapCameraPosition, OverlayController } from '@mapconductor/js-sdk-core';
import type { HeatmapTileRenderer } from './HeatmapTileRenderer';

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
export class HeatmapCameraController implements OverlayController<void, void, void> {
    readonly zIndex = 0;
    clickListener: ((event: void) => void) | null = null;

    constructor(private readonly renderer: HeatmapTileRenderer) {}

    add(_data: void[]): Promise<void> {
        return Promise.resolve();
    }

    update(_state: void): Promise<void> {
        return Promise.resolve();
    }

    clear(): Promise<void> {
        return Promise.resolve();
    }

    find(_position: GeoPoint): void | null {
        return null;
    }

    onCameraChanged(mapCameraPosition: MapCameraPosition): void {
        this.renderer.updateCameraZoom(mapCameraPosition.zoom);
    }

    destroy(): void {
        // No native resources to clean up.
    }
}
