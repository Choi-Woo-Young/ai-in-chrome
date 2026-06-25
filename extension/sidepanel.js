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
};

let cfg = { ...DEFAULTS };
let selectedModel = ""; // "providerID/modelID" 또는 "" (opencode 기본값)
let autoMode = false;   // "묻지 않고 실행"
let sessionID = null;
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

function addUserMessage(text) {
  clearEmpty();
  const div = document.createElement("div");
  div.className = "msg user";
  div.textContent = text;
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
    if (label) workingEl.querySelector(".working-label").textContent = label;
    else if (!workingEl.querySelector(".working-label").textContent) workingEl.querySelector(".working-label").textContent = "생각 중…";
    els.messages.appendChild(workingEl); // 항상 맨 아래로
    updateWorkingTime();
    scrollDown();
  } else {
    if (workingEl) { workingEl.remove(); workingEl = null; }
    if (workingTimer) { clearInterval(workingTimer); workingTimer = null; }
  }
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
  let defaultModel = "";
  try {
    const conf = await api("/config", { method: "GET" });
    defaultModel = (conf && conf.model) || "";
    const prov = (conf && conf.provider) || {};
    for (const pid of Object.keys(prov)) {
      const models = (prov[pid] && prov[pid].models) || {};
      for (const mid of Object.keys(models)) list.push(pid + "/" + mid);
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

function connectEvents() {
  const ev = new EventSource(cfg.opencodeUrl + "/event");
  ev.onopen = () => setStatus("연결됨", "ok");
  ev.onerror = () => setStatus("서버 연결 끊김 — opencode serve 확인", "err");
  ev.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    const p = msg.properties || {};
    if (p.sessionID && sessionID && p.sessionID !== sessionID) return; // 내 세션만

    // 세션 작업 상태 → 스피너 제어
    if (msg.type === "session.status") {
      const busy = p.status && p.status.type === "busy";
      if (busy) setWorking(true);
      else setWorking(false);
      return;
    }
    if (msg.type === "message.updated" && p.info) {
      roleByMsg[p.info.id] = p.info.role;
      // 어시스턴트 메시지 완료 → 스피너 종료
      if (p.info.role === "assistant" && p.info.time && p.info.time.completed) {
        setWorking(false);
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
        renderTextPart(part);
        setWorking(true, "답변 작성 중…");
        keepWorkingLast();
      } else if (part.type === "tool") {
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
  if (!text || !sessionID) return;
  els.input.value = "";
  els.input.style.height = "auto";
  addUserMessage(text);
  setWorking(true, "생각 중…");

  await refreshActiveTab();
  // 현재 탭 ID를 맥락으로 주입 → opencode가 올바른 tabId를 사용(환각 완화)
  let prompt = text;
  if (activeTab && activeTab.tabId != null) {
    prompt = `[현재 활성 탭: tabId=${activeTab.tabId}, url=${activeTab.url}] 이 탭에서 작업해줘. 요청: ${text}`;
  }
  lastSentText = prompt;

  els.send.disabled = true;
  setStatus("작업 중…", "ok");
  try {
    await api(`/session/${sessionID}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        ...modelParam(),
        parts: [{ type: "text", text: prompt }],
      }),
    });
  } catch (err) {
    addError(`전송 실패: ${err.message}`);
  } finally {
    els.send.disabled = false;
    setStatus("연결됨", "ok");
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
