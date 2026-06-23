/**
 * 위급 알림 이메일 발송 — Resend.
 * RESEND_API_KEY env 없으면 graceful skip. from은 RESEND_FROM env(없으면 onboarding@resend.dev 테스트용).
 *   ⚠️ 임의 수신자에게 보내려면 Resend에서 발신 도메인 인증 필요(테스트는 본인 메일만 가능).
 */
import { Resend } from "resend";

let cached: Resend | null | undefined;
function getResend(): Resend | null {
  if (cached !== undefined) return cached;
  const key = process.env.RESEND_API_KEY;
  cached = key ? new Resend(key) : null;
  return cached;
}

export interface EmergencyEmailPayload {
  userName: string;
  level: 2 | 3;
  category: string;
  createdAt: Date;
}

export async function sendEmergencyEmail(to: string, p: EmergencyEmailPayload): Promise<boolean> {
  const resend = getResend();
  if (!resend || !to) return false;

  const from = process.env.RESEND_FROM || "마음이음 <onboarding@resend.dev>";
  const urgent = p.level === 3;
  const when = p.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const subject = `${urgent ? "🚨 즉시 응급" : "⚠️ 주의"} [마음이음] ${p.userName}님 위급 신호`;
  const action = urgent
    ? `지금 바로 ${p.userName}님께 연락하시거나 119에 신고해주세요.`
    : `시간 되실 때 ${p.userName}님 안부를 확인해주세요.`;
  const accent = urgent ? "#E2547B" : "#E8920C";
  const html = `
  <div style="font-family:'Malgun Gothic',Apple SD Gothic Neo,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#211B2E">
    <div style="background:${accent};color:#fff;border-radius:14px 14px 0 0;padding:16px 20px;font-size:18px;font-weight:bold">
      ${urgent ? "🚨 즉시 응급 신호" : "⚠️ 주의 신호"}
    </div>
    <div style="border:1px solid #DDD9E6;border-top:none;border-radius:0 0 14px 14px;padding:20px">
      <p style="font-size:16px;margin:0 0 12px"><b>${p.userName}</b>님에게서 위급 신호가 감지되었습니다.</p>
      <table style="font-size:14px;color:#4b4b5a;border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#6B7280">종류</td><td>${p.category}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6B7280">시각</td><td>${when}</td></tr>
      </table>
      <p style="margin:16px 0 0;padding:12px 14px;background:#FBEAEF;border-radius:10px;font-size:15px;font-weight:600;color:${accent}">
        👉 ${action}
      </p>
      <p style="margin:16px 0 0;font-size:12px;color:#9C93B0">마음이음 · 이 메일은 보호자 알림용으로 자동 발송되었습니다.</p>
    </div>
  </div>`;

  try {
    const { error } = await resend.emails.send({ from, to, subject, html });
    if (error) {
      console.warn("[email] Resend 오류:", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[email] 발송 실패:", (e as Error).message);
    return false;
  }
}
