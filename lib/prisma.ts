import { PrismaClient } from "../generated/prisma/client/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

let connectionString =
  process.env.DATABASE_URL ?? "postgresql://localhost:5432/maeumieu";
// SSL 인증서 검증 기본 활성 — 건강/인지 민감 데이터 경로의 중간자 공격 방지.
// 관리형 DB가 자체서명 인증서라 연결이 실패하는 환경에서만 DATABASE_SSL_NO_VERIFY=1로 완화.
const sslNoVerify = process.env.DATABASE_SSL_NO_VERIFY === "1";
if (sslNoVerify) {
  try {
    const url = new URL(connectionString);
    url.searchParams.set("sslmode", "no-verify");
    connectionString = url.toString();
  } catch {
    // URL 파싱 실패 시 그대로 사용
  }
}

const adapter = new PrismaPg({
  connectionString,
  ...(sslNoVerify ? { ssl: { rejectUnauthorized: false } } : {}),
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
