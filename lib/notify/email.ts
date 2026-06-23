/**
 * 위급 알림 이메일 발송 — Gmail SMTP(nodemailer).
 *
 * env: GMAIL_USER(보내는 Gmail 주소) + GMAIL_APP_PASSWORD(앱 비밀번호, 공백 자동 제거).
 *   미설정 시 graceful skip. 수신자는 보호자 이메일(동적).
 *   ⚠️ 앱 비밀번호는 절대 코드/깃에 두지 말 것 — env로만. 노출 시 Google 계정에서 재발급.
 */
import nodemailer from "nodemailer";

let transporter: nodemailer.Transporter | null | undefined;
function getTransporter(): nodemailer.Transporter | null {
  if (transporter !== undefined) return transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, ""); // "abcd efgh ..." → 공백 제거
  if (!user || !pass) {
    transporter = null;
    return null;
  }
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  return transporter;
}

export interface EmergencyEmailPayload {
  userName: string;
  level: 2 | 3;
  category: string;
  createdAt: Date;
}

export async function sendEmergencyEmail(to: string, p: EmergencyEmailPayload): Promise<boolean> {
  const t = getTransporter();
  if (!t || !to) return false;

  const from = `마음이음 <${process.env.GMAIL_USER}>`;
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
    await t.sendMail({ from, to, subject, html });
    return true;
  } catch (e) {
    console.warn("[email] Gmail 발송 실패:", (e as Error).message);
    return false;
  }
}
