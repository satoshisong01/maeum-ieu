/** KST 시간 관련 유틸리티 */

import type { TimeContext } from "./types";
import { DATE_TIME_PATTERNS, RELATIVE_TIME_EXCLUDE_PATTERNS } from "./constants";

export function getTimeContext(clientTimeIso?: string): TimeContext {
  const now = clientTimeIso ? new Date(clientTimeIso) : new Date();
  const kr = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const hour = kr.getHours();

  const dateStr = now.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  });

  let timeLabel = "오후";
  if (hour >= 5 && hour < 10) timeLabel = "아침";
  else if (hour >= 10 && hour < 14) timeLabel = "오전";
  else if (hour >= 14 && hour < 17) timeLabel = "점심 시간대";
  else if (hour >= 17 && hour < 21) timeLabel = "저녁";

  return { timeLabel, hour, dateStr };
}

export function getCurrentKstDateTimeString(clientTimeIso?: string): string {
  const now = clientTimeIso ? new Date(clientTimeIso) : new Date();
  return now.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function getNowKst(): Date {
  const s = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" });
  return new Date(s.replace(" ", "T") + "+09:00");
}

export function toKstDateString(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

export function isDateTimeQuestion(text: string): boolean {
  const t = text.trim().replace(/\s+/g, " ");
  // "몇일전", "며칠 후" 같은 상대 시점 표현은 날짜 질문이 아님
  if (RELATIVE_TIME_EXCLUDE_PATTERNS.some((p) => p.test(t))) return false;
  return DATE_TIME_PATTERNS.some((p) => p.test(t));
}

/**
 * 과거 시점과 현재 시점의 차이를 사람이 읽기 쉬운 한국어로 반환.
 * 예: "방금", "10분 전", "2시간 전", "어제 오후", "3일 전", "1주일 전", "오래 전"
 */
export function getRelativeTimeLabel(past: Date | string, now: Date = new Date()): string {
  const pastDate = typeof past === "string" ? new Date(past) : past;
  const diffMs = now.getTime() - pastDate.getTime();
  if (diffMs < 0) return "방금";

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;

  // 일 단위: KST 날짜 기준으로 계산 (시차 없이 "오늘/어제"를 정확히 판단)
  const todayKst = toKstDateString(now);
  const pastKst = toKstDateString(pastDate);
  const todayDate = new Date(todayKst + "T00:00:00+09:00");
  const pastDateOnly = new Date(pastKst + "T00:00:00+09:00");
  const dayDiff = Math.round((todayDate.getTime() - pastDateOnly.getTime()) / 86400000);

  if (dayDiff === 0) return `${hours}시간 전`;
  if (dayDiff === 1) return "어제";
  if (dayDiff < 7) return `${dayDiff}일 전`;
  if (dayDiff < 14) return "1주일 전";
  if (dayDiff < 30) return `${Math.floor(dayDiff / 7)}주 전`;
  return "오래 전";
}
