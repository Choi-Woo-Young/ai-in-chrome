// docextract.js — 첨부 문서에서 텍스트(또는 스캔 PDF의 경우 페이지 이미지)를 추출한다.
// 로컬 텍스트 모델(gpt-oss/Qwen3)은 docx/pdf 바이너리를 직접 못 읽으므로, 클라이언트에서
// 텍스트로 풀어 모델에 텍스트 파트로 주입한다. 전부 사이드패널(브라우저)에서 실행 — 호스트 무관.
// 의존: vendor/fflate.min.js(window.fflate), vendor/pdf.min.js(window.pdfjsLib).
(function () {
  "use strict";

  // ---------- 공통 헬퍼 ----------
  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsText(file);
    });
  }
  function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsArrayBuffer(file);
    });
  }
  function decodeEntities(s) {
    return s
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCp(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => safeCp(parseInt(d, 10)))
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }
  function safeCp(n) { try { return String.fromCodePoint(n); } catch { return ""; } }

  // 네임스페이스 태그(예: w:t, a:t, hp:t)의 inner 텍스트를 문서 순서대로 수집
  function collectTags(xml, tag) {
    const re = new RegExp("<" + tag + "\\b[^>]*?(?:/>|>([\\s\\S]*?)</" + tag + ">)", "g");
    const out = [];
    let m;
    while ((m = re.exec(xml))) { if (m[1] != null) out.push(decodeEntities(m[1])); }
    return out;
  }
  function utf8(u8) { return new TextDecoder("utf-8").decode(u8); }
  function unzip(buf) { return window.fflate.unzipSync(new Uint8Array(buf)); } // { path: Uint8Array }

  // zip 안에서 패턴에 맞는 경로들을 숫자 순으로 정렬해 반환 (slide1, slide2, … / section0, section1, …)
  function sortedEntries(files, re) {
    return Object.keys(files)
      .filter((p) => re.test(p))
      .sort((a, b) => (numIn(a) - numIn(b)) || a.localeCompare(b));
  }
  function numIn(s) { const m = /(\d+)/.exec(s); return m ? Number(m[1]) : 0; }

  // 단락 단위로 텍스트 태그를 모아 줄바꿈으로 잇는다 (docx/pptx/hwpx 공통 패턴)
  function paragraphs(xml, paraCloseTag, textTag) {
    return xml.split(new RegExp("</" + paraCloseTag + ">"))
      .map((block) => collectTags(block, textTag).join(""))
      .map((t) => t.trimEnd())
      .filter((t) => t.length > 0)
      .join("\n");
  }

  // ---------- 형식별 추출 ----------
  async function fromDocx(file) {
    const files = unzip(await readAsArrayBuffer(file));
    const doc = files["word/document.xml"];
    if (!doc) return "";
    return paragraphs(utf8(doc), "w:p", "w:t");
  }

  async function fromPptx(file) {
    const files = unzip(await readAsArrayBuffer(file));
    const slides = sortedEntries(files, /^ppt\/slides\/slide\d+\.xml$/);
    const parts = [];
    slides.forEach((p, i) => {
      const txt = paragraphs(utf8(files[p]), "a:p", "a:t");
      parts.push(`# 슬라이드 ${i + 1}\n${txt}`);
    });
    return parts.join("\n\n");
  }

  async function fromHwpx(file) {
    const files = unzip(await readAsArrayBuffer(file));
    const secs = sortedEntries(files, /^Contents\/section\d+\.xml$/);
    if (!secs.length) return "";
    return secs.map((p) => paragraphs(utf8(files[p]), "hp:p", "hp:t")).filter(Boolean).join("\n\n");
  }

  async function fromXlsx(file) {
    const files = unzip(await readAsArrayBuffer(file));
    const shared = files["xl/sharedStrings.xml"] ? parseShared(utf8(files["xl/sharedStrings.xml"])) : [];
    const sheets = sortedEntries(files, /^xl\/worksheets\/sheet\d+\.xml$/);
    const out = [];
    sheets.forEach((p, i) => {
      const body = parseSheet(utf8(files[p]), shared);
      if (body) out.push(`# 시트 ${i + 1}\n${body}`);
    });
    return out.join("\n\n");
  }
  function parseShared(xml) {
    const out = [];
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml))) out.push(collectTags(m[1], "t").join(""));
    return out;
  }
  function parseSheet(xml, shared) {
    const lines = [];
    for (const row of xml.split(/<\/row>/)) {
      const cells = [];
      const re = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let m;
      while ((m = re.exec(row))) {
        const attrs = m[1], inner = m[2];
        const t = (/t="([^"]+)"/.exec(attrs) || [])[1] || "";
        let val = "";
        if (t === "s") {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
          if (v) val = shared[Number(v[1])] || "";
        } else if (t === "inlineStr") {
          val = collectTags(inner, "t").join("");
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
          if (v) val = decodeEntities(v[1]);
        }
        cells.push(val);
      }
      if (cells.some((c) => c !== "")) lines.push(cells.join("\t"));
    }
    return lines.join("\n");
  }

  // ---------- PDF (텍스트 우선, 수율 낮으면 페이지 이미지) ----------
  const MAX_PDF_RENDER_PAGES = 50; // 스캔 PDF를 이미지로 렌더할 최대 페이지(메모리 보호)

  function ensurePdfWorker() {
    if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.js");
    }
  }
  async function fromPdf(file) {
    ensurePdfWorker();
    const data = new Uint8Array(await readAsArrayBuffer(file));
    const pdf = await window.pdfjsLib.getDocument({ data }).promise;
    const pageTexts = [];
    let totalLen = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const txt = content.items.map((it) => (it.str || "")).join(" ").replace(/\s+/g, " ").trim();
      pageTexts.push(txt);
      totalLen += txt.length;
    }
    // 텍스트 수율 판정: 페이지당 평균 글자 수가 매우 적으면 스캔/이미지 PDF로 간주
    const avg = totalLen / Math.max(1, pdf.numPages);
    if (avg >= 40) {
      const text = pageTexts.map((t, i) => `# p.${i + 1}\n${t}`).filter((s) => s.length > 8).join("\n\n");
      return { kind: "doc", text };
    }
    // 스캔 PDF → 페이지를 이미지로 렌더(비전 OCR용)
    const images = [];
    const n = Math.min(pdf.numPages, MAX_PDF_RENDER_PAGES);
    for (let i = 1; i <= n; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      images.push({ mime: "image/jpeg", dataUrl: canvas.toDataURL("image/jpeg", 0.7), name: `${file.name} p.${i}` });
      canvas.width = canvas.height = 0; // 캔버스 메모리 해제
    }
    return { kind: "image-pages", images, pages: pdf.numPages, truncated: pdf.numPages > n };
  }

  // ---------- 디스패처 ----------
  const PLAIN_EXT = /\.(md|markdown|txt|text|csv|tsv|json|log|ya?ml|ini|xml|html?|js|ts|py|java|c|cc|cpp|h|go|rs|rb|php|sh|sql|toml)$/i;

  function extOf(name) { const m = /\.([^.]+)$/.exec(name || ""); return m ? m[1].toLowerCase() : ""; }

  // file → { kind:"doc"|"image-pages", name, mime, text?, images?, pages?, truncated? }
  async function extractDocument(file) {
    const name = file.name || "document";
    const ext = extOf(name);
    let res;
    if (ext === "pdf" || file.type === "application/pdf") {
      res = await fromPdf(file);
    } else if (ext === "docx") {
      res = { kind: "doc", text: await fromDocx(file) };
    } else if (ext === "pptx") {
      res = { kind: "doc", text: await fromPptx(file) };
    } else if (ext === "xlsx") {
      res = { kind: "doc", text: await fromXlsx(file) };
    } else if (ext === "hwpx") {
      res = { kind: "doc", text: await fromHwpx(file) };
    } else if (PLAIN_EXT.test(name) || (file.type && file.type.startsWith("text/"))) {
      res = { kind: "doc", text: await readAsText(file) };
    } else if (ext === "doc" || ext === "ppt" || ext === "xls" || ext === "hwp") {
      throw new Error(`${ext.toUpperCase()} 구버전(바이너리) 형식은 지원하지 않습니다. ${ext}x로 저장해 첨부해 주세요.`);
    } else {
      // 알 수 없는 형식 — 텍스트로 시도
      res = { kind: "doc", text: await readAsText(file) };
    }
    return Object.assign({ name, mime: file.type || "" }, res);
  }

  window.DocExtract = { extractDocument };
})();
