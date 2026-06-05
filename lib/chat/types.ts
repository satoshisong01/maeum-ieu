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

/** 선별 모드: user=공감 대화에 자연스럽게 끼워넣기 / pro=표준화 검사 시행(전문가·관리사용) */
export type ScreeningMode = "user" | "pro";

export interface ChatRequestBody {
  messages?: { role: string; content: string; createdAt?: string }[];
  conversationId?: string;
  isInitialGreeting?: boolean;
  isReturningGreeting?: boolean;
  audio?: AudioInput;
  context?: ClientContext;
  mode?: ScreeningMode;
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
