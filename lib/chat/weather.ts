/** 날씨 + 위치 조회 (Open-Meteo 무료 API + Nominatim 역지오코딩) */

import type { WeatherContext } from "./types";

/** 위도/경도 → 주소 변환 (Nominatim 무료 역지오코딩) */
async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=ko&zoom=14`;
    const res = await fetch(url, {
      headers: { "User-Agent": "maeum-ieu/1.0" },
    });
    if (!res.ok) return "";
    const data = await res.json() as {
      address?: {
        city?: string;
        county?: string;
        borough?: string;
        suburb?: string;
        town?: string;
        village?: string;
        state?: string;
      };
      display_name?: string;
    };
    const addr = data.address;
    if (!addr) return "";
    // 시/도 + 시/군/구 + 동/읍/면
    const parts = [
      addr.state,
      addr.city || addr.county,
      addr.borough || addr.suburb || addr.town || addr.village,
    ].filter(Boolean);
    return parts.join(" ") || "";
  } catch {
    return "";
  }
}

// 날씨·위치 캐시 — 외부 API(open-meteo + Nominatim)가 매 메시지마다 1~4.5s로 응답 지연 주범이라
//   위치별(약 1km 반올림) 20분 인메모리 캐시. 날씨는 자주 안 변하므로 안전.
const weatherCache = new Map<string, { ctx: WeatherContext; expires: number }>();
const WEATHER_TTL_MS = 20 * 60 * 1000;

export async function getWeatherContext(lat?: number, lon?: number): Promise<WeatherContext> {
  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const cached = weatherCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.ctx;
    try {
      // 날씨 + 위치 동시 조회
      const [weatherRes, location] = await Promise.all([
        fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=weather_code,temperature_2m&timezone=Asia%2FSeoul`),
        reverseGeocode(lat, lon),
      ]);

      let desc = "맑음";
      let temp = "";
      if (weatherRes.ok) {
        const data = (await weatherRes.json()) as { current?: { weather_code?: number; temperature_2m?: number } };
        const code = data.current?.weather_code ?? 0;
        desc = code === 0 ? "맑음" : code < 4 ? "대체로 맑음/흐림" : code < 70 ? "구름" : code < 90 ? "비 또는 눈" : "천둥/폭풍";
        if (data.current?.temperature_2m != null) {
          temp = `, ${data.current.temperature_2m}°C`;
        }
      }

      const locationText = location || "위치 미확인";
      const ctx: WeatherContext = {
        description: desc,
        location: locationText,
        promptText: `현재 날씨: ${desc}${temp}\n- 사용자 현재 위치: ${locationText}`,
      };
      weatherCache.set(cacheKey, { ctx, expires: Date.now() + WEATHER_TTL_MS });
      return ctx;
    } catch { /* fallback */ }
  }
  return { description: "맑음", location: "", promptText: "현재 날씨: 맑음 (위치 미제공 시 기본값)" };
}
