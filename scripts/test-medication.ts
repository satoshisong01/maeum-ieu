// 복약 알림 시간 매칭 + 멘트 빌더 + 입력 정규화 검증
import { findDueSlot, slotToTodayDate, buildMedicationReminder, normalizeTimes, TOLERANCE_MS } from "../lib/chat/medication";

// 헬퍼: KST 시각으로 Date 만들기
function kstDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, 0, 0));
}

let pass = 0, fail = 0;
function assert(cond: boolean, label: string, ctx?: unknown) {
  if (cond) { console.log(`✓ ${label}`); pass++; }
  else { console.log(`✗ ${label}`); if (ctx) console.log("  ctx:", JSON.stringify(ctx)); fail++; }
}

// 1) slotToTodayDate — "09:00" + KST 2026-05-18 10:00 → 2026-05-18 KST 09:00
{
  const now = kstDate(2026, 5, 18, 10, 0);
  const d = slotToTodayDate("09:00", now);
  assert(d !== null, "유효 slot 파싱");
  if (d) {
    const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    assert(kst.getUTCHours() === 9 && kst.getUTCMinutes() === 0, "KST 09:00 매핑", { kst: kst.toISOString() });
  }
}
{
  assert(slotToTodayDate("25:00") === null, "invalid hour 25 → null");
  assert(slotToTodayDate("ab:cd") === null, "non-numeric → null");
  assert(slotToTodayDate("") === null, "빈 문자열 → null");
}

// 2) findDueSlot — 슬롯 정시 도달, lastTriggeredAt 없음 → due
{
  const now = kstDate(2026, 5, 18, 9, 5);     // KST 09:05
  const sched = {
    id: "s1", label: "혈압약",
    times: ["09:00", "13:00", "20:00"],
    enabled: true, lastTriggeredAt: null,
  };
  const due = findDueSlot(sched, now);
  assert(due !== null && due.slotTime === "09:00", "09:05 → 09:00 슬롯 due", due);
}

// 3) Backward tolerance — 09:25 까지는 잡힘 (30분 tolerance)
{
  const now = kstDate(2026, 5, 18, 9, 25);
  const sched = { id: "s1", label: "혈압약", times: ["09:00"], enabled: true, lastTriggeredAt: null };
  const due = findDueSlot(sched, now);
  assert(due !== null, "09:25 → 09:00 슬롯 여전히 due (tolerance 30분)");
}

// 4) Tolerance 초과 — 09:35는 skip (30분 초과)
{
  const now = kstDate(2026, 5, 18, 9, 35);
  const sched = { id: "s1", label: "혈압약", times: ["09:00"], enabled: true, lastTriggeredAt: null };
  const due = findDueSlot(sched, now);
  assert(due === null, "09:35 → tolerance 초과로 skip");
}

// 5) 이미 트리거됨 — 같은 슬롯 재발송 안 함
{
  const now = kstDate(2026, 5, 18, 9, 10);
  const slotAt = kstDate(2026, 5, 18, 9, 0).getTime();
  const sched = {
    id: "s1", label: "혈압약", times: ["09:00"], enabled: true,
    lastTriggeredAt: new Date(slotAt + 1000), // 09:00 이후에 발송됨
  };
  const due = findDueSlot(sched, now);
  assert(due === null, "lastTriggeredAt > slot이면 skip");
}

// 6) 비활성화된 스케줄 → 항상 skip
{
  const now = kstDate(2026, 5, 18, 9, 5);
  const sched = { id: "s1", label: "혈압약", times: ["09:00"], enabled: false, lastTriggeredAt: null };
  assert(findDueSlot(sched, now) === null, "enabled=false → skip");
}

// 7) 여러 슬롯 동시 due — 가장 최근 슬롯 선택
{
  const now = kstDate(2026, 5, 18, 13, 5);
  const sched = { id: "s1", label: "혈압약", times: ["09:00", "13:00"], enabled: true, lastTriggeredAt: null };
  // 09:00 슬롯은 tolerance 초과로 이미 만료, 13:00만 due
  const due = findDueSlot(sched, now);
  assert(due !== null && due.slotTime === "13:00", "13:05 → 13:00 슬롯 선택");
}

// 8) 정시 정확히 → due (경계)
{
  const now = kstDate(2026, 5, 18, 9, 0);
  const sched = { id: "s1", label: "혈압약", times: ["09:00"], enabled: true, lastTriggeredAt: null };
  assert(findDueSlot(sched, now) !== null, "정시 정확히 09:00 → due");
}

// 9) 정시 1초 전 → not due (아직 시간 안 됨)
{
  const slotAt = kstDate(2026, 5, 18, 9, 0).getTime();
  const now = new Date(slotAt - 1000);
  const sched = { id: "s1", label: "혈압약", times: ["09:00"], enabled: true, lastTriggeredAt: null };
  assert(findDueSlot(sched, now) === null, "정시 1초 전 → not due");
}

// 10) times에 잘못된 항목 섞임 → 무시
{
  const now = kstDate(2026, 5, 18, 9, 5);
  const sched = {
    id: "s1", label: "혈압약",
    times: ["09:00", "invalid", "25:00", "9:5", ""] as unknown,
    enabled: true, lastTriggeredAt: null,
  } as Parameters<typeof findDueSlot>[0];
  const due = findDueSlot(sched, now);
  assert(due !== null && due.slotTime === "09:00", "유효한 09:00만 매칭");
}

// 11) normalizeTimes
{
  const r1 = normalizeTimes(["9:00", "13:00", "9:00", "invalid", "25:00"]);
  assert(JSON.stringify(r1) === JSON.stringify(["09:00", "13:00"]), "정규화 + 중복 제거 + 정렬", r1);
  const r2 = normalizeTimes("not array" as unknown);
  assert(r2.length === 0, "비-배열 → 빈 배열");
}

// 12) buildMedicationReminder
{
  const msg = buildMedicationReminder("혈압약", "09:00", "할아버지", "민지");
  assert(msg.includes("혈압약") && msg.includes("할아버지") && msg.includes("민지"), "멘트에 라벨/호칭/companion 포함", msg);
  assert(msg.length < 200, "멘트 길이 적당");
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
