# 에어갭 환경 LLM 서빙 인프라 검토 보고서
## "Open Claude in Chrome" + 로컬 LLM 자체호스팅 구동 가이드

> 하네스팀 검토 ① — LLM 모델 & 서빙 인프라
> 전제: 완전 에어갭 · 고사양 GPU 클러스터(H100/A100 다수) · 오픈소스 모델 자체호스팅

> ⚠️ **아키텍처 업데이트 (반드시 [05 문서](./05-확정-아키텍처-opencode-및-PoC.md) 우선):** 두뇌가 **Claude Code → opencode**로 확정되었습니다. 그 결과 **Anthropic API 호환 게이트웨이(LiteLLM 변환)는 불필요**하며, opencode가 **OpenAI API로 vLLM에 직결**합니다(LiteLLM은 로드밸런싱 옵션). 또한 모델은 **gpt-oss + Qwen3.5-27B + 비전 모델 1종**으로 확정. 본 문서의 §1(연결 방식·ANTHROPIC_BASE_URL/LiteLLM) 부분은 05 문서로 **대체**되며, **§2~§5의 모델/서빙/양자화/오프라인 반입 substance는 그대로 유효**합니다.

---

## 0. 요약 (Executive Summary)

| 항목 | 결론 |
|---|---|
| **연결 방식** | Claude Code → `ANTHROPIC_BASE_URL`로 **LiteLLM Proxy(:4000)** 지정 → LiteLLM이 Anthropic `/v1/messages` ↔ OpenAI 포맷 변환 → **vLLM** 백엔드 호출 |
| **왜 이 경로** | 에어갭에서는 Bedrock/Vertex(클라우드 의존) 불가. 순수 자체호스팅 + Anthropic 호환 게이트웨이 = LiteLLM+vLLM이 유일하게 성립하는 조합 |
| **1순위 모델** | **DeepSeek-V3 계열**(대규모 에이전틱) 또는 **Qwen3-Coder 계열**(코딩+툴콜+Apache-2.0 라이선스 안전). 둘 중 라이선스/하드웨어 제약에 따라 선택 |
| **비전(스크린샷) 처리** | 이 프로젝트의 `computer`/`zoom` 툴이 JPEG 이미지를 반환 → **비전 모델 필요**. 비전 미지원 모델 사용 시 `read_page`/`find`/`get_page_text`(텍스트 접근성 트리) 위주로 우회하는 **텍스트-퍼스트 전략** 필수 |
| **서빙 스택** | **vLLM**(범용 1순위) 또는 **SGLang**(고동시성). 둘 다 Anthropic 호환은 LiteLLM이 담당 |
| **양자화** | H100 보유 시 **FP8** 권장(품질 손실 최소, 처리량 ↑). A100만 있으면 **AWQ/GPTQ INT4** |

> **중요 주의:** 본 보고서의 모델 성능/벤치마크 수치와 일부 "최신 모델"(DeepSeek-V4, Qwen3.5/3.6, GLM-5.1, Kimi K2.6 등)은 공개정보에서 언급되었으나 **명칭·버전·가용성이 시점에 따라 빠르게 변하므로 반입 직전 내부 검증이 반드시 필요**합니다. 해당 항목은 본문에서 `⚠️검증필요`로 표시했습니다.

---

## 1. Claude Code의 내부 LLM 연결 방식

### 1.1 핵심 환경변수

| 환경변수 | 역할 | 에어갭 설정 예시 |
|---|---|---|
| `ANTHROPIC_BASE_URL` | 게이트웨이 주소. `api.anthropic.com` 대신 내부 LiteLLM 지정 | `http://litellm.internal:4000` |
| `ANTHROPIC_AUTH_TOKEN` | `Authorization` 헤더로 전송되는 토큰(LiteLLM virtual key) | `sk-litellm-internal-xxxx` |
| `ANTHROPIC_API_KEY` | (대안) `x-api-key` 헤더. 토큰 미설정 시 사용 | — |
| `ANTHROPIC_MODEL` | 기본(메인) 모델명 | `deepseek-v3` |
| `ANTHROPIC_SMALL_FAST_MODEL` | 경량 작업용(요약·제목 생성 등) 모델 | `qwen3-coder-30b` |
| `ANTHROPIC_CUSTOM_HEADERS` | 추가 헤더 | (옵션) |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` | 비-Anthropic 모델에서 실험적 beta 기능 비활성화. **자체호스팅 시 권장** | `1` |
| `CLAUDE_CODE_ATTRIBUTION_HEADER=0` | system prompt 앞 attribution 블록 제거(게이트웨이 캐시 충돌 방지) | `0` |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` | 게이트웨이 `/v1/models`로 모델 목록 자동 검색 | 옵션 |

> **검색 필터 주의:** 게이트웨이 모델 자동검색(`/model` 피커)은 **모델 ID가 `claude` 또는 `anthropic`으로 시작하는 것만** 추가합니다. `deepseek-v3` 같은 이름은 피커에 안 뜨므로, LiteLLM에서 모델 별칭을 `claude-...`로 매핑하거나 `ANTHROPIC_MODEL`로 직접 지정하세요.

### 1.2 게이트웨이가 구현해야 할 엔드포인트

- `POST /v1/messages` (필수 — 메인 추론)
- `POST /v1/messages/count_tokens` (토큰 카운트)
- 요청 헤더 `anthropic-beta`, `anthropic-version` **반드시 전달(forward)**
- (선택) `GET /v1/models` (모델 디스커버리용)

LiteLLM의 **unified endpoint**(`/v1/messages`)가 이를 모두 충족하므로 별도 구현 불필요.

### 1.3 왜 LiteLLM + vLLM 경로가 에어갭에 적합한가

Claude Code는 세 가지 API 포맷을 지원합니다: **Anthropic Messages**, **Bedrock InvokeModel**, **Vertex rawPredict**.

| 경로 | 에어갭 적합성 | 이유 |
|---|---|---|
| Bedrock 모드 (`CLAUDE_CODE_USE_BEDROCK=1`) | ❌ 불가 | AWS Bedrock = 외부 클라우드. 폐쇄망에서 접근 불가 |
| Vertex 모드 (`CLAUDE_CODE_USE_VERTEX=1`) | ❌ 불가 | GCP Vertex = 외부 클라우드. 동일 |
| **Anthropic Messages → LiteLLM → vLLM** | ✅ 적합 | 전 구간 내부망. LiteLLM이 포맷 변환, vLLM이 오픈모델 서빙 |

에어갭에서 클라우드 패스스루는 원천 불가하므로, "Anthropic Messages 포맷을 그대로 받아 OpenAI 포맷으로 번역해 로컬 vLLM에 전달"하는 LiteLLM이 유일하게 성립하는 게이트웨이입니다.

### 1.4 실제 설정 예시

**(a) Claude Code 측 — `~/.claude/settings.json`**

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://litellm.internal:4000",
    "ANTHROPIC_AUTH_TOKEN": "sk-litellm-internal-team-key",
    "ANTHROPIC_MODEL": "claude-deepseek-v3",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-qwen3-coder-30b",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0"
  }
}
```

> 모델 별칭을 `claude-...`로 둔 이유: 디스커버리 필터와 일부 기능 게이팅이 모델명 prefix를 보기 때문. LiteLLM에서 `claude-deepseek-v3` → 실제 `deepseek-v3` vLLM 백엔드로 라우팅.

**(b) LiteLLM Proxy — `config.yaml`**

```yaml
model_list:
  # 메인 에이전틱 모델
  - model_name: claude-deepseek-v3
    litellm_params:
      model: hosted_vllm/deepseek-ai/DeepSeek-V3        # vLLM 백엔드(OpenAI 호환)
      api_base: http://vllm-deepseek.internal:8000/v1
      api_key: "dummy"                                   # vLLM는 키 불요, placeholder
  # 경량/코딩 모델
  - model_name: claude-qwen3-coder-30b
    litellm_params:
      model: hosted_vllm/Qwen/Qwen3-Coder-30B-A3B-Instruct
      api_base: http://vllm-qwen.internal:8001/v1
      api_key: "dummy"
  # 비전 모델(스크린샷 처리용)
  - model_name: claude-qwen-vl
    litellm_params:
      model: hosted_vllm/Qwen/Qwen2.5-VL-72B-Instruct
      api_base: http://vllm-vl.internal:8002/v1
      api_key: "dummy"

litellm_settings:
  drop_params: true        # 미지원 파라미터 자동 제거(호환성)

general_settings:
  master_key: sk-litellm-internal-team-key
```

기동: `litellm --config /etc/litellm/config.yaml --port 4000 --host 0.0.0.0`

> ⚠️ **보안 경고:** LiteLLM PyPI **1.82.7 / 1.82.8 버전은 자격증명 탈취 악성코드가 포함**된 것으로 보고된 바 있습니다. 반입 시 해당 버전을 절대 사용하지 말고, 내부 미러에 검증된 버전만 등록하세요. (반입 전 최신 보안 권고 재확인 — `⚠️검증필요`)

---

## 2. 추천 오픈소스 모델

### 2.1 후보 비교표

> ⚠️검증필요: 아래 수치는 공개정보 기준이며, MoE 활성 파라미터·컨텍스트·라이선스는 모델 리비전마다 변동. **반입 전 모델 카드 원본 재확인 필수.**

| 모델 | 툴콜/함수호출 | 컨텍스트 | 에이전틱 적합성 | 라이선스 | 필요 VRAM (개략) | GPU 구성(개략) |
|---|---|---|---|---|---|---|
| **DeepSeek-V3** (671B MoE, ~37B active) | 우수 | 128K | 매우 우수(다단계 툴콜·코딩) | DeepSeek License(상용 허용, 조건부) | FP8 ~700GB+ | H100 80GB **×8** (1노드), TP=8 |
| **DeepSeek-R1** (추론특화) | 양호(reasoning 누수 주의) | 128K | 추론 강함, 단 `<think>` 토큰이 툴콜 파싱 방해 가능 | MIT | DeepSeek-V3와 유사 | H100 ×8 |
| **Qwen3-Coder 30B-A3B** (MoE, ~3B active) | **우수**(전용 파서 `qwen3_coder`) | **256K** | 우수(repo-scale 코딩·에이전틱) | **Apache-2.0** ✅ | FP8 ~40–60GB | H100 ×1~2 |
| **Qwen2.5-Coder 32B** (dense) | 우수(`hermes` 파서) | 128K | 양호 | **Apache-2.0** ✅ | ~65GB(BF16) / ~20GB(AWQ) | H100/A100 ×1 |
| **Llama 3.3 70B** (dense) | 양호(`llama3_json` 파서) | 128K | 보통(코딩은 Qwen/DeepSeek 대비 약함) | Llama Community License(상용 일부 제약) | BF16 ~140GB / INT4 ~43GB | H100 ×2 / A100 ×2 |
| **Mistral Large** | 양호 | 128K | 보통 | Mistral 라이선스(상용 별도) | ~250GB(BF16) | H100 ×4 |
| **Qwen2.5-VL 72B** (비전) | 양호 | 128K | 비전+에이전틱(스크린샷용) | Qwen License | BF16 ~145GB / AWQ ~45GB | H100 ×2 |

> ⚠️검증필요: **DeepSeek-V4(1M 컨텍스트)**, **Qwen3.5/3.6**, **GLM-5.1**, **Kimi K2.6** 등 더 최신 세대가 언급됨. 폐쇄망 반입 시점에 이들 신모델 가용성·라이선스를 추가 확인하면 더 나은 선택지가 될 수 있음. 다만 **검증되지 않은 신모델보다 안정성이 입증된 DeepSeek-V3 / Qwen3-Coder를 1차 도입** 권장.

### 2.2 1순위 추천 (1~2개)

**1순위 A — Qwen3-Coder (30B-A3B Instruct)** ← 대부분의 조직에 권장
- **근거:**
  1. **Apache-2.0 라이선스** → 내부/상용 사용 컴플라이언스 가장 안전 (법무 리뷰 부담 최소)
  2. MoE로 활성 파라미터 ~3B → **단일/2장 H100에서 고동시성** 가능, 멀티유저 비용효율 압도적
  3. 256K 컨텍스트 → Claude Code의 긴 툴콜 루프 + 큰 `read_page`(50000자) 출력 수용
  4. vLLM 전용 툴콜 파서(`--tool-call-parser qwen3_coder`)로 **Claude Code의 다단계 툴콜 루프 안정 처리**

**1순위 B — DeepSeek-V3** ← 최고 성능이 필요하고 H100 8장 노드를 전용할 수 있을 때
- **근거:**
  1. 에이전틱 다단계 추론·툴콜·코딩에서 오픈모델 중 최상위권
  2. 복잡한 브라우저 자동화 시나리오(여러 탭·조건 분기·실패 복구)에서 안정성 우위
  3. 단점: 671B MoE라 **H100 80GB ×8 1노드를 통째로 점유** → 동시 사용자 수 제한, GPU 비용 큼

> **실무 권장 조합:** 메인 = Qwen3-Coder, `SMALL_FAST_MODEL` = 더 작은 Qwen3(예: 8B-FP8). 성능 한계 도달 시에만 DeepSeek-V3 노드를 별도로 띄워 고난도 작업 라우팅.

### 2.3 멀티모달(비전) 필요성 분석 — **이 프로젝트에서 매우 중요**

`mcp-server.js` 분석 결과, **이미지를 반환하는 툴이 존재**합니다:

- `computer` 툴의 `action: "screenshot"` → JPEG 이미지 반환
- `computer` 툴의 `action: "zoom"` → 특정 영역 JPEG 캡처
- `imageResult()` 헬퍼가 `{ type: "image", data: base64, mimeType }` MCP 콘텐츠 블록 생성 (`mcp-server.js:422`)
- 스크린샷은 JPEG, quality 55 (페이로드 제어 목적)

즉, Claude Code가 이 MCP 서버를 쓰면 **모델에 이미지 입력(base64 JPEG)이 전달**됩니다. 따라서:

| 시나리오 | 결과 |
|---|---|
| **비전 모델 사용** (Qwen2.5-VL 등) | `computer` 스크린샷 기반 좌표 클릭/시각 검증 정상 동작 → 공식 Claude in Chrome과 가장 유사 |
| **텍스트 전용 모델 사용** (Qwen3-Coder, DeepSeek-V3 등) | 스크린샷 이미지를 모델이 해석 불가 → `computer`의 시각 기반 워크플로 무력화 |

**결론:** 공식 확장과 동등한 경험을 원하면 **비전 모델이 필요**합니다. 후보: **Qwen2.5-VL 72B**(또는 더 작은 7B/32B), `⚠️검증필요`로 더 최신 VL 모델(Qwen3-VL 등) 확인. 단, 비전 모델은 코딩/에이전틱 능력이 동급 텍스트 모델보다 약할 수 있으므로, **§4.2의 텍스트-퍼스트 우회 전략**과 비교 평가 권장.

---

## 3. 서빙 스택

### 3.1 vLLM vs SGLang vs TGI

| 항목 | **vLLM** | **SGLang** | **TGI (HF)** |
|---|---|---|---|
| 툴콜 파싱 | ✅ 풍부(`hermes`/`llama3_json`/`qwen3_coder`/`qwen3_xml` 등) | ✅ 우수, 구조화 출력 강함 | △ 제한적 |
| 처리량/동시성 | 매우 높음(PagedAttention, continuous batching) | **최상위권**(RadixAttention, 프롬프트 캐시 재사용) | 양호 |
| 텐서 병렬(TP) | ✅ `--tensor-parallel-size` | ✅ | ✅ |
| 양자화 | FP8/AWQ/GPTQ/INT8 광범위 | FP8/AWQ 등 | 제한적 |
| 비전 모델 | ✅ Qwen-VL 등 지원 | ✅ 멀티모달 강점 | △ |
| 생태계/문서 | **가장 넓음**, LiteLLM 연동 검증多 | 빠르게 성장 | 성숙하나 정체 |
| **권장도** | **1순위(범용)** | 고동시성/멀티모달 특화 시 | 비권장 |

> **검색 확인 사항(`⚠️검증필요`):** vLLM 일부 버전에서 **Qwen FP8 + XML 툴콜이 `<think>` 추론 태그 안에서 방출될 때 툴콜을 유실하는 버그**가 보고됨. → reasoning 모델(R1/Qwen reasoning)을 쓸 때 `--reasoning-parser`와 `--tool-call-parser`를 **반드시 함께** 설정하고, 도입 vLLM 버전에서 툴콜 정상 파싱을 사전 검증할 것.

**기동 예시 (Qwen3-Coder, 툴콜 활성):**
```bash
vllm serve Qwen/Qwen3-Coder-30B-A3B-Instruct \
  --tensor-parallel-size 2 \
  --quantization fp8 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --max-model-len 256000 \
  --port 8001
```

**기동 예시 (DeepSeek-V3):**
```bash
vllm serve deepseek-ai/DeepSeek-V3 \
  --tensor-parallel-size 8 \
  --quantization fp8 \
  --enable-auto-tool-choice \
  --tool-call-parser deepseek_v3 \
  --max-model-len 128000 \
  --port 8000
```

### 3.2 멀티유저 동시성 / GPU 사이징 가이드

| 목표 | 구성 |
|---|---|
| **Qwen3-Coder 30B-A3B (FP8)** | H100 80GB ×1~2(TP=1~2). MoE 활성 3B라 동시 세션 수십 개 처리 가능. 멀티유저에 최적 |
| **Llama 3.3 70B (BF16)** | H100 ×2(TP=2) 또는 INT4면 ×1. 32K 컨텍스트 시 ~56GB |
| **Llama 3.3 70B (FP8)** | H100 ×1~2 |
| **DeepSeek-V3 (FP8)** | H100 80GB **×8 1노드(TP=8)**. 단일 모델이 노드 점유 → 동시성 위해 **인스턴스 2개면 노드 2개** |
| **Qwen2.5-VL 72B (AWQ)** | H100 ×1~2 |

**동시성 설계 원칙:**
- 멀티유저는 **단일 큰 인스턴스의 continuous batching**으로 먼저 흡수 → 한계 시 **동일 모델 인스턴스 수평 확장 + LiteLLM 로드밸런싱**(`config.yaml`에 동일 `model_name` 여러 백엔드 등록)
- 작은 모델(Qwen3-Coder MoE)은 인스턴스당 처리량이 높아 **GPU 1~2장으로 팀 전체 커버** 가능 → 최우선 검토

### 3.3 양자화 트레이드오프

| 방식 | 품질 손실 | 처리량/메모리 | 권장 상황 |
|---|---|---|---|
| **FP8** | 매우 작음(H100 네이티브) | VRAM ~½, 속도 ↑ | **H100 보유 시 1순위** |
| **AWQ (INT4)** | 작음 | VRAM ~¼ | A100/메모리 제약, 동시성 극대화 |
| **GPTQ (INT4)** | 작음~보통 | VRAM ~¼ | AWQ 대안 |
| **BF16 (무양자화)** | 없음 | VRAM 최대 | 품질 최우선·VRAM 여유 |

> **에이전틱 주의:** 양자화는 **다단계 툴콜의 정확도·일관성**을 미세하게 떨어뜨릴 수 있음. 특히 INT4는 긴 툴콜 루프에서 인자 포맷 오류가 늘 수 있으니, **H100이면 FP8을 기본**으로 하고 INT4는 동시성이 절실할 때만.

---

## 4. 호환성 위험 (중요)

### 4.1 툴콜 포맷 불일치

Claude Code는 Anthropic `tool_use`/`tool_result` 블록 구조에 최적화. 오픈모델은 내부적으로 OpenAI function-calling 또는 XML(`<tool_call>{...}</tool_call>`) 포맷을 씀. LiteLLM이 변환하나, 다음 위험 존재:

| 위험 | 설명 | 완화책 |
|---|---|---|
| **블록 순서 제약** | Anthropic은 assistant 메시지 내 text 블록이 tool_use보다 먼저, tool_use 다음 즉시 tool_result를 요구. 컨텍스트 압축(compaction)으로 턴이 병합되면 순서가 깨져 거부될 수 있음 | LiteLLM **unified endpoint** 사용(passthrough 회피) |
| **parallel tool calls** | Claude는 한 턴에 여러 툴 병렬 호출. 오픈모델은 병렬 툴콜 지원이 약하거나 파서가 첫 호출만 인식 | 병렬 약한 모델은 순차 실행 위주. 기능엔 영향 적으나 속도 저하. 도입 모델로 병렬 시나리오 사전 테스트 |
| **tool_use 누락** | reasoning 모델(R1 등)이 `<think>` 내부에 툴콜을 방출하면 파서가 놓침 | `--reasoning-parser` + `--tool-call-parser` 동시 설정, 버전 검증 |
| **system prompt 차이** | Claude Code의 긴 시스템 프롬프트·툴 설명이 오픈모델 학습 분포와 달라 지시 준수도 저하 | 프롬프트 길이 수용 위해 충분한 컨텍스트 모델 선택. 필요시 모델별 프롬프트 튜닝 |

### 4.2 비전 미지원 모델 → `computer` 무력화와 우회

텍스트 전용 모델을 쓰면 `computer`의 `screenshot`/`zoom` 이미지가 무의미해집니다. 다행히 이 프로젝트는 **텍스트 기반 대체 툴이 풍부**합니다:

| 무력화되는 것 | 텍스트-퍼스트 우회 |
|---|---|
| `computer` 스크린샷 보고 좌표 클릭 | `read_page`(접근성 트리 + `ref_id`) → `find`(자연어로 요소 검색) → 반환된 **`ref`로 클릭/입력** |
| 시각 기반 폼 입력 | `form_input`(ref 기반 값 설정) |
| 페이지 내용 시각 파악 | `get_page_text`(본문 텍스트 추출) |
| 좌표 기반 `computer` 클릭 | `computer`는 `ref`로도 클릭 가능(스키마상 `ref`가 `coordinate` 대안) — **좌표 대신 ref 사용** |

**권장:** 텍스트 모델 운용 시 Claude Code/프로젝트 가이드에 **"스크린샷보다 `read_page`/`find`/`ref` 우선"** 정책을 명시(시스템 프롬프트나 CLAUDE.md). 이렇게 하면 비전 없이도 상당수 자동화가 동작. 단, 캔버스 기반/접근성 트리가 빈약한 사이트(이미지 맵, 게임 UI)는 한계가 있으므로 그런 케이스가 많으면 **비전 모델 필수**.

### 4.3 LiteLLM 변환 레이어의 한계

- **unified `/v1/messages` 권장** (로드밸런싱·폴백·비용추적 지원). passthrough는 메시지 검증을 안 해 블록 순서 오류 발생 가능.
- `count_tokens` 정확도: 오픈모델 토크나이저와 Anthropic 추정이 달라 컨텍스트 한계 근처에서 오차 가능 → 컨텍스트 여유 두기.
- `drop_params: true`로 미지원 파라미터 자동 제거(에러 방지).
- prompt caching·일부 beta 기능은 오픈백엔드에서 미동작 → `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 설정.

---

## 5. 오프라인 모델 준비 (에어갭 반입)

### 5.1 가중치 반입 절차

1. **외부 스테이징 환경**(인터넷 가능)에서 HuggingFace로부터 모델 다운로드:
   ```bash
   huggingface-cli download Qwen/Qwen3-Coder-30B-A3B-Instruct \
     --local-dir ./qwen3-coder --local-dir-use-symlinks False
   ```
2. **무결성 검증**: 모델 카드의 SHA/`model.safetensors.index.json` 체크섬 확인. 악성 pickle 회피 위해 **`.safetensors` 포맷만** 반입(`.bin`/pickle 지양).
3. **보안 매체 전송**(승인된 단방향 게이트웨이/물리 매체)로 폐쇄망 반입. 반입 시 바이러스/무결성 재검사.
4. **내부 모델 레지스트리** 구축:
   - 내부 **HuggingFace 미러**(`HF_HUB_OFFLINE=1`, 로컬 캐시 지정) 또는
   - **MinIO/S3 호환 내부 오브젝트 스토리지** + vLLM `--model /mnt/models/...` 로컬 경로 로드.
5. **vLLM/LiteLLM/의존 패키지**도 동일하게 내부 PyPI 미러(devpi/Nexus)로 반입. **LiteLLM 악성 버전 차단** 정책 적용.

### 5.2 라이선스 컴플라이언스

| 모델 | 라이선스 | 내부/상용 사용 | 주의 |
|---|---|---|---|
| Qwen3-Coder / Qwen2.5-Coder | Apache-2.0 | ✅ 자유 | 가장 안전 |
| DeepSeek-V3 | DeepSeek License | ✅ 상용 허용(조건부) | 사용제한 조항·재배포 조건 법무 확인 |
| DeepSeek-R1 | MIT | ✅ 자유 | — |
| Llama 3.3 70B | Llama Community License | ⚠️ 조건부 | MAU 700M 초과 등 제약·"Built with Llama" 표기 의무 확인 |
| Mistral Large | Mistral 라이선스 | ⚠️ 상용 별도 | 상용 라이선스 계약 필요 가능 |
| Qwen2.5-VL | Qwen License | ✅ 대체로 허용 | 모델별 조항 확인 |

> 법무 리스크 최소화 우선이면 **Apache-2.0(Qwen) 또는 MIT(DeepSeek-R1)** 모델을 1차 선정 권장.

---

## 6. 최종 권장 아키텍처

```
Claude Code (ANTHROPIC_BASE_URL=http://litellm:4000)
   │  Anthropic /v1/messages (+ JPEG 스크린샷 image 블록)
   ▼
LiteLLM Proxy :4000  (unified endpoint, 로드밸런싱/폴백)
   ├─► vLLM A: Qwen3-Coder 30B-A3B FP8  (H100×1~2)  ← 메인, 멀티유저
   ├─► vLLM B: DeepSeek-V3 FP8          (H100×8)    ← 고난도 라우팅(옵션)
   └─► vLLM C: Qwen2.5-VL 72B AWQ       (H100×1~2)  ← 스크린샷 처리(비전 필요 시)
   │
   ▼  (아래 MCP 데이터 경로는 기존 그대로)
mcp-server.js ─TCP→ native-host.js ─NM→ 확장 ─CDP→ 브라우저
```

**단계별 도입 권고:**
1. **PoC:** Qwen3-Coder 단일 인스턴스 + LiteLLM + Claude Code. `read_page`/`find`/`ref` 기반 텍스트-퍼스트로 18툴 동작 검증(특히 `navigate`, `computer`(ref 클릭), `read_page`, `find`, `form_input`).
2. **비전 평가:** Qwen2.5-VL 추가 후 `computer` 스크린샷 워크플로 vs 텍스트-퍼스트 비교. 사이트 특성에 따라 비전 필수 여부 결정.
3. **확장:** 동시성 한계 시 인스턴스 수평 확장 + LiteLLM 밸런싱. 고난도 작업만 DeepSeek-V3로 라우팅.

---

## 7. 추가 검증이 필요한 항목 (반입 전 체크리스트)

- ⚠️ **최신 모델 가용성:** DeepSeek-V4 / Qwen3.5·3.6 / GLM-5.1 / Kimi K2.6 등 신세대의 명칭·라이선스·하드웨어 요구를 모델 카드 원본으로 재확인. (안정 입증된 V3/Qwen3-Coder 우선 권장)
- ⚠️ **vLLM 버전별 툴콜 파서 정상성:** 도입 vLLM 버전에서 선택 모델의 `--tool-call-parser`가 Claude Code 다단계/병렬 툴콜을 정확히 파싱하는지 사전 테스트. (FP8+XML+`<think>` 유실 버그 등)
- ⚠️ **LiteLLM unified endpoint의 블록 순서 처리:** 컨텍스트 압축 시 tool_use/tool_result 순서 거부 재현·완화 확인. 안전 버전 고정. **악성 버전(1.82.7/1.82.8 등) 차단.**
- ⚠️ **count_tokens 정확도:** 오픈모델 토크나이저와의 오차가 긴 세션에서 컨텍스트 초과를 유발하는지.
- ⚠️ **DeepSeek/Llama 라이선스 조항:** 내부망 상용 사용·재배포·표기 의무 법무 검토.
- ⚠️ **스텁 툴 영향 없음 확인:** `gif_creator`/`shortcuts_*`/`switch_browser`/`upload_image`는 stub이므로 모델 선택과 무관(기능 미구현). 실제 동작 12툴 중심으로 평가.

---

## 참고 출처

- LLM gateway configuration — Claude Code Docs (`code.claude.com/docs/en/llm-gateway`)
- Claude Code Quickstart / Anthropic unified `/v1/messages` — LiteLLM Docs
- Bug #22946: `/v1/messages` tool_use ordering — BerriAI/litellm
- Running Claude Code with Local LLMs via vLLM and LiteLLM — DEV
- Tool Calling — vLLM Documentation / Issue #39056 (Qwen FP8 XML tool_call loss)
- Function Calling — Qwen Docs
- Best Open-Source LLMs for Agentic Coding 2026 — MindStudio
- The Complete Guide to DeepSeek Models — BentoML

> 모든 외부 출처 수치는 반입 시점에 재검증 필요(`⚠️검증필요`).
