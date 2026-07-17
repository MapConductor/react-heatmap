import Foundation
import MapConductorReactNativeCore

/// Exists purely so React Native instantiates it once at bridge startup (via
/// `MapConductorHeatmapPackage.m`'s `RCT_EXTERN_MODULE`), as the trigger point to register the
/// `"heatmap"` native map extension renderer — mirrors Android's `MapConductorHeatmapPackage.kt`.
/// No JS code ever calls a method on this module.
@objc(MapConductorHeatmapPackage)
public final class MapConductorHeatmapPackage: NSObject {
    public override init() {
        super.init()
        MapConductorHeatmapPackage.registerOnce
    }

    @objc public static func requiresMainQueueSetup() -> Bool { false }

    private static let registerOnce: Void = {
        NativeMapExtensionRegistry.register(type: "heatmap") { extensionId, eventSink in
            HeatmapExtensionRenderer(extensionId: extensionId, eventSink: eventSink)
        }
    }()
}
