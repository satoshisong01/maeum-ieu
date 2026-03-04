# Vercel 배포

## 1. Git 저장소에 올리기

```bash
git init
git add .
git commit -m "Initial commit - 마음이음"
git branch -M main
git remote add origin https://github.com/본인아이디/저장소이름.git
git push -u origin main
```

## 2. Vercel에서 프로젝트 가져오기

1. [vercel.com](https://vercel.com) 로그인
2. **Add New** → **Project**
3. GitHub 저장소 선택 후 **Import**
4. Framework Preset: **Next.js** (자동 감지)
5. **Deploy** 전에 **Environment Variables** 설정

## 3. Vercel 환경 변수 (필수)

| 이름 | 값 | 비고 |
|------|-----|------|
| `DATABASE_URL` | RDS 연결 문자열 (로컬 .env와 동일) | 비밀번호 `#` → `%23` |
| `NEXTAUTH_URL` | **https://프로젝트도메인.vercel.app** | 배포 후 주소로 수정 가능 |
| `NEXTAUTH_SECRET` | 랜덤 문자열 (로컬과 동일해도 됨) | `openssl rand -base64 32` |
| `GEMINI_API_KEY` | Google AI Studio 키 | 로컬과 동일 |

- RDS 보안 그룹: Vercel IP 또는 `0.0.0.0/0`에서 5432 허용해야 배포 환경에서 접속 가능

## 4. 배포 후

- 첫 배포 URL: `https://maeum-ieu-xxx.vercel.app` 형태
- **NEXTAUTH_URL**을 이 주소로 바꾼 뒤 재배포하거나, Vercel 대시보드에서 환경 변수 수정 후 Redeploy
- 휴대폰에서 같은 URL로 접속하면 됨
