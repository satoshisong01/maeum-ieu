/**
 * API 경계 입력 검증(Zod) — 타입 안전성 + 크기/길이 상한으로 오용·DoS 방어.
 * permissive: 알 수 없는 키는 strip(거부 X)해 정상 요청을 깨지 않음. 알려진 필드만 bound.
 */
import { z } from "zod";

export const ChatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.string().max(20),
        content: z.string().max(5000),
        createdAt: z.string().max(40).optional(),
      }),
    )
    .max(500) // 자체 DoS 상한. 클라이언트는 최근 50개만 보내므로 평상시 도달 X(방어선).
    .optional(),
  conversationId: z.string().max(100).optional(),
  isInitialGreeting: z.boolean().optional(),
  isReturningGreeting: z.boolean().optional(),
  isReEngage: z.boolean().optional(),
  reEngageAttempt: z.number().int().min(1).max(2).optional(),
  mode: z.enum(["user", "pro", "general"]).optional(), // 선별 모드(전문가 검사 시행 / 사용자 대화 / 일반인 정신건강) — 서버는 세션 역할로 재결정(스푸핑 무시)

  audio: z
    .object({
      data: z.string().max(15_000_000), // base64 음성(~10MB raw) 상한 — 과대 페이로드 차단
      mimeType: z.string().max(60),
    })
    .optional(),
  context: z
    .object({
      currentTime: z.string().max(40).optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
    })
    .optional(),
});

export type ChatRequestValidated = z.infer<typeof ChatRequestSchema>;
