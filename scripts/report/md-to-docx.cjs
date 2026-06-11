/**
 * 여러 마크다운 파일을 하나의 .docx로 합치는 변환기 (docx-js).
 * 지원: # ## ### 제목, | 표 |, - 불릿, > 인용, **볼드**, 일반 문단.
 *
 * 사용: NODE_PATH=$(npm root -g) node scripts/md-to-docx.mjs <out.docx> <in1.md> [in2.md ...]
 */
const fs = require("fs");
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType, PageBreak, LevelFormat } = require("docx");

const out = process.argv[2];
const inputs = process.argv.slice(3);
if (!out || inputs.length === 0) { console.error("usage: md-to-docx.mjs <out.docx> <in.md...>"); process.exit(1); }

const CONTENT_W = 9360; // US Letter, 1" margins
const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };

// **볼드** 인라인 파싱 → TextRun[]
function runs(text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((s) => s !== "");
  return parts.map((p) => p.startsWith("**") && p.endsWith("**")
    ? new TextRun({ text: p.slice(2, -2), bold: true })
    : new TextRun(p));
}

function splitCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function makeTable(rows) {
  const header = splitCells(rows[0]);
  const bodyRows = rows.slice(2); // skip |---| separator
  const n = header.length;
  const colW = Math.floor(CONTENT_W / n);
  const colWidths = Array.from({ length: n }, (_, i) => i === n - 1 ? CONTENT_W - colW * (n - 1) : colW);
  const mkRow = (cells, isHeader) => new TableRow({
    children: cells.map((c, i) => new TableCell({
      borders,
      width: { size: colWidths[i], type: WidthType.DXA },
      shading: isHeader ? { fill: "D5E8F0", type: ShadingType.CLEAR } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ children: runs(c || " "), spacing: { after: 0 } })],
    })),
  });
  const trimmed = bodyRows.filter((r) => r.includes("|"));
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [mkRow(header, true), ...trimmed.map((r) => mkRow(splitCells(r), false))],
  });
}

function parseMd(md) {
  const lines = md.split(/\r?\n/);
  const children = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (t === "") { i++; continue; }
    // 표 블록
    if (t.startsWith("|")) {
      const block = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { block.push(lines[i]); i++; }
      if (block.length >= 2) children.push(makeTable(block));
      children.push(new Paragraph({ text: "", spacing: { after: 80 } }));
      continue;
    }
    if (t.startsWith("### ")) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: runs(t.slice(4)) }));
    } else if (t.startsWith("## ")) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: runs(t.slice(3)) }));
    } else if (t.startsWith("# ")) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: runs(t.slice(2)) }));
    } else if (t.startsWith("> ")) {
      children.push(new Paragraph({ children: [new TextRun({ text: t.slice(2).replace(/\*\*/g, ""), italics: true, color: "555555" })], indent: { left: 360 }, spacing: { after: 80 } }));
    } else if (t.startsWith("- ") || t.startsWith("* ")) {
      children.push(new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: runs(t.slice(2)) }));
    } else if (/^\d+\.\s/.test(t)) {
      children.push(new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: runs(t.replace(/^\d+\.\s/, "")) }));
    } else if (t === "---") {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "2E75B6", space: 1 } }, spacing: { after: 120 } }));
    } else {
      children.push(new Paragraph({ children: runs(t), spacing: { after: 80 } }));
    }
    i++;
  }
  return children;
}

const allChildren = [];
inputs.forEach((f, idx) => {
  if (idx > 0) allChildren.push(new Paragraph({ children: [new PageBreak()] }));
  allChildren.push(...parseMd(fs.readFileSync(f, "utf-8")));
});

const doc = new Document({
  styles: {
    default: { document: { run: { font: "맑은 고딕", size: 20 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "맑은 고딕", color: "1F4E79" },
        paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, font: "맑은 고딕", color: "2E75B6" },
        paragraph: { spacing: { before: 180, after: 120 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 22, bold: true, font: "맑은 고딕", color: "444444" },
        paragraph: { spacing: { before: 120, after: 80 }, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 280 } } } }] },
      { reference: "numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 280 } } } }] },
    ],
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    children: allChildren,
  }],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(out, buf); console.log(`생성: ${out} (${(buf.length / 1024).toFixed(0)}KB)`); });
