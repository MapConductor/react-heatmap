import React, {
    createContext,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    LocalTileServer,
    OverlayCollector,
    TileScheme,
    TileServerRegistry,
    createRasterLayerState,
    type GeoPointInterface,
    type MapCameraPosition,
} from '@mapconductor/js-sdk-core';
import { MapContext, RasterLayer } from '@mapconductor/js-sdk-react';
import { HeatmapGradient, HeatmapDefaults } from './HeatmapGradient';
import { HeatmapTileRenderer } from './HeatmapTileRenderer';
import { HeatmapPointState } from './HeatmapPointState';
import type { HeatmapOverlayState } from './HeatmapOverlayState';

// ─── Context ─────────────────────────────────────────────────────────────────

const HeatmapPointContext = createContext<OverlayCollector<HeatmapPointState> | null>(null);

function useHeatmapPointCollector(): OverlayCollector<HeatmapPointState> {
    const ctx = useContext(HeatmapPointContext);
    if (!ctx) throw new Error('HeatmapPoint must be rendered inside <HeatmapOverlay>');
    return ctx;
}

// ─── HeatmapOverlay ──────────────────────────────────────────────────────────

export interface HeatmapOverlayStateProps {
    state: HeatmapOverlayState;
    radiusPx?: never;
    opacity?: never;
    gradient?: never;
    maxIntensity?: never;
    weightProvider?: never;
}

export interface HeatmapOverlayParamsProps {
    state?: never;
    radiusPx?: number;
    opacity?: number;
    gradient?: HeatmapGradient;
    maxIntensity?: number | null;
    weightProvider?: (state: HeatmapPointState) => number;
}

export type HeatmapOverlayProps = (HeatmapOverlayStateProps | HeatmapOverlayParamsProps) & {
    /** Provide points directly instead of (or in addition to) child HeatmapPoint components. */
    points?: HeatmapPointState[];
    tileSize?: number;
    trackPointUpdates?: boolean;
    children?: React.ReactNode;
};

export function HeatmapOverlay(props: HeatmapOverlayProps): React.ReactElement | null {
    const {
        state: stateProp,
        points: pointsProp,
        tileSize = HeatmapTileRenderer.DEFAULT_TILE_SIZE,
        trackPointUpdates = false,
        children,
    } = props;

    const radiusPx = stateProp?.radiusPx ?? props.radiusPx ?? HeatmapDefaults.DEFAULT_RADIUS_PX;
    const opacity = stateProp?.opacity ?? props.opacity ?? HeatmapDefaults.DEFAULT_OPACITY;
    const gradient = stateProp?.gradient ?? props.gradient ?? HeatmapGradient.DEFAULT;
    const maxIntensity = stateProp?.maxIntensity ?? props.maxIntensity ?? null;
    const weightProvider = stateProp?.weightProvider ?? props.weightProvider ?? ((s: HeatmapPointState) => s.weight);

    // Stable per-mount references
    const groupId = useMemo(() => `heatmap-${Math.random().toString(36).slice(2)}`, []);
    const renderer = useMemo(() => new HeatmapTileRenderer({ tileSize }), [tileSize]);
    const collector = useMemo(() => new OverlayCollector<HeatmapPointState>(), []);
    const tileServer = useMemo(() => TileServerRegistry.get(), []);

    const mapCtx = useContext(MapContext);
    const controller = mapCtx?.controller ?? null;

    // RasterLayerState created once
    const rasterStateRef = useRef(
        createRasterLayerState({
            source: {
                type: 'UrlTemplate',
                template: tileServer.urlTemplate({ routeId: groupId, tileSize }),
                tileSize,
                maxZoom: 22,
                scheme: TileScheme.XYZ,
            },
            debug: true,
            opacity: Math.max(0, Math.min(1, opacity)),
            visible: true,
            id: `heatmap-${groupId}`,
        }),
    );

    const [isTileServerRegistered, setIsTileServerRegistered] = useState(false);
    const [hasRenderedOnce, setHasRenderedOnce] = useState(false);
    const [pointsVersion, setPointsVersion] = useState(0);
    const [updateToken, setUpdateToken] = useState(0);
    const pointsRef = useRef<ReadonlyMap<string, HeatmapPointState>>(new Map());

    // Keep weightProvider stable via ref so it doesn't re-trigger effects
    const weightProviderRef = useRef(weightProvider);
    useLayoutEffect(() => { weightProviderRef.current = weightProvider; }, [weightProvider]);

    // ── Opacity updates without full re-render ──
    useEffect(() => {
        rasterStateRef.current.opacity = Math.max(0, Math.min(1, opacity));
    }, [opacity]);

    // ── Register tile server ──────────────────────────────────────────────────
    useEffect(() => {
        tileServer.register(groupId, renderer);

        // The `/__tiles/` URL template is only resolvable while the tile
        // Service Worker controls the page, so start it and wait before
        // mounting the RasterLayer (otherwise tile requests 404 or time out).
        let cancelled = false;
        if (LocalTileServer.isServiceWorkerSupported()) {
            tileServer.startServiceWorker('/tile-sw.js');
            tileServer.waitForController().then(() => {
                if (!cancelled) setIsTileServerRegistered(true);
            });
        } else {
            setIsTileServerRegistered(true);
        }

        return () => {
            cancelled = true;
            tileServer.unregister(groupId);
            setIsTileServerRegistered(false);
        };
    }, [groupId, tileServer, renderer]);

    // ── Camera zoom tracking ──────────────────────────────────────────────────
    useEffect(() => {
        if (!controller) return;

        // Chain any existing listener so we don't break other components
        type WithCb = { cameraMoveEndCallback?: ((c: MapCameraPosition) => void) | null };
        const prev = (controller as unknown as WithCb).cameraMoveEndCallback ?? null;

        controller.setCameraMoveEndListener((camera: MapCameraPosition) => {
            renderer.updateCameraZoom(camera.zoom);
            prev?.(camera);
        });

        const initial = controller.getCameraPosition();
        if (initial) renderer.updateCameraZoom(initial.zoom);

        return () => { controller.setCameraMoveEndListener(prev); };
    }, [controller, renderer]);

    // ── Subscribe to collector for child-based points ─────────────────────────
    useEffect(() => {
        return collector.subscribe((map) => {
            pointsRef.current = map;
            setPointsVersion(v => v + 1);
        });
    }, [collector]);

    // ── trackPointUpdates: listen to individual state changes ─────────────────
    useEffect(() => {
        if (trackPointUpdates) {
            collector.setUpdateHandler(() => setUpdateToken(t => t + 1));
        } else {
            collector.setUpdateHandler(null);
        }
        return () => { collector.setUpdateHandler(null); };
    }, [collector, trackPointUpdates]);

    // ── points prop → collector ───────────────────────────────────────────────
    useEffect(() => {
        if (pointsProp === undefined) return;
        collector.replaceAll(pointsProp);
    }, [pointsProp, collector]);

    // ── Re-render when points / settings change ───────────────────────────────
    useEffect(() => {
        const wp = weightProviderRef.current;
        const heatmapPoints = Array.from(pointsRef.current.values())
            .flatMap(ps => {
                const w = wp(ps);
                if (isNaN(w) || w <= 0) return [];
                return [{ position: ps.position, weight: w }];
            });

        renderer.update({ points: heatmapPoints, radiusPx, gradient, maxIntensity });

        if (heatmapPoints.length === 0) {
            setHasRenderedOnce(false);
            return;
        }

        setHasRenderedOnce(true);
        rasterStateRef.current.source = {
            type: 'UrlTemplate',
            template: tileServer.urlTemplate({
                routeId: groupId,
                tileSize,
                cacheKey: String(updateToken + pointsVersion),
            }),
            tileSize,
            maxZoom: 22,
            scheme: TileScheme.XYZ,
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pointsVersion, updateToken, radiusPx, gradient, maxIntensity, tileSize, groupId, tileServer, renderer]);

    // ── Cleanup on unmount ────────────────────────────────────────────────────
    useEffect(() => {
        return () => {
            collector.setUpdateHandler(null);
            collector.clear();
        };
    }, [collector]);

    return (
        <HeatmapPointContext.Provider value={collector}>
            {isTileServerRegistered && hasRenderedOnce && (
                <RasterLayer state={rasterStateRef.current} />
            )}
            {children}
        </HeatmapPointContext.Provider>
    );
}

// ─── HeatmapPoint ────────────────────────────────────────────────────────────

export interface HeatmapPointStateProps {
    state: HeatmapPointState;
    position?: never;
}

export interface HeatmapPointPositionProps {
    state?: never;
    position: GeoPointInterface;
    weight?: number;
    id?: string | null;
}

export type HeatmapPointProps = HeatmapPointStateProps | HeatmapPointPositionProps;

function HeatmapPointWithState({ state }: HeatmapPointStateProps): null {
    const collector = useHeatmapPointCollector();

    useEffect(() => {
        collector.add(state);
    }, [state, collector]);

    useEffect(() => {
        return () => { collector.remove(state.id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.id, collector]);

    return null;
}

function HeatmapPointFromPositionProps(props: HeatmapPointPositionProps): React.ReactElement | null {
    const stateRef = useRef<HeatmapPointState | null>(null);
    if (!stateRef.current) {
        stateRef.current = new HeatmapPointState({
            position: props.position,
            weight: props.weight,
            id: props.id,
        });
    }
    const state = stateRef.current;

    useEffect(() => { state.position = props.position; }, [state, props.position]);
    useEffect(() => { state.weight = props.weight ?? 1.0; }, [state, props.weight]);

    return <HeatmapPointWithState state={state} />;
}

export function HeatmapPoint(props: HeatmapPointStateProps): null;
export function HeatmapPoint(props: HeatmapPointPositionProps): React.ReactElement | null;
export function HeatmapPoint(props: HeatmapPointProps): React.ReactElement | null {
    if (props.state !== undefined) {
        return <HeatmapPointWithState state={props.state} />;
    }
    return <HeatmapPointFromPositionProps {...(props as HeatmapPointPositionProps)} />;
}

// ─── HeatmapPoints (bulk) ────────────────────────────────────────────────────

interface HeatmapPointsProps {
    states: HeatmapPointState[];
}

export function HeatmapPoints({ states }: HeatmapPointsProps): null {
    const collector = useHeatmapPointCollector();

    useEffect(() => {
        collector.replaceAll(states);
    }, [states, states.length, collector]);

    useEffect(() => {
        return () => { collector.clear(); };
    }, [collector]);

    return null;
}
