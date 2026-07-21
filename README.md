English | [日本語](./README.ja.md) | [Español (Latinoamérica)](./README.es-419.md)

# @mapconductor/react-heatmap

Heatmap overlay extension for the MapConductor React SDK. Renders large point
datasets as a tiled heatmap inside any provider map view
(`react-for-googlemaps`, `react-for-maplibre`, `react-for-here`, …), with
configurable radius, gradient, opacity, and per-point weights. Works on the
web and, through the bundled Android/iOS modules, in React Native.

## Installation

```shell
npm install @mapconductor/react-heatmap
```

`@mapconductor/js-sdk-core` and `@mapconductor/js-sdk-react` are installed
automatically as dependencies. Your code imports from them directly, so with
pnpm's strict (isolated) `node_modules` — or whenever you prefer to declare
everything you import — install them explicitly instead:

```shell
npm install @mapconductor/react-heatmap @mapconductor/js-sdk-core @mapconductor/js-sdk-react
```

You also need a provider package (any `@mapconductor/react-for-*`) to host the
map view.

## Quick start

The example uses MapLibre, but the overlay works unchanged inside any provider
view:

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

The `examples/basic` heatmap sample renders 24,526 points this way.

## API overview

- `HeatmapOverlay` — the overlay component. Points come from `HeatmapPoint` /
  `HeatmapPoints` children or the `points` prop; appearance comes from an
  optional `HeatmapOverlayState` (or inline params).
- `HeatmapOverlayState` — `radiusPx`, `opacity`, `gradient`, `maxIntensity`,
  and a `weightProvider` callback for data-driven intensity.
- `HeatmapPointState` — observable point with `position` and `weight`
  (default `1.0`); mutations update the rendered heatmap.
- `HeatmapGradient` with `HeatmapGradientStop`, plus `colorArgb` / `colorRgb`
  helpers — the ARGB color format shared with the Android SDK.

## Related packages

- [`@mapconductor/js-sdk-core`](../js-sdk-core) — geometry, camera, and state primitives
- [`@mapconductor/js-sdk-react`](../js-sdk-react) — shared `Marker`, `Markers`, shapes, and info bubbles
- `@mapconductor/react-for-*` — provider packages (Google Maps, MapLibre, Mapbox, Leaflet, OpenLayers, ArcGIS, Cesium, HERE)
