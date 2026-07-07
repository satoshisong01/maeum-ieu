/**
 * 파일럿 일일 점검 — 현장 테스트 기간 매일 아침 1회 실행하는 관제 스크립트.
 *   배경: Vercel Hobby는 에러 모니터링·cron·로그 보존이 없어 장애를 아무도 모름(2026-07-07 감사 high).
 *   이 스크립트가 그 갭을 사람-루프로 메움. 읽기 전용(DB 쓰기 없음).
 *
 * 실행: npx tsx scripts/pilot-daily-check.ts [조회일수=2]
 * 종료코드: 미발송 응급(🔴)이 있으면 1, 아니면 0.
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";

const DAYS = Math.max(1, parseInt(process.argv[2] || "2", 10) || 2);
const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

const FALLBACK_MARKS = ["잠깐 멍해졌어요", "제대로 못 들었나 봐요", "생각이 꼬였네요", "잠깐 정신이 흐릿했어요"];

async function main() {
  console.log(`\n═══════ 마음이음 파일럿 일일 점검 (최근 ${DAYS}일) ═══════`);

  // ── 1) 🔴 미발송 응급 워치독 — 가장 중요. 알림 채널이 조용히 죽으면 여기서 드러남 ──
  const unnotified = await prisma.message.findMany({
    where: { emergencyLevel: { gte: 2 }, notifiedAt: null, createdAt: { gte: since }, role: "user" },
    select: { id: true, emergencyLevel: true, emergencyEvidence: true, createdAt: true, conversation: { select: { userId: true } } },
    orderBy: { createdAt: "desc" },
  });
  const critical: string[] = [];
  for (const m of unnotified) {
    const uid = m.conversation.userId;
    const [links, u] = await Promise.all([
      prisma.expertPatient.count({ where: { patientUserId: uid, status: "active" } }),
      prisma.user.findUnique({ where: { id: uid }, select: { guardianWebhookUrl: true, guardianEmail: true, name: true } }),
    ]);
    const hadTargets = links > 0 || Boolean(u?.guardianWebhookUrl) || Boolean(u?.guardianEmail);
    if (hadTargets) {
      critical.push(`  🔴 L${m.emergencyLevel} ${(m.emergencyEvidence || "").slice(0, 30)} | ${u?.name ?? uid.slice(0, 8)} @${m.createdAt.toISOString().slice(0, 16)} (연결 ${links})`);
    }
  }
  console.log(`\n[1] 미발송 응급 워치독`);
  if (critical.length) {
    console.log(`  ❌ 알림 대상이 있는데 발송 안 된 응급 ${critical.length}건 — FCM 자격증명/채널 즉시 점검!`);
    critical.forEach((l) => console.log(l));
  } else if (unnotified.length) {
    console.log(`  ✅ 발송 실패 0건 (미발송 ${unnotified.length}건은 전부 보호자 미연결 사용자 — 정상)`);
  } else {
    console.log(`  ✅ 미발송 응급 없음`);
  }

  // ── 2) 응급 발생·발송 현황 (24h) ──
  const emg = await prisma.message.findMany({
    where: { emergencyLevel: { gte: 1 }, createdAt: { gte: last24h }, role: "user" },
    select: { emergencyLevel: true, emergencyEvidence: true, notifiedAt: true },
  });
  const byLvl = [1, 2, 3].map((l) => emg.filter((m) => m.emergencyLevel === l).length);
  const sent = emg.filter((m) => m.notifiedAt).length;
  const byBackstop = emg.filter((m) => (m.emergencyEvidence || "").includes(":llm:")).length;
  console.log(`\n[2] 응급 현황(24h): L1 ${byLvl[0]} · L2 ${byLvl[1]} · L3 ${byLvl[2]} — 알림 발송 ${sent}건, 백스톱 감지 ${byBackstop}건`);

  // ── 3) 활동량 (24h) ──
  const userMsgs = await prisma.message.findMany({
    where: { role: "user", createdAt: { gte: last24h } },
    select: { conversation: { select: { userId: true } } },
  });
  const activeUsers = new Set(userMsgs.map((m) => m.conversation.userId));
  const newUsers = await prisma.user.count({ where: { createdAt: { gte: last24h } } });
  console.log(`\n[3] 활동(24h): 발화 ${userMsgs.length}건 · 활성 사용자 ${activeUsers.size}명 · 신규 가입 ${newUsers}명`);
  if (userMsgs.length === 0) console.log(`  ⚠️ 발화 0건 — 파일럿 중이라면 앱/서버 접속 문제 가능성 확인`);

  // ── 4) 폴백(빈 응답)률 (24h) — 높으면 Gemini 쿼터/장애 신호 ──
  const aiMsgs = await prisma.message.findMany({
    where: { role: "assistant", createdAt: { gte: last24h } },
    select: { content: true },
  });
  const fallbacks = aiMsgs.filter((m) => FALLBACK_MARKS.some((f) => m.content.includes(f))).length;
  const rate = aiMsgs.length ? ((fallbacks / aiMsgs.length) * 100).toFixed(1) : "0.0";
  console.log(`\n[4] 폴백률(24h): ${fallbacks}/${aiMsgs.length} (${rate}%)`);
  if (aiMsgs.length >= 10 && fallbacks / aiMsgs.length > 0.1) console.log(`  ⚠️ 10% 초과 — Gemini 쿼터(429)/장애 가능성. Vercel 로그·사용량 확인`);
  else console.log(`  ✅ 정상 범위`);

  // ── 5) 보호자 연결 현황 — 온보딩 빠짐 감지 ──
  const patients = await prisma.user.findMany({ where: { screeningMode: "user" }, select: { id: true, name: true, createdAt: true } });
  const recentPatients = patients.filter((p) => p.createdAt >= since);
  const unlinked: string[] = [];
  for (const pt of recentPatients) {
    const links = await prisma.expertPatient.count({ where: { patientUserId: pt.id, status: "active" } });
    if (links === 0) unlinked.push(pt.name ?? pt.id.slice(0, 8));
  }
  console.log(`\n[5] 보호자 연결: 최근 ${DAYS}일 신규 어르신 ${recentPatients.length}명 중 미연결 ${unlinked.length}명${unlinked.length ? ` — ${unlinked.join(", ")}` : ""}`);
  if (unlinked.length) console.log(`  ⚠️ 미연결 어르신은 위급 시 앱 알림이 가지 않음 — 온보딩(코드 연결) 마저 진행 필요`);

  console.log(`\n═══════ 판정: ${critical.length ? "🔴 즉시 조치 필요(위 [1])" : "✅ 이상 없음"} ═══════\n`);
  await prisma.$disconnect();
  process.exit(critical.length ? 1 : 0);
}
main().catch((e) => { console.error("점검 실패:", e.message); process.exit(2); });
