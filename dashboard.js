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
  hasLoadedData: false,
  initialLoadFailed: false,
  refreshFailed: false,
  isLoading: false,
  booted: false,
  source: 'live',
  demoForecasts: false,
  risk: 'all',
  metric: 'flow',
  flowFilter: 'all',
  district: '',
  horizon: 'h1',
  sortKey: 'h1',
  sortDir: 'desc',
  page: 1,
  selectedStationId: '',
  suggestions: [],
  activeSuggestion: -1,
  map: null,
  clusterer: null,
  infoOverlay: null,
  mapMetricMaximum: 0,
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
  demoDataNote: document.getElementById('demoDataNote'),
  dataError: document.getElementById('dataError'),
  retryLoad: document.getElementById('retryLoad'),
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

function coordinateValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function flowValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function seededUnit(seed, intervalIndex, salt) {
  let value = (seed ^ Math.imul(intervalIndex + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  value = (value ^ (value >>> 16)) >>> 0;
  return value / 0x100000000;
}

function makeDemoFlow(stationId, rackTotCnt, stockNow) {
  const seed = stableSeed(stationId);
  const rackScale = Math.max(0, rackTotCnt);
  const flow = {};
  const volume = {};
  const intervals = ['h1', 'h2', 'h3'];
  intervals.forEach((key, index) => {
    const intervalSeed = (seed + Math.round(stockNow || 0)) >>> 0;
    const sizeRatio = 0.1 + seededUnit(intervalSeed, index, 1) * 0.5;
    const variation = 0.8 + seededUnit(intervalSeed, index, 2) * 0.4;
    const intervalVolume = Math.round(rackScale * sizeRatio * variation);
    const rentalShare = 0.2 + seededUnit(intervalSeed, index, 3) * 0.6;
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
    const rackValue = Number(raw.rackTotCnt ?? raw.rackCount);
    const rackTotCnt = Number.isFinite(rackValue) ? rackValue : 0;
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
      lat: coordinateValue(raw.lat ?? raw.latitude),
      lon: coordinateValue(raw.lon ?? raw.longitude),
      rackTotCnt,
      stock,
      flow,
      volume,
      forecastSource: generatedForecast ? 'demo' : 'model',
      extra: raw.extra || {}
    };
  }).filter((station) => station.stationId);
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

function filteredStations() {
  const query = elements.search.value.trim().toLocaleLowerCase('ko-KR');
  return state.allStations.filter((station) => {
    const districtMatch = !state.district || station.gu === state.district;
    const searchMatch = !query
      || `${station.stationName} ${station.stationId} ${station.gu}`.toLocaleLowerCase('ko-KR').includes(query);
    return districtMatch && searchMatch;
  });
}

function filteredTableStations() {
  return filteredStations().filter((station) => {
    return stationMatchesFlowFilter(station);
  });
}

function stationMatchesFlowFilter(station) {
  if (state.metric !== 'flow' || state.flowFilter === 'all') return true;
  return ['h1', 'h2', 'h3'].some((key) => state.flowFilter === 'out'
    ? station.flow[key] < 0
    : station.flow[key] > 0);
}

function stationsForSummary() {
  return state.allStations.filter((station) => !state.district || station.gu === state.district);
}

function compareStationNames(left, right) {
  return left.stationName.localeCompare(right.stationName, 'ko-KR', { numeric: true });
}

function sortedRows() {
  const rows = filteredTableStations();
  rows.sort((left, right) => {
    const nameOrder = compareStationNames(left, right);
    if (state.sortKey === 'stationName') return state.sortDir === 'asc' ? nameOrder : -nameOrder;
    const metric = state.metric === 'flow' ? 'flow' : 'volume';
    const leftRaw = left[metric][state.sortKey];
    const rightRaw = right[metric][state.sortKey];
    const leftValue = Number.isFinite(leftRaw)
      && (state.metric !== 'flow' || state.flowFilter === 'all'
        || (state.flowFilter === 'out' ? leftRaw < 0 : leftRaw > 0))
      ? state.metric === 'flow' ? Math.abs(leftRaw) : leftRaw
      : null;
    const rightValue = Number.isFinite(rightRaw)
      && (state.metric !== 'flow' || state.flowFilter === 'all'
        || (state.flowFilter === 'out' ? rightRaw < 0 : rightRaw > 0))
      ? state.metric === 'flow' ? Math.abs(rightRaw) : rightRaw
      : null;
    if ((leftValue === null) !== (rightValue === null)) return leftValue === null ? 1 : -1;
    if (leftValue === null) return nameOrder;
    const byUnits = state.sortDir === 'desc' ? rightValue - leftValue : leftValue - rightValue;
    return byUnits || nameOrder;
  });
  return rows;
}

function sortedCsvRows() {
  return sortedRows();
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
  const sortSummary = document.getElementById('sortSummary');
  if (!sortSummary) return;
  if (state.sortKey === 'stationName') {
    sortSummary.textContent = `정렬: 대여소명 ${state.sortDir === 'asc' ? '가나다순' : '역순'}`;
    return;
  }
  const label = state.sortKey === 'now' ? '현재' : `+${state.sortKey.slice(1)}h`;
  const measure = state.metric === 'volume'
    ? '이용량'
    : state.flowFilter === 'all' ? '순증감 절대값' : state.flowFilter === 'out' ? '감소량' : '증가량';
  sortSummary.textContent = `정렬: ${label} · ${measure} ${state.sortDir === 'desc' ? '큰 순' : '작은 순'} (단위: 대/시간)`;
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

function updateDataStatus() {
  const demo = state.demoForecasts;
  elements.dataMode.textContent = state.source === 'sample' ? '샘플 재고' : '실시간 재고';
  elements.dataMode.classList.toggle('demo', demo || state.source === 'sample');
  elements.forecastNote.textContent = demo ? '예측: 데모 시뮬레이션' : '예측: 모델 연동';
  elements.forecastNote.classList.toggle('forecast-note', demo);
  updateDataAge();
}

function showInitialLoadFailure() {
  state.initialLoadFailed = true;
  elements.dataMode.textContent = '연결 오류';
  elements.dataMode.classList.add('demo');
  elements.dataFreshness.textContent = '갱신 실패';
  elements.dataFreshness.className = 'freshness-chip old';
  elements.dataFreshness.title = '데이터를 불러오지 못했습니다.';
  elements.dataError.hidden = false;
  elements.retryLoad.disabled = false;
  elements.resultCount.textContent = '데이터를 불러오지 못했습니다';
  elements.tableEmpty.textContent = '데이터를 불러오지 못했습니다';
  elements.tableEmpty.hidden = false;
  renderDashboard();
  if (state.map) elements.mapStatus.textContent = '데이터를 불러오지 못했습니다';
}

function updateDataAge() {
  if (!Number.isFinite(state.fetchedAt)) return;
  if (state.refreshFailed) {
    const lastDataTime = formatTime(state.fetchedAt * 1000);
    elements.dataFreshness.textContent = `갱신 실패 · 마지막 데이터 ${lastDataTime}`;
    elements.dataFreshness.className = 'freshness-chip old';
    elements.dataFreshness.title = '갱신에 실패했습니다. 마지막으로 성공한 데이터를 표시 중입니다.';
    return;
  }
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000 - state.fetchedAt));
  const ageLabel = ageSeconds < 60 ? '방금' : `${Math.floor(ageSeconds / 60)}분 전`;
  const old = state.stale || ageSeconds > 600;
  const delayed = !old && ageSeconds > 300;
  const status = old ? '오래된 데이터' : delayed ? '지연' : '최신';
  const className = old ? 'old' : delayed ? 'delayed' : 'latest';
  const staleReasonText = state.staleReason === 'quota'
    ? '일일 호출 한도 소진으로 저장된 데이터를 표시 중입니다'
    : state.staleReason === 'error'
      ? '원천 데이터 조회 실패로 저장된 데이터를 표시 중입니다'
      : '저장된 데이터를 표시 중입니다';
  const tooltip = state.stale
    ? staleReasonText
    : '서울시 원천 데이터는 최대 약 5분 늦게 반영될 수 있습니다.';
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
  const retryAvailable = state.initialLoadFailed || state.refreshFailed;
  elements.refreshButton.title = retryAvailable ? '다시 시도' : '데이터 새로고침';
  elements.refreshButton.setAttribute('aria-label', retryAvailable ? '다시 시도' : '데이터 새로고침');
  elements.refreshButton.disabled = state.isLoading || remaining > 0 && !retryAvailable;
  elements.refreshCountdown.textContent = state.isLoading
    ? '조회 중'
    : retryAvailable
      ? '다시 시도'
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
    const cell = document.querySelector(`[data-summary="${key}"]`);
    const count = cell.querySelector('.summary-count');
    const units = cell.querySelector('.summary-units');
    count.replaceChildren();
    units.replaceChildren();
    cell.classList.toggle('volume-summary', state.metric === 'volume');
    if (state.initialLoadFailed) {
      count.append(textNode('span', '—'));
      units.append(textNode('span', '데이터 조회 실패'));
      continue;
    }
    const appendAmount = (parent, label, value, tone = 'neutral') => {
      const line = document.createElement('span');
      line.className = `metric-summary-line ${tone}`;
      if (label) line.append(textNode('span', label));
      const formatted = !Number.isFinite(value) ? '—'
        : tone === 'shortage' ? `−${Math.abs(value).toLocaleString('ko-KR')}`
          : tone === 'surplus' ? `+${Math.abs(value).toLocaleString('ko-KR')}`
            : value.toLocaleString('ko-KR');
      const amount = textNode('span', formatted);
      amount.className = 'metric-summary-number';
      line.append(amount);
      line.append(textNode('small', '(대)'));
      parent.append(line);
      return line;
    };
    const appendCountLine = (label, countValue, tone) => {
      const line = document.createElement('span');
      line.className = `metric-summary-line count-line ${tone}`;
      line.append(
        textNode('span', label),
        textNode('strong', countValue.toLocaleString('ko-KR')),
        textNode('span', `/ ${totalCount.toLocaleString('ko-KR')}`),
        textNode('small', '(곳)')
      );
      count.append(line);
      return line;
    };

    if (key === 'now') {
      count.append(textNode('span', '—'));
      cell.title = '현재 시점의 순증감과 이용량은 제공되지 않습니다.';
      continue;
    }

    if (state.metric === 'volume') {
      const values = scopeStations.map((station) => station.volume[key]).filter(Number.isFinite);
      const total = values.reduce((sum, value) => sum + value, 0);
      const average = values.length ? total / values.length : null;
      appendAmount(count, '합계', total, 'neutral');
      units.append(
        textNode('span', '대여소 평균 '),
        textNode('span', average === null ? '—' : average.toLocaleString('ko-KR', { maximumFractionDigits: 1 })),
        textNode('small', '(대)')
      );
      cell.title = `${values.length.toLocaleString('ko-KR')}개 대여소의 이용량 집계`;
    } else {
      const flows = scopeStations.map((station) => station.flow[key]).filter(Number.isFinite);
      const decreases = flows.filter((flow) => flow < 0);
      const increases = flows.filter((flow) => flow > 0);
      const decreaseTotal = decreases.reduce((sum, flow) => sum + flow, 0);
      const increaseTotal = increases.reduce((sum, flow) => sum + flow, 0);
      const net = flows.reduce((sum, flow) => sum + flow, 0);
      if (state.flowFilter !== 'in') appendCountLine('감소', decreases.length, 'shortage');
      if (state.flowFilter !== 'out') appendCountLine('증가', increases.length, 'surplus');
      if (state.flowFilter === 'out') {
        appendAmount(units, '합계', decreaseTotal, 'shortage');
      } else if (state.flowFilter === 'in') {
        appendAmount(units, '합계', increaseTotal, 'surplus');
      } else {
        appendAmount(units, '순합계', net, net < 0 ? 'shortage' : net > 0 ? 'surplus' : 'neutral');
      }
      cell.title = `감소 ${decreases.length.toLocaleString('ko-KR')}곳, 증가 ${increases.length.toLocaleString('ko-KR')}곳 · 감소 합계 ${decreaseTotal.toLocaleString('ko-KR')}대 · 증가 합계 ${increaseTotal.toLocaleString('ko-KR')}대`;
    }
  }
}

function createStockCell(station, horizon) {
  const cell = document.createElement('td');
  const flow = station.flow[horizon];
  const volume = station.volume[horizon];
  const stock = station.stock[horizon];
  const direction = horizon === 'h1' ? '현재→1시간 뒤'
    : horizon === 'h2' ? '1→2시간 뒤'
      : horizon === 'h3' ? '2→3시간 뒤' : '현재';
  const formatNumber = (value) => Number.isFinite(value) ? value.toLocaleString('ko-KR') : '—';
  const overCapacity = Number.isFinite(stock) && stock > station.rackTotCnt;
  const flowDescription = !Number.isFinite(flow) ? '순증감 예측값 없음'
    : flow > 0 ? `반납이 대여보다 ${flow.toLocaleString('ko-KR')}대 많을 것으로 예측`
      : flow < 0 ? `반납이 대여보다 ${Math.abs(flow).toLocaleString('ko-KR')}대 적을 것으로 예측`
        : '반납과 대여가 같을 것으로 예측';
  const description = state.metric === 'flow'
    ? horizon === 'now'
      ? `현재 순증감은 과거 스냅샷이 없어 제공되지 않습니다 · 예상 재고 ${formatNumber(stock)}대 / 거치대 ${formatNumber(station.rackTotCnt)}대`
      : `${direction} 동안 ${flowDescription} · 이용량 ${formatNumber(volume)}대 · 예상 재고 ${formatNumber(stock)}대 / 거치대 ${formatNumber(station.rackTotCnt)}대`
    : `${direction} 이용량 ${formatNumber(volume)}대 · 예상 재고 ${formatNumber(stock)}대 / 거치대 ${formatNumber(station.rackTotCnt)}대`;
  const fullDescription = overCapacity ? `${description} · 재고가 거치대 수를 초과했습니다` : description;
  cell.title = fullDescription;
  cell.setAttribute('aria-label', fullDescription);

  const wrapper = document.createElement('div');
  wrapper.className = 'stock-cell';
  const primaryText = state.metric === 'flow'
    ? Number.isFinite(flow) ? flow > 0 ? `+${flow.toLocaleString('ko-KR')}` : flow < 0 ? `−${Math.abs(flow).toLocaleString('ko-KR')}` : '0' : '—'
    : Number.isFinite(volume) ? volume.toLocaleString('ko-KR') : '—';
  const status = textNode('span', primaryText);
  status.className = `stock-primary ${state.metric === 'volume' ? 'volume' : flow < 0 ? 'shortage' : flow > 0 ? 'surplus' : 'neutral'}`;

  const details = document.createElement('span');
  details.className = 'stock-details';
  const stockValueNode = textNode('span', Number.isFinite(stock) ? stock.toLocaleString('ko-KR') : '—');
  stockValueNode.className = 'stock-value';
  const divider = textNode('span', `/ ${station.rackTotCnt.toLocaleString('ko-KR')}`);
  divider.className = 'stock-capacity';
  const unit = textNode('span', '(대)');
  unit.className = 'stock-unit';
  details.append(stockValueNode, divider, unit);
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
  if (state.district && state.district !== station.gu) {
    state.district = station.gu;
    elements.districtFilter.value = station.gu;
  }
  state.selectedStationId = station.stationId;
  syncSelectedMarker();
  state.page = Math.max(1, Math.ceil((sortedRows().findIndex((item) => item.stationId === station.stationId) + 1) / config.pageSize));
  renderDashboard();
  renderSelectedStation(station);

  const canShowOnMap = Boolean(state.map && hasMapSdk()
    && Number.isFinite(station.lat) && Number.isFinite(station.lon));
  if (focusMap && canShowOnMap) {
    const position = new kakao.maps.LatLng(station.lat, station.lon);
    state.map.setLevel(5);
    state.map.panTo(position);
    document.getElementById('mapTitle').textContent = `${station.gu} · ${station.stationName}`;
  }
  if (openInfo && canShowOnMap) {
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
    if (hasMapSdk() && typeof kakao.maps.event?.preventMap === 'function') kakao.maps.event.preventMap();
  });
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'map-info-close';
  closeButton.setAttribute('aria-label', '닫기');
  closeButton.textContent = '×';
  closeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (hasMapSdk() && typeof kakao.maps.event?.preventMap === 'function') kakao.maps.event.preventMap();
    clearSelection();
  });
  content.append(closeButton, textNode('strong', station.stationName));
  const district = textNode('span', station.gu || '자치구 미상');
  district.className = 'map-info-district';
  content.append(district);

  const current = textNode('span', `현재 재고 ${formatStock(station.stock.now)} / 거치대 ${formatStock(station.rackTotCnt)} (대)`);
  current.className = 'map-info-current';
  content.append(current);

  for (const { key } of horizons.filter(({ key }) => key !== 'now')) {
    const period = document.createElement('div');
    period.className = 'map-info-period';
    const heading = textNode('span', `+${key.slice(1)}h`);
    heading.className = 'map-info-period-label';
    const flow = station.flow[key];
    const flowText = Number.isFinite(flow) ? `${flow > 0 ? '+' : flow < 0 ? '−' : ''}${formatStock(Math.abs(flow))} (대)` : '-';
    const flowRow = textNode('span', `순증감 ${flowText}`);
    flowRow.className = `map-info-flow${flow < 0 ? ' shortage' : flow > 0 ? ' surplus' : ''}`;
    const volumeRow = textNode('span', `이용량 ${formatStock(station.volume[key])} (대)`);
    volumeRow.className = 'map-info-volume';
    const stockRow = textNode('span', `예상 재고 ${formatStock(station.stock[key])} / 거치대 ${formatStock(station.rackTotCnt)} (대)`);
    stockRow.className = 'map-info-stock';
    period.append(heading, flowRow, volumeRow, stockRow);
    content.append(period);
  }
  return content;
}

function textNode(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function formatStock(value) {
  return Number.isFinite(value) ? value.toLocaleString('ko-KR') : '—';
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
  if (state.infoOverlay && hasMapSdk()) state.infoOverlay.setMap(null);
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
  elements.tableEmpty.textContent = state.initialLoadFailed
    ? '데이터를 불러오지 못했습니다'
    : '조건에 맞는 대여소가 없습니다';
  elements.tableEmpty.hidden = rows.length > 0 || !state.hasLoadedData && !state.initialLoadFailed;
  elements.resultCount.textContent = `${rows.length.toLocaleString('ko-KR')}곳`;
  elements.pageStatus.textContent = rows.length
    ? `${(start + 1).toLocaleString('ko-KR')}–${Math.min(start + config.pageSize, rows.length).toLocaleString('ko-KR')} / ${rows.length.toLocaleString('ko-KR')}`
    : '0 / 0';
  elements.previousPage.disabled = state.page <= 1;
  elements.nextPage.disabled = state.page >= totalPages;
  elements.exportCsv.disabled = !state.hasLoadedData || rows.length === 0;
}

function renderDashboard(options = {}) {
  updateFilterSummary();
  renderRows(options);
  updateActiveFilter();
  renderMapLayers();
}

function syncHorizonControls() {
  if (state.horizon === 'now') state.horizon = 'h1';
  document.querySelectorAll('[data-horizon]').forEach((button) => {
    const unavailable = button.dataset.horizon === 'now';
    button.disabled = unavailable;
    button.title = unavailable ? '실측 이력 축적 후 제공' : '';
    button.classList.toggle('active', button.dataset.horizon === state.horizon);
  });
}

function syncMetricControls() {
  document.querySelectorAll('[data-metric]').forEach((button) => {
    const active = button.dataset.metric === state.metric;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const flowFilterGroup = document.getElementById('flowFilterGroup');
  if (flowFilterGroup) flowFilterGroup.hidden = state.metric !== 'flow';
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
  return filteredTableStations().filter((station) => Number.isFinite(station.lat) && Number.isFinite(station.lon));
}

function hasMapSdk() {
  return Boolean(window.kakao && window.kakao.maps);
}

function removeDistrictOverlays() {
  for (const overlay of state.districtOverlays) overlay.setMap(null);
  state.districtOverlays = [];
}

function stationGroups(stations) {
  const groups = new Map();
  for (const station of stations) {
    if (!station.gu) continue;
    if (!groups.has(station.gu)) groups.set(station.gu, []);
    groups.get(station.gu).push(station);
  }
  return groups;
}

function mapMetricValue(station) {
  return state.metric === 'flow' ? station.flow[state.horizon] : station.volume[state.horizon];
}

function districtRisk(stations) {
  const validStations = stations.filter((station) => Number.isFinite(mapMetricValue(station)));
  if (state.metric === 'volume') {
    return {
      total: validStations.length,
      amount: validStations.reduce((sum, station) => sum + mapMetricValue(station), 0),
      color: 'volume',
      dominantRatio: 0
    };
  }
  const decreaseCount = validStations.filter((station) => mapMetricValue(station) < 0).length;
  const increaseCount = validStations.filter((station) => mapMetricValue(station) > 0).length;
  const total = validStations.length;
  const dominantRatio = total ? Math.max(decreaseCount, increaseCount) / total : 0;
  return {
    total,
    decreaseCount,
    increaseCount,
    amount: validStations.reduce((sum, station) => sum + Math.abs(mapMetricValue(station)), 0),
    color: decreaseCount > increaseCount ? 'shortage'
      : increaseCount > decreaseCount ? 'surplus' : 'normal',
    dominantRatio
  };
}

function makeDistrictBubble(district, stations, metrics, diameter, intensity) {
  const content = document.createElement('button');
  content.type = 'button';
  content.className = `district-bubble ${metrics.color}`;
  content.style.setProperty('--intensity', `${intensity * 100}%`);
  content.style.width = `${diameter}px`;
  content.style.height = `${diameter}px`;
  content.style.minWidth = `${diameter}px`;
  content.style.minHeight = `${diameter}px`;
  content.style.color = 'var(--ink)';
  content.style.whiteSpace = 'nowrap';
  content.append(textNode('strong', district));
  const subline = `${metrics.amount.toLocaleString('ko-KR')} (대)`;
  content.append(textNode('span', subline));
  content.title = state.metric === 'flow'
    ? `감소 ${metrics.decreaseCount} / 증가 ${metrics.increaseCount} (곳) · 절댓값 합 ${metrics.amount.toLocaleString('ko-KR')} (대)`
    : `이용량 합 ${metrics.amount.toLocaleString('ko-KR')} (대) · 대여소 ${metrics.total}곳`;
  content.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (hasMapSdk() && typeof kakao.maps.event?.preventMap === 'function') kakao.maps.event.preventMap();
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
  if (!state.map || !hasMapSdk()) return 'district';
  const level = state.map.getLevel();
  if (level >= config.map.districtBubbleLevel) return 'district';
  if (level >= config.map.clusterLevel) return 'cluster';
  return 'station';
}

function markerImageFor(station) {
  const metric = mapMetricValue(station);
  const selected = station.stationId === state.selectedStationId;
  const markerBaseSize = config.map.markerImageSize;
  const ratio = Number.isFinite(metric) && state.mapMetricMaximum > 0
    ? Math.abs(metric) / state.mapMetricMaximum
    : 0;
  const regularSize = !Number.isFinite(metric) || ratio < config.map.markerSmallRatio
    ? markerBaseSize + config.map.markerSmallSizeOffset
    : ratio < config.map.markerMediumRatio
      ? markerBaseSize
      : markerBaseSize + config.map.markerLargeSizeOffset;
  const width = selected ? markerBaseSize * 1.5 : regularSize;
  const height = selected ? Math.round(markerBaseSize * 54 / 28) : Math.round(regularSize * 36 / 28);
  const anchor = Math.round(width / 2);
  const palette = getComputedStyle(document.documentElement);
  const color = state.metric === 'volume'
    ? palette.getPropertyValue('--ink').trim()
    : !Number.isFinite(metric) || metric === 0
      ? palette.getPropertyValue('--normal').trim()
      : palette.getPropertyValue(metric < 0 ? '--shortage' : '--surplus').trim();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 28 36"><path d="M14 1C6.82 1 1 6.82 1 14c0 9.5 13 21 13 21s13-11.5 13-21C27 6.82 21.18 1 14 1Z" fill="${color}" stroke="white" stroke-width="2"/><circle cx="14" cy="14" r="4" fill="white"/></svg>`;
  return new kakao.maps.MarkerImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, new kakao.maps.Size(width, height), {
    offset: new kakao.maps.Point(anchor, height)
  });
}

function syncSelectedMarker() {
  if (!state.map || !hasMapSdk()) return;
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
      if (hasMapSdk() && typeof kakao.maps.event?.preventMap === 'function') kakao.maps.event.preventMap();
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

function mapMetricMaximumForStage(stations, stage) {
  let candidates = stations;
  if (stage === 'station') {
    const bounds = state.map.getBounds();
    const southWest = bounds.getSouthWest();
    const northEast = bounds.getNorthEast();
    candidates = stations.filter((station) =>
      station.lat >= southWest.getLat() - 0.012 && station.lat <= northEast.getLat() + 0.012
      && station.lon >= southWest.getLng() - 0.018 && station.lon <= northEast.getLng() + 0.018);
  }
  return candidates.reduce((maximum, station) => {
    const value = mapMetricValue(station);
    return Number.isFinite(value) ? Math.max(maximum, Math.abs(value)) : maximum;
  }, 0);
}

function renderMapLayers() {
  if (!hasMapSdk() || !state.map || !state.clusterer) return;
  const stage = mapStage();
  const stations = currentMapStations();
  state.mapMetricMaximum = mapMetricMaximumForStage(stations, stage);
  const selectedStation = stations.find((station) => station.stationId === state.selectedStationId);
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
    const allGroups = stationGroups(state.allStations.filter((station) =>
      Number.isFinite(station.lat) && Number.isFinite(station.lon)));
    const groups = displayDistricts.map((district) => [district, allGroups.get(district) || []]);
    const districtMetrics = groups.map(([district, group]) => ({
      district,
      group,
      metrics: districtRisk(group)
    }));
    const maxAmount = Math.max(0, ...districtMetrics.map(({ metrics }) => metrics.amount));
    const bubbleScaleByLevel = config.map.bubbleScaleByLevel;
    const bubbleScaleLevels = Object.keys(bubbleScaleByLevel).map(Number).sort((a, b) => a - b);
    const minBubbleScaleLevel = bubbleScaleLevels[0];
    const maxBubbleScaleLevel = bubbleScaleLevels[bubbleScaleLevels.length - 1];
    const zoomLevel = state.map.getLevel();
    const bubbleScale = zoomLevel < minBubbleScaleLevel
      ? bubbleScaleByLevel[minBubbleScaleLevel]
      : zoomLevel > maxBubbleScaleLevel
        ? bubbleScaleByLevel[maxBubbleScaleLevel]
        : bubbleScaleByLevel[zoomLevel] || 1;
    const bubbles = districtMetrics.map(({ district, group, metrics }) => {
      const baseDiameter = maxAmount > 0
        ? Math.max(config.map.districtBubbleMinDiameter,
          Math.min(config.map.districtBubbleMaxDiameter,
            Math.sqrt(metrics.amount / maxAmount) * config.map.districtBubbleMaxDiameter))
        : config.map.districtBubbleMinDiameter;
      const diameter = baseDiameter * bubbleScale;
      const intensity = state.metric === 'volume'
        ? 0.3
        : metrics.decreaseCount === metrics.increaseCount
          ? 0.3
          : 0.15 + 0.55 * metrics.dominantRatio;
      return { district, group, metrics, diameter, intensity };
    }).sort((left, right) => right.diameter - left.diameter);
    for (const { district, group, metrics, diameter, intensity } of bubbles) {
      state.districtOverlays.push(makeDistrictBubble(district, group, metrics, diameter, intensity));
    }
    showSelectedStation();
    elements.mapStatus.textContent = `${state.district ? '자치구 범위' : '서울 전체'} · 자치구별 지표`;
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
  if (!hasMapSdk() || !state.map) return;
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
    ['stationId', '대여소ID'], ['stationName', '대여소명'], ['gu', '자치구'], ['rackTotCnt', '거치대'],
    ['now', '현재 재고'], ['flowH1', '순증감 +1h'], ['flowH2', '순증감 +2h'], ['flowH3', '순증감 +3h'],
    ['volumeH1', '이용량 +1h'], ['volumeH2', '이용량 +2h'], ['volumeH3', '이용량 +3h'],
    ['stockH1', '예상 재고 +1h'], ['stockH2', '예상 재고 +2h'], ['stockH3', '예상 재고 +3h']
  ];
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [columns.map(([, label]) => escape(label)).join(',')];
  for (const station of rows) {
    const record = {
      stationId: station.stationId, stationName: station.stationName, gu: station.gu, rackTotCnt: station.rackTotCnt,
      now: station.stock.now,
      flowH1: station.flow.h1, flowH2: station.flow.h2, flowH3: station.flow.h3,
      volumeH1: station.volume.h1, volumeH2: station.volume.h2, volumeH3: station.volume.h3,
      stockH1: station.stock.h1, stockH2: station.stock.h2, stockH3: station.stock.h3
    };
    lines.push(columns.map(([key]) => escape(record[key])).join(','));
  }
  return `\ufeff${lines.join('\r\n')}`;
}

function exportCsv() {
  const rows = sortedCsvRows();
  if (!state.hasLoadedData || rows.length === 0) return;
  const blob = new Blob([buildCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const demoSuffix = config.demoForecasts ? 'demo-' : '';
  link.download = `bikebike-flow-${demoSuffix}${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function setupResizeHandle() {
  const handle = document.getElementById('resizeHandle');
  const move = (event) => {
    if (!state.isDragging) return;
    const width = Math.min(window.innerWidth * 0.55, Math.max(390, window.innerWidth - event.clientX));
    elements.dashboardLayout.style.setProperty('--panel-width', `${width}px`);
    if (state.map && hasMapSdk()) state.map.relayout();
  };
  const stop = () => {
    if (!state.isDragging) return;
    state.isDragging = false;
    document.body.classList.remove('resizing');
    if (state.map && hasMapSdk()) state.map.relayout();
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
    if (state.map && hasMapSdk()) state.map.relayout();
  });
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 2600);
}

async function loadData({ force = false } = {}) {
  if (state.isLoading) return;
  if (!force && Number.isFinite(state.nextFetchAt) && Date.now() / 1000 < state.nextFetchAt) return;
  state.isLoading = true;
  updateRefreshButton();
  elements.retryLoad.disabled = true;
  elements.refreshButton.classList.add('loading');
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 10000);
  try {
    const response = await fetch(config.apiEndpoint, { cache: 'no-store', signal: controller.signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '대여소 데이터를 불러오지 못했습니다.');
    const dashboardData = toDashboardData(payload);
    state.allStations = dashboardData.stations;
    state.baseTime = dashboardData.baseTime;
    state.fetchedAt = dashboardData.fetchedAt;
    state.nextFetchAt = dashboardData.stale
      ? Date.now() / 1000 + config.refreshIntervalMs / 1000
      : dashboardData.nextFetchAt;
    state.source = dashboardData.source;
    state.stale = dashboardData.stale;
    state.staleReason = dashboardData.staleReason;
    state.hasLoadedData = true;
    state.initialLoadFailed = false;
    state.refreshFailed = false;
    elements.dataError.hidden = true;
    elements.retryLoad.disabled = false;
    state.risk = 'all';
    if (state.horizon === 'now') state.horizon = 'h1';
    syncHorizonControls();
    syncMetricControls();
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
    const stationsWithCoordinates = state.allStations.filter((station) =>
      Number.isFinite(station.lat) && Number.isFinite(station.lon));
    if (state.map && hasMapSdk() && stationsWithCoordinates.length) {
      const bounds = new kakao.maps.LatLngBounds();
      stationsWithCoordinates.forEach((station) => bounds.extend(new kakao.maps.LatLng(station.lat, station.lon)));
      state.map.setBounds(bounds, 40, 40, 40, 40);
      document.getElementById('mapTitle').textContent = '서울 전체';
    }
    if (state.map) {
      elements.mapStatus.textContent = `${stationsWithCoordinates.length.toLocaleString('ko-KR')}개 대여소 데이터`;
    }

  } catch (error) {
    state.nextFetchAt = Date.now() / 1000 + config.refreshIntervalMs / 1000;
    if (state.hasLoadedData) {
      state.refreshFailed = true;
      state.stale = true;
      updateDataAge();
    } else {
      showInitialLoadFailure();
    }
    if (timedOut || error instanceof Error && error.name === 'AbortError') {
      elements.dataFreshness.title = '데이터 요청이 10초 안에 완료되지 않았습니다.';
    }
  } finally {
    window.clearTimeout(timeoutId);
    state.isLoading = false;
    elements.refreshButton.classList.remove('loading');
    elements.retryLoad.disabled = false;
    updateRefreshButton();
  }
}

function setupMap() {
  if (!hasMapSdk() || !window.kakao.maps.Map || !window.kakao.maps.MarkerClusterer
      || !window.kakao.maps.CustomOverlay || !window.kakao.maps.event
      || typeof window.kakao.maps.event.addListener !== 'function') {
    showMapUnavailable();
    return false;
  }
  try {
    state.map = new window.kakao.maps.Map(document.getElementById('map'), {
      center: new window.kakao.maps.LatLng(37.5665, 126.9780),
      level: 9
    });
    state.clusterer = new window.kakao.maps.MarkerClusterer({
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
    state.infoOverlay = new window.kakao.maps.CustomOverlay({
      position: state.map.getCenter(),
      content: document.createElement('div'),
      xAnchor: 0.5,
      yAnchor: 1,
      zIndex: 11,
      clickable: true
    });
    window.kakao.maps.event.addListener(state.map, 'click', handleEmptyMapClick);
    window.kakao.maps.event.addListener(state.map, 'zoom_changed', renderMapLayers);
    window.kakao.maps.event.addListener(state.map, 'idle', refreshPointVisibility);
    window.addEventListener('resize', () => {
      if (state.map && hasMapSdk()) state.map.relayout();
    });
    return true;
  } catch {
    state.map = null;
    state.clusterer = null;
    state.infoOverlay = null;
    showMapUnavailable();
    return false;
  }
}

function showMapUnavailable() {
  document.querySelector('.map-panel').classList.add('map-unavailable');
  document.getElementById('map').replaceChildren();
  elements.mapStatus.textContent = '지도를 불러오지 못했습니다';
}

function bindControls() {
  syncHorizonControls();
  syncMetricControls();
  elements.demoDataNote.hidden = !config.demoForecasts;
  elements.refreshButton.addEventListener('click', () => loadData({ force: true }));
  elements.retryLoad.addEventListener('click', () => loadData({ force: true }));
  elements.exportCsv.addEventListener('click', exportCsv);
  elements.districtFilter.addEventListener('change', () => {
    state.district = elements.districtFilter.value;
    renderListForCriteriaChange();
    if (state.district) focusDistrict(state.district);
  });
  elements.clearDistrict.addEventListener('click', () => {
    clearDistrictFilter();
  });
  document.querySelectorAll('[data-metric]').forEach((button) => {
    button.addEventListener('click', () => {
      state.metric = button.dataset.metric;
      if (state.horizon === 'now') state.horizon = 'h1';
      syncMetricControls();
      syncHorizonControls();
      renderListForCriteriaChange();
    });
  });
  document.querySelectorAll('[data-flow-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.flowFilter = button.dataset.flowFilter;
      document.querySelectorAll('[data-flow-filter]').forEach((item) => {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      renderListForCriteriaChange();
    });
  });
  document.querySelectorAll('[data-horizon]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.horizon === 'now') return;
      state.horizon = button.dataset.horizon;
      syncHorizonControls();
      renderMapLayers();
    });
  });
  document.querySelectorAll('[data-sort]').forEach((button) => {
    button.addEventListener('click', () => sortBy(button.dataset.sort));
  });
  elements.previousPage.addEventListener('click', () => { state.page -= 1; renderRows(); });
  elements.nextPage.addEventListener('click', () => { state.page += 1; renderRows(); });

  elements.search.addEventListener('input', () => {
    showSuggestions(elements.search.value);
    renderDashboard();
  });
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
  if (state.booted) return;
  state.booted = true;
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

if (!window.kakaoSdkFailed && window.kakao && window.kakao.maps && typeof window.kakao.maps.load === 'function') {
  try {
    window.kakao.maps.load(boot);
  } catch (error) {
    boot();
  }
} else {
  boot();
}