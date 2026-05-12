"use client";

import { useSession, signOut } from "next-auth/react";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AudioVisualizer } from "./AudioVisualizer";
import { ThemeToggle } from "../theme-toggle";
import { useWakeWord } from "./useWakeWord";

type Message = { id: string; role: "user" | "assistant"; content: string; createdAt?: string };

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(blob);
  });

function getErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const isApiQuotaError =
    raw.includes("429") ||
    raw.includes("Too Many Requests") ||
    raw.includes("quota") ||
    raw.includes("Quota exceeded") ||
    raw.includes("GoogleGenerativeAI") ||
    raw.includes("rate-limit");
  if (isApiQuotaError) return "오늘은 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  // 서버에서 보낸 안전한 한국어 메시지만 그대로 표시, 그 외는 일반 메시지로 대체
  if (raw && !raw.includes("Error") && !raw.includes("error") && !raw.includes("fetch")) return raw;
  return "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
}

/** 마크다운(```json ... ```)이 섞인 응답에서 JSON만 추출해 파싱 */
function extractJsonFromResponse(raw: string): { text: string; transcription: string } | null {
  try {
    const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = codeBlock ? codeBlock[1].trim() : raw.trim();
    const firstBrace = jsonStr.indexOf("{");
    if (firstBrace === -1) return null;
    const slice = jsonStr.slice(firstBrace);
    let depth = 0;
    let end = -1;
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] === "{") depth++;
      else if (slice[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const toParse = end > 0 ? slice.slice(0, end) : slice;
    const parsed = JSON.parse(toParse) as { text?: string; transcription?: string };
    return {
      text: typeof parsed.text === "string" ? parsed.text : "",
      transcription: typeof parsed.transcription === "string" ? parsed.transcription : "",
    };
  } catch {
    return null;
  }
}

/** 대화창에 표시할 때: JSON이나 기술 데이터를 제거하고 대화 텍스트만 표시 */
function displayMessageContent(content: string): string {
  if (!content || !content.trim()) return content;
  // AI가 실수로 포함한 cognitiveChecks 등 기술 데이터 + moderation 메타 시그니처 제거
  let cleaned = content
    .replace(/<!--\s*__mod:[^>]*-->/g, "")
    .replace(/cognitiveChecks\s*:\s*\[[\s\S]*?\]/g, "")
    .replace(/isAnomaly\s*:\s*(true|false)/gi, "")
    .replace(/analysisNote\s*:\s*"[^"]*"/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\{[\s\S]*?"domain"[\s\S]*?\}/g, "")
    .trim();
  if (cleaned !== content) return cleaned || content;
  if (!content.includes("```") && !content.trimStart().startsWith("{")) return content;
  const extracted = extractJsonFromResponse(content);
  if (extracted?.text) return extracted.text;
  return content;
}

/** API 응답에서 TTS용 text와 받아쓰기용 transcription 안전 추출 (마크다운 JSON 대응) */
function parseAudioResponse(data: unknown): { text: string; transcription: string } {
  const fallback = { text: "", transcription: "" };
  if (!data || typeof data !== "object" || !("text" in data)) return fallback;
  const obj = data as { text?: unknown; transcription?: unknown };
  let text = obj.text;
  let transcription = obj.transcription;
  if (typeof text === "string" && (text.includes("```") || text.includes("{"))) {
    const extracted = extractJsonFromResponse(text);
    if (extracted) {
      text = extracted.text;
      transcription = extracted.transcription || (typeof transcription === "string" ? transcription : "");
    }
  }
  return {
    text: typeof text === "string" ? text : "",
    transcription: typeof transcription === "string" ? transcription : "",
  };
}

export default function ChatPage() {
  const { data: session, status } = useSession();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [micAllowed, setMicAllowed] = useState(false);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [listening, setListening] = useState(false); // 녹음 중 여부
  const [alwaysOn, setAlwaysOn] = useState(false); // 음성 전원 (기본 꺼짐 — 사용자가 명시적으로 켜야 함)
  const alwaysOnRef = useRef(false);
  alwaysOnRef.current = alwaysOn; // stale closure 방지
  // wake-word 활성화 단계: false=대기(wake 기다림), true=마음 호출 후 발화 캡처 진행 중
  const [wakeArmed, setWakeArmed] = useState(false);
  const wakeArmedRef = useRef(false);
  wakeArmedRef.current = wakeArmed;
  const discardNextRef = useRef(false); // OFF 직후 onstop에서 전송 스킵용
  const turnLockRef = useRef(false);     // AI 응답 중 마이크 입력 완전 차단 (한 턴씩 주고받기)
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadFrameRef = useRef<number>(0);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const locationRef = useRef<{ latitude?: number; longitude?: number }>({});

  /** API 호출 시 사용할 현재 시간·위치 컨텍스트 */
  const getContext = useCallback(() => ({
    currentTime: new Date().toISOString(),
    ...locationRef.current,
  }), []);

  const createId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const audioElRef = useRef<HTMLAudioElement | null>(null);

  const cleanForTTS = (text: string): string =>
    text
      .replace(/cognitiveChecks\s*:\s*\[[\s\S]*?\]/g, "")
      .replace(/isAnomaly\s*:\s*(true|false)/g, "")
      .replace(/analysisNote\s*:\s*"[^"]*"/g, "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\{[\s\S]*?"domain"[\s\S]*?\}/g, "")
      .replace(/(\d+)-(\d+)-(\d+)/g, "$1, $2, $3")
      .replace(/(\d+(?:\.\d+)?)\s*km\/h/gi, "$1 킬로미터퍼아워")
      .replace(/(\d+(?:\.\d+)?)\s*km/gi, "$1 킬로미터")
      .replace(/https?:\/\/\S+/g, "링크")
      .replace(/\([A-Za-z0-9./%]+\)/g, "")
      .trim();

  const speakWithWebSpeech = useCallback((ttsText: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const utter = new SpeechSynthesisUtterance(ttsText);
    utter.lang = "ko-KR";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }, []);

  /**
   * Gemini 3.1 Flash TTS Preview로 음성 생성 시도. 실패 시 Web Speech API 폴백.
   *
   * onReady: 오디오가 준비되어 재생 직전에 호출되는 훅.
   *          호출자는 여기서 화면에 텍스트를 표시해 음성·텍스트 노출 타이밍을 맞춘다.
   */
  const speak = useCallback(async (text: string, onReady?: () => void) => {
    if (typeof window === "undefined") { onReady?.(); return; }
    const ttsText = cleanForTTS(text);
    if (!ttsText) { onReady?.(); return; }

    // 직전 재생 정리
    if (audioElRef.current) {
      try { audioElRef.current.pause(); } catch { /* ignore */ }
      audioElRef.current = null;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();

    // 한 턴씩 주고받기: 사용자 발화 전송 직후부터 AI 음성 종료까지 마이크 입력 차단
    turnLockRef.current = true;

    const releaseLock = () => { turnLockRef.current = false; };

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: ttsText }),
      });
      if (!res.ok) throw new Error(`tts ${res.status}`);
      const data = (await res.json()) as { audioBase64: string; mimeType: string };
      const audio = new Audio(`data:${data.mimeType};base64,${data.audioBase64}`);
      audio.onended = releaseLock;
      audio.onerror = releaseLock;
      audioElRef.current = audio;
      onReady?.();
      try {
        await audio.play();
      } catch {
        releaseLock();
      }
    } catch (e) {
      console.warn("[chat] TTS fallback to Web Speech:", (e as Error).message);
      onReady?.();
      // Web Speech 폴백: utterance.onend / onerror로 락 해제
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        const utter = new SpeechSynthesisUtterance(ttsText);
        utter.lang = "ko-KR";
        utter.onend = releaseLock;
        utter.onerror = releaseLock;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utter);
      } else {
        releaseLock();
      }
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // 앱/채팅 진입 시 위치 수집 (날씨 기반 인사·인지 모니터링용, 권한 거부 시 무시)
  useEffect(() => {
    if (typeof window === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locationRef.current = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        };
      },
      () => {},
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 300000 }
    );
  }, []);

  // 진입 시: 최근 대화 불러오기 + 시간 경과에 따라 AI 인사
  useEffect(() => {
    if (status !== "authenticated" || conversationId !== null) return;

    const RETURNING_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2시간

    let cancelled = false;
    (async () => {
      const getRes = await fetch("/api/conversations", { method: "GET" });
      if (!getRes.ok || cancelled) return;
      const data = (await getRes.json()) as {
        conversation?: { id: string } | null;
        messages?: { id: string; role: string; content: string }[];
        lastMessageAt?: string | null;
      };
      if (cancelled) return;

      const conv = data.conversation ?? null;
      const existingMessages = Array.isArray(data.messages) ? data.messages : [];

      // 기존 대화가 있는 경우
      if (conv?.id && existingMessages.length > 0) {
        setConversationId(conv.id);
        setMessages(
          existingMessages.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
          }))
        );

        // 마지막 메시지로부터 2시간 이상 경과 → AI 재인사
        const lastAt = data.lastMessageAt ? new Date(data.lastMessageAt).getTime() : 0;
        const elapsed = Date.now() - lastAt;

        if (elapsed >= RETURNING_THRESHOLD_MS) {
          const chatRes = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId: conv.id,
              isReturningGreeting: true,
              context: getContext(),
            }),
          });
          if (!chatRes.ok || cancelled) return;
          const { text } = (await chatRes.json()) as { text: string };
          if (cancelled) return;
          setLoading(true);
          await speak(text, () => {
            if (cancelled) return;
            setMessages((prev) => [
              ...prev,
              { id: createId(), role: "assistant", content: text },
            ]);
            setLoading(false);
          });
          setAiSpeaking(true);
          setTimeout(() => setAiSpeaking(false), 3000);
        }
        return;
      }

      // 새 사용자: 대화 생성 + 최초 인사
      let conversationIdToUse: string;
      if (conv?.id) {
        conversationIdToUse = conv.id;
        setConversationId(conv.id);
      } else {
        const postRes = await fetch("/api/conversations", { method: "POST" });
        if (!postRes.ok || cancelled) return;
        const { id } = (await postRes.json()) as { id: string };
        if (cancelled) return;
        conversationIdToUse = id;
        setConversationId(id);
      }

      const chatRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: conversationIdToUse,
          isInitialGreeting: true,
          context: getContext(),
        }),
      });
      if (!chatRes.ok || cancelled) return;
      const { text } = (await chatRes.json()) as { text: string };
      if (cancelled) return;
      setLoading(true);
      await speak(text, () => {
        if (cancelled) return;
        setMessages((prev) => [
          ...prev,
          { id: createId(), role: "assistant", content: text },
        ]);
        setLoading(false);
      });
      setAiSpeaking(true);
      setTimeout(() => setAiSpeaking(false), 3000);
    })();
    return () => {
      cancelled = true;
    };
  }, [status, conversationId, getContext]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || loading || !conversationId) return;
      const userMessage: Message = {
        id: createId(),
        role: "user",
        content: content.trim(),
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage]);
      setInput("");
      setLoading(true);
      setAiSpeaking(true);

      const assistantId = createId();

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            messages: [...messagesRef.current, userMessage].map(
              ({ role, content, createdAt }) => ({ role, content, createdAt })
            ),
            context: getContext(),
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error ?? "오류");
        }

        const data = await res.json();
        // 음성이 준비되는 시점에 텍스트도 동시 노출 (시각/청각 타이밍 동기화)
        await speak(data.text, () => {
          setMessages((prev) => [
            ...prev,
            { id: assistantId, role: "assistant", content: data.text },
          ]);
          setLoading(false);
        });
        setAiSpeaking(false);
        return;
      } catch (e) {
        console.error("[chat] sendMessage error", e);
        const msg = getErrorMessage(e);
        const displayMsg = msg.startsWith("오늘은 사용할 수 없습니다") ? msg : `오류: ${msg}`;
        setMessages((prev) => [
          ...prev,
          {
            id: createId(),
            role: "assistant",
            content: displayMsg,
          },
        ]);
      }
      setLoading(false);
      setAiSpeaking(false);
    },
    [loading, conversationId, messages, createId, speak, getContext]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const [micDenied, setMicDenied] = useState(false);
  const [textOnly, setTextOnly] = useState(false); // 텍스트 전용 모드
  const [modeSelected, setModeSelected] = useState(false); // 음성/텍스트 선택 완료

  /** 마이크 권한만 받고 즉시 release. 실제 stream은 wake 시점에 다시 잡음. */
  const startConversation = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 권한만 받았으면 트랙은 즉시 stop — wake-word(SpeechRecognition)와 마이크 점유 충돌 방지
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setMicAllowed(true);
      setMicDenied(false);
      setModeSelected(true);
      setTextOnly(false);
    } catch {
      setMicDenied(true);
    }
  }, []);

  /** wake 시점에 호출 — getUserMedia로 stream 재획득 (권한 이미 받았으므로 팝업 없음). */
  const ensureStream = useCallback(async (): Promise<MediaStream | null> => {
    if (streamRef.current && streamRef.current.getTracks().some((t) => t.readyState === "live")) {
      return streamRef.current;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      return stream;
    } catch (e) {
      console.warn("[chat] ensureStream failed:", (e as Error).message);
      return null;
    }
  }, []);

  /** 발화 전송이 끝나거나 wake 해제 시 stream을 release하여 SpeechRecognition이 마이크 점유 가능하게 함. */
  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const startTextMode = useCallback(() => {
    setTextOnly(true);
    setModeSelected(true);
  }, []);

  const sendAudioMessage = useCallback(
    async (audioBase64: string, mimeType: string) => {
      if (!conversationId || loading) return;
      const placeholderId = createId();
      const placeholder: Message = {
        id: placeholderId,
        role: "user",
        content: "(음성 인식 중...)",
      };
      setMessages((prev) => [...prev, placeholder]);
      setLoading(true);
      setAiSpeaking(true);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            audio: { data: audioBase64, mimeType },
            messages: messagesRef.current.map(({ role, content, createdAt }) => ({
              role,
              content,
              createdAt,
            })),
            context: getContext(),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "오류");

        const { text: textToSpeak, transcription: transcriptionText } = parseAudioResponse(data);

        // 사용자 transcription은 즉시 화면 갱신 (placeholder 대체)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === placeholderId
              ? { ...m, content: transcriptionText || "(음성 메시지)" }
              : m
          )
        );

        const aiText = textToSpeak || "(답변 없음)";
        await speak(aiText, () => {
          setMessages((prev) => [
            ...prev,
            { id: createId(), role: "assistant", content: aiText },
          ]);
          setLoading(false);
        });
        setAiSpeaking(false);
        return;
      } catch (e) {
        console.error("[chat] sendAudioMessage error", e);
        const msg = getErrorMessage(e);
        const displayMsg = msg.startsWith("오늘은 사용할 수 없습니다") ? msg : `오류: ${msg}`;
        setMessages((prev) => [
          ...prev,
          {
            id: createId(),
            role: "assistant",
            content: displayMsg,
          },
        ]);
      } finally {
        setLoading(false);
        setAiSpeaking(false);
      }
    },
    [conversationId, loading, speak, getContext]
  );

  const startRecording = useCallback(async () => {
    if (loading || !conversationId) return;
    // 전원 OFF면 절대 녹음 시작하지 않음
    if (!alwaysOnRef.current) return;
    // wake-word 활성화 안 됐으면 시작 금지 (폴백 환경에서는 wakeArmed를 true로 유지)
    if (!wakeArmedRef.current) return;
    // AI 응답 중이면 녹음 시작 금지 — 락 해제될 때까지 폴링
    if (turnLockRef.current) {
      setTimeout(() => startRecording(), 500);
      return;
    }
    // wake 직후 stream 재획득 (권한 이미 있으므로 팝업 없음)
    const stream = await ensureStream();
    if (!stream) {
      alert("마이크를 사용할 수 없습니다. 브라우저 마이크 권한을 확인해 주세요.");
      return;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") return;
    if (typeof window === "undefined" || !(window as any).MediaRecorder) {
      alert("이 브라우저는 음성 녹음을 지원하지 않습니다.");
      return;
    }
    const recorder = new MediaRecorder(stream, {
      mimeType: "audio/webm",
    } as MediaRecorderOptions);
    audioChunksRef.current = [];
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) {
        audioChunksRef.current.push(e.data);
      }
    };
    recorder.onstart = () => setListening(true);
    recorder.onstop = async () => {
      setListening(false);
      const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
      audioChunksRef.current = [];

      // OFF 직후 중단된 녹음은 전송 금지 (전원 OFF 시 어떤 경우에도 음성 전달 안 됨)
      if (discardNextRef.current || !alwaysOnRef.current) {
        discardNextRef.current = false;
        releaseStream();
        wakeArmedRef.current = false;
        setWakeArmed(false);
        return;
      }

      // 너무 짧은 녹음(0.3초 미만)은 무시 — 침묵만 녹음된 경우 → wake 대기로 복귀
      if (blob.size < 5000) {
        releaseStream();
        wakeArmedRef.current = false;
        setWakeArmed(false);
        return;
      }
      try {
        const base64 = await blobToBase64(blob);
        await sendAudioMessage(base64, blob.type);
      } catch (e) {
        console.error("[chat] recorder onstop error", e);
        const msg = getErrorMessage(e);
        const displayMsg = msg.startsWith("오늘은 사용할 수 없습니다") ? msg : `음성 처리 오류: ${msg}`;
        setMessages((prev) => [
          ...prev,
          { id: createId(), role: "assistant", content: displayMsg },
        ]);
      }
      // 발화 전송 끝 → stream release → wake 상태 해제. 다시 "마음아" 부를 때까지 대기 모드.
      releaseStream();
      wakeArmedRef.current = false;
      setWakeArmed(false);
    };
    mediaRecorderRef.current = recorder;
    try {
      recorder.start();

      // VAD: 음량 모니터링 → 2초 침묵 시 자동 전송
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const SILENCE_THRESHOLD = 15; // 음량 기준 (0~255)
      const SILENCE_DURATION = 2000; // 침묵 지속 시간 (ms)
      let speechDetected = false;

      const checkSilence = () => {
        if (!mediaRecorderRef.current || mediaRecorderRef.current.state !== "recording") {
          audioCtx.close().catch(() => {});
          return;
        }
        // OFF 상태에서 잔존 녹음이 있으면 즉시 버리고 중단
        if (!alwaysOnRef.current) {
          discardNextRef.current = true;
          try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
          audioCtx.close().catch(() => {});
          return;
        }
        // AI 응답 진행 중(턴 락) — 사용자 추가 발화는 버리고 녹음 중단
        if (turnLockRef.current) {
          discardNextRef.current = true;
          try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
          audioCtx.close().catch(() => {});
          return;
        }
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

        if (avg > SILENCE_THRESHOLD) {
          speechDetected = true;
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
        } else if (speechDetected && !silenceTimerRef.current) {
          silenceTimerRef.current = setTimeout(() => {
            if (mediaRecorderRef.current?.state === "recording") {
              mediaRecorderRef.current.stop();
            }
            audioCtx.close().catch(() => {});
          }, SILENCE_DURATION);
        }

        vadFrameRef.current = requestAnimationFrame(checkSilence);
      };
      vadFrameRef.current = requestAnimationFrame(checkSilence);
    } catch {
      setListening(false);
      alert("음성 녹음을 시작할 수 없습니다. Chrome 또는 Edge에서 시도해 주세요.");
    }
  }, [conversationId, loading, sendAudioMessage, ensureStream, releaseStream]);

  /** 녹음 중지. discard=true면 진행 중이던 녹음 블롭을 서버로 전송하지 않고 버림. */
  const stopRecording = useCallback((opts?: { discard?: boolean }) => {
    // VAD 정리
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    if (vadFrameRef.current) { cancelAnimationFrame(vadFrameRef.current); vadFrameRef.current = 0; }

    if (opts?.discard) discardNextRef.current = true;

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    } else {
      // recording 중이 아니면 onstop이 안 불리므로 여기서 stream release
      releaseStream();
    }
    setListening(false);
  }, [releaseStream]);

  // wake-word 감지 ("마음", "마음아") — alwaysOn 활성 상태에서만 동작.
  //  - 듣고 있을 때(listening) / AI 응답 중(turnLock) / 이미 wake된 상태는 일시 정지
  //  - 미지원 브라우저면 supported=false → 폴백으로 wakeArmed 자동 활성화해 기존 흐름 유지
  const { supported: wakeSupported, listening: wakeListening, lastHeard: wakeLastHeard } = useWakeWord({
    enabled: micAllowed && alwaysOn && !!conversationId,
    paused: listening || loading || wakeArmed,
    onWake: () => {
      if (turnLockRef.current) return; // AI 응답 중이면 무시
      wakeArmedRef.current = true;
      setWakeArmed(true);
      // 살짝 딜레이 두고 녹음 시작 (recognition stop이 마이크 해제하는 데 시간이 필요)
      setTimeout(() => startRecording(), 250);
    },
  });

  // 폴백: SpeechRecognition 미지원 브라우저 → wake-word 없이 기존처럼 자동 녹음
  useEffect(() => {
    if (!wakeSupported && micAllowed && alwaysOn && !listening && !loading && conversationId && !turnLockRef.current) {
      wakeArmedRef.current = true;
      setWakeArmed(true);
      const timer = setTimeout(() => startRecording(), 1000);
      return () => clearTimeout(timer);
    }
  }, [wakeSupported, micAllowed, alwaysOn, listening, loading, conversationId, startRecording]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f0f2f5] dark:bg-[#0b0d10]">
        <p className="text-zinc-500 dark:text-zinc-400">로딩 중...</p>
      </div>
    );
  }

  if (status !== "authenticated") {
    return null;
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#f0f2f5] dark:bg-[#0b0d10]">
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-2 py-2 sm:px-3 dark:border-zinc-700 dark:bg-zinc-900">
        <h1 className="text-sm font-semibold leading-tight text-zinc-800 sm:text-base dark:text-zinc-100">
          마음<br />이음
        </h1>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <ThemeToggle />
          <Link
            href="/dashboard"
            className="rounded-lg bg-orange-50 px-2 py-1 text-[10px] font-medium leading-tight text-orange-600 hover:bg-orange-100 sm:px-2.5 sm:py-1.5 sm:text-xs dark:bg-orange-900/30 dark:text-orange-300 dark:hover:bg-orange-900/50"
          >
            건강<br />기록
          </Link>
          <Link
            href="/mypage"
            className="max-w-[60px] truncate text-[10px] text-zinc-500 hover:text-[#007bff] hover:underline sm:max-w-none sm:text-xs dark:text-zinc-400 dark:hover:text-blue-400"
          >
            {session.user?.name ?? "사용자"}님
          </Link>
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: "/" })}
            title="로그아웃"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 sm:h-8 sm:w-8 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </header>

      {/* 파동 + 상태 텍스트: 헤더 아래 고정. wake 대기 중에도 시각화 표시 */}
      {micAllowed && (alwaysOn || listening || aiSpeaking) && (
        <div className="flex shrink-0 flex-col items-center gap-2 border-b border-zinc-100 bg-white px-4 py-3 dark:border-zinc-700 dark:bg-zinc-900">
          <AudioVisualizer
            stream={streamRef.current}
            active={listening || aiSpeaking || (alwaysOn && wakeListening)}
            aiSpeaking={aiSpeaking}
            size={120}
          />
          <p className={`text-sm font-semibold ${
            listening ? "text-red-500" : aiSpeaking ? "text-[#007bff]" : "text-amber-600 dark:text-amber-400"
          }`}>
            {listening
              ? "말씀하세요… (끝나면 자동 전송됩니다)"
              : aiSpeaking
                ? "AI가 응답하고 있어요…"
                : wakeSupported
                  ? wakeListening
                    ? '"마음아" 부르시면 들을게요'
                    : "마이크 준비 중…"
                  : "자동 듣기 모드 (호출어 미지원)"}
          </p>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white dark:bg-zinc-900">
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {/* 초기 안내 (모드 미선택 시) */}
          {!modeSelected && (
            <div className="mb-4 flex flex-col items-center gap-4">
              <AudioVisualizer
                stream={null}
                active={false}
                aiSpeaking={false}
              />
              <p className="text-center text-zinc-600 dark:text-zinc-300">
                아래에서 대화 방식을 선택해주세요.
              </p>
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`mb-3 flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2 ${
                  m.role === "user"
                    ? "bg-[#007bff] text-white"
                    : "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
                }`}
              >
                <p className="whitespace-pre-wrap text-sm">{displayMessageContent(m.content)}</p>
              </div>
            </div>
          ))}
          {loading && (
            <div className="mb-3 flex justify-start">
              <div className="flex items-center gap-1.5 rounded-2xl bg-zinc-100 px-4 py-3 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400 [animation-delay:0ms] dark:bg-zinc-500" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400 [animation-delay:200ms] dark:bg-zinc-500" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400 [animation-delay:400ms] dark:bg-zinc-500" />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="shrink-0 border-t border-zinc-200 px-3 py-3 dark:border-zinc-700">
          {!modeSelected ? (
            /* 모드 선택 화면 */
            <div className="space-y-2">
              <button
                type="button"
                onClick={startConversation}
                className="w-full rounded-full bg-[#007bff] py-3 text-base font-medium text-white shadow-lg transition hover:bg-[#0069d9]"
              >
                🎤 음성으로 대화하기
              </button>
              <button
                type="button"
                onClick={startTextMode}
                className="w-full rounded-full bg-zinc-200 py-3 text-base font-medium text-zinc-700 transition hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600"
              >
                ⌨️ 글씨로 대화하기
              </button>
              {micDenied && (
                <div className="mt-2 rounded-xl bg-red-50 p-3 text-sm">
                  <p className="mb-1 font-semibold text-red-700">마이크를 사용할 수 없어요</p>
                  <p className="text-xs text-red-600">마이크가 없거나 권한이 차단되어 있습니다.</p>
                  <div className="mt-2 space-y-1 text-xs text-zinc-600">
                    <p><b>Chrome / Edge:</b> 주소창 🔒 → 마이크 → 허용 → 새로고침</p>
                    <p><b>Safari:</b> 설정 → Safari → 마이크 → 허용</p>
                  </div>
                  <p className="mt-2 text-xs text-zinc-500">&quot;글씨로 대화하기&quot;를 눌러 텍스트로 대화할 수도 있어요.</p>
                </div>
              )}
            </div>
          ) : textOnly ? (
            /* 텍스트 전용 모드 */
            <div className="space-y-2">
              <form onSubmit={handleSubmit} className="flex items-center gap-2">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="메시지를 입력하세요."
                  className="min-w-0 flex-1 rounded-full border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  disabled={loading}
                  autoFocus
                />
                <button
                  type="submit"
                  disabled={loading || !input.trim()}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#007bff] text-white transition hover:bg-[#0069d9] disabled:opacity-50"
                  title="전송"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                </button>
              </form>
              <button
                type="button"
                onClick={() => { setModeSelected(false); setTextOnly(false); }}
                className="w-full text-center text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
              >
                음성 대화로 전환
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {/* 음성 전원 토글 — 버튼 = 현재 상태 표시 (클릭 = 전환) */}
              <div className="flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    const next = !alwaysOn;
                    setAlwaysOn(next);
                    alwaysOnRef.current = next;
                    if (next) {
                      // OFF → ON: wake-word 모드로 시작 (녹음은 wake 시점에)
                    } else {
                      // ON → OFF: 녹음 중이던 블롭 버리고 즉시 중지 + wake 해제
                      stopRecording({ discard: true });
                      wakeArmedRef.current = false;
                      setWakeArmed(false);
                    }
                  }}
                  aria-pressed={alwaysOn}
                  title={alwaysOn ? "눌러서 끄기" : "눌러서 켜기"}
                  className={`flex min-w-[200px] items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition ${
                    !alwaysOn
                      ? "bg-zinc-300 text-zinc-700 hover:bg-zinc-400 dark:bg-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-600"
                      : listening
                        ? "bg-red-500 text-white shadow-md hover:bg-red-600"
                        : "bg-amber-400 text-zinc-900 shadow-md hover:bg-amber-500"
                  }`}
                >
                  <span
                    className={`inline-block h-2.5 w-2.5 rounded-full ${
                      !alwaysOn
                        ? "bg-zinc-500"
                        : listening
                          ? "bg-white animate-pulse"
                          : "bg-zinc-900 animate-pulse"
                    }`}
                  />
                  🎤 음성 {!alwaysOn ? "꺼짐" : listening ? "듣는 중" : '"마음아" 대기 중'}
                </button>
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  {!alwaysOn
                    ? "(눌러서 켜면 \"마음아\" 호출로 대화 시작)"
                    : listening
                      ? "(말씀 끝나면 자동 전송)"
                      : wakeSupported
                        ? wakeListening
                          ? '("마음아" 또는 "마음" 부르시면 들을게요)'
                          : "(마이크 준비 중…)"
                        : "(이 브라우저는 호출어 미지원 — 자동 듣기 모드)"}
                </span>
                {alwaysOn && !listening && wakeSupported && wakeLastHeard && (
                  <span className="max-w-[280px] truncate text-[10px] text-zinc-400 dark:text-zinc-500" title={wakeLastHeard}>
                    들림: {wakeLastHeard}
                  </span>
                )}
              </div>
              {/* 텍스트 입력 */}
              <form onSubmit={handleSubmit} className="flex items-center gap-2">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="또는 글씨로 입력하세요."
                  className="min-w-0 flex-1 rounded-full border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  disabled={loading}
                />
                <button
                  type="submit"
                  disabled={loading || !input.trim()}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#007bff] text-white transition hover:bg-[#0069d9] disabled:opacity-50"
                  title="전송"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                </button>
              </form>
              <button
                type="button"
                onClick={() => { setAlwaysOn(false); alwaysOnRef.current = false; wakeArmedRef.current = false; setWakeArmed(false); stopRecording({ discard: true }); setModeSelected(false); setMicAllowed(false); }}
                className="w-full text-center text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
              >
                텍스트 대화로 전환
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
