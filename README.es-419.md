[English](./README.md) | [日本語](./README.ja.md) | Español (Latinoamérica)

# @mapconductor/react-heatmap

Extensión de superposición de mapa de calor para el SDK de React de MapConductor. Renderiza grandes conjuntos de puntos como un mapa de calor teselado dentro de cualquier vista de mapa de proveedor (`react-for-googlemaps`, `react-for-maplibre`, `react-for-here`, …), con radio, gradiente, opacidad y pesos por punto configurables. Funciona en la web y, mediante los módulos de Android/iOS incluidos, en React Native.

## Instalación

```shell
npm install @mapconductor/react-heatmap
```

`@mapconductor/js-sdk-core` y `@mapconductor/js-sdk-react` se instalan automáticamente como dependencias. Tu código importa directamente de ambos, así que con el `node_modules` estricto (aislado) de pnpm — o siempre que prefieras declarar todo lo que importas — instálalos explícitamente:

```shell
npm install @mapconductor/react-heatmap @mapconductor/js-sdk-core @mapconductor/js-sdk-react
```

También necesitas un paquete de proveedor (cualquier `@mapconductor/react-for-*`) para alojar la vista de mapa.

## Inicio rápido

El ejemplo usa MapLibre, pero la superposición funciona sin cambios dentro de cualquier vista de proveedor:

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

El ejemplo de mapa de calor de `examples/basic` renderiza 24,526 puntos de esta manera.

## Resumen de la API

- `HeatmapOverlay` — el componente de superposición. Los puntos llegan mediante hijos `HeatmapPoint` / `HeatmapPoints` o la prop `points`; la apariencia mediante un `HeatmapOverlayState` opcional (o parámetros en línea).
- `HeatmapOverlayState` — `radiusPx`, `opacity`, `gradient`, `maxIntensity` y un callback `weightProvider` para intensidad basada en datos.
- `HeatmapPointState` — punto observable con `position` y `weight` (por defecto `1.0`); las mutaciones actualizan el mapa de calor renderizado.
- `HeatmapGradient` con `HeatmapGradientStop`, más los helpers `colorArgb` / `colorRgb` — el formato de color ARGB compartido con el SDK de Android.

## Paquetes relacionados

- [`@mapconductor/js-sdk-core`](../js-sdk-core) — primitivas de geometría, cámara y estado
- [`@mapconductor/js-sdk-react`](../js-sdk-react) — `Marker`, `Markers`, formas y burbujas de información compartidos
- `@mapconductor/react-for-*` — paquetes de proveedor (Google Maps, MapLibre, Mapbox, Leaflet, OpenLayers, ArcGIS, Cesium, HERE)
