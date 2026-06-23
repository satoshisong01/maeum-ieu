/**
 * 민감 식별정보(연락처 PII) 앱 레벨 암호화 — AES-256-GCM.
 *
 * - 키: env ENCRYPTION_KEY (64자리 hex = 32바이트, 또는 임의 패스프레이즈 → SHA-256으로 32바이트 파생).
 * - 형식: "enc:v1:" + base64(iv(12) + tag(16) + ciphertext).
 * - 레거시 평문 호환: prefix 없는 값은 평문으로 보고 그대로 반환(기존 데이터·미설정 환경 방어).
 * - 키 미설정 시: 암호화/복호화 모두 원본 통과(개발 편의). ⚠️ 운영에선 ENCRYPTION_KEY 필수.
 *
 * 적용 대상: guardianPhone, guardianEmail 등 분석에 쓰지 않는 연락처 식별정보.
 *   (대화·인지검사 데이터는 분석에 평문 필요 → 인프라 저장암호화 + 접근통제로 보호)
 */
import crypto from "node:crypto";

const PREFIX = "enc:v1:";

function getKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  return crypto.createHash("sha256").update(raw).digest(); // 패스프레이즈 → 32바이트
}

/** 평문 → 암호문("enc:v1:..."). null/빈값/키없음은 원본 통과. */
export function encryptPII(plain: string | null | undefined): string | null {
  if (plain == null || plain === "") return plain ?? null;
  if (plain.startsWith(PREFIX)) return plain; // 이미 암호화됨(중복 암호화 방지)
  const key = getKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

/** 암호문 → 평문. prefix 없으면 레거시 평문으로 보고 그대로 반환. 키없음/실패 시 원본 반환. */
export function decryptPII(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (!value.startsWith(PREFIX)) return value; // 레거시 평문
  const key = getKey();
  if (!key) return value;
  try {
    const buf = Buffer.from(value.slice(PREFIX.length), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return value;
  }
}
