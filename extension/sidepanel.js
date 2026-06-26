// 사이드패널 채팅 — opencode serve(헤드리스 에이전트)에 붙는 씬 클라이언트.
// 두뇌(추론·툴콜 루프)는 opencode가, 브라우저 조작은 기존 MCP 경로가 담당한다.
// 이 스크립트는 채팅 UI + opencode HTTP API(세션/프롬프트/SSE) 연동만 한다.

// opencode 서버 주소는 로컬 상수(환경 무관). 모델은 피커로 선택하며 기본값은 opencode 설정을 따른다.
const DEFAULTS = { opencodeUrl: "http://127.0.0.1:7777" };

const els = {
  messages: document.getElementById("messages"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  status: document.getElementById("status"),
  ctx: document.getElementById("ctx"),
  modelSelect: document.getElementById("modelSelect"),
  modeToggle: document.getElementById("modeToggle"),
  modeIcon: document.getElementById("modeIcon"),
  modeText: document.getElementById("modeText"),
  modeMenu: document.getElementById("modeMenu"),
  warn: document.getElementById("warn"),
  thumbs: document.getElementById("thumbs"),
  attachBtn: document.getElementById("attachBtn"),
  fileInput: document.getElementById("fileInput"),
};

let cfg = { ...DEFAULTS };
let selectedModel = ""; // "providerID/modelID" 또는 "" (opencode 기본값)
let autoMode = false;   // "묻지 않고 실행"
let sessionID = null;
// 첨부 + 비전 모델 자동 전환
// 항목: 이미지 { kind:"image", mime, name, dataUrl } 또는
//       문서   { kind:"doc", name, mime, text?, status:"extracting"|"ready"|"error", error?, note? }
const attachedItems = [];
let defaultModel = "";          // opencode.json top-level model
const visionModels = new Set(); // 이미지 입력 가능 모델("providerID/modelID")
const toolModels = new Set();   // tool-calling 가능 모델
let autoSwitchedFrom = null;     // 이미지 때문에 자동 전환했다면 직전 선택값 보관
let activeTab = null;
const roleByMsg = {};      // messageID -> "user" | "assistant"
const textNodeByPart = {}; // part.id -> DOM node (스트리밍 텍스트 갱신)
const stepByPart = {};     // part.id -> DOM node (도구 활동)
const bubbleByMsg = {};    // messageID -> assistant 말풍선
let lastSentText = "";

// opencode 내장 코딩/파일 도구를 끈다 — 이 사이드패널은 "브라우저 에이전트"이므로
// 반드시 MCP 브라우저 도구(open-claude-in-chrome_*)만 써야 한다. (이 목록에 없는 도구=MCP는 그대로 활성)
// 끄지 않으면 "테스트 페이지에 등록" 같은 요청을 glob/read로 파일 찾기처럼 오해한다.
const BUILTIN_TOOLS_OFF = {
  bash: false, edit: false, write: false, read: false, grep: false, glob: false,
  list: false, patch: false, webfetch: false, task: false, todowrite: false, todoread: false,
};

// ---------- 유틸 ----------
function setStatus(text, cls) {
  els.status.textContent = text;
  els.status.className = "status" + (cls ? " " + cls : "");
}
function clearEmpty() {
  const e = els.messages.querySelector(".empty");
  if (e) e.remove();
}
function scrollDown() { els.messages.scrollTop = els.messages.scrollHeight; }

function addUserMessage(text, items) {
  clearEmpty();
  const div = document.createElement("div");
  div.className = "msg user";
  if (text) {
    const t = document.createElement("div");
    t.className = "msg-text";
    t.textContent = text;
    div.appendChild(t);
  }
  const imgs = (items || []).filter((i) => i.kind === "image");
  const docs = (items || []).filter((i) => i.kind === "doc");
  if (imgs.length) {
    const strip = document.createElement("div");
    strip.className = "msg-images";
    for (const img of imgs) {
      const im = document.createElement("img");
      im.src = img.dataUrl;
      im.alt = img.name || "image";
      strip.appendChild(im);
    }
    div.appendChild(strip);
  }
  if (docs.length) {
    const strip = document.createElement("div");
    strip.className = "msg-files";
    for (const doc of docs) {
      const chip = document.createElement("span");
      chip.className = "msg-file";
      const ic = document.createElement("span"); ic.textContent = docIcon(doc.name);
      const nm = document.createElement("span"); nm.className = "doc-name"; nm.textContent = doc.name; nm.title = doc.name;
      chip.appendChild(ic); chip.appendChild(nm);
      strip.appendChild(chip);
    }
    div.appendChild(strip);
  }
  els.messages.appendChild(div);
  scrollDown();
}
function ensureAssistantBubble(messageID) {
  if (bubbleByMsg[messageID]) return bubbleByMsg[messageID];
  clearEmpty();
  const div = document.createElement("div");
  div.className = "msg assistant";
  els.messages.appendChild(div);
  bubbleByMsg[messageID] = div;
  scrollDown();
  return div;
}
function renderTextPart(part) {
  const bubble = ensureAssistantBubble(part.messageID);
  let node = textNodeByPart[part.id];
  if (!node) {
    node = document.createElement("span");
    bubble.appendChild(node);
    textNodeByPart[part.id] = node;
  }
  node.textContent = part.text || "";
  scrollDown();
}
function renderToolPart(part) {
  // 도구 활동을 활동 로그로 표시 (스크린샷의 단계 표시와 유사)
  let actBlock = bubbleByMsg["__act_" + part.messageID];
  if (!actBlock) {
    actBlock = document.createElement("div");
    actBlock.className = "activity";
    // 어시스턴트 말풍선 앞에 활동 블록 배치
    const bubble = ensureAssistantBubble(part.messageID);
    els.messages.insertBefore(actBlock, bubble);
    bubbleByMsg["__act_" + part.messageID] = actBlock;
  }
  let step = stepByPart[part.id];
  if (!step) {
    step = document.createElement("span");
    step.className = "step";
    actBlock.appendChild(step);
    stepByPart[part.id] = step;
  }
  const name = part.tool || part.name || "tool";
  const state = part.state || {};
  const status = state.status || "";
  const out = typeof state.output === "string" ? state.output : "";
  const needsApproval = /미승인/.test(out);
  const policyBlocked = /차단됨/.test(out);
  step.classList.toggle("blocked", needsApproval || policyBlocked);
  const running = status !== "completed" && status !== "error";
  const icon = status === "completed" ? "✓" : status === "error" ? "✗" : "⚙";
  const label = needsApproval ? " (승인 필요)" : policyBlocked ? " (정책 차단)" : status ? " · " + status : "";
  const inputSummary = toolInputSummary(part);
  // 텍스트 노드만 갱신(버튼은 보존)
  let labelNode = step.querySelector(".step-label");
  if (!labelNode) {
    labelNode = document.createElement("span");
    labelNode.className = "step-label";
    step.insertBefore(labelNode, step.firstChild);
  }
  labelNode.textContent = `${icon} ${name}${inputSummary}${label}`;
  step.classList.toggle("running", running && !needsApproval && !policyBlocked);
  // 실행 중인 도구를 작업 표시에 반영
  if (running && !needsApproval) setWorking(true, `${name}${inputSummary} 실행 중…`);
  keepWorkingLast();
  // 미승인이면 승인 버튼 노출(정책 차단은 버튼 없음)
  if (needsApproval && !step.querySelector(".approve-btn")) {
    const m = out.match(/도메인\s+"([^"]+)"\s*미승인/) || out.match(/domains:\["([^"]+)"\]/);
    const host = m ? m[1] : null;
    if (host) {
      const btn = document.createElement("button");
      btn.className = "approve-btn";
      btn.textContent = `${host} 승인하고 계속`;
      btn.addEventListener("click", () => approveAndContinue(host, btn));
      step.appendChild(btn);
    }
  }
  scrollDown();
}

// 승인 버튼: 도메인을 확장의 승인 목록에 추가하고 opencode에 계속 진행을 지시
async function approveAndContinue(host, btn) {
  btn.disabled = true;
  btn.textContent = `${host} 승인됨 · 계속 중…`;
  try {
    await chrome.runtime.sendMessage({ type: "sidepanel_approve_domain", host });
  } catch {}
  lastSentText = "";
  setStatus("작업 중…", "ok");
  try {
    await api(`/session/${sessionID}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        ...modelParam(),
        tools: { ...BUILTIN_TOOLS_OFF },
        parts: [{ type: "text", text: `${host} 도메인을 방금 승인했어. 막혔던 작업을 같은 탭에서 다시 진행해줘.` }],
      }),
    });
  } catch (err) {
    addError(`계속 실패: ${err.message}`);
  } finally {
    setStatus("연결됨", "ok");
  }
}
function addError(text) {
  clearEmpty();
  const div = document.createElement("div");
  div.className = "msg error";
  div.textContent = text;
  els.messages.appendChild(div);
  scrollDown();
}

// ---------- 작업 진행 표시 ----------
let workingEl = null;
let workingSince = 0;
let workingTimer = null;
let statusPollTimer = null;   // SSE 종료 이벤트 유실 대비 백스톱 폴링
let sawAssistantPart = false; // 이번 턴에 assistant 파트(텍스트/도구)가 렌더됐는지
let mapReduceActive = false;  // 분할 반복 중에는 메인 세션이 idle이라 백스톱 폴링을 멈춘다
function setWorking(on, label) {
  if (on) {
    clearEmpty();
    if (!workingEl) {
      workingEl = document.createElement("div");
      workingEl.className = "working";
      workingEl.innerHTML = '<span class="spinner">●</span><span class="working-label"></span><span class="working-time"></span>';
      workingSince = Date.now();
      if (!workingTimer) workingTimer = setInterval(updateWorkingTime, 1000);
    }
    // EventSource 재연결 구간에 종료 이벤트가 유실돼도 스피너가 멈추지 않도록 서버 상태를 주기 확인
    if (!statusPollTimer) statusPollTimer = setInterval(pollSessionStatus, 4000);
    if (label) workingEl.querySelector(".working-label").textContent = label;
    else if (!workingEl.querySelector(".working-label").textContent) workingEl.querySelector(".working-label").textContent = "생각 중…";
    els.messages.appendChild(workingEl); // 항상 맨 아래로
    updateWorkingTime();
    scrollDown();
  } else {
    if (workingEl) { workingEl.remove(); workingEl = null; }
    if (workingTimer) { clearInterval(workingTimer); workingTimer = null; }
    if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
    sawAssistantPart = false;
  }
}
// 서버의 권위 상태로 스피너를 보정. /session/status 맵에는 idle이 아닌 세션만 존재(없으면 idle).
async function pollSessionStatus() {
  if (!workingEl || !sessionID) return;
  if (mapReduceActive) return; // 분할 반복 중: 작업은 임시 세션에서 진행되므로 메인 세션 idle로 끄지 않음
  let map;
  try { map = await api("/session/status"); } catch { return; } // 일시 장애: 다음 틱에 재시도
  const st = map && map[sessionID];
  const busy = st && (st.type === "busy" || st.type === "retry"); // retry도 작업 중으로 간주
  if (busy) return;
  // 서버상 idle. 턴이 실제 진행됐다는 근거가 있을 때만 종료:
  //  - assistant 파트가 이미 렌더됐거나(1890s 케이스), 또는
  //  - 시작 직후 race(서버가 아직 busy로 마킹 전)를 배제할 만큼 시간이 지난 경우
  const elapsedMs = Date.now() - workingSince;
  if (sawAssistantPart || elapsedMs > 12000) setWorking(false);
}
function updateWorkingTime() {
  if (!workingEl) return;
  const s = Math.floor((Date.now() - workingSince) / 1000);
  workingEl.querySelector(".working-time").textContent = s > 0 ? ` ${s}s` : "";
}
function keepWorkingLast() {
  if (workingEl) els.messages.appendChild(workingEl);
}
function toolInputSummary(part) {
  const inp = (part.state && part.state.input) || {};
  const v = inp.url || inp.query || inp.action || inp.text || "";
  return v ? " → " + String(v).slice(0, 40) : "";
}

// ---------- opencode API ----------
async function api(path, opts) {
  const res = await fetch(cfg.opencodeUrl + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.status === 204 ? null : res.json();
}

async function createSession() {
  const s = await api("/session", { method: "POST", body: "{}" });
  sessionID = s.id;
}

// 선택 모델 → prompt 본문 파라미터. 빈 값이면 model 생략(opencode 기본 모델 사용).
function modelParam() {
  if (!selectedModel) return {};
  const i = selectedModel.indexOf("/");
  if (i < 0) return {};
  return { model: { providerID: selectedModel.slice(0, i), modelID: selectedModel.slice(i + 1) } };
}

// opencode 설정에서 사용 가능한 모델 목록을 받아 드롭다운 구성(환경 무관)
async function fetchModels() {
  let list = [];
  defaultModel = "";
  visionModels.clear();
  toolModels.clear();
  try {
    const conf = await api("/config", { method: "GET" });
    defaultModel = (conf && conf.model) || "";
    const prov = (conf && conf.provider) || {};
    for (const pid of Object.keys(prov)) {
      const models = (prov[pid] && prov[pid].models) || {};
      for (const mid of Object.keys(models)) {
        const id = pid + "/" + mid;
        const mc = models[mid] || {};
        list.push(id);
        // 비전: modalities.input에 image 포함 또는 attachment 플래그
        const inputMods = (mc.modalities && mc.modalities.input) || [];
        if (mc.attachment === true || inputMods.includes("image")) visionModels.add(id);
        // 도구: tool_call 플래그(미설정이면 기본 가능으로 간주)
        if (mc.tool_call !== false) toolModels.add(id);
      }
    }
  } catch { /* 목록 못 받아도 '기본값'으로 동작 */ }
  const sel = els.modelSelect;
  // 첫 옵션('기본값')에 실제 기본 모델명 표시
  if (sel.options.length > 0) {
    sel.options[0].textContent = defaultModel ? `기본값 · ${defaultModel}` : "기본값";
  }
  while (sel.options.length > 1) sel.remove(1); // 첫 옵션('기본값')만 보존
  for (const m of list) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = defaultModel && m === defaultModel ? `${m}  (기본값)` : m;
    sel.appendChild(opt);
  }
  if (selectedModel && list.includes(selectedModel)) sel.value = selectedModel;
  else { sel.value = ""; selectedModel = ""; }
}

// ---------- 모델 선택 헬퍼 + 비전 자동 전환 ----------
function setModelSelection(value) {
  selectedModel = value || "";
  els.modelSelect.value = selectedModel;
  chrome.storage.local.set({ selectedModel });
}
function effectiveModel() { return selectedModel || defaultModel; }
function isVisionModel(m) { return !!m && visionModels.has(m); }
function isToolModel(m) { return !!m && toolModels.has(m); }
// 비전 모델 중 도구(tool-calling)까지 되는 모델을 우선 선택(qwen3-vl 등)
function firstVisionModel() {
  for (const m of visionModels) if (toolModels.has(m)) return m; // vision+tools 우선
  return visionModels.values().next().value || "";              // 없으면 vision-only
}
function hasImageItems() { return attachedItems.some((i) => i.kind === "image"); }
function maybeAutoSwitchVision() {
  // 이미지(스캔 PDF 페이지 포함)만 비전 모델이 필요. 텍스트 문서는 전환 불필요.
  if (!hasImageItems() || isVisionModel(effectiveModel())) return;
  const vm = firstVisionModel();
  if (!vm) { showNote("비전(이미지) 지원 모델이 없어 이미지를 인식하지 못할 수 있습니다."); return; }
  if (autoSwitchedFrom === null) autoSwitchedFrom = selectedModel; // 직전 선택 보관(""=기본값)
  setModelSelection(vm);
  showNote(`이미지 처리를 위해 ${vm} 로 전환했습니다.`);
}
function maybeRestoreModel() {
  if (hasImageItems() || autoSwitchedFrom === null) return;
  const prev = autoSwitchedFrom;
  autoSwitchedFrom = null;
  setModelSelection(prev); // 이미지 없으면 원래(기본) 모델로 복귀
}
function showNote(text) {
  clearEmpty();
  const div = document.createElement("div");
  div.className = "activity";
  const s = document.createElement("span");
  s.className = "step";
  s.textContent = "ℹ " + text;
  div.appendChild(s);
  els.messages.appendChild(div);
  keepWorkingLast();
  scrollDown();
}

// ---------- 첨부 (이미지 + 문서) ----------
function readImageAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function isImageFile(f) { return f.type && f.type.startsWith("image/"); }
function docIcon(name) {
  const ext = (/\.([^.]+)$/.exec(name || "") || [])[1] || "";
  if (ext === "pdf") return "📕";
  if (ext === "docx" || ext === "doc") return "📄";
  if (ext === "pptx" || ext === "ppt") return "📊";
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return "📈";
  if (ext === "hwpx" || ext === "hwp") return "📑";
  return "📃";
}

async function addFiles(files) {
  for (const f of [...files]) {
    if (isImageFile(f)) {
      try {
        const dataUrl = await readImageAsDataURL(f);
        attachedItems.push({ kind: "image", mime: f.type, dataUrl, name: f.name || "image" });
      } catch {}
      renderThumbs();
      continue;
    }
    // 문서: 자리표시자 추가 → 추출 → 채움
    const item = { kind: "doc", name: f.name || "document", mime: f.type || "", status: "extracting" };
    attachedItems.push(item);
    renderThumbs();
    try {
      const res = await window.DocExtract.extractDocument(f);
      if (res.kind === "image-pages") {
        // 스캔/이미지 PDF → 페이지 이미지를 개별 이미지 항목으로 편입(비전 OCR 경로)
        const idx = attachedItems.indexOf(item);
        if (idx >= 0) attachedItems.splice(idx, 1);
        (res.images || []).forEach((im) =>
          attachedItems.push({ kind: "image", mime: im.mime, dataUrl: im.dataUrl, name: im.name }));
        if (res.truncated) showNote(`${item.name}: 페이지가 많아 앞부분만 이미지로 변환했습니다.`);
      } else {
        const text = (res.text || "").trim();
        if (!text) { item.status = "error"; item.error = "텍스트를 추출하지 못했습니다(빈 문서/스캔본일 수 있음)."; }
        else { item.status = "ready"; item.text = text; item.note = `${text.length.toLocaleString()}자`; }
      }
    } catch (e) {
      item.status = "error";
      item.error = (e && e.message) || "추출 실패";
    }
    renderThumbs();
  }
  maybeAutoSwitchVision();
}
function removeItem(idx) {
  attachedItems.splice(idx, 1);
  renderThumbs();
  maybeRestoreModel();
}
function renderThumbs() {
  els.thumbs.innerHTML = "";
  attachedItems.forEach((it, i) => {
    const d = document.createElement("div");
    if (it.kind === "image") {
      d.className = "thumb";
      const im = document.createElement("img");
      im.src = it.dataUrl; im.alt = it.name;
      d.appendChild(im);
    } else {
      d.className = "thumb doc" + (it.status === "error" ? " error" : "") + (it.status === "extracting" ? " working" : "");
      const ic = document.createElement("span");
      ic.className = "doc-icon"; ic.textContent = docIcon(it.name);
      d.appendChild(ic);
      const meta = document.createElement("div");
      meta.className = "doc-meta";
      const nm = document.createElement("div");
      nm.className = "doc-name"; nm.textContent = it.name; nm.title = it.name;
      const sub = document.createElement("div");
      sub.className = "doc-sub";
      sub.textContent = it.status === "extracting" ? "추출 중…" : it.status === "error" ? (it.error || "실패") : (it.note || "");
      meta.appendChild(nm); meta.appendChild(sub);
      d.appendChild(meta);
    }
    const rm = document.createElement("button");
    rm.className = "rm"; rm.textContent = "×"; rm.title = "제거";
    rm.addEventListener("click", () => removeItem(i));
    d.appendChild(rm);
    els.thumbs.appendChild(d);
  });
}

function connectEvents() {
  const ev = new EventSource(cfg.opencodeUrl + "/event");
  ev.onopen = () => { setStatus("연결됨", "ok"); if (workingEl) pollSessionStatus(); };
  ev.onerror = () => setStatus("서버 연결 끊김 — opencode serve 확인", "err");
  ev.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    const p = msg.properties || {};
    if (p.sessionID && sessionID && p.sessionID !== sessionID) return; // 내 세션만

    // 세션 작업 상태 → busy면 스피너 ON, 아니면(턴 종료) OFF
    if (msg.type === "session.status") {
      if (p.status && (p.status.type === "busy" || p.status.type === "retry")) setWorking(true);
      else setWorking(false);
      return;
    }
    if (msg.type === "message.updated" && p.info) {
      roleByMsg[p.info.id] = p.info.role;
      if (p.info.role === "assistant") {
        // 에러 표시(이전엔 빈 화면처럼 보였음)
        if (p.info.error && !p.info._errShown) {
          p.info._errShown = true;
          const em = (p.info.error.data && p.info.error.data.message) || p.info.error.name || "알 수 없는 오류";
          addError(`오류: ${em}`);
          setWorking(false);
        }
        // 메시지 완료 → 스피너 종료
        if (p.info.time && p.info.time.completed) setWorking(false);
      }
      return;
    }
    if (msg.type === "message.part.updated" && p.part) {
      const part = p.part;
      const role = roleByMsg[part.messageID];
      if (role === "user") return; // 사용자 메시지는 로컬에서 이미 표시
      // 역할 미상 텍스트가 방금 보낸 내용의 에코면 스킵
      if (part.type === "text" && role === undefined && lastSentText &&
          part.text && lastSentText.startsWith(part.text.slice(0, 20)) &&
          !textNodeByPart[part.id]) {
        roleByMsg[part.messageID] = "user";
        return;
      }
      if (part.type === "text") {
        sawAssistantPart = true;
        renderTextPart(part);
        setWorking(true, "답변 작성 중…");
        keepWorkingLast();
      } else if (part.type === "tool") {
        sawAssistantPart = true;
        renderToolPart(part);
      }
      // reasoning/step-* 등 기타 파트는 v1에서 생략
    }
  };
}

// ---------- 전송 ----------
// adopt=true면 현재 탭을 "메인 탭"으로 그룹에 편입(새 창 X, 공식 동작) 후 그 탭에서 작업하게 한다.
// adopt=false(기본)는 읽기 전용 — 패널 로드 시 맥락 라벨 표시용.
async function refreshActiveTab(opts) {
  const adopt = opts && opts.adopt;
  const type = adopt ? "sidepanel_adopt_active_tab" : "sidepanel_get_active_tab";
  try {
    activeTab = await chrome.runtime.sendMessage({ type });
  } catch { activeTab = null; }
  els.ctx.textContent = activeTab && activeTab.url
    ? `현재 페이지: ${activeTab.title || activeTab.url}`
    : "현재 페이지 정보 없음";
}

// ---------- 대용량 문서: 분할 반복(map-reduce) ----------
const SINGLE_PASS_CHARS = 24000; // 추출 텍스트가 이 길이 이하면 한 번에 주입
const CHUNK_CHARS = 18000;       // map 단계 청크 크기
const PAGES_PER_BATCH = 2;       // 스캔 PDF 이미지 묶음당 페이지 수

function modelParamFor(modelId) {
  if (!modelId) return {};
  const i = modelId.indexOf("/");
  if (i < 0) return {};
  return { model: { providerID: modelId.slice(0, i), modelID: modelId.slice(i + 1) } };
}
function partsText(parts) {
  return (parts || []).filter((p) => p && p.type === "text" && p.text).map((p) => p.text).join("\n").trim();
}
async function freshSession() {
  const s = await api("/session", { method: "POST", body: "{}" });
  return s.id;
}
// 블로킹 호출 — 부분 결과(어시스턴트 텍스트)를 동기로 회수 (도구 비활성, 순수 텍스트 처리)
async function blockingText(sid, parts, modelId) {
  const body = JSON.stringify({ ...modelParamFor(modelId), tools: { "*": false }, parts });
  const res = await api(`/session/${sid}/message`, { method: "POST", body });
  return partsText(res && res.parts);
}
function chunkText(s, size) {
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
// 요청이 단순 분석(요약/설명)을 넘어 브라우저 "동작"을 요구하는지 대략 판정(분할 반복의 동작 턴 분리용).
function wantsBrowserAction(text) {
  const t = (text || "").toLowerCase();
  const ko = ["등록", "올려", "올리", "게시", "생성", "만들", "입력", "작성", "저장", "추가", "클릭", "이동", "제출", "보내", "전송", "수정", "삭제", "변경", "검색해", "다운로드", "업로드", "채워", "선택해"];
  const en = ["register", "create", "add ", "post ", "submit", "fill", "click", "navigate", "upload", "download", "save", "send", "edit", "delete", "update", "search for", "publish", "enter "];
  return ko.some((k) => (text || "").includes(k)) || en.some((k) => t.includes(k));
}
// 부분 결과를 예산 이하로 축약(많으면 그룹 요약을 재귀적으로)
async function reduceToBudget(userText, partials, textModelId) {
  let blocks = partials.map((p) => `[${p.label}]\n${p.text}`);
  let joined = blocks.join("\n\n---\n\n");
  let guard = 0;
  while (joined.length > SINGLE_PASS_CHARS && blocks.length > 1 && guard++ < 4) {
    const groups = [];
    let cur = [], curLen = 0;
    for (const b of blocks) {
      if (curLen + b.length > CHUNK_CHARS && cur.length) { groups.push(cur); cur = []; curLen = 0; }
      cur.push(b); curLen += b.length;
    }
    if (cur.length) groups.push(cur);
    const out = [];
    for (let i = 0; i < groups.length; i++) {
      setWorking(true, `중간 정리 ${i + 1}/${groups.length}…`);
      try {
        const sid = await freshSession();
        const t = await blockingText(sid, [{ type: "text", text:
          `다음 부분 결과들을 사용자 요청 관점에서 한국어로 간결히 통합 정리하라.\n\n[사용자 요청]\n${userText}\n\n${groups[i].join("\n\n---\n\n")}` }], textModelId);
        out.push(t || groups[i].join("\n\n"));
      } catch { out.push(groups[i].join("\n\n")); }
    }
    blocks = out;
    joined = blocks.join("\n\n---\n\n");
  }
  return joined;
}
// 큰 첨부를 조각내 처리 후 종합. 최종 답은 메인 세션에서 스트리밍 렌더.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 메인 세션이 idle이 될 때까지 대기(직전 prompt_async 턴 완료 대기). 최대 ~5분.
async function waitSessionIdle() {
  await sleep(1500); // 서버가 busy로 마킹할 시간
  for (let i = 0; i < 300; i++) {
    let map;
    try { map = await api("/session/status"); } catch { await sleep(1000); continue; }
    const st = map && map[sessionID];
    if (!(st && (st.type === "busy" || st.type === "retry"))) return;
    await sleep(1000);
  }
}

async function runMapReduce({ userText, basePrompt, docBlocks, imageItems, textModelId, visionModelId, toolsField, needAction }) {
  mapReduceActive = true; // 백스톱 폴링이 스피너를 끄지 않도록
  const units = [];
  for (const d of docBlocks) {
    const chunks = chunkText(d.text, CHUNK_CHARS);
    chunks.forEach((c, k) => units.push({
      type: "text",
      label: chunks.length > 1 ? `${d.label} (${k + 1}/${chunks.length})` : d.label,
      text: c,
    }));
  }
  for (let i = 0; i < imageItems.length; i += PAGES_PER_BATCH) {
    const batch = imageItems.slice(i, i + PAGES_PER_BATCH);
    units.push({ type: "images", label: `페이지 ${i + 1}~${i + batch.length}`, images: batch });
  }
  const N = units.length;
  const partials = [];
  for (let i = 0; i < N; i++) {
    const u = units[i];
    setWorking(true, `자료 처리 ${i + 1}/${N}…`);
    try {
      const sid = await freshSession();
      let parts, modelId;
      if (u.type === "text") {
        modelId = textModelId;
        parts = [{ type: "text", text:
          `다음은 첨부 자료의 일부다(${u.label}). 사용자 요청과 관련된 핵심 내용을 한국어로 충실히 정리하라. 이 부분에 없는 내용은 지어내지 마라.\n\n[사용자 요청]\n${userText}\n\n[자료 일부]\n${u.text}` }];
      } else {
        modelId = visionModelId || textModelId;
        parts = [{ type: "text", text:
          `다음 이미지(들)는 문서 페이지다(${u.label}). 보이는 텍스트/내용을 읽어 사용자 요청과 관련된 핵심을 한국어로 정리하라.\n\n[사용자 요청]\n${userText}` }];
        for (const im of u.images) parts.push({ type: "file", mime: im.mime, url: im.dataUrl, filename: im.name });
      }
      const t = await blockingText(sid, parts, modelId);
      partials.push({ label: u.label, text: t || "(내용 없음)" });
    } catch (e) {
      partials.push({ label: u.label, text: `(이 부분 처리 실패: ${(e && e.message) || e})` });
    }
  }
  setWorking(true, "종합 정리 중…");
  const reduced = await reduceToBudget(userText, partials, textModelId);
  mapReduceActive = false; // 이후 턴은 메인 세션에서 → 정상 상태 추적 복귀

  // 1) 요약 턴: 메인 세션에 렌더(도구 off). 요약이 사용자에게 보이고 세션 히스토리에 남는다.
  const summaryPrompt = `사용자 요청: ${userText}\n\n아래는 첨부 자료를 ${N}개로 나눠 처리한 부분 결과다. 이를 종합해 한국어로 깔끔히 정리해줘. 중복은 합치고 누락 없이.\n\n${reduced}`;
  lastSentText = summaryPrompt;
  await api(`/session/${sessionID}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({ ...modelParamFor(textModelId), tools: { "*": false }, parts: [{ type: "text", text: summaryPrompt }] }),
  });
  if (!needAction) return; // 요약만 원한 요청이면 여기서 끝

  // 2) 동작 턴: 요약 덩어리를 다시 끼우지 않고(완성-모드 환각 방지) 짧고 깔끔한 동작 지시만 전송.
  //    방금 만든 요약은 세션 히스토리에 있으므로 모델이 참조할 수 있다. → 실험2의 "깔끔한 프롬프트=실제 툴콜" 재현.
  await waitSessionIdle();
  setWorking(true, "동작 수행 중…");
  const actionTurn = `${basePrompt}\n\n(바로 위에 방금 작성한 요약이 있다. 그 요약 내용을 본문/근거로 사용해 위 요청의 동작을 **실제 브라우저 도구를 호출해** 수행하라. 도구 사용을 텍스트로 흉내내지 말 것.)`;
  lastSentText = actionTurn;
  await api(`/session/${sessionID}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({ ...modelParamFor(textModelId), tools: toolsField || { "*": false }, parts: [{ type: "text", text: actionTurn }] }),
  });
}

async function send() {
  const text = els.input.value.trim();
  if ((!text && !attachedItems.length) || !sessionID) return;
  // 문서 추출이 끝나지 않았으면 대기 요청
  if (attachedItems.some((i) => i.kind === "doc" && i.status === "extracting")) {
    showNote("문서 추출이 끝난 뒤 보내주세요.");
    return;
  }
  const snapshot = attachedItems.slice();
  const imageItems = snapshot.filter((i) => i.kind === "image");
  const docBlocks = snapshot.filter((i) => i.kind === "doc" && i.status === "ready" && i.text)
    .map((d) => ({ label: d.name, text: d.text }));
  const hasImages = imageItems.length > 0;
  const hasDocs = docBlocks.length > 0;
  const userText = text || (hasImages ? "첨부한 이미지를 분석해줘." : hasDocs ? "첨부한 문서를 요약해줘." : "");

  els.input.value = "";
  els.input.style.height = "auto";
  addUserMessage(text, snapshot);
  setWorking(true, "생각 중…");
  // 첨부 UI 즉시 정리(스냅샷은 이미 확보)
  attachedItems.length = 0;
  renderThumbs();

  // 이미지 없는 메시지인데 비전으로 자동전환된 상태면 → 기본 모델로 복귀(VLM 불필요)
  if (!hasImages && autoSwitchedFrom !== null) {
    setModelSelection(autoSwitchedFrom);
    autoSwitchedFrom = null;
  }
  const toolsOn = isToolModel(effectiveModel());
  // 도구 작업 가능 시 현재 탭을 메인 탭으로 편입(새 창 X). 분석 전용이면 맥락만 읽음.
  await refreshActiveTab({ adopt: toolsOn });

  // 탭 맥락을 반영한 "동작 프롬프트"를 한 번 구성(단일/분할 양쪽에서 최종 요청에 사용).
  const hasAttachment = hasImages || hasDocs;
  let actionPrompt = userText;
  if (toolsOn && activeTab && activeTab.tabId != null) {
    if (hasAttachment) {
      actionPrompt = `[참고: 현재 탭 tabId=${activeTab.tabId}, url=${activeTab.url}] 아래 첨부 자료(이미지/문서)를 활용해 요청을 수행하라. 페이지에 등록/입력/생성 등 조작이 필요하면 현재 웹앱 UI에서 브라우저 도구로 직접 수행하라. 요청: ${userText}`;
    } else {
      actionPrompt = `[현재 활성 탭: tabId=${activeTab.tabId}, url=${activeTab.url}] 이 탭에서 작업해줘. 요청: ${userText}`;
    }
  }

  // 텍스트 길이로 단일 처리 vs 분할 반복 결정 (이미지가 5장 이상이면 묶어서 반복)
  const totalDocChars = docBlocks.reduce((n, d) => n + d.text.length, 0);
  const needMapReduce = totalDocChars > SINGLE_PASS_CHARS || imageItems.length > 4;
  const toolsField = toolsOn ? { ...BUILTIN_TOOLS_OFF } : { "*": false };
  // 요청에 브라우저 "동작"이 포함되는지(요약만이 아니라) — 분할 반복 시 동작 턴 분리 여부 결정
  const needAction = toolsOn && wantsBrowserAction(userText);

  els.send.disabled = true;
  setStatus("작업 중…", "ok");
  try {
    if (needMapReduce) {
      // 큰 첨부 → 조각내 분석 후, 최종 단계에서 '원래 동작 요청 + 정리 결과 + 브라우저 도구'로 수행
      const textModelId = effectiveModel();
      const visionModelId = isVisionModel(effectiveModel()) ? effectiveModel() : firstVisionModel();
      showNote(`첨부가 커서 ${needMapReduceUnitsHint(totalDocChars, imageItems.length)} 나눠 처리합니다…`);
      await runMapReduce({ userText, basePrompt: actionPrompt, docBlocks, imageItems, textModelId, visionModelId, toolsField, needAction });
    } else {
      // 단일 처리: 동작 프롬프트 + 문서 텍스트(텍스트 파트) + 이미지(파일 파트)
      lastSentText = actionPrompt;
      const parts = [{ type: "text", text: actionPrompt }];
      for (const d of docBlocks) parts.push({ type: "text", text: `[첨부 문서: ${d.label}]\n\n${d.text}` });
      for (const im of imageItems) parts.push({ type: "file", mime: im.mime, url: im.dataUrl, filename: im.name });
      // 도구 가능 모델: 내장 코딩 도구만 끄고 MCP 브라우저 도구는 유지. 분석 전용 모델: 모든 도구 off.
      const reqBody = { ...modelParam(), parts, tools: toolsField };
      await api(`/session/${sessionID}/prompt_async`, { method: "POST", body: JSON.stringify(reqBody) });
    }
  } catch (err) {
    addError(`전송 실패: ${err.message}`);
    setWorking(false);
  } finally {
    mapReduceActive = false; // 안전 복구(에러 등)
    els.send.disabled = false;
    setStatus("연결됨", "ok");
  }
}
function needMapReduceUnitsHint(chars, imgs) {
  const textUnits = Math.ceil(chars / CHUNK_CHARS);
  const imgUnits = Math.ceil(imgs / PAGES_PER_BATCH);
  return `약 ${textUnits + imgUnits}개로`;
}

// ---------- 초기화 ----------
els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 120) + "px";
});
els.input.addEventListener("keydown", (e) => {
  // 한글 등 IME 조합 중의 Enter(조합 확정)는 전송으로 처리하지 않음 (중복 입력 방지)
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    send();
  }
});
els.send.addEventListener("click", send);
els.modelSelect.addEventListener("change", () => {
  selectedModel = els.modelSelect.value;
  chrome.storage.local.set({ selectedModel });
  autoSwitchedFrom = null; // 사용자가 직접 모델을 바꾸면 자동 복귀 해제(수동 선택 존중)
});

// 이미지 첨부: 버튼 / 파일선택 / 붙여넣기 / 드래그앤드롭
els.attachBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files && els.fileInput.files.length) addFiles(els.fileInput.files);
  els.fileInput.value = "";
});
els.input.addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const it of items) {
    if (it.kind === "file") { const f = it.getAsFile(); if (f) files.push(f); }
  }
  if (files.length) { e.preventDefault(); addFiles(files); }
});
document.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragover"); });
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dragover"); });
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragover");
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

// ---------- 실행 모드 (실행 전 확인 / 묻지 않고 실행) ----------
async function setMode(auto) {
  autoMode = !!auto;
  els.modeToggle.classList.toggle("auto", autoMode);
  els.modeIcon.textContent = autoMode ? "▷▷" : "✋";
  els.modeText.textContent = autoMode ? "묻지 않고 실행" : "실행 전 확인";
  els.warn.hidden = !autoMode;
  els.modeMenu.querySelectorAll(".mode-item").forEach((it) => {
    it.classList.toggle("active", (it.dataset.mode === "auto") === autoMode);
  });
  try { await chrome.runtime.sendMessage({ type: "sidepanel_set_auto_approve", on: autoMode }); } catch {}
  chrome.storage.local.set({ autoMode });
}
els.modeToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  els.modeMenu.hidden = !els.modeMenu.hidden;
});
els.modeMenu.querySelectorAll(".mode-item").forEach((it) => {
  it.addEventListener("click", (e) => {
    e.stopPropagation();
    setMode(it.dataset.mode === "auto");
    els.modeMenu.hidden = true;
  });
});
document.addEventListener("click", () => { els.modeMenu.hidden = true; });

async function init() {
  const stored = await chrome.storage.local.get(["opencodeUrl", "selectedModel", "autoMode"]);
  cfg = { ...DEFAULTS, opencodeUrl: stored.opencodeUrl || DEFAULTS.opencodeUrl };
  selectedModel = stored.selectedModel || "";
  await setMode(stored.autoMode || false); // 저장된 모드 복원 + 배경 플래그 재동기화
  els.messages.innerHTML = '<div class="empty">현재 페이지에 대해 무엇이든 물어보세요.\n예: "이 페이지 요약해줘"</div>';
  await refreshActiveTab();
  try {
    connectEvents();
    await createSession();
    await fetchModels();
    setStatus("연결됨", "ok");
  } catch (err) {
    setStatus("opencode 서버 없음", "err");
    addError(`opencode serve(${cfg.opencodeUrl})에 연결할 수 없습니다. 서버가 실행 중인지 확인하세요.\n${err.message}`);
  }
}
init();
