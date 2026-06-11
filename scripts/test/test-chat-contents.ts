// buildChatContents 구조 검증 — Gemini multi-turn contents 변환
// 주요 검증: turn 순서 보존, user/model 교대, 마지막은 user, Q-A 페어 마커

type GeminiTurn = { role: "user" | "model"; parts: { text: string }[] };
type Msg = { role: string; content: string; createdAt?: string };

// route.ts와 동일 로직 복사 — getRelativeTimeLabel은 더미로
function getRelativeTimeLabel(_iso: string, _now: Date): string { return "방금"; }

function buildChatContents(params: {
  messages: Msg[];
  currentUserMessage: string;
  memories: string;
  hintBlock: string;
  now?: Date;
  maxRecent?: number;
}): GeminiTurn[] {
  const { messages, currentUserMessage, memories, hintBlock, now = new Date(), maxRecent = 20 } = params;
  const recent = messages.slice(-maxRecent);
  let prior = recent;
  const lastMsg = recent[recent.length - 1];
  if (lastMsg && lastMsg.role === "user" && lastMsg.content.trim() === (currentUserMessage || "").trim()) {
    prior = recent.slice(0, -1);
  }
  const turns: GeminiTurn[] = [];
  for (const m of prior) {
    const role: "user" | "model" = m.role === "user" ? "user" : "model";
    const timeLabel = m.createdAt ? `[${getRelativeTimeLabel(m.createdAt, now)}] ` : "";
    const cleaned = m.content.replace(/\s*<!--\s*__mod:[^>]*-->\s*$/g, "").trim();
    if (!cleaned) continue;
    const text = `${timeLabel}${cleaned}`;
    const lastTurn = turns[turns.length - 1];
    if (lastTurn && lastTurn.role === role) {
      lastTurn.parts[0].text += `\n${text}`;
    } else {
      turns.push({ role, parts: [{ text }] });
    }
  }
  if (turns.length > 0 && turns[0].role === "model") {
    turns.unshift({ role: "user", parts: [{ text: "(대화 시작)" }] });
  }
  const lastPrior = prior[prior.length - 1];
  const lastWasAi = lastPrior && lastPrior.role !== "user";
  const qaMarker = lastWasAi
    ? `[지금 사용자의 답변은 바로 위 AI의 마지막 발화에 대한 응답입니다. 새 주제가 아니라 그 흐름을 이어받으세요.]\n`
    : "";
  const cleanedHints = (hintBlock || "").trim();
  const finalText = [
    memories ? `[참고 — 과거 메모리]\n${memories}` : "",
    cleanedHints,
    `${qaMarker}[현재 사용자 발화]\n${currentUserMessage || "(빈 메시지)"}`,
  ].filter(Boolean).join("\n\n");
  const tail = turns[turns.length - 1];
  if (tail && tail.role === "user") {
    tail.parts[0].text += `\n\n${finalText}`;
  } else {
    turns.push({ role: "user", parts: [{ text: finalText }] });
  }
  return turns;
}

let pass = 0, fail = 0;
function assert(cond: boolean, label: string, ctx?: unknown) {
  if (cond) { console.log(`✓ ${label}`); pass++; }
  else { console.log(`✗ ${label}`); if (ctx) console.log("  ctx:", JSON.stringify(ctx, null, 2)); fail++; }
}

// Case 1: 텍스트 모드 — 마지막 messages가 currentUserMessage와 동일 → prior에서 제외
{
  const msgs: Msg[] = [
    { role: "user", content: "어제 점심 뭐 먹었지" },
    { role: "assistant", content: "어제 점심으로 김치찌개 드셨다고 하셨어요." },
    { role: "user", content: "맞아 김치찌개" },
  ];
  const c = buildChatContents({ messages: msgs, currentUserMessage: "맞아 김치찌개", memories: "", hintBlock: "" });
  assert(c.length >= 2, "텍스트 모드 — 최소 user→model→user 구조", c);
  assert(c[c.length - 1].role === "user", "마지막 turn은 user", c[c.length - 1]);
  assert(c[c.length - 1].parts[0].text.includes("맞아 김치찌개"), "현재 발화 포함");
  assert(c[c.length - 1].parts[0].text.includes("[지금 사용자의 답변은 바로 위 AI"), "Q-A 페어링 마커 주입(직전이 AI)");
  // 중복 방지: 현재 메시지가 prior에 한 번만
  const occurrences = c.filter((t) => t.parts[0].text.includes("맞아 김치찌개")).length;
  assert(occurrences === 1, "현재 발화 중복 방지", { occurrences });
}

// Case 2: 음성 모드 — messages에 현재 발화 없음, transcription을 별도 주입
{
  const msgs: Msg[] = [
    { role: "user", content: "점심 뭐 먹어야 할까" },
    { role: "assistant", content: "어떤 음식 드시고 싶으세요?" },
  ];
  const c = buildChatContents({ messages: msgs, currentUserMessage: "냉면 어때", memories: "", hintBlock: "" });
  assert(c[c.length - 1].parts[0].text.includes("냉면 어때"), "transcription이 현재 발화로 들어감");
  assert(c[c.length - 1].parts[0].text.includes("[지금 사용자의 답변은 바로 위 AI"), "직전 AI 질문 페어링 마커");
}

// Case 3: 첫 turn이 model이면 dummy user를 앞에 넣음
{
  const msgs: Msg[] = [
    { role: "assistant", content: "안녕하세요! 오늘은 어떠세요?" },
    { role: "user", content: "좋아요" },
    { role: "assistant", content: "다행이네요." },
  ];
  const c = buildChatContents({ messages: msgs, currentUserMessage: "산책 가도 좋겠어요", memories: "", hintBlock: "" });
  assert(c[0].role === "user", "첫 turn은 user (dummy 삽입)", c[0]);
}

// Case 4: 연속된 같은 role 합치기
{
  const msgs: Msg[] = [
    { role: "user", content: "첫 발화" },
    { role: "user", content: "두 번째 발화" },
    { role: "assistant", content: "응답" },
  ];
  const c = buildChatContents({ messages: msgs, currentUserMessage: "새 발화", memories: "", hintBlock: "" });
  // user 두 개가 합쳐져야 함
  const firstUser = c[0];
  assert(firstUser.role === "user", "첫 user turn");
  assert(firstUser.parts[0].text.includes("첫 발화") && firstUser.parts[0].text.includes("두 번째 발화"), "연속 user 합쳐짐", firstUser);
}

// Case 5: 직전이 user면 Q-A 마커 없음, 그 user 턴에 현재 발화가 append됨
{
  const msgs: Msg[] = [
    { role: "user", content: "어제 일" },
    { role: "assistant", content: "어떤 일이었어요?" },
    { role: "user", content: "장보러" },
  ];
  // currentUserMessage가 last와 안 맞는 경우 — last "장보러"는 그대로 prior로, current는 신규
  const c = buildChatContents({ messages: msgs, currentUserMessage: "마트 갔어", memories: "", hintBlock: "" });
  // last prior가 user니까 합쳐짐 → 마지막 user turn에 "장보러"와 "마트 갔어"가 같이
  const last = c[c.length - 1];
  assert(last.role === "user", "마지막 user");
  assert(last.parts[0].text.includes("마트 갔어"), "현재 발화 들어감");
  assert(!last.parts[0].text.includes("[지금 사용자의 답변은 바로 위 AI"), "직전이 user면 Q-A 마커 없음", last);
}

// Case 6: 메모리/힌트 블록 주입
{
  const msgs: Msg[] = [
    { role: "user", content: "안녕" },
    { role: "assistant", content: "반가워요" },
  ];
  const c = buildChatContents({
    messages: msgs,
    currentUserMessage: "오늘 뭐 할까",
    memories: "사용자는 산책을 좋아함",
    hintBlock: "[답변 직전 점검]\n중복 질문 금지",
  });
  const final = c[c.length - 1].parts[0].text;
  assert(final.includes("[참고 — 과거 메모리]"), "메모리 블록 주입");
  assert(final.includes("산책을 좋아함"), "메모리 내용 포함");
  assert(final.includes("[답변 직전 점검]"), "힌트 블록 주입");
}

// Case 7: 모더레이션 시그니처 제거
{
  const msgs: Msg[] = [
    { role: "user", content: "욕설" },
    { role: "assistant", content: "그런 말은 어렵네요.\n<!-- __mod:profanity__ -->" },
  ];
  const c = buildChatContents({ messages: msgs, currentUserMessage: "미안", memories: "", hintBlock: "" });
  const modelTurn = c.find((t) => t.role === "model");
  assert(modelTurn !== undefined && !modelTurn.parts[0].text.includes("__mod:"), "모더레이션 시그니처 제거됨", modelTurn);
}

// Case 8: 빈 messages
{
  const c = buildChatContents({ messages: [], currentUserMessage: "처음", memories: "", hintBlock: "" });
  assert(c.length === 1 && c[0].role === "user", "빈 history → user turn 하나");
  assert(c[0].parts[0].text.includes("처음"), "현재 발화 포함");
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
