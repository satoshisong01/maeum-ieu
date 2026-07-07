/**
 * 배포 환경변수 점검 — 현장 테스트/프로덕션 투입 전 필수 env 존재·형식 검증.
 *   ⚠️ 비밀값은 절대 출력하지 않음(존재·형식·기능 영향만 표시).
 *   로컬: `npx tsx scripts/check-env.ts` (.env 기준)
 *   프로덕션: Vercel에서 `vercel env pull .env.prod` 후 `dotenv -e .env.prod -- tsx scripts/check-env.ts`
 *             또는 배포 환경에서 직접 실행.
 */
import "dotenv/config";

type Sev = "critical" | "important" | "optional";
interface Check {
  label: string;
  sev: Sev;
  feature: string;
  breaks: string;                       // 없을 때 무슨 일이 나는지
  names: string[];                       // 이 중 하나라도 있으면 present (대체 허용: _B64 등)
  validate?: (v: string) => string | null; // 형식 오류 문자열 또는 null(정상)
}

function jsonFields(v: string, fields: string[]): string | null {
  try { const o = JSON.parse(v); for (const f of fields) if (!o[f]) return `JSON에 '${f}' 필드 없음`; return null; }
  catch { return "JSON 파싱 실패(한 줄인지·따옴표 확인)"; }
}
function b64Json(v: string, fields: string[]): string | null {
  try { return jsonFields(Buffer.from(v, "base64").toString("utf8"), fields); } catch { return "base64 디코드 실패"; }
}

const CHECKS: Check[] = [
  // ── 코어(앱 자체) ──
  { label: "DATABASE_URL", sev: "critical", feature: "DB", breaks: "앱 전체 동작 불가", names: ["DATABASE_URL"],
    validate: v => /^postgres(ql)?:\/\//.test(v) ? null : "postgres URL 형식 아님" },
  { label: "GEMINI_API_KEY", sev: "critical", feature: "AI 대화·분석", breaks: "대화·인지분석·백스톱 전부 불가", names: ["GEMINI_API_KEY"] },
  { label: "NEXTAUTH_SECRET", sev: "critical", feature: "로그인 세션(JWT 서명)", breaks: "로그인 불가 또는 세션 위조 위험", names: ["NEXTAUTH_SECRET"],
    validate: v => v.length >= 32 ? null : "32자 미만 — 더 긴 무작위 값 권장" },
  // ── 위급 알림(현장 테스트 핵심) ──
  { label: "FCM_SERVICE_ACCOUNT(_B64)", sev: "critical", feature: "보호자 앱 푸시", breaks: "앱 위급 알림이 조용히 skip됨", names: ["FCM_SERVICE_ACCOUNT_B64", "FCM_SERVICE_ACCOUNT"],
    validate: v => (v.trim().startsWith("{") ? jsonFields(v, ["project_id", "private_key", "client_email"]) : b64Json(v, ["project_id", "private_key", "client_email"])) },
  { label: "ENCRYPTION_KEY", sev: "critical", feature: "연락처 PII 암/복호화", breaks: "보호자 이메일/전화 복호화 불가 → 이메일 알림 실패, PII 평문 저장",
    names: ["ENCRYPTION_KEY"], validate: v => /^[0-9a-fA-F]{64}$/.test(v) ? null : (v.length >= 16 ? "hex64 아님 → 패스프레이즈로 SHA-256 파생됨(정상이나 ⚠️바뀌면 기존 데이터 복호화 불가)" : "너무 짧음") },
  { label: "GMAIL_USER + GMAIL_APP_PASSWORD", sev: "important", feature: "이메일 위급 알림", breaks: "이메일 채널 미동작(앱푸시/webhook은 별개)", names: ["GMAIL_USER"],
    validate: v => { const pw = process.env.GMAIL_APP_PASSWORD; if (!pw) return "GMAIL_APP_PASSWORD 없음"; if (!/@/.test(v)) return "GMAIL_USER 이메일 형식 아님"; return null; } },
  // ── 음성(TTS) — 계획 env 목록에 누락돼 있었음 ──
  { label: "GOOGLE_APPLICATION_CREDENTIALS_JSON(_B64)", sev: "important", feature: "Google Cloud 고품질 TTS", breaks: "Cloud TTS 불가 → Gemini TTS 폴백(GEMINI_API_KEY)으로 동작하나 음질/지연 확인 필요",
    names: ["GOOGLE_APPLICATION_CREDENTIALS_JSON", "GOOGLE_APPLICATION_CREDENTIALS_B64"],
    validate: v => (v.trim().startsWith("{") ? jsonFields(v, ["project_id", "private_key", "client_email"]) : b64Json(v, ["project_id", "private_key", "client_email"])) },
  { label: "GCP_PROJECT_ID", sev: "important", feature: "서버 TTS", breaks: "TTS 프로젝트 식별 불가", names: ["GCP_PROJECT_ID"] },
  // ── rate-limit ──
  { label: "UPSTASH_REDIS_REST_URL + _TOKEN", sev: "important", feature: "분산 rate-limit", breaks: "인메모리 폴백(서버리스에서 부정확·남용 방어 약화)", names: ["UPSTASH_REDIS_REST_URL"],
    validate: v => { if (!process.env.UPSTASH_REDIS_REST_TOKEN) return "UPSTASH_REDIS_REST_TOKEN 없음"; return /^https:\/\//.test(v) ? null : "https URL 아님"; } },
];

const icon = { ok: "✅", miss: "❌", warn: "⚠️ " };
const sevTag = { critical: "🔴 필수", important: "🟠 권장", optional: "🟡 선택" };

let criticalMissing = 0, importantMissing = 0;
console.log(`\n===== 배포 env 점검 (NODE_ENV=${process.env.NODE_ENV || "development"}) =====`);
console.log(`※ 비밀값은 표시하지 않음 — 존재·형식만 검사\n`);

for (const c of CHECKS) {
  const val = c.names.map(n => process.env[n]).find(v => v && v.length > 0);
  if (!val) {
    console.log(`${icon.miss} ${sevTag[c.sev]}  ${c.label} — 없음`);
    console.log(`      ↳ ${c.breaks}`);
    if (c.sev === "critical") criticalMissing++; else if (c.sev === "important") importantMissing++;
    continue;
  }
  const err = c.validate ? c.validate(val) : null;
  if (err && err.startsWith("hex64")) console.log(`${icon.warn}${sevTag[c.sev]}  ${c.label} — 있음 (${err})`);
  else if (err) { console.log(`${icon.warn}${sevTag[c.sev]}  ${c.label} — 있으나 형식 이상: ${err}`); if (c.sev === "critical") criticalMissing++; }
  else console.log(`${icon.ok} ${sevTag[c.sev]}  ${c.label} — OK (${c.feature})`);
}

// 주의 플래그
console.log("");
if (process.env.DATABASE_SSL_NO_VERIFY === "1")
  console.log(`${icon.warn}주의: DATABASE_SSL_NO_VERIFY=1 — 프로덕션에서는 인증서 검증 비활성화(중간자 위험). 프로드에서 제거 권장.`);

console.log(`\n===== 판정 =====`);
console.log(`🔴 필수 누락/오류: ${criticalMissing}  ·  🟠 권장 누락: ${importantMissing}`);
if (criticalMissing > 0) console.log(`❌ 현장 테스트 불가 — 필수 env를 채운 뒤 재확인하세요.`);
else if (importantMissing > 0) console.log(`⚠️  가능하나 일부 기능 제한(위 권장 항목 확인). 특히 알림/음성 채널.`);
else console.log(`✅ 필수·권장 env 모두 충족.`);
console.log(`\n※ 이 결과는 실행한 환경(.env)의 것 — 프로덕션 판정은 Vercel 환경에서 동일 실행해야 확정됩니다.`);
process.exit(criticalMissing > 0 ? 1 : 0);
