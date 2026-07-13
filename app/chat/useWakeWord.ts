/**
 * Wake-word 감지 훅 — 브라우저 Web Speech Recognition API 기반.
 *
 * 정책:
 * - alwaysOn=true 이면 백그라운드로 음성 인식을 돌리되 transcript는 서버 전송 안 함.
 * - "마음", "마음아", "마음이" 등 변형을 들으면 onWake 콜백 호출 → 호출자가 실제 녹음/STT 파이프라인 시작.
 * - paused=true (예: AI가 응답 중) 면 recognition 중지.
 * - 브라우저 미지원 환경(Firefox 등) supported=false 반환 — 호출자는 fallback(자동 녹음) 동작.
 *
 * 주의: SpeechRecognition은 마이크 권한이 따로 또 떠지 않도록 streamRef와 공존 가능.
 *   onresult.interimResults=true 사용으로 사용자가 "마음아"라고 끝까지 말하기 전 부분 매칭도 가능.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type SpeechRecognitionEvent = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [transcriptIndex: number]: { transcript: string };
      length: number;
    };
  };
};

type SpeechRecognitionInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function getSpeechRecognitionCtor(): { new(): SpeechRecognitionInstance } | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: { new(): SpeechRecognitionInstance }; webkitSpeechRecognition?: { new(): SpeechRecognitionInstance } };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

// 한국어 STT 결과는 띄어쓰기/철자가 흔들리므로 "마음" 어근을 단순 포함 매칭
// 예: "마음아", "마음 아", "마음이", "마으마음", "마음마음" 모두 통과.
// "마음 같이", "마음대로" 같은 단어 안 들어가는 것 같지만 사용자가 wake 의도 없이 우연히 부른 경우엔
// 그래도 발화 캡처되므로 false positive는 큰 문제 아님(사용자가 "괜찮아" 정도 답하면 됨).
const WAKE_PATTERN = /마음/;

export interface UseWakeWordOptions {
  enabled: boolean;       // alwaysOn 등 상위 ON/OFF
  paused: boolean;         // AI 응답 중에는 잠시 멈춤
  onWake: (heard?: string) => void; // 감지 시 — 인식 텍스트 전달(에코 필터 등 호출자 판단용)
  wakePhrase?: RegExp;     // override 가능 (기본 "마음/마음아")
  // 연속 무결과 실패 시 자동재시작을 차단하는 한도. 기본 3.
  // barge-in 명령 모드는 "AI 발화 중 침묵"이 정상이라 no-speech 종료가 잦음 — 높게 잡아야
  // 긴 TTS 턴 후반에 리스너가 조용히 죽지 않는다(2026-07-10 barge-in 도입).
  failBlockLimit?: number;
}

export interface UseWakeWordReturn {
  supported: boolean;      // SpeechRecognition API 지원 여부
  listening: boolean;       // 현재 듣고 있는 상태
  lastHeard: string;        // 디버깅용 최근 인식 텍스트
}

export function useWakeWord(opts: UseWakeWordOptions): UseWakeWordReturn {
  const { enabled, paused, onWake, wakePhrase = WAKE_PATTERN, failBlockLimit = 3 } = opts;
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [lastHeard, setLastHeard] = useState("");
  const recRef = useRef<SpeechRecognitionInstance | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;
  const wakePhraseRef = useRef(wakePhrase);
  wakePhraseRef.current = wakePhrase;
  // enabled/paused 최신값을 onend 콜백에서 안전하게 참조하기 위한 ref
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const failBlockLimitRef = useRef(failBlockLimit);
  failBlockLimitRef.current = failBlockLimit;
  // 연속 실패(권한 거부, 즉시 종료 등) 시 무한 재시작 차단용 카운터
  const consecutiveFailRef = useRef(0);
  const blockedRef = useRef(false);

  // 안전한 stop
  const stop = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    if (recRef.current) {
      try { recRef.current.abort(); } catch { /* ignore */ }
      recRef.current = null;
    }
    setListening(false);
  }, []);

  // 시작
  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    if (recRef.current) return;        // 이미 실행 중
    if (blockedRef.current) return;     // 권한 거부 등으로 차단된 상태
    if (!enabledRef.current || pausedRef.current) return; // 외부 조건 안 맞으면 시작 안 함
    try {
      const rec = new Ctor();
      rec.lang = "ko-KR";
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      let gotResult = false;

      rec.onresult = (e) => {
        gotResult = true;
        consecutiveFailRef.current = 0; // 정상 응답이 들어오면 실패 카운터 리셋
        let combined = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          combined += e.results[i][0]?.transcript || "";
        }
        if (combined) setLastHeard(combined.slice(-60));
        if (wakePhraseRef.current.test(combined)) {
          try { rec.stop(); } catch { /* ignore */ }
          onWakeRef.current(combined);
        }
      };
      rec.onerror = (ev) => {
        const err = ev?.error || "";
        // not-allowed / service-not-allowed: 권한 거부 → 영구 차단
        if (err === "not-allowed" || err === "service-not-allowed") {
          console.warn("[wake-word] permission denied → blocking until next reload");
          blockedRef.current = true;
        }
        if (err && !["no-speech", "aborted", "audio-capture"].includes(err)) {
          console.warn("[wake-word] error:", err);
        }
      };
      rec.onend = () => {
        recRef.current = null;
        setListening(false);

        // 결과 한 번도 못 받고 즉시 종료 → 권한 미허용/오류 가능성
        if (!gotResult) {
          consecutiveFailRef.current += 1;
          if (consecutiveFailRef.current >= failBlockLimitRef.current) {
            console.warn(`[wake-word] ${failBlockLimitRef.current} consecutive failures → blocking auto-restart`);
            blockedRef.current = true;
            return;
          }
        } else {
          consecutiveFailRef.current = 0;
        }

        if (blockedRef.current) return;
        if (!enabledRef.current || pausedRef.current) return;

        // continuous=true여도 브라우저가 ~60초마다 끊는 경우가 있음 → 자동 재시작
        // 단, 즉시 실패한 경우엔 backoff
        const delay = gotResult ? 500 : 2000 + consecutiveFailRef.current * 1000;
        if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
        restartTimerRef.current = setTimeout(() => {
          restartTimerRef.current = null;
          start();
        }, delay);
      };

      recRef.current = rec;
      rec.start();
      setListening(true);
    } catch (e) {
      console.warn("[wake-word] start failed:", (e as Error).message);
      recRef.current = null;
      setListening(false);
      consecutiveFailRef.current += 1;
      if (consecutiveFailRef.current >= failBlockLimitRef.current) { blockedRef.current = true; return; }
      // 동기 start() 실패도 onend와 동일하게 backoff 재시도 — 예약 없이는 enabled/paused가 바뀔 때까지
      // 영구 침묵(예: barge-in 직후 다른 인식 세션이 마이크를 아직 쥔 채 throw, 2026-07-10 리뷰 #4)
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        start();
      }, 2000 + consecutiveFailRef.current * 1000);
    }
  }, []);

  useEffect(() => {
    setSupported(!!getSpeechRecognitionCtor());
  }, []);

  useEffect(() => {
    if (enabled && !paused) {
      // 외부 enable 조건이 다시 켜진 경우 차단 해제 재시도
      blockedRef.current = false;
      consecutiveFailRef.current = 0;
      start();
    } else {
      stop();
    }
    return () => stop();
  }, [enabled, paused, start, stop]);

  return { supported, listening, lastHeard };
}
