// normalizeHonorific vocative-fix 단위 진단
function normalizeHonorific(text, userHonorific = "할머니") {
  if (!text) return text;
  const KIN = ["할아버지", "할머니", "아버지", "어머니", "아빠", "엄마", "아저씨", "이모", "삼촌", "고모"];
  const filter = (arr) => arr.filter((h) => h !== userHonorific && !userHonorific.includes(h));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = text;
  const kinOffenders = filter(KIN).sort((a, b) => b.length - a.length);
  if (kinOffenders.length > 0) {
    const kinPat = new RegExp(
      `(?<![가-힣])(${kinOffenders.map(esc).join("|")})(?=$|[^가-힣]|의|은|는|이|가|을|를|와|과|랑|이랑|도|만|께|께서|한테|에게|에서|로|으로)`,
      "g",
    );
    out = out.replace(kinPat, (m, _g, offset, full) => {
      const before = full.slice(0, offset);
      return /(?:^|[.!?…\n]|["'“(])\s*$/.test(before) ? userHonorific : m;
    });
  }
  return out;
}
const tests = [
  "꿈에 어머니께서 손을 꼭 잡아주셨다니 정말 따뜻하셨겠어요",
  "꿈속에서 어머니와 함께 어떤 기분을 느끼셨어요?",
  "어머니가 살아계실 때 따뜻하게 대해주셨군요",
  "어머니, 진지 드셨어요?",
];
for (const t of tests) console.log(JSON.stringify(t.slice(0, 22)) + "  →  " + JSON.stringify(normalizeHonorific(t).slice(0, 22)));
