"""서울 따릉이 bikeList API 갱신 시각 실측 스크립트.

목적: 대여소 재고(parkingBikeTotCnt)가 실제로 언제 갱신되는지 측정하여
      server.py의 CACHE_SECONDS, dashboard-config.js의 refreshIntervalMs 결정 근거로 사용.

사용법 (코드 폴더에서):
    python poll_test.py                      # 5개 대여소, 300초 간격, 36회 (약 3시간)
    python poll_test.py --count 3 --interval 60   # 동작 확인용 빠른 테스트 (3회 호출)

산출물: poll_log.csv (호출 1회당 대여소 1행), 종료 시 변경 요약 콘솔 출력.
호출은 주기당 1회(start=1, end=N)이며 재시도하지 않습니다. 인증키는 출력/기록하지 않습니다.
"""
import argparse
import csv
import time
from datetime import datetime
from pathlib import Path

import server  # .env 로드 및 read_api_key / fetch_page 재사용 (서버는 실행되지 않음)

LOG_PATH = Path(__file__).resolve().parent / "poll_log.csv"
FIELDS = ["polled_at", "elapsed_sec", "stationId", "stationName", "parkingBikeTotCnt", "rackTotCnt", "shared", "changed"]


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--interval", type=int, default=300, help="호출 간격(초), 기본 300")
    parser.add_argument("--count", type=int, default=36, help="총 호출 횟수, 기본 36")
    parser.add_argument("--stations", type=int, default=5, help="조회 대여소 수(1부터), 기본 5")
    args = parser.parse_args()

    api_key = server.read_api_key()
    if not api_key:
        print("bike_api 값을 .env에서 찾지 못했습니다. 종료합니다.")
        return

    print(f"측정 시작: {args.stations}개 대여소, {args.interval}초 간격, {args.count}회 (호출 1회/주기)")
    print(f"로그 파일: {LOG_PATH.name}  (중단: Ctrl+C)")

    previous = {}     # stationId -> 직전 재고
    change_times = {}  # stationId -> [변경 감지 시각 datetime]
    started = time.time()
    new_file = not LOG_PATH.exists()

    with open(LOG_PATH, "a", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        if new_file:
            writer.writeheader()

        for i in range(args.count):
            tick = time.time()
            polled_at = datetime.now()
            try:
                data = server.fetch_page(api_key, 1, args.stations)
                rows = data.get("row", [])
            except Exception as error:  # 재시도하지 않고 다음 주기로 진행
                print(f"[{now_str()}] 호출 {i + 1}/{args.count} 실패: {type(error).__name__}: {str(error)[:120]}")
                rows = []

            for row in rows:
                station_id = str(row.get("stationId", ""))
                stock = server.parse_int(row.get("parkingBikeTotCnt"))
                changed = ""
                if station_id in previous and previous[station_id] != stock:
                    changed = f"{previous[station_id]}->{stock}"
                    change_times.setdefault(station_id, []).append(polled_at)
                    print(f"변경 감지: {row.get('stationName')} ({station_id}) {previous[station_id]}→{stock} / {polled_at:%H:%M:%S}")
                previous[station_id] = stock
                writer.writerow({
                    "polled_at": polled_at.strftime("%Y-%m-%d %H:%M:%S"),
                    "elapsed_sec": int(tick - started),
                    "stationId": station_id,
                    "stationName": row.get("stationName", ""),
                    "parkingBikeTotCnt": stock,
                    "rackTotCnt": row.get("rackTotCnt", ""),
                    "shared": row.get("shared", ""),
                    "changed": changed,
                })
            handle.flush()
            if rows:
                print(f"[{now_str()}] 호출 {i + 1}/{args.count} 완료 ({len(rows)}개 대여소)")

            if i < args.count - 1:
                time.sleep(max(0, args.interval - (time.time() - tick)))

    print("\n=== 요약 ===")
    total = sum(len(v) for v in change_times.values())
    print(f"총 변경 감지: {total}건 / 대여소 {len(previous)}개")
    for station_id, times in change_times.items():
        print(f"{station_id}: " + ", ".join(t.strftime("%H:%M") for t in times))
    if total == 0:
        print("변경이 없었습니다. 이용이 적은 대여소일 수 있으니 --stations 값을 늘리거나 낮 시간대에 다시 측정해 주세요.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n사용자가 중단했습니다. poll_log.csv에 그때까지의 기록이 남아 있습니다.")
