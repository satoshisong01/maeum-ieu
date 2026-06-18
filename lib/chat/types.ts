/** chat API 공통 타입 */

export interface AudioInput {
  data: string;
  mimeType: string;
}

export interface ClientContext {
  currentTime?: string;
  latitude?: number;
  longitude?: number;
}

/** 선별 모드: user=공감 대화에 자연스럽게 끼워넣기 / pro=표준화 검사 시행(전문가·관리사용) / general=일반인 정신건강(인지 선별 없음) */
export type ScreeningMode = "user" | "pro" | "general";

export interface ChatRequestBody {
  messages?: { role: string; content: string; createdAt?: string }[];
  conversationId?: string;
  isInitialGreeting?: boolean;
  isReturningGreeting?: boolean;
  isReEngage?: boolean;        // 세션 중 침묵 시 동반자가 먼저 거는 재참여 발화
  reEngageAttempt?: number;    // 1=부드러운 재유도, 2=후퇴(천천히 하셔도 돼요)
  audio?: AudioInput;
  context?: ClientContext;
  mode?: ScreeningMode;
  proxyPatientId?: string;     // 전문가 대리 검사 — 결과를 이 환자 계정에 귀속(서버가 연결 검증)
}

export interface TimeContext {
  timeLabel: string;
  hour: number;
  dateStr: string;
}

export interface WeatherContext {
  description: string;
  location: string;
  promptText: string;
}

/** 인지 평가 단일 항목 (cognitive_assessments 테이블 저장용) */
export interface CognitiveCheck {
  domain: string;
  score: number;
  confidence: number;
  evidence: string;
  note: string;
}

/** 인지 분석기 반환 결과 */
export interface CognitiveAnalysisResult {
  isAnomaly: boolean;
  analysisNote: string;
  cognitiveChecks: CognitiveCheck[];
}
