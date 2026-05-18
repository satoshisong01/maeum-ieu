"use client";

import { useEffect, useState } from "react";

export interface MedicationSchedule {
  id: string;
  label: string;
  times: string[];
  enabled: boolean;
  lastTriggeredAt: string | null;
}

interface DraftSchedule {
  label: string;
  times: string[];
  enabled: boolean;
}

const TIME_PRESETS: Array<{ label: string; times: string[] }> = [
  { label: "하루 1회 (아침)", times: ["09:00"] },
  { label: "하루 2회 (아침/저녁)", times: ["09:00", "20:00"] },
  { label: "하루 3회 (식후)", times: ["09:00", "13:00", "20:00"] },
  { label: "8시간 간격", times: ["08:00", "16:00", "00:00"] },
];

function timeIsValid(t: string): boolean {
  return /^\d{1,2}:\d{2}$/.test(t.trim()) && (() => {
    const [h, m] = t.split(":").map((v) => parseInt(v, 10));
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
  })();
}

export interface MedicationEditorProps {
  /** API에 즉시 저장할지 (mypage) 아니면 부모가 모아서 처리할지 (signup) */
  persist: boolean;
  /** persist=false 일 때 부모가 임시 목록 관리 */
  initial?: DraftSchedule[];
  onChange?: (drafts: DraftSchedule[]) => void;
  className?: string;
}

export default function MedicationEditor({ persist, initial, onChange, className }: MedicationEditorProps) {
  const [items, setItems] = useState<MedicationSchedule[]>([]);
  const [drafts, setDrafts] = useState<DraftSchedule[]>(initial ?? []);
  const [loading, setLoading] = useState(persist);

  const [newLabel, setNewLabel] = useState("");
  const [newTimes, setNewTimes] = useState<string[]>(["09:00"]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!persist) return;
    (async () => {
      try {
        const r = await fetch("/api/medications");
        if (r.ok) {
          const data = await r.json();
          setItems(data.items ?? []);
        }
      } finally { setLoading(false); }
    })();
  }, [persist]);

  useEffect(() => {
    if (!persist && onChange) onChange(drafts);
  }, [drafts, persist, onChange]);

  function applyPreset(times: string[]) {
    setNewTimes([...times]);
  }

  function updateNewTimeAt(idx: number, value: string) {
    setNewTimes((prev) => prev.map((t, i) => i === idx ? value : t));
  }

  function addTimeSlot() {
    setNewTimes((prev) => [...prev, "12:00"]);
  }

  function removeTimeSlot(idx: number) {
    setNewTimes((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleAdd() {
    setError("");
    const label = newLabel.trim();
    if (!label) { setError("약 이름을 입력해주세요."); return; }
    const validTimes = newTimes.filter(timeIsValid);
    if (validTimes.length === 0) { setError("유효한 복약 시간을 한 개 이상 입력해주세요."); return; }

    if (persist) {
      const r = await fetch("/api/medications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, times: validTimes }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError(data.error ?? "추가 실패");
        return;
      }
      const created = await r.json();
      setItems((prev) => [...prev, created]);
    } else {
      setDrafts((prev) => [...prev, { label, times: validTimes, enabled: true }]);
    }
    setNewLabel("");
    setNewTimes(["09:00"]);
  }

  async function handleDelete(id: string) {
    if (!confirm("이 스케줄을 삭제할까요?")) return;
    const r = await fetch(`/api/medications/${id}`, { method: "DELETE" });
    if (r.ok) setItems((prev) => prev.filter((x) => x.id !== id));
  }

  async function toggleEnabled(item: MedicationSchedule) {
    const r = await fetch(`/api/medications/${item.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !item.enabled }),
    });
    if (r.ok) {
      const updated = await r.json();
      setItems((prev) => prev.map((x) => x.id === item.id ? updated : x));
    }
  }

  function removeDraft(idx: number) {
    setDrafts((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <div className={`flex flex-col gap-3 ${className ?? ""}`}>
      {persist && loading && <p className="text-xs text-zinc-400">불러오는 중...</p>}

      {/* 기존 목록 */}
      {persist && items.map((item) => (
        <div key={item.id} className={`flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800 ${!item.enabled ? "opacity-50" : ""}`}>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.label}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{item.times.join(" · ")}</p>
          </div>
          <button type="button" onClick={() => toggleEnabled(item)} className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700">
            {item.enabled ? "끄기" : "켜기"}
          </button>
          <button type="button" onClick={() => handleDelete(item.id)} className="rounded-md px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950">
            삭제
          </button>
        </div>
      ))}

      {/* 임시 (signup용) */}
      {!persist && drafts.map((d, i) => (
        <div key={i} className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{d.label}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{d.times.join(" · ")}</p>
          </div>
          <button type="button" onClick={() => removeDraft(i)} className="rounded-md px-2 py-1 text-xs text-red-500 hover:bg-red-50">삭제</button>
        </div>
      ))}

      {/* 신규 입력 */}
      <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-3 dark:border-zinc-600 dark:bg-zinc-900/40">
        <p className="mb-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">새 복약/일과 알림 추가</p>
        <input
          type="text"
          placeholder="약 이름 또는 일과 (예: 혈압약, 아침 영양제)"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          className="mb-2 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
        <div className="mb-2 flex flex-wrap gap-1">
          {TIME_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p.times)}
              className="rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="mb-2 flex flex-wrap gap-2">
          {newTimes.map((t, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="time"
                value={t}
                onChange={(e) => updateNewTimeAt(i, e.target.value)}
                className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
              {newTimes.length > 1 && (
                <button type="button" onClick={() => removeTimeSlot(i)} className="rounded px-1 text-xs text-zinc-400 hover:text-red-500">×</button>
              )}
            </div>
          ))}
          <button type="button" onClick={addTimeSlot} className="rounded-md border border-dashed border-zinc-300 px-2 py-1 text-xs text-zinc-500 hover:border-zinc-400 dark:border-zinc-600">
            + 시간 추가
          </button>
        </div>
        {error && <p className="mb-2 text-xs text-red-500">{error}</p>}
        <button
          type="button"
          onClick={handleAdd}
          className="rounded-lg bg-[#007bff] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#006bdc]"
        >
          추가
        </button>
      </div>

      {!persist && (
        <p className="text-[11px] text-zinc-400">회원가입 완료 후 마이페이지에서 언제든 추가/수정/삭제할 수 있어요.</p>
      )}
    </div>
  );
}
