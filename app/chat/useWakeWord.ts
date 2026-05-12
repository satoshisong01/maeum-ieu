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

// 한국어 STT 결과는 띄어쓰기/철자가 흔들리므로 "마음" 어근 매칭 + 짧은 발음 변형 허용
const WAKE_PATTERN = /(?:^|[^가-힣])(마음|마음[아야이이야]|마으마음|마음마음)(?:[^가-힣]|$)/;

export interface UseWakeWordOptions {
  enabled: boolean;       // alwaysOn 등 상위 ON/OFF
  paused: boolean;         // AI 응답 중에는 잠시 멈춤
  onWake: () => void;      // wake word 감지 시
  wakePhrase?: RegExp;     // override 가능 (기본 "마음/마음아")
}

export interface UseWakeWordReturn {
  supported: boolean;      // SpeechRecognition API 지원 여부
  listening: boolean;       // 현재 듣고 있는 상태
  lastHeard: string;        // 디버깅용 최근 인식 텍스트
}

export function useWakeWord(opts: UseWakeWordOptions): UseWakeWordReturn {
  const { enabled, paused, onWake, wakePhrase = WAKE_PATTERN } = opts;
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [lastHeard, setLastHeard] = useState("");
  const recRef = useRef<SpeechRecognitionInstance | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;
  const wakePhraseRef = useRef(wakePhrase);
  wakePhraseRef.current = wakePhrase;

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
    if (recRef.current) return; // 이미 실행 중
    try {
      const rec = new Ctor();
      rec.lang = "ko-KR";
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onresult = (e) => {
        let combined = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          combined += e.results[i][0]?.transcript || "";
        }
        if (combined) setLastHeard(combined.slice(-60));
        if (wakePhraseRef.current.test(combined)) {
          // wake 감지 → recognition 즉시 중단 후 콜백
          try { rec.stop(); } catch { /* ignore */ }
          onWakeRef.current();
        }
      };
      rec.onerror = (ev) => {
        // no-speech / aborted 등은 정상 회복 흐름
        if (ev?.error && !["no-speech", "aborted", "audio-capture"].includes(ev.error)) {
          console.warn("[wake-word] error:", ev.error);
        }
      };
      rec.onend = () => {
        recRef.current = null;
        // 자동 재시작: 호출자가 멈추라고 한 게 아니면 0.3s 후 다시 시작
        // (continuous=true여도 브라우저가 ~60초마다 멈추는 경우 있음)
        if (!restartTimerRef.current) {
          restartTimerRef.current = setTimeout(() => {
            restartTimerRef.current = null;
            // 외부 상태 의존성 없이 다시 시도. 외부에서 stop했으면 enabled/paused 다시 false라 effect가 처리.
            // 여기서는 단순 재진입만 트리거하기 위해 effect 의존성 변경처럼 동작시키지 않고 직접 start
            // start 자체가 recRef 가드를 가지므로 안전
            const Ctor2 = getSpeechRecognitionCtor();
            if (Ctor2) {
              // re-enter via the same start path
              start();
            }
          }, 300);
        }
      };

      recRef.current = rec;
      rec.start();
      setListening(true);
    } catch (e) {
      console.warn("[wake-word] start failed:", (e as Error).message);
      recRef.current = null;
      setListening(false);
    }
  }, []);

  useEffect(() => {
    setSupported(!!getSpeechRecognitionCtor());
  }, []);

  useEffect(() => {
    if (enabled && !paused) {
      start();
    } else {
      stop();
    }
    return () => stop();
  }, [enabled, paused, start, stop]);

  return { supported, listening, lastHeard };
}
