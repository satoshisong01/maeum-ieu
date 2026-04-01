/**
 * 학습 데이터를 Vertex AI 형식으로 변환
 *
 * OpenAI 스타일 JSONL → Vertex AI supervised tuning JSONL
 * - "system" → systemInstruction
 * - "user"/"assistant" → contents (role: "user"/"model")
 *
 * 사용법: npx tsx scripts/convert-to-vertex-format.ts
 */

import * as fs from "fs";
import * as path from "path";

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIRow {
  messages: OpenAIMessage[];
}

interface VertexPart {
  text: string;
}

interface VertexContent {
  role: "user" | "model";
  parts: VertexPart[];
}

interface VertexRow {
  systemInstruction?: { role: string; parts: VertexPart[] };
  contents: VertexContent[];
}

function convertRow(row: OpenAIRow): VertexRow | null {
  const systemMsg = row.messages.find((m) => m.role === "system");
  const nonSystemMsgs = row.messages.filter((m) => m.role !== "system");

  if (nonSystemMsgs.length < 2) return null;

  // 연속된 같은 role 병합 (Vertex AI는 role이 번갈아야 함)
  const contents: VertexContent[] = [];
  for (const m of nonSystemMsgs) {
    const role = m.role === "user" ? "user" as const : "model" as const;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      // 같은 role 연속 → 텍스트 병합
      last.parts[0].text += "\n" + m.content;
    } else {
      contents.push({ role, parts: [{ text: m.content }] });
    }
  }

  // 첫 턴이 user여야 하고, 마지막 턴이 model이어야 함
  if (contents.length < 2) return null;
  if (contents[0].role !== "user") {
    // model로 시작하면 제거
    contents.shift();
  }
  if (contents[contents.length - 1].role !== "model") {
    // user로 끝나면 제거
    contents.pop();
  }
  if (contents.length < 2) return null;

  const result: VertexRow = { contents };

  if (systemMsg) {
    result.systemInstruction = {
      role: "user",
      parts: [{ text: systemMsg.content }],
    };
  }

  return result;
}

function convertFile(inputPath: string, outputPath: string): number {
  const lines = fs.readFileSync(inputPath, "utf-8").trim().split("\n").filter(Boolean);
  const converted: string[] = [];

  for (const line of lines) {
    try {
      const row = JSON.parse(line) as OpenAIRow;
      const vertexRow = convertRow(row);
      if (vertexRow) {
        converted.push(JSON.stringify(vertexRow));
      }
    } catch {
      // skip invalid lines
    }
  }

  fs.writeFileSync(outputPath, converted.join("\n") + "\n");
  return converted.length;
}

// ─── 실행 ────────────────────────────────────────────────────────────────────

const dataDir = path.join(process.cwd(), "training-data");

const files = [
  { input: "merged-chat.jsonl", output: "vertex-chat.jsonl" },
  { input: "merged-analysis.jsonl", output: "vertex-analysis.jsonl" },
];

console.log("=== Vertex AI 형식 변환 ===\n");

for (const f of files) {
  const inputPath = path.join(dataDir, f.input);
  const outputPath = path.join(dataDir, f.output);

  if (!fs.existsSync(inputPath)) {
    console.log(`[SKIP] ${f.input} 없음`);
    continue;
  }

  const count = convertFile(inputPath, outputPath);
  console.log(`${f.input} → ${f.output}: ${count}건 변환`);
}

console.log("\n변환 완료! PowerShell에서 아래 명령으로 업로드하세요:");
console.log("gsutil cp C:\\Users\\jungm\\Desktop\\projects\\maeum-ieu\\training-data\\vertex-chat.jsonl gs://maeum-ieu-training-data/");
console.log("gsutil cp C:\\Users\\jungm\\Desktop\\projects\\maeum-ieu\\training-data\\vertex-analysis.jsonl gs://maeum-ieu-training-data/");
