const config = window.OPERATOR_CONFIG;
const SEOUL_COORDINATE_BOUNDS = Object.freeze({
  minLat: 37.4,
  maxLat: 37.75,
  minLon: 126.7,
  maxLon: 127.2
});
const horizons = [
  { key: 'now', label: '현재' },
  { key: 'h1', label: '+1시간' },
  { key: 'h2', label: '+2시간' },
  { key: 'h3', label: '+3시간' }
];
const state = {
  allStations: [],
  baseTime: null,
  fetchedAt: null,
  nextFetchAt: null,
  stale: false,
  staleReason: null,
  isLoading: false,
  source: 'live',
  demoForecasts: false,
  risk: 'shortage',
  district: '',
  horizon: 'now',
  sortKey: 'h3',
  sortDir: 'desc',
  page: 1,
  selectedStationId: '',
  suggestions: [],
  activeSuggestion: -1,
  map: null,
  clusterer: null,
  infoOverlay: null,
  districtLegend: null,
  districtLegendMaximum: null,
  markers: new Map(),
  districtOverlays: [],
  mapStage: '',
  toastTimer: null,
  isDragging: false
};

const elements = {
  baseTime: document.getElementById('baseTime'),
  dataMode: document.getElementById('dataMode'),
  dataFreshness: document.getElementById('dataFreshness'),
  refreshButton: document.getElementById('refreshButton'),
  refreshCountdown: document.getElementById('refreshCountdown'),
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

function stockValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function flowValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function makeDemoFlow(stationId, rackTotCnt, stockNow) {
  const seed = stableSeed(stationId);
  const rackScale = Math.max(0, rackTotCnt);
  const flow = {};
  const volume = {};
  const intervals = ['h1', 'h2', 'h3'];
  intervals.forEach((key, index) => {
    const intervalSeed = (seed + Math.imul(index + 1, 0x9e3779b1) + Math.round(stockNow || 0)) >>> 0;
    const sizeRatio = 0.1 + (intervalSeed % 501) / 1000;
    const variation = 0.8 + ((intervalSeed >>> 9) % 401) / 1000;
    const intervalVolume = Math.round(rackScale * sizeRatio * variation);
    const rentalShare = 0.2 + ((intervalSeed >>> 18) % 601) / 1000;
    const rentals = Math.round(intervalVolume * rentalShare);
    volume[key] = intervalVolume;
    flow[key] = intervalVolume - 2 * rentals;
  });
  return { flow, volume };
}

function warnInvalidFlowData(stations) {
  const invalidStations = stations.filter((station) =>
    ['h1', 'h2', 'h3'].some((key) => {
      const flow = station.flow[key];
      const volume = station.volume[key];
      if (flow === null || volume === null) return false;
      return volume < 0
        || Math.abs(flow) > volume
        || Math.abs(flow) % 2 !== volume % 2;
    })
  );
  if (invalidStations.length) {
    console.warn('Flow/volume contract violation:', invalidStations.map((station) => station.stationId));
  }
}

function toDashboardData(payload) {
  const rawStations = Array.isArray(payload.stations) ? payload.stations : [];
  const stations = rawStations.map((raw) => {
    const rawStock = raw.stock || {};
    const rawFlow = raw.flow || {};
    const rawVolume = raw.volume || {};
    const stationId = String(raw.stationId ?? raw.id ?? '');
    const stationName = String(raw.stationName ?? raw.name ?? '이름 없는 대여소');
    const rackTotCnt = Number(raw.rackTotCnt ?? raw.rackCount) || 0;
    const stockNow = stockValue(rawStock.now ?? raw.bikeCount);
    let generatedForecast = false;
    const flow = {
      now: null,
      h1: flowValue(rawFlow.h1),
      h2: flowValue(rawFlow.h2),
      h3: flowValue(rawFlow.h3)
    };
    const volume = {
      now: null,
      h1: flowValue(rawVolume.h1),
      h2: flowValue(rawVolume.h2),
      h3: flowValue(rawVolume.h3)
    };
    if (config.demoForecasts) {
      const missingIntervals = ['h1', 'h2', 'h3'].some((key) => flow[key] === null && volume[key] === null);
      if (missingIntervals) {
        const demo = makeDemoFlow(stationId, rackTotCnt, stockNow);
        for (const key of ['h1', 'h2', 'h3']) {
          if (flow[key] === null && volume[key] === null) {
            flow[key] = demo.flow[key];
            volume[key] = demo.volume[key];
          }
        }
        generatedForecast = true;
      }
    }

    const stock = { now: stockNow };
    let previousStock = stockNow;
    for (const key of ['h1', 'h2', 'h3']) {
      const suppliedStock = stockValue(rawStock[key]);
      const calculatedStock = previousStock === null || flow[key] === null
        ? null
        : Math.max(0, previousStock + flow[key]);
      stock[key] = suppliedStock ?? calculatedStock;
      previousStock = stock[key];
    }

    return {
      stationId,
      stationName,
      gu: String(raw.gu ?? raw.district ?? ''),
      lat: Number(raw.lat ?? raw.latitude),
      lon: Number(raw.lon ?? raw.longitude),
      rackTotCnt,
      stock,
      flow,
      volume,
      forecastSource: generatedForecast ? 'demo' : 'model',
      extra: raw.extra || {}
    };
  }).filter((station) => station.stationId && Number.isFinite(station.lat) && Number.isFinite(station.lon));
  if (config.demoForecasts) warnInvalidFlowData(stations);

  return {
    baseTime: payload.baseTime || (payload.fetchedAt ? new Date(payload.fetchedAt * 1000).toISOString() : new Date().toISOString()),
    fetchedAt: Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : Date.now() / 1000,
    nextFetchAt: Number.isFinite(payload.nextFetchAt)
      ? payload.nextFetchAt
      : (Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : Date.now() / 1000) + config.refreshIntervalMs / 1000,
    source: payload.source || 'live',
    stale: payload.stale === true,
    staleReason: payload.staleReason || null,
    stations
  };
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '시각 정보 없음';
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
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

function compareStationNames(left, right) {
  return left.stationName.localeCompare(right.stationName, 'ko-KR', { numeric: true });
}

function sortedRows() {
  const rows = filteredStations();
  rows.sort((left, right) => {
    const nameOrder = compareStationNames(left, right);
    if (state.sortKey === 'stationName') return state.sortDir === 'asc' ? nameOrder : -nameOrder;
    const leftRisk = riskAt(left, state.sortKey);
    const rightRisk = riskAt(right, state.sortKey);
    const matchesSortRisk = (risk) => state.risk === 'all'
      ? risk.type === 'shortage' || risk.type === 'surplus'
      : risk.type === state.risk;
    const leftHasRisk = matchesSortRisk(leftRisk);
    const rightHasRisk = matchesSortRisk(rightRisk);
    if (leftHasRisk !== rightHasRisk) return leftHasRisk ? -1 : 1;
    if (!leftHasRisk) return nameOrder;
    const leftUnits = leftRisk.units;
    const rightUnits = rightRisk.units;
    const byUnits = state.sortDir === 'desc' ? rightUnits - leftUnits : leftUnits - rightUnits;
    return byUnits || nameOrder;
  });
  return rows;
}

function updateSortHeaders() {
  document.querySelectorAll('[data-sort]').forEach((button) => {
    const active = button.dataset.sort === state.sortKey;
    const th = button.closest('th');
    th.setAttribute('aria-sort', active ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    button.querySelectorAll('[data-sort-direction]').forEach((indicator) => {
      const isCurrentDirection = indicator.dataset.sortDirection === state.sortDir;
      indicator.classList.toggle('active', active && isCurrentDirection);
    });
  });
}

function sortBy(key) {
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortKey = key;
    state.sortDir = key === 'stationName' ? 'asc' : 'desc';
  }
  renderListForCriteriaChange(() => renderRows());
}

function renderListForCriteriaChange(render = renderDashboard) {
  const selectedId = state.selectedStationId;
  const rows = sortedRows();
  const selectedIndex = selectedId
    ? rows.findIndex((station) => station.stationId === selectedId)
    : -1;

  if (selectedIndex >= 0) {
    state.page = Math.floor(selectedIndex / config.pageSize) + 1;
  } else {
    if (selectedId) clearSelection();
    state.page = 1;
  }

  render();
  requestAnimationFrame(() => {
    const container = document.getElementById('tableScroll');
    if (!container) return;
    if (selectedIndex >= 0 && state.selectedStationId === selectedId) {
      centerSelectedRow(selectedId, 'map');
    } else {
      container.scrollTop = 0;
    }
  });
}

function setSelectedRisk(risk) {
  state.risk = risk;
  document.querySelectorAll('[data-risk]').forEach((button) => {
    button.classList.toggle('active', button.dataset.risk === risk);
  });
  renderListForCriteriaChange();
}

function updateDataStatus() {
  const demo = state.demoForecasts;
  elements.dataMode.textContent = state.source === 'sample' ? '샘플 재고' : '실시간 재고';
  elements.dataMode.classList.toggle('demo', demo || state.source === 'sample');
  elements.forecastNote.textContent = demo ? '예측: 데모 시뮬레이션' : '예측: 모델 연동';
  elements.forecastNote.classList.toggle('forecast-note', demo);
  updateDataAge();
}

function updateDataAge() {
  if (!Number.isFinite(state.fetchedAt)) return;
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000 - state.fetchedAt));
  const ageLabel = ageSeconds < 60 ? '방금' : `${Math.floor(ageSeconds / 60)}분 전`;
  const old = state.stale || ageSeconds > 600;
  const delayed = !old && ageSeconds > 300;
  const status = old ? '오래된 데이터' : delayed ? '지연' : '최신';
  const className = old ? 'old' : delayed ? 'delayed' : 'latest';
  const explanation = state.staleReason === 'quota' ? '호출 한도 보호'
    : state.staleReason === 'error' ? '조회 실패' : '';
  const tooltip = `서울시 원천 데이터는 최대 약 5분 늦게 반영될 수 있습니다.${state.stale && explanation ? ` (${explanation})` : ''}`;
  elements.baseTime.textContent = `${formatTime(state.fetchedAt * 1000)} 기준 · ${ageLabel}`;
  elements.baseTime.title = tooltip;
  elements.dataFreshness.textContent = status;
  elements.dataFreshness.className = `freshness-chip ${className}`;
  elements.dataFreshness.title = tooltip;
}

function updateRefreshButton() {
  const remaining = Number.isFinite(state.nextFetchAt)
    ? Math.max(0, Math.ceil(state.nextFetchAt - Date.now() / 1000))
    : 0;
  elements.refreshButton.disabled = state.isLoading || remaining > 0;
  elements.refreshCountdown.textContent = state.isLoading
    ? '조회 중'
    : remaining > 0
      ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} 후 가능`
      : '새로고침';
}

function fillDistrictSelect() {
  const districts = [...new Set(state.allStations.map((station) => station.gu).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko-KR'));
  elements.districtFilter.replaceChildren(new Option('전체 자치구', ''));
  for (const district of districts) elements.districtFilter.add(new Option(district, district));
}

function updateFilterSummary() {
  const scopeStations = stationsForSummary();
  const totalCount = scopeStations.length;
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
    count.replaceChildren();
    units.replaceChildren();
    const unknownTitle = unknownCount ? `예측 없음 ${unknownCount.toLocaleString('ko-KR')}곳` : '';
    cell.title = unknownTitle;
    units.title = unknownTitle;
    cell.classList.toggle('all', state.risk === 'all');

    const appendCountLine = (target, value, type, unitText = '(곳)') => {
      const line = document.createElement('span');
      line.className = `summary-risk-line ${type}`;
      const amount = textNode('span', value.toLocaleString('ko-KR'));
      amount.className = 'summary-risk-number';
      const denominator = textNode('span', `/ ${totalCount.toLocaleString('ko-KR')}`);
      denominator.className = 'summary-total';
      const unit = textNode('span', unitText);
      unit.className = 'summary-unit';
      line.append(amount, denominator, unit);
      target.append(line);
      return line;
    };

    if (state.risk === 'shortage') {
      appendCountLine(count, shortageCount, 'shortage');
      const amount = textNode('span', `−${shortageUnits.toLocaleString('ko-KR')}`);
      amount.className = 'summary-risk-number shortage';
      const unit = textNode('span', '(대)');
      unit.className = 'summary-unit';
      units.append(amount, unit);
    } else if (state.risk === 'surplus') {
      appendCountLine(count, surplusCount, 'surplus');
      const amount = textNode('span', `+${surplusUnits.toLocaleString('ko-KR')}`);
      amount.className = 'summary-risk-number surplus';
      const unit = textNode('span', '(대)');
      unit.className = 'summary-unit';
      units.append(amount, unit);
    } else {
      const shortageLine = appendCountLine(count, shortageCount, 'shortage');
      const shortageUnitsLabel = document.createElement('span');
      shortageUnitsLabel.className = 'summary-risk-total shortage';
      shortageUnitsLabel.append(
        textNode('span', `−${shortageUnits.toLocaleString('ko-KR')}`),
        textNode('span', '(대)')
      );
      shortageLine.append(shortageUnitsLabel);
      const surplusLine = appendCountLine(count, surplusCount, 'surplus');
      const surplusUnitsLabel = document.createElement('span');
      surplusUnitsLabel.className = 'summary-risk-total surplus';
      surplusUnitsLabel.append(
        textNode('span', `+${surplusUnits.toLocaleString('ko-KR')}`),
        textNode('span', '(대)')
      );
      surplusLine.append(surplusUnitsLabel);
    }
  }
}

function createStockCell(station, horizon) {
  const risk = riskAt(station, horizon);
  const cell = document.createElement('td');
  const type = risk.type === 'shortage' || risk.type === 'surplus' ? risk.type : 'normal';
  const target = Math.ceil(station.rackTotCnt * config.thresholds.targetRate);
  const overCapacity = Number.isFinite(risk.stock) && risk.stock > station.rackTotCnt;
  let description = risk.type === 'shortage'
    ? `현재 ${risk.stock}대 / 전체 거치대 ${station.rackTotCnt}대 · 목표 ${target}대 대비 ${risk.units}대 부족`
    : risk.type === 'surplus'
      ? `현재 ${risk.stock}대 / 전체 거치대 ${station.rackTotCnt}대 · 목표 ${target}대 대비 ${risk.units}대 과잉`
      : risk.type === 'normal' ? '정상 범위' : '예측 없음';
  if (overCapacity) description += ' · 재고가 거치대 수를 초과했습니다(거치대 외 주차이거나 거치대 수 정보 확인 필요)';
  cell.title = description;
  cell.setAttribute('aria-label', description);

  const wrapper = document.createElement('div');
  wrapper.className = 'stock-cell';
  const status = textNode('span', risk.type === 'shortage'
    ? `부족 −${risk.units.toLocaleString('ko-KR')}`
    : risk.type === 'surplus'
      ? `과잉 +${risk.units.toLocaleString('ko-KR')}`
      : risk.type === 'normal' ? '정상' : '—');
  status.className = `stock-primary ${type}`;

  const details = document.createElement('span');
  details.className = 'stock-details';
  const stock = textNode('span', Number.isFinite(risk.stock) ? risk.stock.toLocaleString('ko-KR') : '—');
  stock.className = `stock-value ${risk.type === 'shortage' || risk.type === 'surplus' ? risk.type : 'normal'}`;
  const divider = textNode('span', `/ ${station.rackTotCnt.toLocaleString('ko-KR')}`);
  divider.className = 'stock-capacity';
  const unit = textNode('span', '(대)');
  unit.className = 'stock-unit';
  details.append(stock, divider, unit);
  wrapper.append(status, details);
  cell.append(wrapper);
  return cell;
}

function centerSelectedRow(stationId, source) {
  const container = document.getElementById('tableScroll');
  const row = container?.querySelector(`[data-station-id="${CSS.escape(stationId)}"]`);
  if (!container || !row) return;

  const containerRect = container.getBoundingClientRect();
  const headerHeight = container.querySelector('thead')?.getBoundingClientRect().height || 0;
  const visibleTop = containerRect.top + container.clientTop + headerHeight;
  const visibleBottom = containerRect.top + container.clientTop + container.clientHeight;
  const rowRect = row.getBoundingClientRect();
  if (source === 'row' && rowRect.top >= visibleTop && rowRect.bottom <= visibleBottom) return;

  const visibleCenter = visibleTop + (visibleBottom - visibleTop) / 2;
  const rowCenter = rowRect.top + rowRect.height / 2;
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const scrollTop = Math.min(maxScrollTop, Math.max(0, container.scrollTop + rowCenter - visibleCenter));
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    container.scrollTop = scrollTop;
  } else {
    container.scrollTo({ top: scrollTop, behavior: 'smooth' });
  }
}

function selectStation(station, options = {}) {
  const { focusMap = true, openInfo = true, marker: suppliedMarker = null, source = 'map' } = options;
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
  syncSelectedMarker();
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
  requestAnimationFrame(() => centerSelectedRow(station.stationId, source));
}

function renderSelectedStation(station) {
  const content = document.createElement('div');
  content.className = 'map-info';
  content.addEventListener('click', (event) => {
    event.stopPropagation();
    kakao.maps.event.preventMap();
  });
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'map-info-close';
  closeButton.setAttribute('aria-label', '닫기');
  closeButton.textContent = '×';
  closeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    kakao.maps.event.preventMap();
    clearSelection();
  });
  content.append(
    closeButton,
    textNode('strong', station.stationName),
    textNode('span', `${station.gu} · ${station.rackTotCnt} 거치대`),
    textNode('span', `현재 ${formatStock(station.stock.now)} · +1h ${formatStock(station.stock.h1)} · +2h ${formatStock(station.stock.h2)} · +3h ${formatStock(station.stock.h3)}`)
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
  const content = renderSelectedStation(station);
  state.infoOverlay.setMap(null);
  state.infoOverlay.setContent(content);
  state.infoOverlay.setPosition(marker.getPosition());
  state.infoOverlay.setMap(state.map);
  content.style.pointerEvents = 'auto';
  if (content.parentNode instanceof HTMLElement) {
    content.parentNode.style.pointerEvents = 'none';
  }
}

function closeStationInfo() {
  state.infoOverlay.setMap(null);
}

function clearSelection() {
  state.selectedStationId = '';
  closeStationInfo();
  syncSelectedMarker();
  elements.riskRows.querySelectorAll('.selected').forEach((row) => row.classList.remove('selected'));
}

function clearDistrictFilter() {
  state.district = '';
  elements.districtFilter.value = '';
  elements.mapTitle.textContent = '서울 전체';
  renderListForCriteriaChange();
}

function handleEmptyMapClick() {
  if (state.selectedStationId) {
    clearSelection();
    return;
  }
  if (mapStage() === 'district' && state.district) clearDistrictFilter();
}

function renderRows({ preservePage = false } = {}) {
  updateSortHeaders();
  const rows = sortedRows();
  const totalPages = Math.max(1, Math.ceil(rows.length / config.pageSize));
  if (!preservePage) state.page = Math.min(state.page, totalPages);
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
    row.addEventListener('click', () => selectStation(station, { source: 'row' }));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectStation(station, { source: 'row' });
      }
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

function renderDashboard(options = {}) {
  updateFilterSummary();
  renderRows(options);
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
  const total = stations.length;
  const shortageRatio = total ? shortage / total : 0;
  const surplusRatio = total ? surplus / total : 0;
  const ratio = state.risk === 'surplus' ? surplusRatio
    : state.risk === 'all' ? Math.max(shortageRatio, surplusRatio) : shortageRatio;
  const color = state.risk === 'surplus' ? 'surplus'
    : state.risk === 'all' ? shortage > surplus ? 'shortage' : surplus > shortage ? 'surplus' : 'normal'
      : 'shortage';
  return { shortage, surplus, shortageUnits, surplusUnits, selectedCount, selectedUnits, shortageRatio, surplusRatio, ratio, color };
}

function makeDistrictBubble(district, stations, intensity) {
  const metrics = districtRisk(stations);
  const content = document.createElement('button');
  content.type = 'button';
  content.className = `district-bubble ${metrics.color}${intensity < 0.5 ? ' light' : ''}`;
  content.style.setProperty('--intensity', `${intensity * 100}%`);
  content.style.width = `${Math.min(142, 82 + metrics.selectedCount * 1.4)}px`;
  content.style.minHeight = `${Math.min(82, 58 + metrics.selectedCount * 0.35)}px`;
  content.append(textNode('strong', district));
  const subline = state.risk === 'surplus'
    ? `과잉 ${metrics.surplus}곳 (${Math.round(metrics.surplusRatio * 100)}%) / +${metrics.surplusUnits}대`
    : state.risk === 'all'
      ? `부족 ${metrics.shortage} (${Math.round(metrics.shortageRatio * 100)}%) · 과잉 ${metrics.surplus} (${Math.round(metrics.surplusRatio * 100)}%)`
      : `부족 ${metrics.shortage}곳 (${Math.round(metrics.shortageRatio * 100)}%) / −${metrics.shortageUnits}대`;
  content.append(textNode('span', subline));
  content.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    kakao.maps.event.preventMap();
    state.district = district;
    elements.districtFilter.value = district;
    renderListForCriteriaChange();
    focusDistrict(district);
  });
  const center = stations.length
    ? new kakao.maps.LatLng(
      stations.reduce((sum, station) => sum + station.lat, 0) / stations.length,
      stations.reduce((sum, station) => sum + station.lon, 0) / stations.length
    )
    : state.map.getCenter();
  return new kakao.maps.CustomOverlay({
    map: state.map,
    position: center,
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
  const selected = station.stationId === state.selectedStationId;
  const width = selected ? 42 : 28;
  const height = selected ? 54 : 36;
  const anchor = selected ? 21 : 14;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 28 36"><path d="M14 1C6.82 1 1 6.82 1 14c0 9.5 13 21 13 21s13-11.5 13-21C27 6.82 21.18 1 14 1Z" fill="${color}" stroke="white" stroke-width="2"/><circle cx="14" cy="14" r="4" fill="white"/></svg>`;
  return new kakao.maps.MarkerImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, new kakao.maps.Size(width, height), {
    offset: new kakao.maps.Point(anchor, height)
  });
}

function syncSelectedMarker() {
  const stationsById = new Map(state.allStations.map((station) => [station.stationId, station]));
  state.markers.forEach((marker, stationId) => {
    const station = stationsById.get(stationId);
    if (!station) {
      marker.setZIndex(0);
      return;
    }
    marker.setImage(markerImageFor(station));
    marker.setZIndex(stationId === state.selectedStationId ? 10 : 0);
  });
}

function getMarker(station) {
  let marker = state.markers.get(station.stationId);
  if (!marker) {
    marker = new kakao.maps.Marker({
      position: new kakao.maps.LatLng(station.lat, station.lon),
      title: station.stationName,
      image: markerImageFor(station),
      zIndex: station.stationId === state.selectedStationId ? 10 : 0,
      clickable: true
    });
    kakao.maps.event.addListener(marker, 'click', () => {
      kakao.maps.event.preventMap();
      const currentStation = state.allStations.find((item) => item.stationId === station.stationId) || station;
      selectStation(currentStation, { focusMap: false, openInfo: true, marker });
    });
    state.markers.set(station.stationId, marker);
  } else {
    marker.setPosition(new kakao.maps.LatLng(station.lat, station.lon));
    marker.setImage(markerImageFor(station));
  }
  marker.setZIndex(station.stationId === state.selectedStationId ? 10 : 0);
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
  const selectedStation = state.allStations.find((station) => station.stationId === state.selectedStationId);
  if (state.districtLegend) state.districtLegend.hidden = stage !== 'district';
  removeDistrictOverlays();
  state.clusterer.clear();

  for (const marker of state.markers.values()) marker.setMap(null);
  state.mapStage = stage;

  const showSelectedStation = () => {
    if (!selectedStation) return;
    const marker = getMarker(selectedStation);
    marker.setZIndex(10);
    marker.setMap(state.map);
    state.infoOverlay.setPosition(marker.getPosition());
  };

  if (stage === 'district') {
    const displayDistricts = [...stationGroups(stations).keys()];
    const allGroups = stationGroups(state.allStations);
    const groups = displayDistricts.map((district) => [district, allGroups.get(district) || []]);
    const maxRatio = Math.max(0, ...groups.map(([, group]) => districtRisk(group).ratio));
    if (state.districtLegend) {
      state.districtLegend.className = `district-legend ${state.risk}`;
      state.districtLegendMaximum.textContent = `최대 ${Math.round(maxRatio * 100)}%`;
    }
    for (const [district, group] of groups) {
      const metrics = districtRisk(group);
      const intensity = maxRatio > 0 ? Math.max(0.25, metrics.ratio / maxRatio) : 0.25;
      state.districtOverlays.push(makeDistrictBubble(district, group, intensity));
    }
    showSelectedStation();
    elements.mapStatus.textContent = `${state.district ? '자치구 범위' : '서울 전체'} · 자치구별 위험`;
    return;
  }

  if (stage === 'cluster') {
    const markers = stations
      .filter((station) => station.stationId !== state.selectedStationId)
      .map(getMarker);
    state.clusterer.addMarkers(markers);
    showSelectedStation();
    elements.mapStatus.textContent = `${stations.length.toLocaleString('ko-KR')}개 대여소 · 클러스터 보기`;
    return;
  }

  const visibleMarkers = updateVisibleStationMarkers(
    stations.filter((station) => station.stationId !== state.selectedStationId)
  );
  showSelectedStation();
  elements.mapStatus.textContent = `${visibleMarkers.length.toLocaleString('ko-KR')}개 대여소 · 현재 화면`;
}

function refreshPointVisibility() {
  renderMapLayers();
}

function focusDistrict(district) {
  const stations = state.allStations.filter((station) => station.gu === district
    && station.lat >= SEOUL_COORDINATE_BOUNDS.minLat
    && station.lat <= SEOUL_COORDINATE_BOUNDS.maxLat
    && station.lon >= SEOUL_COORDINATE_BOUNDS.minLon
    && station.lon <= SEOUL_COORDINATE_BOUNDS.maxLon);
  if (!stations.length) return;
  const bounds = new kakao.maps.LatLngBounds();
  stations.forEach((station) => bounds.extend(new kakao.maps.LatLng(station.lat, station.lon)));
  state.map.setBounds(bounds, 70, 60, 70, 60);
  if (state.map.getLevel() >= config.map.districtBubbleLevel) {
    state.map.setLevel(config.map.clusterLevel, { animate: true });
  } else {
    state.map.panTo(bounds.getCenter());
  }
  document.getElementById('mapTitle').textContent = district;
}

function focusStation(station) {
  selectStation(station, { focusMap: true, openInfo: true, source: 'search' });
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
    renderListForCriteriaChange();
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
    ['h2', '+2시간재고'], ['h2Risk', '+2시간위험'],
    ['h3', '+3시간재고'], ['h3Risk', '+3시간위험'], ['lat', '위도'], ['lon', '경도']
  ];
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [columns.map(([, label]) => escape(label)).join(',')];
  for (const station of rows) {
    const record = {
      stationId: station.stationId, stationName: station.stationName, gu: station.gu, rackTotCnt: station.rackTotCnt,
      now: station.stock.now, nowRisk: statusText(riskAt(station, 'now'), state.risk),
      h1: station.stock.h1, h1Risk: statusText(riskAt(station, 'h1'), state.risk),
      h2: station.stock.h2, h2Risk: statusText(riskAt(station, 'h2'), state.risk),
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
  if (state.isLoading) return;
  if (Number.isFinite(state.nextFetchAt) && Date.now() / 1000 < state.nextFetchAt) return;
  state.isLoading = true;
  updateRefreshButton();
  elements.refreshButton.classList.add('loading');
  try {
    const response = await fetch(config.apiEndpoint, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '대여소 데이터를 불러오지 못했습니다.');
    const dashboardData = toDashboardData(payload);
    state.allStations = dashboardData.stations;
    state.baseTime = dashboardData.baseTime;
    state.fetchedAt = dashboardData.fetchedAt;
    state.nextFetchAt = dashboardData.nextFetchAt;
    state.source = dashboardData.source;
    state.stale = dashboardData.stale;
    state.staleReason = dashboardData.staleReason;
    state.demoForecasts = config.demoForecasts && state.allStations.some((station) => station.forecastSource === 'demo');
    fillDistrictSelect();
    elements.districtFilter.value = state.district;
    updateDataStatus();
    const tableScroll = document.getElementById('tableScroll');
    const previousScrollTop = tableScroll?.scrollTop ?? 0;
    renderDashboard({ preservePage: true });
    if (tableScroll) {
      const maxScrollTop = Math.max(0, tableScroll.scrollHeight - tableScroll.clientHeight);
      tableScroll.scrollTop = Math.min(previousScrollTop, maxScrollTop);
    }
    if (state.map && state.allStations.length) {
      const bounds = new kakao.maps.LatLngBounds();
      state.allStations.forEach((station) => bounds.extend(new kakao.maps.LatLng(station.lat, station.lon)));
      state.map.setBounds(bounds, 40, 40, 40, 40);
      document.getElementById('mapTitle').textContent = '서울 전체';
    }
    elements.mapStatus.textContent = `${state.allStations.length.toLocaleString('ko-KR')}개 대여소 데이터`;
    if (state.staleReason === 'error') showToast('갱신 실패');
  } catch {
    state.stale = true;
    state.staleReason = 'error';
    if (state.allStations.length) {
      updateDataAge();
    } else {
      elements.dataMode.textContent = '연결 오류';
      elements.dataMode.classList.add('demo');
      elements.dataFreshness.textContent = '오래된 데이터';
      elements.dataFreshness.className = 'freshness-chip old';
      elements.dataFreshness.title = '서울시 원천 데이터는 최대 약 5분 늦게 반영될 수 있습니다. (조회 실패)';
      elements.resultCount.textContent = '데이터를 불러오지 못했습니다';
      elements.tableEmpty.textContent = '대여소 데이터를 불러오지 못했습니다.';
      elements.tableEmpty.hidden = false;
      elements.mapStatus.textContent = '데이터를 불러오지 못했습니다';
    }
    showToast('갱신 실패');
  } finally {
    state.isLoading = false;
    elements.refreshButton.classList.remove('loading');
    updateRefreshButton();
  }
}

function setupMap() {
  state.map = new kakao.maps.Map(document.getElementById('map'), {
    center: new kakao.maps.LatLng(37.5665, 126.9780),
    level: 9
  });
  state.districtLegend = document.createElement('div');
  state.districtLegend.className = 'district-legend';
  state.districtLegend.hidden = true;
  const legendBar = document.createElement('span');
  legendBar.className = 'district-legend-bar';
  const legendLabel = textNode('span', '구별 비율 낮음 → 높음');
  const legendMaximum = textNode('span', '');
  legendMaximum.className = 'district-legend-maximum';
  state.districtLegend.append(legendBar, legendLabel, legendMaximum);
  document.querySelector('.map-panel').append(state.districtLegend);
  state.districtLegendMaximum = legendMaximum;
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
    zIndex: 11,
    clickable: true
  });
  kakao.maps.event.addListener(state.map, 'click', handleEmptyMapClick);
  kakao.maps.event.addListener(state.map, 'zoom_changed', renderMapLayers);
  kakao.maps.event.addListener(state.map, 'idle', refreshPointVisibility);
  window.addEventListener('resize', () => state.map.relayout());
}

function bindControls() {
  elements.refreshButton.addEventListener('click', loadData);
  elements.exportCsv.addEventListener('click', exportCsv);
  elements.districtFilter.addEventListener('change', () => {
    state.district = elements.districtFilter.value;
    renderListForCriteriaChange();
    if (state.district) focusDistrict(state.district);
  });
  elements.clearDistrict.addEventListener('click', () => {
    clearDistrictFilter();
  });
  document.querySelectorAll('[data-risk]').forEach((button) => {
    button.addEventListener('click', () => {
      state.risk = button.dataset.risk;
      document.querySelectorAll('[data-risk]').forEach((item) => item.classList.toggle('active', item === button));
      renderListForCriteriaChange();
    });
  });
  document.querySelectorAll('[data-horizon]').forEach((button) => {
    button.addEventListener('click', () => {
      state.horizon = button.dataset.horizon;
      document.querySelectorAll('[data-horizon]').forEach((item) => item.classList.toggle('active', item === button));
      renderMapLayers();
    });
  });
  document.querySelectorAll('[data-sort]').forEach((button) => {
    button.addEventListener('click', () => sortBy(button.dataset.sort));
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
    if (document.visibilityState !== 'hidden') loadData();
  }, config.refreshIntervalMs);
  window.setInterval(updateDataAge, 30000);
  window.setInterval(updateRefreshButton, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' && Number.isFinite(state.fetchedAt)
      && Date.now() / 1000 - state.fetchedAt > 300) {
      loadData();
    }
  });
}

if (window.kakao && window.kakao.maps) {
  kakao.maps.load(boot);
} else {
  elements.mapStatus.textContent = '카카오 개발자 콘솔에서 현재 도메인의 JavaScript 허용 설정을 확인해 주세요.';
  elements.dataMode.textContent = '지도 연결 오류';
}