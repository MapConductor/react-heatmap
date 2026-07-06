import type { GeoPointInterface } from '@mapconductor/js-sdk-core';
import { createSubject } from '@mapconductor/js-sdk-core';

export interface HeatmapPointFingerPrint {
    positionLat: number;
    positionLng: number;
    weight: number;
}

function fpEquals(a: HeatmapPointFingerPrint, b: HeatmapPointFingerPrint): boolean {
    return a.positionLat === b.positionLat &&
        a.positionLng === b.positionLng &&
        a.weight === b.weight;
}

let nextAutoId = 0;

export class HeatmapPointState {
    readonly id: string;

    private _position: GeoPointInterface;
    private _weight: number;
    private readonly subject = createSubject<HeatmapPointFingerPrint>(fpEquals);

    constructor(params: {
        position: GeoPointInterface;
        weight?: number;
        id?: string | null;
    }) {
        this._position = params.position;
        this._weight = params.weight ?? 1.0;
        this.id = params.id ?? `heatmap-point-${++nextAutoId}`;
        this.subject.next(this.fingerPrint());
    }

    get position(): GeoPointInterface { return this._position; }
    set position(v: GeoPointInterface) {
        this._position = v;
        this.subject.next(this.fingerPrint());
    }

    get weight(): number { return this._weight; }
    set weight(v: number) {
        this._weight = v;
        this.subject.next(this.fingerPrint());
    }

    fingerPrint(): HeatmapPointFingerPrint {
        return {
            positionLat: this._position.latitude,
            positionLng: this._position.longitude,
            weight: this._weight,
        };
    }

    asObservable(): { subscribe: (fn: (fp: HeatmapPointFingerPrint) => void) => () => void } {
        return { subscribe: this.subject.subscribe };
    }
}
