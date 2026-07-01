import { PrismaClient } from "../generated/prisma/client/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { RDS_CA } from "./rds-ca";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

let connectionString =
  process.env.DATABASE_URL ?? "postgresql://localhost:5432/maeumieu";
// SSL 정책 — 건강/인지 민감 데이터 경로의 중간자 공격 방지.
//   기본: AWS RDS는 자체 CA로 서명 → 시스템 신뢰저장소에 없어 검증 실패. RDS CA 번들로 서버 인증서 검증(rejectUnauthorized:true).
//   ⚠ 연결문자열에 sslmode가 있으면 node-postgres가 ssl.ca를 무시하므로, sslmode를 제거하고 ssl 객체로 제어.
//   DATABASE_SSL_NO_VERIFY=1: 검증 비활성 비상 탈출구(권장 안 함).
const sslNoVerify = process.env.DATABASE_SSL_NO_VERIFY === "1";
const isRds = /\.rds\.amazonaws\.com/i.test(connectionString);
let ssl: { rejectUnauthorized: boolean; ca?: string } | undefined;
try {
  const url = new URL(connectionString);
  if (sslNoVerify) {
    url.searchParams.set("sslmode", "no-verify");
    ssl = { rejectUnauthorized: false };
  } else if (isRds) {
    url.searchParams.delete("sslmode"); // sslmode가 남아있으면 ca가 무시됨 → 제거 후 ssl 객체로 검증
    ssl = { ca: RDS_CA, rejectUnauthorized: true };
  }
  connectionString = url.toString();
} catch {
  // URL 파싱 실패 시 그대로 사용(로컬 등)
}

const adapter = new PrismaPg({
  connectionString,
  ...(ssl ? { ssl } : {}),
});

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    // dev query 로그는 PII 컬럼 포함 SQL이 로그 파일에 누적됨 — DEBUG_PRISMA_QUERY=1일 때만 활성
    log: process.env.NODE_ENV === "development"
      ? (process.env.DEBUG_PRISMA_QUERY === "1" ? ["query", "error", "warn"] : ["error", "warn"])
      : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
