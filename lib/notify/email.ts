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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function sendEmergencyEmail(to: string, p: EmergencyEmailPayload): Promise<boolean> {
  const t = getTransporter();
  if (!t || !to || !EMAIL_RE.test(to)) return false; // 복호 실패 시 enc:… 값이 수신자로 가는 것 방지

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
      <p style="font-size:16px;margin:0 0 12px"><b>${esc(p.userName)}</b>님에게서 위급 신호가 감지되었습니다.</p>
      <table style="font-size:14px;color:#4b4b5a;border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#6B7280">종류</td><td>${esc(p.category)}</td></tr>
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

/**
 * 운영자 경보 — **모든 보호자 채널이 실패했을 때**의 마지막 통보.
 *
 * 왜 필요한가 (2026-10-02 적대 리뷰): notifyGuardian이 sent:false를 돌려줘도 호출부 5곳이
 *   전부 console.warn으로 끝냈다. 영속 기록도, 사람에게 닿는 경로도 없었다.
 *   유일한 사후 탐지인 scripts/pilot-daily-check.ts는 `Message.notifiedAt IS NULL`을 보는데,
 *   **알림이 실패하는 전형적 상황(RDS 장애)에서는 Message 행 자체가 안 만들어진다.**
 *   즉 가장 위험한 순간의 사건이 하루 한 번 점검에도 안 잡혀 "그날 응급 0건"으로 보였다 —
 *   탐지 사각이 이중으로 겹친 상태였다.
 *
 * 이 경로는 **DB를 쓰지 않는다**(SMTP만). 그래서 RDS가 죽어도 사람에게 닿는다.
 * env OPS_ALERT_EMAIL 미설정이면 조용히 skip — 기능을 막지는 않는다.
 */
export async function sendOpsAlert(subject: string, lines: string[]): Promise<boolean> {
  const to = process.env.OPS_ALERT_EMAIL?.trim();
  const t = getTransporter();
  if (!t || !to || !EMAIL_RE.test(to)) return false;
  try {
    await t.sendMail({
      from: `마음이음 운영 <${process.env.GMAIL_USER}>`,
      to,
      subject: `[마음이음 운영] ${subject}`,
      text: lines.join("\n"),
      html: `<pre style="font:14px/1.6 ui-monospace,monospace">${lines.map(esc).join("\n")}</pre>`,
    });
    return true;
  } catch (e) {
    // 여기서 throw하면 호출부(이미 실패 처리 중)가 또 무너진다.
    console.error("[ops-alert] 발송 실패:", e instanceof Error ? e.message : e);
    return false;
  }
}
