const config = window.OPERATOR_CONFIG;
const horizons = [
  { key: 'now', label: '현재' },
  { key: 'h1', label: '+1시간' },
  { key: 'h3', label: '+3시간' }
];
const state = {
  allStations: [],
  baseTime: null,
  source: 'live',
  demoForecasts: false,
  risk: 'shortage',
  district: '',
  horizon: 'now',
  sort: 'shortageH3',
  page: 1,
  selectedStationId: '',
  suggestions: [],
  activeSuggestion: -1,
  map: null,
  clusterer: null,
  infoOverlay: null,
  markers: new Map(),
  districtOverlays: [],
  mapStage: '',
  toastTimer: null,
  isDragging: false
};

const elements = {
  baseTime: document.getElementById('baseTime'),
  dataMode: document.getElementById('dataMode'),
  refreshButton: document.getElementById('refreshButton'),
  search: document.getElementById('stationSearch'),
  suggestions: document.getElementById('searchSuggestions'),
  districtFilter: document.getElementById('districtFilter'),
  clearDistrict: document.getElementById('clearDistrict'),
  activeFilter: document.getElementById('activeFilter'),
  summaryScope: document.getElementById('summaryScope'),
  riskRows: document.getElementById('riskRows'),
  resultCount: document.getElementById('resultCount'),
  tableEmpty: document.getElementById('tableEmpty'),
  pageStatus: document.getElementById('pageStatus'),
  previousPage: document.getElementById('previousPage'),
  nextPage: document.getElementById('nextPage'),
  sortSelect: document.getElementById('sortSelect'),
  exportCsv: document.getElementById('exportCsv'),
  mapTitle: document.getElementById('mapTitle'),
  mapStatus: document.getElementById('mapStatus'),
  forecastNote: document.getElementById('forecastNote'),
  toast: document.getElementById('toast'),
  resizeHandle: document.getElementById('resizeHandle'),
  dashboardLayout: document.getElementById('dashboardLayout')
};

function stableSeed(stationId) {
  let seed = 0;
  for (const character of String(stationId)) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
  return seed;
}

function clampStock(value, capacity) {
  return Math.max(0, Math.min(capacity, Math.round(value)));
}

function stockValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function makeDemoForecast(stationId, now, capacity) {
  const seed = stableSeed(stationId);
  const firstShift = (seed % 13) - 6;
  const laterShift = ((seed >>> 4) % 15) - 7;
  return {
    h1: clampStock(now + firstShift, capacity),
    h3: clampStock(now + firstShift + laterShift, capacity)
  };
}

function toDashboardData(payload) {
  const rawStations = Array.isArray(payload.stations) ? payload.stations : [];
  const stations = rawStations.map((raw) => {
    const rawStock = raw.stock || {};
    const stationId = String(raw.stationId ?? raw.id ?? '');
    const stationName = String(raw.stationName ?? raw.name ?? '이름 없는 대여소');
    const rackTotCnt = Number(raw.rackTotCnt ?? raw.rackCount) || 0;
    const stockNow = stockValue(rawStock.now ?? raw.bikeCount);
    let stockH1 = stockValue(rawStock.h1);
    let stockH3 = stockValue(rawStock.h3);
    let generatedForecast = false;

    if (config.demoForecasts && rackTotCnt > 0 && stockNow !== null && (stockH1 === null || stockH3 === null)) {
      const demo = makeDemoForecast(stationId, stockNow, rackTotCnt);
      if (stockH1 === null) stockH1 = demo.h1;
      if (stockH3 === null) stockH3 = demo.h3;
      generatedForecast = true;
    }

    return {
      stationId,
      stationName,
      gu: String(raw.gu ?? raw.district ?? ''),
      lat: Number(raw.lat ?? raw.latitude),
      lon: Number(raw.lon ?? raw.longitude),
      rackTotCnt,
      stock: { now: stockNow, h1: stockH1, h3: stockH3 },
      forecastSource: generatedForecast ? 'demo' : 'model',
      extra: raw.extra || {}
    };
  }).filter((station) => station.stationId && Number.isFinite(station.lat) && Number.isFinite(station.lon));

  return {
    baseTime: payload.baseTime || (payload.fetchedAt ? new Date(payload.fetchedAt * 1000).toISOString() : new Date().toISOString()),
    source: payload.source || 'live',
    stations
  };
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '시각 정보 없음';
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

function riskAt(station, horizon) {
  const stock = station.stock[horizon];
  const capacity = station.rackTotCnt;
  if (!Number.isFinite(stock) || capacity <= 0) return { type: 'unknown', stock: null, units: 0 };

  const rate = stock / capacity;
  if (rate <= config.thresholds.shortageRate) {
    return {
      type: 'shortage',
      stock,
      units: Math.max(0, Math.ceil(capacity * config.thresholds.targetRate) - stock)
    };
  }
  if (rate >= config.thresholds.surplusRate) {
    return {
      type: 'surplus',
      stock,
      units: Math.max(0, stock - Math.floor(capacity * config.thresholds.targetRate))
    };
  }
  return { type: 'normal', stock, units: 0 };
}

function stationMatchesRisk(station) {
  if (state.risk === 'all') return true;
  return horizons.some(({ key }) => riskAt(station, key).type === state.risk);
}

function filteredStations() {
  return state.allStations.filter((station) => {
    const districtMatch = !state.district || station.gu === state.district;
    return districtMatch && stationMatchesRisk(station);
  });
}

function stationsForSummary() {
  return state.allStations.filter((station) => !state.district || station.gu === state.district);
}

function statusText(risk, riskMode) {
  if (risk.type === 'unknown') return '예측 없음';
  if (risk.type === 'shortage') return `부족 −${risk.units}`;
  if (risk.type === 'surplus') return `과잉 +${risk.units}`;
  return riskMode === 'all' ? '안정' : '정상';
}

function statusClass(risk) {
  return risk.type === 'shortage' ? 'shortage' : risk.type === 'surplus' ? 'surplus' : risk.type;
}

function relevantRisk(risk) {
  if (state.risk === 'shortage') return risk.type === 'shortage';
  if (state.risk === 'surplus') return risk.type === 'surplus';
  return risk.type === 'shortage' || risk.type === 'surplus';
}

function sortValue(station, key) {
  if (key === 'stationName') return station.stationName;
  const horizon = key === 'shortageNow' ? 'now' : key === 'shortageH1' ? 'h1' : 'h3';
  const risk = riskAt(station, horizon);
  if (key === 'surplusH3') return risk.type === 'surplus' ? risk.units : -1;
  return risk.type === 'shortage' ? risk.units : -1;
}

function sortedRows() {
  const rows = filteredStations();
  const isNameSort = state.sort === 'stationName';
  rows.sort((left, right) => {
    const a = sortValue(left, state.sort);
    const b = sortValue(right, state.sort);
    if (isNameSort) return String(a).localeCompare(String(b), 'ko-KR');
    return b - a || left.stationName.localeCompare(right.stationName, 'ko-KR');
  });
  return rows;
}

function setSelectedRisk(risk) {
  state.risk = risk;
  state.page = 1;
  document.querySelectorAll('[data-risk]').forEach((button) => {
    button.classList.toggle('active', button.dataset.risk === risk);
  });
  renderDashboard();
}

function updateDataStatus() {
  const demo = state.demoForecasts;
  elements.dataMode.textContent = state.source === 'sample' ? '샘플 재고' : '실시간 재고';
  elements.dataMode.classList.toggle('demo', demo || state.source === 'sample');
  elements.forecastNote.textContent = demo ? '예측: 데모 시뮬레이션' : '예측: 모델 연동';
  elements.forecastNote.classList.toggle('forecast-note', demo);
  elements.baseTime.textContent = `${formatTime(state.baseTime)} 기준`;
}

function fillDistrictSelect() {
  const districts = [...new Set(state.allStations.map((station) => station.gu).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko-KR'));
  elements.districtFilter.replaceChildren(new Option('전체 자치구', ''));
  for (const district of districts) elements.districtFilter.add(new Option(district, district));
}

function updateFilterSummary() {
  const scopeStations = stationsForSummary();
  elements.summaryScope.textContent = state.district || '서울 전체';
  for (const { key } of horizons) {
    let shortageCount = 0;
    let shortageUnits = 0;
    let surplusCount = 0;
    let surplusUnits = 0;
    let unknownCount = 0;
    for (const station of scopeStations) {
      const risk = riskAt(station, key);
      if (risk.type === 'shortage') { shortageCount += 1; shortageUnits += risk.units; }
      else if (risk.type === 'surplus') { surplusCount += 1; surplusUnits += risk.units; }
      else if (risk.type === 'unknown') unknownCount += 1;
    }

    const cell = document.querySelector(`[data-summary="${key}"]`);
    const count = cell.querySelector('.summary-count');
    const units = cell.querySelector('.summary-units');
    cell.classList.toggle('surplus', state.risk === 'surplus');
    cell.classList.toggle('all', state.risk === 'all');
    if (state.risk === 'shortage') {
      count.textContent = `${shortageCount.toLocaleString('ko-KR')}곳`;
      units.textContent = `부족 −${shortageUnits.toLocaleString('ko-KR')}대`;
    } else if (state.risk === 'surplus') {
      count.textContent = `${surplusCount.toLocaleString('ko-KR')}곳`;
      units.textContent = `과잉 +${surplusUnits.toLocaleString('ko-KR')}대`;
    } else {
      count.textContent = `${shortageCount.toLocaleString('ko-KR')} / ${surplusCount.toLocaleString('ko-KR')}`;
      units.textContent = `부족 ${shortageUnits.toLocaleString('ko-KR')}대 · 과잉 ${surplusUnits.toLocaleString('ko-KR')}대`;
    }
    if (unknownCount && state.risk === 'all') units.title = `예측 없음 ${unknownCount.toLocaleString('ko-KR')}곳`;
  }
}

function createStockCell(station, horizon) {
  const risk = riskAt(station, horizon);
  const cell = document.createElement('td');
  if (risk.type === 'shortage') cell.className = 'cell-shortage';
  if (risk.type === 'surplus') cell.className = 'cell-surplus';
  const wrapper = document.createElement('div');
  wrapper.className = 'stock-cell';
  const stock = document.createElement('span');
  stock.textContent = risk.stock === null ? '—' : `${risk.stock}대`;
  const status = document.createElement('span');
  status.className = `status ${statusClass(risk)}`;
  status.textContent = statusText(risk, state.risk);
  wrapper.append(stock, status);
  cell.append(wrapper);
  return cell;
}

function selectStation(station, options = {}) {
  const { focusMap = true, openInfo = true, marker: suppliedMarker = null } = options;
  if (!stationMatchesRisk(station)) {
    state.risk = 'all';
    document.querySelector('[data-risk="all"]').classList.add('active');
    document.querySelectorAll('[data-risk]:not([data-risk="all"])').forEach((button) => button.classList.remove('active'));
    showToast('위험 유형 필터를 전체로 바꿔 대여소를 표시했습니다.');
  }
  if (state.district && state.district !== station.gu) {
    state.district = station.gu;
    elements.districtFilter.value = station.gu;
  }
  state.selectedStationId = station.stationId;
  state.page = Math.max(1, Math.ceil((sortedRows().findIndex((item) => item.stationId === station.stationId) + 1) / config.pageSize));
  renderDashboard();
  renderSelectedStation(station);

  if (focusMap) {
    const position = new kakao.maps.LatLng(station.lat, station.lon);
    state.map.setLevel(5);
    state.map.panTo(position);
    document.getElementById('mapTitle').textContent = `${station.gu} · ${station.stationName}`;
  }
  if (openInfo) {
    const marker = suppliedMarker || getMarker(station);
    marker.setMap(state.map);
    openStationInfo(station, marker);
  }
  requestAnimationFrame(() => {
    const row = document.querySelector(`[data-station-id="${CSS.escape(station.stationId)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  });
}

function renderSelectedStation(station) {
  const content = document.createElement('div');
  content.className = 'map-info';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'map-info-close';
  closeButton.setAttribute('aria-label', '닫기');
  closeButton.textContent = '×';
  closeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    closeStationInfo();
  });
  content.append(
    closeButton,
    textNode('strong', station.stationName),
    textNode('span', `${station.gu} · ${station.rackTotCnt} 거치대`),
    textNode('span', `현재 ${formatStock(station.stock.now)} · +1h ${formatStock(station.stock.h1)} · +3h ${formatStock(station.stock.h3)}`)
  );
  return content;
}

function textNode(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function formatStock(value) {
  return Number.isFinite(value) ? `${value}대` : '예측 없음';
}

function openStationInfo(station, marker) {
  state.infoOverlay.setMap(null);
  state.infoOverlay.setContent(renderSelectedStation(station));
  state.infoOverlay.setPosition(marker.getPosition());
  state.infoOverlay.setMap(state.map);
}

function closeStationInfo() {
  state.infoOverlay.setMap(null);
}

function renderRows() {
  const rows = sortedRows();
  const totalPages = Math.max(1, Math.ceil(rows.length / config.pageSize));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * config.pageSize;
  const pageRows = rows.slice(start, start + config.pageSize);
  const fragment = document.createDocumentFragment();

  for (const station of pageRows) {
    const row = document.createElement('tr');
    row.tabIndex = 0;
    row.dataset.stationId = station.stationId;
    row.classList.toggle('selected', station.stationId === state.selectedStationId);
    const nameCell = document.createElement('td');
    nameCell.className = 'station-cell';
    const name = textNode('span', station.stationName);
    name.className = 'station-main';
    const district = textNode('span', `${station.gu || '자치구 미상'} · ${station.stationId}`);
    district.className = 'station-sub';
    nameCell.append(name, district);
    row.append(nameCell);
    for (const { key } of horizons) row.append(createStockCell(station, key));
    row.addEventListener('click', () => selectStation(station));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectStation(station); }
    });
    fragment.append(row);
  }

  elements.riskRows.replaceChildren(fragment);
  elements.tableEmpty.hidden = rows.length > 0;
  elements.resultCount.textContent = `${rows.length.toLocaleString('ko-KR')}곳`;
  elements.pageStatus.textContent = rows.length
    ? `${(start + 1).toLocaleString('ko-KR')}–${Math.min(start + config.pageSize, rows.length).toLocaleString('ko-KR')} / ${rows.length.toLocaleString('ko-KR')}`
    : '0 / 0';
  elements.previousPage.disabled = state.page <= 1;
  elements.nextPage.disabled = state.page >= totalPages;
}

function renderDashboard() {
  updateFilterSummary();
  renderRows();
  updateActiveFilter();
  if (state.map) renderMapLayers();
}

function updateActiveFilter() {
  elements.clearDistrict.hidden = !state.district;
  elements.activeFilter.hidden = !state.district;
  elements.activeFilter.textContent = state.district ? `자치구: ${state.district}` : '';
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 2600);
}

function currentMapStations() {
  return filteredStations();
}

function removeDistrictOverlays() {
  for (const overlay of state.districtOverlays) overlay.setMap(null);
  state.districtOverlays = [];
}

function stationGroups(stations) {
  const groups = new Map();
  for (const station of stations) {
    if (!groups.has(station.gu || '기타')) groups.set(station.gu || '기타', []);
    groups.get(station.gu || '기타').push(station);
  }
  return groups;
}

function districtRisk(stations) {
  const shortage = stations.reduce((sum, station) => sum + Number(riskAt(station, state.horizon).type === 'shortage'), 0);
  const surplus = stations.reduce((sum, station) => sum + Number(riskAt(station, state.horizon).type === 'surplus'), 0);
  const shortageUnits = stations.reduce((sum, station) => {
    const risk = riskAt(station, state.horizon);
    return sum + (risk.type === 'shortage' ? risk.units : 0);
  }, 0);
  const surplusUnits = stations.reduce((sum, station) => {
    const risk = riskAt(station, state.horizon);
    return sum + (risk.type === 'surplus' ? risk.units : 0);
  }, 0);
  const selectedCount = state.risk === 'surplus' ? surplus : state.risk === 'all' ? shortage + surplus : shortage;
  const selectedUnits = state.risk === 'surplus' ? surplusUnits : state.risk === 'all' ? shortageUnits + surplusUnits : shortageUnits;
  return { shortage, surplus, shortageUnits, surplusUnits, selectedCount, selectedUnits };
}

function makeDistrictBubble(district, stations) {
  const metrics = districtRisk(stations);
  const content = document.createElement('button');
  content.type = 'button';
  content.className = `district-bubble ${state.risk === 'surplus' ? 'surplus' : metrics.selectedCount ? 'shortage' : 'normal'}`;
  content.style.width = `${Math.min(142, 82 + metrics.selectedCount * 1.4)}px`;
  content.style.minHeight = `${Math.min(82, 58 + metrics.selectedCount * 0.35)}px`;
  content.append(textNode('strong', district));
  const subline = state.risk === 'surplus'
    ? `과잉 ${metrics.surplus}곳 / +${metrics.surplusUnits}대`
    : state.risk === 'all'
      ? `부족 ${metrics.shortage} · 과잉 ${metrics.surplus}`
      : `부족 ${metrics.shortage}곳 / −${metrics.shortageUnits}대`;
  content.append(textNode('span', subline));
  content.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    kakao.maps.event.preventMap();
    state.district = district;
    elements.districtFilter.value = district;
    state.page = 1;
    renderDashboard();
    focusDistrict(district);
  });
  const center = stations.reduce((acc, station) => ({ lat: acc.lat + station.lat, lon: acc.lon + station.lon }), { lat: 0, lon: 0 });
  return new kakao.maps.CustomOverlay({
    map: state.map,
    position: new kakao.maps.LatLng(center.lat / stations.length, center.lon / stations.length),
    content,
    yAnchor: 0.5,
    zIndex: 4
  });
}

function mapStage() {
  const level = state.map.getLevel();
  if (level >= config.map.districtBubbleLevel) return 'district';
  if (level >= config.map.clusterLevel) return 'cluster';
  return 'station';
}

function markerImageFor(station) {
  const risk = riskAt(station, state.horizon);
  const color = risk.type === 'shortage' ? '#c74735' : risk.type === 'surplus' ? '#2768a6' : '#52655a';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36"><path d="M14 1C6.82 1 1 6.82 1 14c0 9.5 13 21 13 21s13-11.5 13-21C27 6.82 21.18 1 14 1Z" fill="${color}" stroke="white" stroke-width="2"/><circle cx="14" cy="14" r="4" fill="white"/></svg>`;
  return new kakao.maps.MarkerImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, new kakao.maps.Size(28, 36), {
    offset: new kakao.maps.Point(14, 36)
  });
}

function getMarker(station) {
  let marker = state.markers.get(station.stationId);
  if (!marker) {
    marker = new kakao.maps.Marker({
      position: new kakao.maps.LatLng(station.lat, station.lon),
      title: station.stationName,
      image: markerImageFor(station),
      clickable: true
    });
    kakao.maps.event.addListener(marker, 'click', () => {
      const currentStation = state.allStations.find((item) => item.stationId === station.stationId) || station;
      selectStation(currentStation, { focusMap: false, openInfo: true, marker });
    });
    state.markers.set(station.stationId, marker);
  } else {
    marker.setPosition(new kakao.maps.LatLng(station.lat, station.lon));
    marker.setImage(markerImageFor(station));
  }
  return marker;
}

function updateVisibleStationMarkers(stations = currentMapStations()) {
  const bounds = state.map.getBounds();
  const padLat = 0.012;
  const padLon = 0.018;
  const southWest = bounds.getSouthWest();
  const northEast = bounds.getNorthEast();
  const visible = [];

  for (const station of stations) {
    const inside = station.lat >= southWest.getLat() - padLat && station.lat <= northEast.getLat() + padLat
      && station.lon >= southWest.getLng() - padLon && station.lon <= northEast.getLng() + padLon;
    let marker = state.markers.get(station.stationId);
    if (!inside) {
      if (marker) marker.setMap(null);
      continue;
    }
    marker = getMarker(station);
    marker.setMap(state.map);
    visible.push(marker);
  }
  return visible;
}

function renderMapLayers() {
  if (!state.map || !state.clusterer) return;
  const stage = mapStage();
  const stations = currentMapStations();
  removeDistrictOverlays();
  state.clusterer.clear();

  for (const marker of state.markers.values()) marker.setMap(null);
  state.mapStage = stage;

  if (stage === 'district') {
    for (const [district, group] of stationGroups(stations)) {
      if (group.length) state.districtOverlays.push(makeDistrictBubble(district, group));
    }
    elements.mapStatus.textContent = `${state.district ? '자치구 범위' : '서울 전체'} · 자치구별 위험`;
    return;
  }

  if (stage === 'cluster') {
    const markers = stations.map(getMarker);
    state.clusterer.addMarkers(markers);
    elements.mapStatus.textContent = `${stations.length.toLocaleString('ko-KR')}개 대여소 · 클러스터 보기`;
    return;
  }

  const visibleMarkers = updateVisibleStationMarkers(stations);
  elements.mapStatus.textContent = `${visibleMarkers.length.toLocaleString('ko-KR')}개 대여소 · 현재 화면`;
}

function refreshPointVisibility() {
  if (state.mapStage === 'station') {
    const visible = updateVisibleStationMarkers();
    elements.mapStatus.textContent = `${visible.length.toLocaleString('ko-KR')}개 대여소 · 현재 화면`;
  }
}

function focusDistrict(district) {
  const stations = state.allStations.filter((station) => station.gu === district);
  if (!stations.length) return;
  const bounds = new kakao.maps.LatLngBounds();
  stations.forEach((station) => bounds.extend(new kakao.maps.LatLng(station.lat, station.lon)));
  state.map.setBounds(bounds, 70, 60, 70, 60);
  document.getElementById('mapTitle').textContent = district;
}

function focusStation(station) {
  if (!rowIsIncluded(station)) {
    state.risk = 'all';
    document.querySelector('[data-risk="all"]').classList.add('active');
    document.querySelectorAll('[data-risk]:not([data-risk="all"])').forEach((button) => button.classList.remove('active'));
    showToast('현재 필터에 포함되지 않아 위험 유형을 전체로 변경했습니다.');
  }
  if (state.district && state.district !== station.gu) {
    state.district = station.gu;
    elements.districtFilter.value = station.gu;
  }
  state.selectedStationId = station.stationId;
  const rows = sortedRows();
  const index = rows.findIndex((item) => item.stationId === station.stationId);
  state.page = index >= 0 ? Math.floor(index / config.pageSize) + 1 : 1;
  renderDashboard();
  document.getElementById('mapTitle').textContent = `${station.gu} · ${station.stationName}`;
  state.map.setLevel(5);
  state.map.panTo(new kakao.maps.LatLng(station.lat, station.lon));
  requestAnimationFrame(() => {
    document.querySelector(`[data-station-id="${CSS.escape(station.stationId)}"]`)?.scrollIntoView({ block: 'nearest' });
  });
}

function rowIsIncluded(station) {
  return stationMatchesRisk(station);
}

function stationMatchesRisk(station) {
  return state.risk === 'all' || horizons.some(({ key }) => riskAt(station, key).type === state.risk);
}

function showSuggestions(query) {
  const normalized = query.trim().toLocaleLowerCase('ko-KR');
  state.suggestions = [];
  state.activeSuggestion = -1;
  elements.suggestions.replaceChildren();
  if (!normalized) { closeSuggestions(); return; }

  const districts = [...new Set(state.allStations.map((station) => station.gu).filter(Boolean))]
    .filter((district) => district.toLocaleLowerCase('ko-KR').includes(normalized))
    .slice(0, 3)
    .map((gu) => ({ kind: 'district', gu, label: gu, meta: '자치구로 이동' }));
  const stationResults = state.allStations
    .filter((station) => `${station.stationName} ${station.stationId} ${station.gu}`.toLocaleLowerCase('ko-KR').includes(normalized))
    .slice(0, Math.max(0, 10 - districts.length))
    .map((station) => ({ kind: 'station', station, label: station.stationName, meta: `${station.gu} · ${station.stationId}` }));
  state.suggestions = [...districts, ...stationResults];

  if (!state.suggestions.length) {
    const empty = textNode('div', '검색 결과가 없습니다.');
    empty.className = 'suggestion-empty';
    elements.suggestions.append(empty);
  } else {
    const districtMatches = state.suggestions.filter((item) => item.kind === 'district');
    const stationMatches = state.suggestions.filter((item) => item.kind === 'station');
    if (districtMatches.length) appendSuggestionGroup('자치구', districtMatches);
    if (stationMatches.length) appendSuggestionGroup('대여소', stationMatches);
  }
  elements.suggestions.hidden = false;
  elements.search.setAttribute('aria-expanded', 'true');
}

function appendSuggestionGroup(label, items) {
  const groupLabel = textNode('div', label);
  groupLabel.className = 'suggestion-group-label';
  elements.suggestions.append(groupLabel);
  for (const item of items) {
    const index = state.suggestions.indexOf(item);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion-item';
    button.setAttribute('role', 'option');
    button.dataset.suggestionIndex = String(index);
    const copy = document.createElement('span');
    copy.className = 'suggestion-copy';
    const name = textNode('span', item.label);
    name.className = 'suggestion-name';
    const meta = textNode('span', item.meta);
    meta.className = 'suggestion-meta';
    const kind = textNode('span', item.kind === 'district' ? '구 이동' : '대여소');
    kind.className = 'suggestion-kind';
    copy.append(name, meta);
    button.append(copy, kind);
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => chooseSuggestion(index));
    elements.suggestions.append(button);
  }
}

function closeSuggestions() {
  elements.suggestions.hidden = true;
  elements.search.setAttribute('aria-expanded', 'false');
  state.activeSuggestion = -1;
}

function highlightSuggestion(index) {
  const buttons = [...elements.suggestions.querySelectorAll('.suggestion-item')];
  if (!buttons.length) return;
  state.activeSuggestion = (index + buttons.length) % buttons.length;
  buttons.forEach((button, buttonIndex) => {
    button.classList.toggle('active', buttonIndex === state.activeSuggestion);
    button.setAttribute('aria-selected', String(buttonIndex === state.activeSuggestion));
  });
  buttons[state.activeSuggestion].scrollIntoView({ block: 'nearest' });
}

function chooseSuggestion(index) {
  const item = state.suggestions[index];
  if (!item) return;
  closeSuggestions();
  if (item.kind === 'district') {
    state.district = item.gu;
    elements.districtFilter.value = item.gu;
    state.page = 1;
    renderDashboard();
    focusDistrict(item.gu);
    return;
  }
  elements.search.value = item.station.stationName;
  focusStation(item.station);
}

function buildCsv(rows) {
  const columns = [
    ['stationId', '대여소ID'], ['stationName', '대여소명'], ['gu', '자치구'], ['rackTotCnt', '거치대수'],
    ['now', '현재재고'], ['nowRisk', '현재위험'], ['h1', '+1시간재고'], ['h1Risk', '+1시간위험'],
    ['h3', '+3시간재고'], ['h3Risk', '+3시간위험'], ['lat', '위도'], ['lon', '경도']
  ];
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [columns.map(([, label]) => escape(label)).join(',')];
  for (const station of rows) {
    const record = {
      stationId: station.stationId, stationName: station.stationName, gu: station.gu, rackTotCnt: station.rackTotCnt,
      now: station.stock.now, nowRisk: statusText(riskAt(station, 'now'), state.risk),
      h1: station.stock.h1, h1Risk: statusText(riskAt(station, 'h1'), state.risk),
      h3: station.stock.h3, h3Risk: statusText(riskAt(station, 'h3'), state.risk), lat: station.lat, lon: station.lon
    };
    lines.push(columns.map(([key]) => escape(record[key])).join(','));
  }
  return `\ufeff${lines.join('\r\n')}`;
}

function exportCsv() {
  const blob = new Blob([buildCsv(sortedRows())], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `bikebike-risk-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function setupResizeHandle() {
  const handle = document.getElementById('resizeHandle');
  const move = (event) => {
    if (!state.isDragging) return;
    const width = Math.min(window.innerWidth * 0.55, Math.max(390, window.innerWidth - event.clientX));
    elements.dashboardLayout.style.setProperty('--panel-width', `${width}px`);
    state.map?.relayout();
  };
  const stop = () => {
    if (!state.isDragging) return;
    state.isDragging = false;
    document.body.classList.remove('resizing');
    state.map?.relayout();
  };
  handle.addEventListener('pointerdown', (event) => {
    state.isDragging = true;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
  });
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const current = elements.dashboardLayout.getBoundingClientRect().width * 0.36;
    const adjustment = event.key === 'ArrowLeft' ? 24 : -24;
    const width = Math.min(window.innerWidth * 0.55, Math.max(390, current + adjustment));
    elements.dashboardLayout.style.setProperty('--panel-width', `${width}px`);
    state.map?.relayout();
  });
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 2600);
}

async function loadData() {
  elements.refreshButton.disabled = true;
  elements.refreshButton.classList.add('loading');
  try {
    const response = await fetch(config.apiEndpoint, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '대여소 데이터를 불러오지 못했습니다.');
    const dashboardData = toDashboardData(payload);
    state.allStations = dashboardData.stations;
    state.baseTime = dashboardData.baseTime;
    state.source = dashboardData.source;
    state.demoForecasts = config.demoForecasts && state.allStations.some((station) => station.forecastSource === 'demo');
    fillDistrictSelect();
    updateDataStatus();
    renderDashboard();
    if (state.map && state.allStations.length) {
      const bounds = new kakao.maps.LatLngBounds();
      state.allStations.forEach((station) => bounds.extend(new kakao.maps.LatLng(station.lat, station.lon)));
      state.map.setBounds(bounds, 40, 40, 40, 40);
      document.getElementById('mapTitle').textContent = '서울 전체';
    }
    elements.mapStatus.textContent = `${state.allStations.length.toLocaleString('ko-KR')}개 대여소 데이터`;
  } catch (error) {
    elements.dataMode.textContent = '연결 오류';
    elements.dataMode.classList.add('demo');
    elements.baseTime.textContent = '기준 시각 없음';
    elements.riskRows.replaceChildren();
    elements.resultCount.textContent = '데이터를 불러오지 못했습니다';
    elements.tableEmpty.textContent = error.message;
    elements.tableEmpty.hidden = false;
    elements.mapStatus.textContent = '데이터를 불러오지 못했습니다';
  } finally {
    elements.refreshButton.disabled = false;
    elements.refreshButton.classList.remove('loading');
  }
}

function setupMap() {
  state.map = new kakao.maps.Map(document.getElementById('map'), {
    center: new kakao.maps.LatLng(37.5665, 126.9780),
    level: 9
  });
  state.clusterer = new kakao.maps.MarkerClusterer({
    map: state.map,
    averageCenter: true,
    minLevel: config.map.clusterLevel,
    gridSize: 55,
    styles: [{
      width: '40px', height: '40px', borderRadius: '50%',
      background: '#43594d', color: '#fff', textAlign: 'center', lineHeight: '40px',
      fontFamily: 'DM Mono, monospace', fontSize: '11px', border: '2px solid #fff', boxShadow: '0 2px 8px #15221b4d'
    }]
  });
  state.infoOverlay = new kakao.maps.CustomOverlay({
    position: state.map.getCenter(),
    content: document.createElement('div'),
    xAnchor: 0.5,
    yAnchor: 1,
    zIndex: 10,
    clickable: true
  });
  kakao.maps.event.addListener(state.map, 'click', closeStationInfo);
  kakao.maps.event.addListener(state.map, 'zoom_changed', renderMapLayers);
  kakao.maps.event.addListener(state.map, 'idle', refreshPointVisibility);
  window.addEventListener('resize', () => state.map.relayout());
}

function bindControls() {
  elements.refreshButton.addEventListener('click', loadData);
  elements.exportCsv.addEventListener('click', exportCsv);
  elements.districtFilter.addEventListener('change', () => {
    state.district = elements.districtFilter.value;
    state.page = 1;
    renderDashboard();
    if (state.district) focusDistrict(state.district);
  });
  elements.clearDistrict.addEventListener('click', () => {
    state.district = '';
    elements.districtFilter.value = '';
    state.page = 1;
    renderDashboard();
  });
  document.querySelectorAll('[data-risk]').forEach((button) => {
    button.addEventListener('click', () => {
      state.risk = button.dataset.risk;
      state.page = 1;
      document.querySelectorAll('[data-risk]').forEach((item) => item.classList.toggle('active', item === button));
      renderDashboard();
    });
  });
  document.querySelectorAll('[data-horizon]').forEach((button) => {
    button.addEventListener('click', () => {
      state.horizon = button.dataset.horizon;
      document.querySelectorAll('[data-horizon]').forEach((item) => item.classList.toggle('active', item === button));
      renderMapLayers();
    });
  });
  elements.sortSelect.addEventListener('change', () => {
    state.sort = elements.sortSelect.value;
    state.page = 1;
    renderRows();
  });
  document.querySelectorAll('[data-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      state.sort = button.dataset.sort === 'now' ? 'shortageNow' : button.dataset.sort === 'h1' ? 'shortageH1' : 'shortageH3';
      elements.sortSelect.value = state.sort;
      state.page = 1;
      renderRows();
    });
  });
  elements.previousPage.addEventListener('click', () => { state.page -= 1; renderRows(); });
  elements.nextPage.addEventListener('click', () => { state.page += 1; renderRows(); });

  elements.search.addEventListener('input', () => showSuggestions(elements.search.value));
  elements.search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && !elements.suggestions.hidden) {
      event.preventDefault();
      highlightSuggestion(state.activeSuggestion + 1);
    } else if (event.key === 'ArrowUp' && !elements.suggestions.hidden) {
      event.preventDefault();
      highlightSuggestion(state.activeSuggestion - 1);
    } else if (event.key === 'Enter' && !elements.suggestions.hidden && state.activeSuggestion >= 0) {
      event.preventDefault();
      chooseSuggestion(state.activeSuggestion);
    } else if (event.key === 'Escape') closeSuggestions();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#searchWrap')) closeSuggestions();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      elements.search.focus();
    }
  });
  setupResizeHandle();
}

function boot() {
  bindControls();
  setupMap();
  loadData();
  window.setInterval(() => {
    if (!document.hidden) loadData();
  }, config.refreshIntervalMs);
}

if (window.kakao && window.kakao.maps) {
  kakao.maps.load(boot);
} else {
  elements.mapStatus.textContent = '카카오 개발자 콘솔에서 현재 도메인의 JavaScript 허용 설정을 확인해 주세요.';
  elements.dataMode.textContent = '지도 연결 오류';
}