window.OPERATOR_CONFIG = Object.freeze({
  apiEndpoint: '/api/stations',
  refreshIntervalMs: 300000,
  pageSize: 75,
  demoForecasts: true,
  thresholds: Object.freeze({
    shortageRate: 0.2,
    surplusRate: 0.9,
    targetRate: 0.5
  }),
  map: Object.freeze({
    districtBubbleLevel: 7,
    clusterLevel: 6,
    markerImageSize: 28,
    markerSmallRatio: 0.34,
    markerMediumRatio: 0.67,
    markerSmallSizeOffset: -4,
    markerLargeSizeOffset: 4,
    districtBubbleMinDiameter: 48,
    districtBubbleMaxDiameter: 96
  }),
  kakaoJavaScriptKey: 'db90fddc5d2042d05f04f1e1bfdd94c7'
});