package com.mapconductor.react.heatmap

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.facebook.react.bridge.ReadableMap
import com.mapconductor.compose.MapViewScope
import com.mapconductor.core.features.GeoPoint
import com.mapconductor.heatmap.HeatmapDefaults
import com.mapconductor.heatmap.HeatmapGradient
import com.mapconductor.heatmap.HeatmapGradientStop
import com.mapconductor.heatmap.HeatmapOverlay
import com.mapconductor.heatmap.HeatmapPointState
import com.mapconductor.heatmap.HeatmapPoints
import com.mapconductor.heatmap.HeatmapTileRenderer
import com.mapconductor.react.extensions.NativeMapExtensionRenderer
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class HeatmapOverlayRenderer(
    extensionId: String,
) : NativeMapExtensionRenderer {
    private val ingestDispatcher: CoroutineDispatcher =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "HeatmapIngest-$extensionId").apply { isDaemon = true }
        }.asCoroutineDispatcher()
    private val scope = CoroutineScope(ingestDispatcher)
    private var updateJob: Job? = null
    private var points by mutableStateOf<List<HeatmapPointState>>(emptyList())
    private var options by mutableStateOf(HeatmapOptions.Default)

    override fun update(payload: ReadableMap?) {
        options = HeatmapOptions.fromReadableMap(payload?.map("options"))
        val pointPayload = payload?.map("points")
        updateJob?.cancel()
        updateJob =
            scope.launch {
                val decoded = decodeHeatmapPointBatch(pointPayload)
                withContext(Dispatchers.Main) {
                    points = decoded
                }
            }
    }

    @Composable
    override fun MapViewScope.Render() {
        val current = options
        HeatmapOverlay(
            radiusPx = current.radiusPx,
            opacity = current.opacity,
            gradient = current.gradient,
            maxIntensity = current.maxIntensity,
            tileSize = current.tileSize,
            trackPointUpdates = false,
            disableTileServerCache = current.disableTileServerCache,
        ) {
            HeatmapPoints(points)
        }
    }

    override fun dispose() {
        updateJob?.cancel()
        scope.cancel()
        (ingestDispatcher as? java.io.Closeable)?.close()
    }
}

private data class HeatmapOptions(
    val radiusPx: Int,
    val opacity: Double,
    val gradient: HeatmapGradient,
    val maxIntensity: Double?,
    val tileSize: Int,
    val disableTileServerCache: Boolean,
) {
    companion object {
        val Default =
            HeatmapOptions(
                radiusPx = HeatmapDefaults.DEFAULT_RADIUS_PX,
                opacity = HeatmapDefaults.DEFAULT_OPACITY,
                gradient = HeatmapGradient.DEFAULT,
                maxIntensity = null,
                tileSize = HeatmapTileRenderer.DEFAULT_TILE_SIZE,
                disableTileServerCache = false,
            )

        fun fromReadableMap(map: ReadableMap?): HeatmapOptions =
            HeatmapOptions(
                radiusPx = map?.number("radiusPx")?.toInt() ?: Default.radiusPx,
                opacity = map?.number("opacity") ?: Default.opacity,
                gradient = decodeGradient(map?.map("gradient")) ?: Default.gradient,
                maxIntensity = map?.number("maxIntensity"),
                tileSize = map?.number("tileSize")?.toInt() ?: Default.tileSize,
                disableTileServerCache = map?.boolean("disableTileServerCache") ?: false,
            )
    }
}

private fun decodeHeatmapPointBatch(payload: ReadableMap?): List<HeatmapPointState> {
    if (payload == null) return emptyList()
    val ids = payload.getArray("ids") ?: return emptyList()
    val positions = payload.getArray("positions") ?: return emptyList()
    val weights = payload.getArray("weights") ?: return emptyList()

    return buildList {
        for (index in 0 until ids.size()) {
            val positionIndex = index * 2
            if (positionIndex + 1 >= positions.size() || index >= weights.size()) continue
            val id = ids.getString(index) ?: continue
            add(
                HeatmapPointState(
                    id = id,
                    position =
                        GeoPoint(
                            latitude = positions.getDouble(positionIndex),
                            longitude = positions.getDouble(positionIndex + 1),
                        ),
                    weight = weights.getDouble(index),
                ),
            )
        }
    }
}

private fun decodeGradient(map: ReadableMap?): HeatmapGradient? {
    val stops = map?.getArray("stops") ?: return null
    if (stops.size() == 0) return null
    return runCatching {
        HeatmapGradient(
            buildList {
                for (index in 0 until stops.size()) {
                    val stop = stops.getMap(index) ?: continue
                    val position = stop.number("position") ?: continue
                    val color = stop.number("color")?.toInt() ?: continue
                    add(HeatmapGradientStop(position = position, color = color))
                }
            },
        )
    }.getOrNull()
}

private fun ReadableMap.map(key: String): ReadableMap? =
    if (hasKey(key) && !isNull(key)) getMap(key) else null

private fun ReadableMap.number(key: String): Double? =
    if (hasKey(key) && !isNull(key)) getDouble(key) else null

private fun ReadableMap.boolean(key: String): Boolean? =
    if (hasKey(key) && !isNull(key)) getBoolean(key) else null
