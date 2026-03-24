/** 프롬프트 조립 관련 함수 */

import type { TimeContext, WeatherContext } from "./types";
import { SYSTEM_PROMPT_BASE, COGNITIVE_DETECTION_RULE } from "./constants";
import { prisma } from "@/lib/prisma";
import { toKstDateString } from "./time";

/** 연령·성별로 호칭 추론 */
export function getHonorific(age: number | null, gender: string | null): string {
  if (age == null || gender == null) return "회원님";
  if (age >= 60) return gender === "male" ? "할아버지" : gender === "female" ? "할머니" : "회원님";
  if (age >= 40) return gender === "male" ? "아빠" : gender === "female" ? "엄마" : "회원님";
  return "회원님";
}

/** 환경 컨텍스트 블록 (프롬프트 삽입용) */
function buildContextBlock(timeCtx: TimeContext, weather: WeatherContext): string {
  return `[현재 환경 정보]
- 현재 시각대: ${timeCtx.timeLabel} (${timeCtx.dateStr})
- ${weather.promptText}

위 정보를 활용해 "점심 드셨나요?", "오늘 날씨가 좋은데 산책 어떠세요?"처럼 구체적인 선제적 질문을 해 주세요.`;
}

/** 마지막 대화가 오늘과 다른 날이면 날짜 안내 블록 반환 */
async function getDateAwareBlock(conversationId: string, todayKst: string): Promise<string> {
  const last = await prisma.message.findFirst({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!last) return "";
  const lastDateStr = toKstDateString(last.createdAt);
  if (lastDateStr === todayKst) return "";

  return `

[날짜 안내]
마지막 대화는 ${lastDateStr}이었고, 오늘은 ${todayKst}입니다. 새로운 날이므로 **오늘의** 식사(아침/점심/저녁), 산책·외부 활동 등을 새로 여쭤보세요. 어제 이전 대화는 기억하되, 식사·활동은 반드시 '오늘' 기준으로만 물어보세요.`;
}

export interface PromptParts {
  systemPrompt: string;
  userName: string;
  honorific: string;
}

/** 전체 시스템 프롬프트를 조립하여 반환 */
export async function buildSystemPrompt(params: {
  userId: string;
  conversationId?: string;
  timeCtx: TimeContext;
  weather: WeatherContext;
}): Promise<PromptParts> {
  const { userId, conversationId, timeCtx, weather } = params;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, age: true, gender: true },
  });
  const userName = user?.name?.trim() || "사용자";
  const honorific = getHonorific(user?.age ?? null, user?.gender ?? null);

  const userBlock = `[사용자 정보]
- 이름: ${userName}
- 호칭: ${honorific} (대화할 때 반드시 이 호칭으로 부르세요. 예: "할아버지", "할머니", "엄마", "아빠", "회원님")`;

  const contextBlock = buildContextBlock(timeCtx, weather);
  const todayKst = toKstDateString(new Date());
  const dateAwareBlock = conversationId
    ? await getDateAwareBlock(conversationId, todayKst)
    : "";

  const systemPrompt = `${SYSTEM_PROMPT_BASE}\n\n${userBlock}\n\n${contextBlock}${dateAwareBlock}${COGNITIVE_DETECTION_RULE}`;

  return { systemPrompt, userName, honorific };
}
