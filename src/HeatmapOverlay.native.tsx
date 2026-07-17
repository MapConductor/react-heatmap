import React, { useEffect, useMemo, useReducer } from 'react';
import { Platform } from 'react-native';
import { OverlayCollector } from '@mapconductor/js-sdk-core';
import {
    useNativeMapExtension,
    type NativeMapExtensionDescriptor,
} from '@mapconductor/js-sdk-react/native';
import { HeatmapDefaults } from './HeatmapGradient';
import type { HeatmapPointState } from './HeatmapPointState';
import {
    HeatmapOverlay as WebHeatmapOverlay,
    HeatmapPoint,
    HeatmapPoints,
    HeatmapPointContext,
    type HeatmapOverlayProps,
    type HeatmapPointProps,
} from './HeatmapOverlay';

export { HeatmapPoint, HeatmapPoints };
export type { HeatmapOverlayProps, HeatmapPointProps };

let nextOverlayId = 1;

export function HeatmapOverlay(props: HeatmapOverlayProps): React.ReactElement | null {
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
        return <WebHeatmapOverlay {...props} />;
    }
    return <NativeHeatmapOverlay {...props} />;
}

function NativeHeatmapOverlay(props: HeatmapOverlayProps): React.ReactElement | null {
    const {
        state: stateProp,
        points: pointsProp,
        tileSize,
        trackPointUpdates = false,
        disableTileServerCache = false,
        children,
    } = props;
    const radiusPx = stateProp?.radiusPx ?? props.radiusPx ?? HeatmapDefaults.DEFAULT_RADIUS_PX;
    const opacity = stateProp?.opacity ?? props.opacity ?? HeatmapDefaults.DEFAULT_OPACITY;
    const gradient = stateProp?.gradient ?? props.gradient;
    const maxIntensity = stateProp?.maxIntensity ?? props.maxIntensity ?? null;
    const weightProvider = stateProp?.weightProvider ?? props.weightProvider ?? defaultWeightProvider;
    const overlayId = useMemo(() => `heatmap-${nextOverlayId++}`, []);
    const collector = useMemo(() => new OverlayCollector<HeatmapPointState>(), []);
    const [revision, invalidate] = useReducer((value: number) => value + 1, 0);

    useEffect(() => collector.subscribe(() => invalidate()), [collector]);

    useEffect(() => {
        collector.setUpdateHandler(trackPointUpdates ? invalidate : null);
        return () => collector.setUpdateHandler(null);
    }, [collector, trackPointUpdates]);

    useEffect(() => {
        if (pointsProp === undefined) return;
        collector.replaceAll(pointsProp);
    }, [collector, pointsProp]);

    useEffect(() => () => collector.clear(), [collector]);

    const pointBatch = useMemo(() => {
        void revision;
        return encodeHeatmapPointBatch(collector.values(), weightProvider);
    }, [collector, revision, weightProvider]);

    const extension = useMemo<NativeMapExtensionDescriptor>(() => ({
        id: overlayId,
        type: 'heatmap',
        payload: {
            points: pointBatch,
            options: {
                radiusPx,
                opacity,
                gradient: gradient == null ? null : { stops: gradient.stops },
                maxIntensity,
                tileSize,
                disableTileServerCache,
            },
        },
    }), [
        overlayId,
        pointBatch,
        radiusPx,
        opacity,
        gradient,
        maxIntensity,
        tileSize,
        disableTileServerCache,
    ]);

    useNativeMapExtension(extension);

    return (
        <HeatmapPointContext.Provider value={collector}>
            {children ?? null}
        </HeatmapPointContext.Provider>
    );
}

function defaultWeightProvider(state: HeatmapPointState): number {
    return state.weight;
}

interface NativeHeatmapPointBatch {
    ids: string[];
    /** Interleaved [latitude0, longitude0, latitude1, longitude1, ...]. */
    positions: number[];
    weights: number[];
}

function encodeHeatmapPointBatch(
    states: HeatmapPointState[],
    weightProvider: (state: HeatmapPointState) => number,
): NativeHeatmapPointBatch {
    const ids: string[] = [];
    const positions: number[] = [];
    const weights: number[] = [];

    states.forEach((state) => {
        const weight = weightProvider(state);
        if (!Number.isFinite(weight) || weight <= 0) return;
        ids.push(state.id);
        positions.push(state.position.latitude, state.position.longitude);
        weights.push(weight);
    });

    return { ids, positions, weights };
}
