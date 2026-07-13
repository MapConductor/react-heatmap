module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath:
          'import com.mapconductor.react.heatmap.MapConductorHeatmapPackage;',
        packageInstance: 'new MapConductorHeatmapPackage()',
      },
    },
  },
};
