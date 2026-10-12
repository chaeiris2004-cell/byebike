import json
import math
import os
import threading
import time
from datetime import datetime, timedelta, timezone
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import Request, urlopen


BASE_DIR = Path(__file__).resolve().parent
API_BASE = "http://openapi.seoul.go.kr:8088"
CACHE_SECONDS = 300
DAILY_CALL_LIMIT = 800
DIRECTORY_CACHE_SECONDS = 21600
PAGE_SIZE = 1000
SAMPLE_PAGE_SIZE = 5
SEOUL_DISTRICTS = (
    "종로구", "중구", "용산구", "성동구", "광진구", "동대문구", "중랑구", "성북구",
    "강북구", "도봉구", "노원구", "은평구", "서대문구", "마포구", "양천구", "강서구",
    "구로구", "금천구", "영등포구", "동작구", "관악구", "서초구", "강남구", "송파구",
    "강동구",
)
QUOTA_FILE = BASE_DIR / ".quota.json"
KOREA_TIMEZONE = timezone(timedelta(hours=9))
cache_lock = threading.Lock()
quota_lock = threading.Lock()
directory_cache_lock = threading.Lock()
cached_result = None
cache_expires_at = 0.0
cached_stale_reason = None
cached_directory = None
directory_cache_expires_at = 0.0


def load_env_file():
    env_path = BASE_DIR / ".env"
    if not env_path.is_file():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        name, separator, value = line.partition("=")
        if not separator:
            continue
        name = name.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        os.environ.setdefault(name, value)


load_env_file()


class ApiError(Exception):
    pass


class QuotaExceeded(ApiError):
    pass


def reserve_api_call():
    today = datetime.now(KOREA_TIMEZONE).date().isoformat()
    with quota_lock:
        if QUOTA_FILE.exists():
            try:
                quota = json.loads(QUOTA_FILE.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise ApiError("서울 API 호출 한도 정보를 읽을 수 없습니다.") from error
        else:
            quota = {}

        if not isinstance(quota, dict):
            raise ApiError("서울 API 호출 한도 정보가 올바르지 않습니다.")
        count = quota.get("count", 0) if quota.get("date") == today else 0
        if not isinstance(count, int) or count < 0:
            raise ApiError("서울 API 호출 한도 정보가 올바르지 않습니다.")
        if count >= DAILY_CALL_LIMIT:
            raise QuotaExceeded("일일 서울 API 호출 한도에 도달했습니다.")

        temporary_file = QUOTA_FILE.with_suffix(".json.tmp")
        try:
            temporary_file.write_text(
                json.dumps({"date": today, "count": count + 1}),
                encoding="utf-8",
            )
            temporary_file.replace(QUOTA_FILE)
        except OSError as error:
            raise ApiError("서울 API 호출 한도 정보를 저장할 수 없습니다.") from error


def fetch_page(api_key, start, end, service="bikeList", response_key="rentBikeStatus"):
    if api_key != "sample":
        reserve_api_call()
    encoded_key = quote(api_key, safe="")
    url = f"{API_BASE}/{encoded_key}/json/{service}/{start}/{end}/"
    request = Request(url, headers={"User-Agent": "TtareungyiMap/1.0"})
    with urlopen(request, timeout=15) as response:
        body = response.read()

    try:
        payload = json.loads(body.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        try:
            root = ET.fromstring(body)
        except ET.ParseError:
            raise ApiError("서울 API가 JSON 또는 XML 응답을 반환하지 않았습니다.") from None
        values = {
            node.tag.split("}")[-1]: (node.text or "").strip()
            for node in root.iter()
            if len(node) == 0
        }
        code = values.get("CODE", "API-ERROR")
        message = values.get("MESSAGE", "서울 API에서 오류 응답을 반환했습니다.")
        raise ApiError(f"{code}: {message}")

    data = payload.get(response_key)
    if not isinstance(data, dict):
        result = payload.get("RESULT", {})
        message = result.get("MESSAGE", "서울 API 응답 형식이 올바르지 않습니다.")
        raise ApiError(message)

    result = data.get("RESULT", {})
    if result.get("CODE") not in (None, "INFO-000"):
        raise ApiError(result.get("MESSAGE", "서울 API 요청에 실패했습니다."))
    return data


def read_api_key():
    configured = os.environ.get("bike_api", "").strip() or os.environ.get("SEOUL_API_KEY", "").strip()
    if not configured:
        return ""

    parsed = urlsplit(configured)
    if not parsed.scheme and not parsed.netloc:
        return configured
    if parsed.scheme not in ("http", "https") or parsed.hostname != "openapi.seoul.go.kr":
        raise ApiError("bike_api URL은 openapi.seoul.go.kr의 요청 URL이어야 합니다.")

    segments = [unquote(segment) for segment in parsed.path.split("/") if segment]
    if len(segments) < 5 or segments[1] != "json" or segments[2] not in ("bikeList", "bikeListHist"):
        raise ApiError("bike_api URL에서 서울 API 인증키를 찾을 수 없습니다.")
    return segments[0]


def parse_int(value):
    try:
        return int(float(str(value).replace(",", "")))
    except (OverflowError, TypeError, ValueError):
        return None


def parse_float(value):
    try:
        parsed = float(str(value).replace(",", ""))
        return parsed if math.isfinite(parsed) else None
    except (OverflowError, TypeError, ValueError):
        return None


def normalize_station(row):
    known_fields = {
        "stationId",
        "stationName",
        "stationLatitude",
        "stationLongitude",
        "rackTotCnt",
        "parkingBikeTotCnt",
        "shared",
    }
    return {
        "id": str(row.get("stationId", "")),
        "name": str(row.get("stationName", "이름 없는 대여소")),
        "latitude": parse_float(row.get("stationLatitude")),
        "longitude": parse_float(row.get("stationLongitude")),
        "rackCount": parse_int(row.get("rackTotCnt")),
        "bikeCount": parse_int(row.get("parkingBikeTotCnt")),
        "shared": parse_float(row.get("shared")),
        "extra": {key: value for key, value in row.items() if key not in known_fields},
    }


def haversine_distance(latitude, longitude, other_latitude, other_longitude):
    earth_radius_km = 6371.0
    latitude_delta = math.radians(other_latitude - latitude)
    longitude_delta = math.radians(other_longitude - longitude)
    latitude_radians = math.radians(latitude)
    other_latitude_radians = math.radians(other_latitude)
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(latitude_radians)
        * math.cos(other_latitude_radians)
        * math.sin(longitude_delta / 2) ** 2
    )
    haversine = min(1.0, max(0.0, haversine))
    return 2 * earth_radius_km * math.asin(math.sqrt(haversine))


def has_valid_coordinates(location):
    latitude = location["latitude"]
    longitude = location["longitude"]
    return (
        isinstance(latitude, (int, float))
        and math.isfinite(latitude)
        and isinstance(longitude, (int, float))
        and math.isfinite(longitude)
    )


def infer_station_districts(directory):
    for location in directory.values():
        if location["district"]:
            continue
        address_district = next(
            (district for district in SEOUL_DISTRICTS if district in location["address"]),
            None,
        )
        if address_district:
            location["district"] = address_district
            location["districtInferred"] = True

    district_stations = [
        location
        for location in directory.values()
        if location["district"]
        and has_valid_coordinates(location)
    ]
    for location in directory.values():
        if location["district"]:
            continue
        if not has_valid_coordinates(location):
            continue
        nearest = min(
            district_stations,
            key=lambda candidate: haversine_distance(
                location["latitude"],
                location["longitude"],
                candidate["latitude"],
                candidate["longitude"],
            ),
            default=None,
        )
        if nearest:
            location["district"] = nearest["district"]
            location["districtInferred"] = True


def fetch_all_rows(api_key, service, response_key, page_size, paginate=True):
    first_page = fetch_page(api_key, 1, page_size, service, response_key)
    rows = list(first_page.get("row", []))
    start = len(rows) + 1

    while paginate and len(rows) and len(rows) % page_size == 0:
        end = start + page_size - 1
        try:
            page = fetch_page(api_key, start, end, service, response_key)
        except ApiError as error:
            if str(error).startswith("INFO-200:"):
                break
            raise
        page_rows = list(page.get("row", []))
        rows.extend(page_rows)
        start += len(page_rows)
        if len(page_rows) < page_size:
            break

    return rows


def load_station_directory(api_key):
    global cached_directory, directory_cache_expires_at
    with directory_cache_lock:
        now = time.monotonic()
        if cached_directory is not None and now < directory_cache_expires_at:
            return cached_directory

        rows = fetch_all_rows(api_key, "tbCycleStationInfo", "stationInfo", PAGE_SIZE)
        directory = {}
        for row in rows:
            station_id = str(row.get("RENT_ID", ""))
            if not station_id:
                continue
            district = row.get("STA_LOC")
            address_parts = (row.get("STA_ADD1"), row.get("STA_ADD2"))
            directory[station_id] = {
                "district": str(district).strip() if district is not None else "",
                "address": " ".join(
                    str(part).strip()
                    for part in address_parts
                    if part is not None and str(part).strip()
                ),
                "latitude": parse_float(row.get("STA_LAT")),
                "longitude": parse_float(row.get("STA_LONG")),
            }

        infer_station_districts(directory)
        cached_directory = directory
        directory_cache_expires_at = time.monotonic() + DIRECTORY_CACHE_SECONDS
        return directory


def load_stations():
    api_key = read_api_key()
    is_sample = not api_key
    api_key = api_key or "sample"
    page_size = SAMPLE_PAGE_SIZE if is_sample else PAGE_SIZE
    rows = fetch_all_rows(api_key, "bikeList", "rentBikeStatus", page_size, paginate=not is_sample)
    directory = {} if is_sample else load_station_directory(api_key)

    stations = []
    for row in rows:
        station = normalize_station(row)
        location = directory.get(station["id"], {})
        station["district"] = location.get("district", "")
        station["address"] = location.get("address", "")
        if location.get("districtInferred"):
            station["districtInferred"] = True
        station["latitude"] = station["latitude"] if station["latitude"] is not None else location.get("latitude")
        station["longitude"] = station["longitude"] if station["longitude"] is not None else location.get("longitude")
        stations.append(station)

    return {
        "source": "sample" if is_sample else "live",
        "fetchedAt": time.time(),
        "totalCount": len(stations),
        "stations": stations,
    }


def get_stations():
    global cached_result, cache_expires_at, cached_stale_reason
    now = time.monotonic()
    with cache_lock:
        if now < cache_expires_at:
            if cached_result is not None:
                return station_response()
            raise ApiError("서울 API 재조회 대기 중이며 사용할 캐시가 없습니다.")

        cache_expires_at = now + CACHE_SECONDS
        try:
            result = load_stations()
        except QuotaExceeded:
            cache_expires_at = time.monotonic() + CACHE_SECONDS
            if cached_result is None:
                raise
            cached_stale_reason = "quota"
            return station_response()
        except (ApiError, URLError, TimeoutError, ValueError, OSError):
            cache_expires_at = time.monotonic() + CACHE_SECONDS
            if cached_result is None:
                raise
            cached_stale_reason = "error"
            return station_response()

        cached_result = result
        cached_stale_reason = None
        cache_expires_at = time.monotonic() + max(
            0,
            result["fetchedAt"] + CACHE_SECONDS - time.time(),
        )
        return station_response()


def station_response():
    response = dict(cached_result)
    response["nextFetchAt"] = response["fetchedAt"] + CACHE_SECONDS
    if cached_stale_reason:
        response["stale"] = True
        response["staleReason"] = cached_stale_reason
    else:
        response.pop("stale", None)
        response.pop("staleReason", None)
    return response


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/stations":
            try:
                self.send_json(200, get_stations())
            except (ApiError, URLError, TimeoutError, ValueError, OSError) as error:
                message = str(error) if isinstance(error, ApiError) else "서울 API에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요."
                self.send_json(502, {"error": message, "fetchedAt": None, "nextFetchAt": None})
            return

        static_files = {
            "/": ("operator-dashboard.html", "text/html; charset=utf-8"),
            "/operator-dashboard.html": ("operator-dashboard.html", "text/html; charset=utf-8"),
            "/dashboard.css": ("dashboard.css", "text/css; charset=utf-8"),
            "/dashboard-config.js": ("dashboard-config.js", "text/javascript; charset=utf-8"),
            "/dashboard.js": ("dashboard.js", "text/javascript; charset=utf-8"),
            "/maptest.html": ("maptest.html", "text/html; charset=utf-8"),
        }
        if self.path in static_files:
            file_name, content_type = static_files[self.path]
            body = (BASE_DIR / file_name).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_error(404)


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5500"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"따릉이 지도 실행 중: http://{host}:{port}")
    print("bike_api 미설정 시 샘플 대여소 5개를 표시합니다.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()