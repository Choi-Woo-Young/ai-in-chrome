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
// 이미지 첨부 + 비전 모델 자동 전환
const attachedImages = []; // { mime, dataUrl, name }
let defaultModel = "";          // opencode.json top-level model
const visionModels = new Set(); // attachment:true 모델("providerID/modelID")
let autoSwitchedFrom = null;     // 이미지 때문에 자동 전환했다면 직전 선택값 보관
let activeTab = null;
const roleByMsg = {};      // messageID -> "user" | "assistant"
const textNodeByPart = {}; // part.id -> DOM node (스트리밍 텍스트 갱신)
const stepByPart = {};     // part.id -> DOM node (도구 활동)
const bubbleByMsg = {};    // messageID -> assistant 말풍선
let lastSentText = "";

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

function addUserMessage(text, images) {
  clearEmpty();
  const div = document.createElement("div");
  div.className = "msg user";
  if (text) {
    const t = document.createElement("div");
    t.className = "msg-text";
    t.textContent = text;
    div.appendChild(t);
  }
  if (images && images.length) {
    const strip = document.createElement("div");
    strip.className = "msg-images";
    for (const img of images) {
      const im = document.createElement("img");
      im.src = img.dataUrl;
      im.alt = img.name || "image";
      strip.appendChild(im);
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
  try {
    const conf = await api("/config", { method: "GET" });
    defaultModel = (conf && conf.model) || "";
    const prov = (conf && conf.provider) || {};
    for (const pid of Object.keys(prov)) {
      const models = (prov[pid] && prov[pid].models) || {};
      for (const mid of Object.keys(models)) {
        const id = pid + "/" + mid;
        list.push(id);
        if (models[mid] && models[mid].attachment === true) visionModels.add(id);
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
function firstVisionModel() { return visionModels.values().next().value || ""; }
function maybeAutoSwitchVision() {
  if (!attachedImages.length || isVisionModel(effectiveModel())) return;
  const vm = firstVisionModel();
  if (!vm) { showNote("비전(이미지) 지원 모델이 없어 이미지를 인식하지 못할 수 있습니다."); return; }
  if (autoSwitchedFrom === null) autoSwitchedFrom = selectedModel; // 직전 선택 보관(""=기본값)
  setModelSelection(vm);
  showNote(`이미지 처리를 위해 ${vm} 로 전환했습니다.`);
}
function maybeRestoreModel() {
  if (attachedImages.length || autoSwitchedFrom === null) return;
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

// ---------- 이미지 첨부 ----------
function readImageAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
async function addImages(files) {
  const imgs = [...files].filter((f) => f.type && f.type.startsWith("image/"));
  for (const f of imgs) {
    try {
      const dataUrl = await readImageAsDataURL(f);
      attachedImages.push({ mime: f.type, dataUrl, name: f.name || "image" });
    } catch {}
  }
  renderThumbs();
  maybeAutoSwitchVision();
}
function removeImage(idx) {
  attachedImages.splice(idx, 1);
  renderThumbs();
  maybeRestoreModel();
}
function renderThumbs() {
  els.thumbs.innerHTML = "";
  attachedImages.forEach((img, i) => {
    const d = document.createElement("div");
    d.className = "thumb";
    const im = document.createElement("img");
    im.src = img.dataUrl;
    im.alt = img.name;
    d.appendChild(im);
    const rm = document.createElement("button");
    rm.className = "rm";
    rm.textContent = "×";
    rm.title = "제거";
    rm.addEventListener("click", () => removeImage(i));
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
async function refreshActiveTab() {
  try {
    activeTab = await chrome.runtime.sendMessage({ type: "sidepanel_get_active_tab" });
  } catch { activeTab = null; }
  els.ctx.textContent = activeTab && activeTab.url
    ? `현재 페이지: ${activeTab.title || activeTab.url}`
    : "현재 페이지 정보 없음";
}

async function send() {
  const text = els.input.value.trim();
  if ((!text && !attachedImages.length) || !sessionID) return;
  const userText = text || "첨부한 이미지를 분석해줘.";
  const imgsSnapshot = attachedImages.slice();
  els.input.value = "";
  els.input.style.height = "auto";
  addUserMessage(text, imgsSnapshot);
  setWorking(true, "생각 중…");

  await refreshActiveTab();
  const hasImages = imgsSnapshot.length > 0;
  // 이미지 없는 메시지인데 비전으로 자동전환된 상태면 → 이번 전송부터 기본 모델로 복귀(VLM 불필요)
  if (!hasImages && autoSwitchedFrom !== null) {
    setModelSelection(autoSwitchedFrom);
    autoSwitchedFrom = null;
  }
  // 텍스트 모델: 탭 맥락 주입(브라우저 작업). 이미지 첨부(비전): 도구 미사용이라 액션 프리픽스 생략.
  let prompt = userText;
  if (!hasImages && activeTab && activeTab.tabId != null) {
    prompt = `[현재 활성 탭: tabId=${activeTab.tabId}, url=${activeTab.url}] 이 탭에서 작업해줘. 요청: ${userText}`;
  }
  lastSentText = prompt;

  // 텍스트 + 첨부 이미지로 parts 구성
  const parts = [{ type: "text", text: prompt }];
  for (const img of imgsSnapshot) {
    parts.push({ type: "file", mime: img.mime, url: img.dataUrl, filename: img.name });
  }
  // 이미지 첨부 시: 비전 모델은 tool-calling 미지원일 수 있어 도구 비활성화(분석 전용)
  const reqBody = { ...modelParam(), parts };
  if (hasImages) reqBody.tools = { "*": false };
  const body = JSON.stringify(reqBody);
  // 첨부 비우기(UI 즉시 정리). 모델 복귀는 전송 후.
  attachedImages.length = 0;
  renderThumbs();

  els.send.disabled = true;
  setStatus("작업 중…", "ok");
  try {
    await api(`/session/${sessionID}/prompt_async`, { method: "POST", body });
  } catch (err) {
    addError(`전송 실패: ${err.message}`);
  } finally {
    els.send.disabled = false;
    setStatus("연결됨", "ok");
    // 전송 직후엔 복귀하지 않음 → 이미지 처리에 쓴 VLM이 드롭다운에 그대로 보임.
    // 기본 복귀는 다음에 '이미지 없는' 메시지를 보낼 때 수행(위 send 시작부) 또는 첨부를 모두 제거할 때.
  }
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
  if (els.fileInput.files && els.fileInput.files.length) addImages(els.fileInput.files);
  els.fileInput.value = "";
});
els.input.addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const it of items) {
    if (it.kind === "file") { const f = it.getAsFile(); if (f) files.push(f); }
  }
  if (files.length) { e.preventDefault(); addImages(files); }
});
document.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragover"); });
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dragover"); });
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragover");
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addImages(e.dataTransfer.files);
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
