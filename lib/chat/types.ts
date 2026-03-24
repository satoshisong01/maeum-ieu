/** chat API 전반에서 사용하는 공통 타입 */

export interface AudioInput {
  data: string;
  mimeType: string;
}

export interface ClientContext {
  currentTime?: string;
  latitude?: number;
  longitude?: number;
}

export interface ChatRequestBody {
  messages?: { role: string; content: string }[];
  conversationId?: string;
  isInitialGreeting?: boolean;
  audio?: AudioInput;
  context?: ClientContext;
}

export interface GeminiParsedResponse {
  transcription?: string;
  text: string;
  isAnomaly: boolean;
  analysisNote: string | null;
}

export interface TimeContext {
  timeLabel: string;
  hour: number;
  dateStr: string;
}

export interface WeatherContext {
  description: string;
  promptText: string;
}
