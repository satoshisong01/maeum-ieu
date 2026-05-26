/**
 * 일과/복약 알림 — 사용자 등록 시각이 도달했고 아직 알림 안 보낸 경우 AI가 먼저 말 건다.
 *
 * 정책:
 * - 시간 매칭은 KST 기준 HH:MM
 * - Backward tolerance 30분: 09:00 슬롯이면 09:00~09:30 사이에 접속하면 1회 알림
 * - 같은 슬롯 1회만 (lastTriggeredAt이 해당 슬롯의 정시보다 이후이면 skip)
 * - 비활성(enabled=false)이거나 times 비어있으면 skip
 */

import type { MedicationSchedule } from "@/generated/prisma/client/client";
import { nameSubj } from "./korean-particle";

export const TOLERANCE_MS = 30 * 60 * 1000; // 30분
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface DueSlot {
  scheduleId: string;
  label: string;
  slotTime: string;   // "09:00"
  slotIso: string;    // KST 기준 오늘의 슬롯 ISO
}

/**
 * 시간 문자열 "HH:MM"을 오늘 날짜의 KST Date로 변환.
 * 반환은 UTC Date지만 의미는 KST의 해당 시각.
 */
export function slotToTodayDate(slotHHMM: string, now: Date = new Date()): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(slotHHMM.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;

  // KST 기준 오늘 날짜를 추출 (UTC 시각에서 +9시간 한 다음 그 날짜를 사용)
  const kstNow = new Date(now.getTime() + KST_OFFSET_MS);
  const y = kstNow.getUTCFullYear();
  const mo = kstNow.getUTCMonth();
  const d = kstNow.getUTCDate();
  // KST 오늘 h:min을 UTC로 환원
  return new Date(Date.UTC(y, mo, d, h - 9, min, 0, 0));
}

/**
 * 한 스케줄에서 지금 시점에 fire해야 할 슬롯을 찾는다.
 * 슬롯 정시 ≤ now ≤ 슬롯 정시 + tolerance AND lastTriggeredAt < 슬롯 정시
 */
export function findDueSlot(
  schedule: Pick<MedicationSchedule, "id" | "label" | "times" | "enabled" | "lastTriggeredAt">,
  now: Date = new Date(),
): DueSlot | null {
  if (!schedule.enabled) return null;
  const times = Array.isArray(schedule.times) ? (schedule.times as unknown[]) : [];
  const last = schedule.lastTriggeredAt ? new Date(schedule.lastTriggeredAt).getTime() : 0;
  const tNow = now.getTime();

  // 가장 최근 슬롯부터 검사 (여러 슬롯 동시 due여도 가장 최신 1개만 fire)
  const candidates: { slot: string; ts: number }[] = [];
  for (const t of times) {
    if (typeof t !== "string") continue;
    const d = slotToTodayDate(t, now);
    if (!d) continue;
    const ts = d.getTime();
    if (tNow >= ts && tNow <= ts + TOLERANCE_MS && last < ts) {
      candidates.push({ slot: t, ts });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.ts - a.ts);
  const chosen = candidates[0];
  return {
    scheduleId: schedule.id,
    label: schedule.label,
    slotTime: chosen.slot,
    slotIso: new Date(chosen.ts).toISOString(),
  };
}

/**
 * AI가 먼저 거는 복약 알림 멘트 — 자연스럽고 짧게.
 */
export function buildMedicationReminder(
  label: string,
  slotTime: string,
  honorific: string,
  companionName: string,
): string {
  const variants = [
    `${honorific}, ${slotTime} ${label} 드실 시간이에요! ${nameSubj(companionName)} 잊으실까 봐 알려드려요. 드시고 나서 ${companionName}한테 말씀해주세요~`,
    `${honorific}! ${label} 챙겨 드실 시간이에요. ${nameSubj(companionName)} 옆에서 같이 챙겨드릴게요. 한 알 드시고 나면 알려주세요!`,
    `${honorific}, 시간 됐어요! ${label} 잊지 마시고 꼭 드세요. 다 드신 다음에 ${companionName}한테 알려주시면 좋아요.`,
  ];
  // 결정적이지만 슬롯 시각에 따라 살짝 다른 멘트
  const idx = Math.floor(parseInt(slotTime.replace(":", ""), 10) / 800) % variants.length;
  return variants[idx];
}

/**
 * times 입력 정규화 — "9:00" → "09:00", 잘못된 항목 제거, 중복 제거, 정렬.
 */
export function normalizeTimes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const t of input) {
    if (typeof t !== "string") continue;
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m) continue;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) continue;
    out.add(`${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
  }
  return Array.from(out).sort();
}
