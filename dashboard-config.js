window.OPERATOR_CONFIG = Object.freeze({
  apiEndpoint: '/api/stations',
  refreshIntervalMs: 300000,
  pageSize: 75,
  demoForecasts: true,
  map: Object.freeze({
    districtBubbleLevel: 7,
    clusterLevel: 6,
    markerImageSize: 28,
    markerSmallRatio: 0.34,
    markerMediumRatio: 0.67,
    markerSmallSizeOffset: -4,
    markerLargeSizeOffset: 4,
    districtBubbleMinDiameter: 64,
    districtBubbleMaxDiameter: 128,
    bubbleScaleByLevel: Object.freeze({
      7: 1.6,
      8: 1.3,
      9: 1.0,
      10: 0.85
    })
  }),
  kakaoJavaScriptKey: 'db90fddc5d2042d05f04f1e1bfdd94c7'
});