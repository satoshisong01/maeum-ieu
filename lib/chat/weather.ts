/** 날씨 조회 (Open-Meteo 무료 API) */

import type { WeatherContext } from "./types";

const WEATHER_CODE_MAP: [number, string][] = [
  [0, "맑음"],
  [4, "대체로 맑음/흐림"],
  [70, "비/눈 없음 구름"],
  [90, "비 또는 눈"],
];

function describeWeatherCode(code: number): string {
  for (const [threshold, label] of WEATHER_CODE_MAP) {
    if (code < threshold) return label;
  }
  return code === 0 ? "맑음" : "천둥/폭풍";
}

/** 위도/경도로 현재 날씨 조회. 실패 시 기본값 반환 */
export async function getWeatherContext(
  lat?: number,
  lon?: number,
): Promise<WeatherContext> {
  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=weather_code&timezone=Asia%2FSeoul`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { current?: { weather_code?: number } };
        const code = data.current?.weather_code ?? 0;
        const description = describeWeatherCode(code);
        return { description, promptText: `현재 날씨: ${description}` };
      }
    } catch {
      // fallback
    }
  }
  return {
    description: "맑음",
    promptText: "현재 날씨: 맑음 (위치 미제공 시 기본값)",
  };
}
