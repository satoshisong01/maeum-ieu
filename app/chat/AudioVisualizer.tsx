"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  stream: MediaStream | null;
  active: boolean;
  aiSpeaking: boolean;
};

export function AudioVisualizer({ stream, active, aiSpeaking }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number>(0);
  const [dim, setDim] = useState(280);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;
    const ctx = context;

    const dpr = window.devicePixelRatio ?? 1;
    const size = Math.min(280, window.innerWidth - 48);
    setDim(size);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.scale(dpr, dpr);
  }, []);

  // 마이크 스트림 → 실시간 주파수 시각화
  useEffect(() => {
    if (!stream) return;

    const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    analyserRef.current = analyser;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;
    const ctx = context;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const w = canvas.width / (window.devicePixelRatio ?? 1);
    const h = canvas.height / (window.devicePixelRatio ?? 1);

    function draw() {
      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = aiSpeaking ? "#007bff" : "#007bff";
      const barWidth = Math.max(1, (w / bufferLength) * 2.5);
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 255;
        const barHeight = v * h * 0.6;
        ctx.fillRect(x, h - barHeight, barWidth - 1, barHeight);
        x += barWidth;
      }
    }
    draw();

    return () => {
      cancelAnimationFrame(animationRef.current);
      analyserRef.current = null;
      audioContext.close();
    };
  }, [stream, aiSpeaking]);

  // 스트림 없고 AI 말할 때: 출렁이는 파형 애니메이션
  useEffect(() => {
    if (stream) return;
    if (!active && !aiSpeaking) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;
    const ctx = context;

    const w = canvas.width / (window.devicePixelRatio ?? 1);
    const h = canvas.height / (window.devicePixelRatio ?? 1);
    let phase = 0;

    function draw() {
      animationRef.current = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#007bff";
      const barCount = 32;
      const barWidth = Math.max(2, (w / barCount) - 2);
      for (let i = 0; i < barCount; i++) {
        const t = phase + i * 0.3;
        const wave = Math.sin(t) * 0.5 + 0.5;
        const barHeight = (0.2 + wave * 0.6) * h;
        const x = (w / barCount) * i + 1;
        ctx.fillRect(x, h - barHeight, barWidth, barHeight);
      }
      phase += 0.08;
    }
    draw();

    return () => cancelAnimationFrame(animationRef.current);
  }, [stream, active, aiSpeaking]);

  return (
    <div
      className="flex items-center justify-center rounded-full bg-white shadow-lg"
      style={{ width: dim, height: dim }}
    >
      <canvas
        ref={canvasRef}
        className="rounded-full"
        width={dim}
        height={dim}
        style={{ width: dim, height: dim }}
      />
    </div>
  );
}
