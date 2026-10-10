window.OPERATOR_CONFIG = Object.freeze({
  apiEndpoint: '/api/stations',
  refreshIntervalMs: 60000,
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
    markerImageSize: 28
  }),
  kakaoJavaScriptKey: 'db90fddc5d2042d05f04f1e1bfdd94c7'
});