import type { GeoPointInterface } from '@mapconductor/js-sdk-core';

export interface HeatmapPointData {
    readonly position: GeoPointInterface;
    readonly weight: number;
}

export function createHeatmapPoint(params: {
    position: GeoPointInterface;
    weight?: number;
}): HeatmapPointData {
    return {
        position: params.position,
        weight: params.weight ?? 1.0,
    };
}
