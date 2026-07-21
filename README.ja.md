[English](./README.md) | 日本語 | [Español (Latinoamérica)](./README.es-419.md)

# @mapconductor/react-heatmap

MapConductor React SDK のヒートマップオーバーレイ拡張です。大規模なポイントデータセットを、任意のプロバイダのマップビュー(`react-for-googlemaps`、`react-for-maplibre`、`react-for-here` など)の中にタイル化されたヒートマップとして描画します。半径・グラデーション・不透明度・ポイントごとの重みを設定できます。Web と、同梱の Android/iOS モジュールを通じて React Native の両方で動作します。

## インストール

```shell
npm install @mapconductor/react-heatmap
```

`@mapconductor/js-sdk-core` と `@mapconductor/js-sdk-react` は依存関係として自動的にインストールされます。ただしアプリケーションコードはこの2つから直接 import するため、pnpm の strict(isolated)な `node_modules` を使う場合や、import するものをすべて明示的に宣言したい場合は、次のように明示的にインストールしてください:

```shell
npm install @mapconductor/react-heatmap @mapconductor/js-sdk-core @mapconductor/js-sdk-react
```

マップビューをホストするプロバイダパッケージ(いずれかの `@mapconductor/react-for-*`)も必要です。

## クイックスタート

以下は MapLibre の例ですが、オーバーレイはどのプロバイダビューでもそのまま動作します:

```tsx
import { useMemo } from 'react';
import { createGeoPoint, createMapCameraPosition } from '@mapconductor/js-sdk-core';
import {
  HeatmapOverlay,
  HeatmapPoints,
  HeatmapPointState,
} from '@mapconductor/react-heatmap';
import {
  MapLibreDesign,
  MapLibreMapView2D,
  useMapLibreViewState,
} from '@mapconductor/react-for-maplibre';
import '@mapconductor/react-for-maplibre/style.css';

const DATA: [number, number][] = [
  [35.6812, 139.7671],
  [35.6896, 139.7006],
  [35.6586, 139.7454],
];

export function App() {
  const state = useMapLibreViewState({
    mapDesignType: MapLibreDesign.OsmBrightJa,
    cameraPosition: createMapCameraPosition({
      position: createGeoPoint({ latitude: 35.6812, longitude: 139.7671 }),
      zoom: 11,
    }),
  });
  const points = useMemo(
    () =>
      DATA.map(
        ([latitude, longitude], i) =>
          new HeatmapPointState({
            id: `p-${i}`,
            position: createGeoPoint({ latitude, longitude }),
          }),
      ),
    [],
  );

  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <MapLibreMapView2D state={state}>
        <HeatmapOverlay>
          <HeatmapPoints states={points} />
        </HeatmapOverlay>
      </MapLibreMapView2D>
    </div>
  );
}
```

`examples/basic` のヒートマップサンプルは、この方法で 24,526 件のポイントを描画しています。

## API 概要

- `HeatmapOverlay` — オーバーレイコンポーネント。ポイントは `HeatmapPoint` / `HeatmapPoints` の子要素または `points` prop で渡し、見た目は任意の `HeatmapOverlayState`(またはインラインのパラメータ)で指定します。
- `HeatmapOverlayState` — `radiusPx`、`opacity`、`gradient`、`maxIntensity` と、データ駆動の強度を実現する `weightProvider` コールバック。
- `HeatmapPointState` — `position` と `weight`(デフォルト `1.0`)を持つオブザーバブルなポイント。変更は描画中のヒートマップに反映されます。
- `HeatmapGradient` と `HeatmapGradientStop`、および `colorArgb` / `colorRgb` ヘルパー — Android SDK と共通の ARGB カラー形式。

## 関連パッケージ

- [`@mapconductor/js-sdk-core`](../js-sdk-core) — ジオメトリ・カメラ・状態のプリミティブ
- [`@mapconductor/js-sdk-react`](../js-sdk-react) — 共有の `Marker`・`Markers`・シェイプ・インフォバブル
- `@mapconductor/react-for-*` — プロバイダパッケージ(Google Maps、MapLibre、Mapbox、Leaflet、OpenLayers、ArcGIS、Cesium、HERE)
