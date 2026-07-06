import { HeatmapGradient, HeatmapDefaults } from './HeatmapGradient';
import type { HeatmapPointState } from './HeatmapPointState';

export class HeatmapOverlayState {
    radiusPx: number;
    opacity: number;
    gradient: HeatmapGradient;
    maxIntensity: number | null;
    weightProvider: (state: HeatmapPointState) => number;

    constructor(params: {
        radiusPx?: number;
        opacity?: number;
        gradient?: HeatmapGradient;
        maxIntensity?: number | null;
        weightProvider?: (state: HeatmapPointState) => number;
    } = {}) {
        this.radiusPx = params.radiusPx ?? HeatmapDefaults.DEFAULT_RADIUS_PX;
        this.opacity = params.opacity ?? HeatmapDefaults.DEFAULT_OPACITY;
        this.gradient = params.gradient ?? HeatmapGradient.DEFAULT;
        this.maxIntensity = params.maxIntensity ?? null;
        this.weightProvider = params.weightProvider ?? ((s) => s.weight);
    }
}
