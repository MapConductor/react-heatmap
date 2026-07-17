import Foundation
import MapConductorCore
import MapConductorHeatmap
import MapConductorReactNativeCore
import UIKit

/// iOS counterpart of Android's `HeatmapOverlayRenderer.kt`: decodes the `upsertNativeMapExtension`
/// payload for `type: "heatmap"` into `HeatmapPointState`s and drives a `HeatmapOverlayState`.
final class HeatmapExtensionRenderer: NativeMapExtensionRenderer {
    private let extensionId: String
    private let eventSink: NativeMapExtensionEventSink
    private var overlayState: HeatmapOverlayState?
    private var pointStates: [HeatmapPointState] = []

    init(extensionId: String, eventSink: @escaping NativeMapExtensionEventSink) {
        self.extensionId = extensionId
        self.eventSink = eventSink
    }

    func update(payload: [String: Any]) {
        let options = Options.decode(payload["options"])
        if let state = overlayState {
            state.radiusPx = options.radiusPx
            state.opacity = options.opacity
            state.gradient = options.gradient
            state.maxIntensity = options.maxIntensity
        } else {
            overlayState = HeatmapOverlayState(
                tileSize: options.tileSize,
                radiusPx: options.radiusPx,
                opacity: options.opacity,
                gradient: options.gradient,
                maxIntensity: options.maxIntensity,
                weightProvider: HeatmapOverlayState.defaultWeightProvider,
                trackPointUpdates: false,
                disableTileServerCache: options.disableTileServerCache
            )
        }
        pointStates = Self.decodePoints(payload["points"])
    }

    func dispose() {}

    func makeContent() -> MapViewContent {
        guard let overlayState else { return MapViewContent() }
        return MapViewContentBuilder.buildExpression(HeatmapOverlay(overlayState) {
            HeatmapPoints(pointStates)
        })
    }

    private static func decodePoints(_ value: Any?) -> [HeatmapPointState] {
        guard let map = mcMap(value),
              let ids = mcArray(map["ids"]) as? [String],
              let positions = mcArray(map["positions"]) as? [NSNumber],
              let weights = mcArray(map["weights"]) as? [NSNumber] else { return [] }
        var result: [HeatmapPointState] = []
        result.reserveCapacity(ids.count)
        for index in ids.indices {
            let offset = index * 2
            guard positions.indices.contains(offset + 1), weights.indices.contains(index) else { continue }
            result.append(HeatmapPointState(
                position: GeoPoint(latitude: positions[offset].doubleValue, longitude: positions[offset + 1].doubleValue),
                weight: weights[index].doubleValue,
                id: ids[index]
            ))
        }
        return result
    }

    private struct Options {
        let radiusPx: Int
        let opacity: Double
        let gradient: HeatmapGradient
        let maxIntensity: Double?
        let tileSize: Int
        let disableTileServerCache: Bool

        static let Default = Options(
            radiusPx: HeatmapDefaults.defaultRadiusPx,
            opacity: HeatmapDefaults.defaultOpacity,
            gradient: .default,
            maxIntensity: nil,
            tileSize: HeatmapTileRenderer.defaultTileSize,
            disableTileServerCache: false
        )

        static func decode(_ value: Any?) -> Options {
            guard let map = mcMap(value) else { return .Default }
            return Options(
                radiusPx: mcInt(map["radiusPx"], default: Default.radiusPx),
                opacity: mcDouble(map["opacity"], default: Default.opacity),
                gradient: decodeGradient(map["gradient"]) ?? Default.gradient,
                maxIntensity: mcNumber(map["maxIntensity"])?.doubleValue,
                tileSize: mcInt(map["tileSize"], default: Default.tileSize),
                disableTileServerCache: mcBool(map["disableTileServerCache"], default: false)
            )
        }

        private static func decodeGradient(_ value: Any?) -> HeatmapGradient? {
            guard let stops = mcArray(mcMap(value)?["stops"]), !stops.isEmpty else { return nil }
            let decoded: [HeatmapGradientStop] = stops.compactMap { entry in
                guard let stop = mcMap(entry), let position = mcNumber(stop["position"]) else { return nil }
                return HeatmapGradientStop(position: position.doubleValue, color: mcColor(argb: stop["color"], default: .red))
            }
            guard !decoded.isEmpty else { return nil }
            return HeatmapGradient(stops: decoded)
        }
    }
}
