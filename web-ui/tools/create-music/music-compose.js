/**
 * Create Music — 구조화 가사 + caption 컴파일 (ACE-Step 형식)
 */

export const SECTION_TYPE_DEFS = {
  verse: { tag: "Verse", label: "절 (Verse)", instrumental: false },
  chorus: { tag: "Chorus", label: "후렴 (Chorus)", instrumental: false },
  bridge: { tag: "Bridge", label: "브릿지 (Bridge)", instrumental: false },
  outro: { tag: "Outro", label: "아웃트로 (Outro)", instrumental: false },
  intro: { tag: "Intro", label: "인트로 (Intro)", instrumental: false },
  instrumental: { tag: "Instrumental", label: "연주 (Instrumental)", instrumental: true },
};

/** label: UI 표시(한글), caption: ACE-Step caption용(영문 태그) */
export const GENRE_OPTIONS = [
  { label: "케이팝", caption: "K-pop" },
  { label: "팝", caption: "Pop" },
  { label: "발라드", caption: "Ballad" },
  { label: "알앤비", caption: "R&B" },
  { label: "힙합", caption: "Hip-hop" },
  { label: "록", caption: "Rock" },
  { label: "로파이", caption: "Lo-fi" },
  { label: "EDM", caption: "EDM" },
  { label: "재즈", caption: "Jazz" },
  { label: "시티팝", caption: "City pop" },
  { label: "어쿠스틱", caption: "Acoustic" },
  { label: "오케스트라", caption: "Orchestral" },
  { label: "시네마틱", caption: "Cinematic" },
  { label: "뉴에이지", caption: "New Age" },
  { label: "앰비언트", caption: "Ambient" },
  { label: "인디", caption: "Indie" },
  { label: "트로트", caption: "Trot" },
  { label: "신스웨이브", caption: "Synthwave" },
  { label: "레트로", caption: "Retro" },
  { label: "소울", caption: "Soul" },
  { label: "펑크", caption: "Funk" },
];

export const INSTRUMENT_OPTIONS = [
  { label: "피아노", caption: "piano" },
  { label: "신시사이저", caption: "synthesizer" },
  { label: "일렉트릭 피아노", caption: "electric piano" },
  { label: "어쿠스틱 기타", caption: "acoustic guitar" },
  { label: "일렉트릭 기타", caption: "electric guitar" },
  { label: "베이스", caption: "bass" },
  { label: "바이올린", caption: "violin" },
  { label: "첼로", caption: "cello" },
  { label: "스트링 앙상블", caption: "string ensemble" },
  { label: "드럼 킷", caption: "drum kit" },
  { label: "웅장한 타악", caption: "epic percussion" },
  { label: "비트 머신", caption: "beat machine" },
  { label: "브라스", caption: "brass" },
  { label: "색소폰", caption: "saxophone" },
  { label: "플루트", caption: "flute" },
];

export const TEMPO_PRESETS = {
  slow: { label: "느림 (~70 BPM)", bpm: 70 },
  medium: { label: "보통 (~110 BPM)", bpm: 110 },
  fast: { label: "빠름 (~140 BPM)", bpm: 140 },
  custom: { label: "직접 입력", bpm: null },
};

export const VOCAL_TYPE_OPTIONS = [
  { value: "female", label: "여성 보컬" },
  { value: "male", label: "남성 보컬" },
  { value: "duet", label: "듀엣" },
  { value: "none", label: "보컬 없음 (연주)" },
];

/** label: UI(한글), caption: ACE-Step 권장 영문 태그 */
export const VOCAL_STYLE_OPTIONS = [
  { label: "부드러운", caption: "soft vocal" },
  { label: "파워풀", caption: "powerful vocal" },
  { label: "숨결감", caption: "breathy vocal" },
  { label: "허스키", caption: "raspy vocal" },
  { label: "고음", caption: "falsetto vocal" },
  { label: "합창", caption: "choir vocals" },
  { label: "속삭임", caption: "whispered vocal" },
  { label: "감성적", caption: "emotional vocal" },
];

/** ACE-Step caption — 언어·성별을 문장 앞쪽에 명시 (Tutorial 권장 형식) */
const VOCAL_CAPTION_BY_LANG = {
  ko: {
    female: "female vocal, woman singer, clear Korean pronunciation, Korean lyrics",
    male: "male vocal, man singer, deep male voice, clear Korean pronunciation, Korean lyrics",
    duet: "male and female duet vocals, two singers, clear Korean pronunciation, Korean lyrics",
    none: "instrumental track, no vocals, no singing",
  },
  en: {
    female: "female vocal, woman singer, clear English pronunciation",
    male: "male vocal, man singer, deep male voice, clear English pronunciation",
    duet: "male and female duet vocals, two singers, clear English pronunciation",
    none: "instrumental track, no vocals, no singing",
  },
  ja: {
    female: "female vocal, woman singer, clear Japanese pronunciation",
    male: "male vocal, man singer, deep male voice, clear Japanese pronunciation",
    duet: "male and female duet vocals, two singers, clear Japanese pronunciation",
    none: "instrumental track, no vocals, no singing",
  },
  zh: {
    female: "female vocal, woman singer, clear Chinese pronunciation",
    male: "male vocal, man singer, deep male voice, clear Chinese pronunciation",
    duet: "male and female duet vocals, two singers, clear Chinese pronunciation",
    none: "instrumental track, no vocals, no singing",
  },
};

function vocalCaptionPhrase(vocalType, vocalLanguage) {
  const lang = VOCAL_CAPTION_BY_LANG[vocalLanguage] || VOCAL_CAPTION_BY_LANG.en;
  return lang[vocalType] || lang.female;
}

let _sectionSeq = 0;

export function createSection(type = "verse", { lyrics = "", instDesc = "" } = {}) {
  const def = SECTION_TYPE_DEFS[type] || SECTION_TYPE_DEFS.verse;
  return {
    id: `sec-${++_sectionSeq}`,
    type: def.instrumental ? "instrumental" : type in SECTION_TYPE_DEFS ? type : "verse",
    lyrics: def.instrumental ? "" : lyrics,
    instDesc: def.instrumental ? instDesc : "",
  };
}

export function defaultSections() {
  _sectionSeq = 0;
  return [createSection("verse"), createSection("chorus"), createSection("instrumental")];
}

/**
 * @param {Array<{ type: string, lyrics?: string, instDesc?: string }>} sections
 */
export function compileLyrics(sections) {
  const blocks = [];
  for (const sec of sections || []) {
    const def = SECTION_TYPE_DEFS[sec.type] || SECTION_TYPE_DEFS.verse;
    blocks.push(`[${def.tag}]`);
    if (def.instrumental) continue;
    const text = String(sec.lyrics || "").trim();
    if (text) blocks.push(text);
  }
  return blocks.join("\n\n").trim();
}

/**
 * @param {{
 *   genres: string[],
 *   tempoPreset: string,
 *   bpmCustom: number | null,
 *   instruments: string[],
 *   vocalType: string,
 *   vocalStyles: string[],
 *   mood: string,
 *   instrumentalNotes: string[],
 * }} state
 */
export function compileCaption(state, vocalLanguage = "ko") {
  const parts = [];
  const vocalType = state.vocalType || "female";

  parts.push(vocalCaptionPhrase(vocalType, vocalLanguage));

  if (vocalType !== "none" && state.vocalStyles?.length) {
    parts.push(state.vocalStyles.join(", "));
  }

  if (state.genres?.length) {
    parts.push(state.genres.join(", "));
  }

  let bpm = null;
  const preset = TEMPO_PRESETS[state.tempoPreset] || TEMPO_PRESETS.medium;
  if (state.tempoPreset === "custom" && state.bpmCustom > 0) {
    bpm = Math.round(state.bpmCustom);
  } else if (preset.bpm) {
    bpm = preset.bpm;
  }
  if (bpm) parts.push(`${bpm} BPM`);

  if (state.instruments?.length) {
    parts.push(state.instruments.join(", "));
  }

  const mood = String(state.mood || "").trim();
  if (mood) parts.push(mood);

  for (const note of state.instrumentalNotes || []) {
    const n = String(note || "").trim();
    if (n) parts.push(`instrumental break: ${n}`);
  }

  return parts.filter(Boolean).join(", ");
}

export function resolveBpm(state) {
  if (state.tempoPreset === "custom" && state.bpmCustom > 0) {
    return Math.round(state.bpmCustom);
  }
  const preset = TEMPO_PRESETS[state.tempoPreset];
  return preset?.bpm ?? null;
}

/**
 * @param {HTMLElement} root
 */
export function initMusicComposeEditor(root) {
  if (!root) throw new Error("compose editor root missing");

  const $genreChips = root.querySelector("#genre-chips");
  const $instrumentChips = root.querySelector("#instrument-chips");
  const $vocalStyleChips = root.querySelector("#vocal-style-chips");
  const $vocalStyleRow = root.querySelector("#vocal-style-row");
  const $vocalRefRow = root.querySelector("#vocal-ref-row");
  const $tempoPreset = root.querySelector("#tempo-preset");
  const $bpmCustom = root.querySelector("#bpm-custom");
  const $bpmCustomRow = root.querySelector("#bpm-custom-row");
  const $vocalType = root.querySelector("#vocal-type");
  const $mood = root.querySelector("#mood-text");
  const $captionPreview = root.querySelector("#caption-preview");
  const $sectionsList = root.querySelector("#lyrics-sections-list");
  const $lyricsPreview = root.querySelector("#lyrics-preview");
  const $btnAddSection = root.querySelector("#btn-add-section");

  /** @type {ReturnType<typeof defaultSections>} */
  let sections = defaultSections();

  function readCaptionState() {
    const genres = [];
    $genreChips?.querySelectorAll(".compose-chip.is-selected").forEach((el) => {
      const cap = el.dataset.caption || el.dataset.value;
      if (cap) genres.push(cap);
    });
    const instruments = [];
    $instrumentChips?.querySelectorAll(".compose-chip.is-selected").forEach((el) => {
      const cap = el.dataset.caption || el.dataset.value;
      if (cap) instruments.push(cap);
    });
    const vocalStyles = [];
    $vocalStyleChips?.querySelectorAll(".compose-chip.is-selected").forEach((el) => {
      const cap = el.dataset.caption || el.dataset.value;
      if (cap) vocalStyles.push(cap);
    });
    const tempoPreset = $tempoPreset?.value || "medium";
    const bpmCustom = $bpmCustom?.value ? parseInt($bpmCustom.value, 10) : null;
    const instrumentalNotes = sections
      .filter((s) => s.type === "instrumental")
      .map((s) => s.instDesc)
      .filter(Boolean);

    return {
      genres,
      tempoPreset,
      bpmCustom: Number.isFinite(bpmCustom) ? bpmCustom : null,
      instruments,
      vocalType: $vocalType?.value || "female",
      vocalStyles,
      mood: $mood?.value || "",
      instrumentalNotes,
    };
  }

  function updatePreviews() {
    const vocalLang =
      document.getElementById("vocal-lang")?.value || "ko";
    const cap = compileCaption(readCaptionState(), vocalLang);
    const lyr = compileLyrics(sections);
    if ($captionPreview) $captionPreview.textContent = cap || "(스타일을 선택하세요)";
    if ($lyricsPreview) $lyricsPreview.textContent = lyr || "(가사 구간을 입력하세요)";
  }

  function refreshSectionIndices() {
    $sectionsList?.querySelectorAll(".lyrics-section-card").forEach((card, idx) => {
      const el = card.querySelector(".lyrics-section-index");
      if (el) el.textContent = String(idx + 1);
    });
  }

  function updateSectionCardForType(card, sec) {
    const def = SECTION_TYPE_DEFS[sec.type] || SECTION_TYPE_DEFS.verse;
    card.querySelector(".section-lyrics-wrap")?.classList.toggle("is-hidden", def.instrumental);
    card.querySelector(".section-instrumental-wrap")?.classList.toggle("is-hidden", !def.instrumental);
  }

  function appendSectionCard(sec, index) {
    if (!$sectionsList) return null;
    const card = renderSectionCard(sec, index);
    $sectionsList.appendChild(card);
    return card;
  }

  function syncSectionsOrderFromDom() {
    if (!$sectionsList) return;
    const ordered = [];
    $sectionsList.querySelectorAll(".lyrics-section-card").forEach((card) => {
      const id = card.dataset.id;
      const sec = sections.find((s) => s.id === id);
      if (sec) ordered.push(sec);
    });
    if (ordered.length === sections.length) sections = ordered;
  }

  function moveSectionCardDom(sectionId, direction) {
    const card = $sectionsList?.querySelector(
      `.lyrics-section-card[data-id="${CSS.escape(sectionId)}"]`,
    );
    if (!card) return;
    if (direction === "up" && card.previousElementSibling) {
      card.parentNode?.insertBefore(card, card.previousElementSibling);
    } else if (direction === "down" && card.nextElementSibling) {
      card.parentNode?.insertBefore(card.nextElementSibling, card);
    }
    syncSectionsOrderFromDom();
    refreshSectionIndices();
  }

  function syncSectionsFromDom() {
    $sectionsList?.querySelectorAll(".lyrics-section-card").forEach((card) => {
      const sec = sections.find((s) => s.id === card.dataset.id);
      if (!sec) return;
      const typeEl = card.querySelector(".section-type");
      const lyricsEl = card.querySelector(".section-lyrics");
      const instEl = card.querySelector(".section-inst-desc");
      if (typeEl) sec.type = typeEl.value;
      if (lyricsEl) sec.lyrics = lyricsEl.value;
      if (instEl) sec.instDesc = instEl.value;
    });
  }

  function renderSectionCard(sec, index) {
    const def = SECTION_TYPE_DEFS[sec.type] || SECTION_TYPE_DEFS.verse;
    const card = document.createElement("div");
    card.className = "lyrics-section-card";
    card.dataset.id = sec.id;

    const typeOptions = Object.entries(SECTION_TYPE_DEFS)
      .map(
        ([key, d]) =>
          `<option value="${key}"${sec.type === key ? " selected" : ""}>${d.label}</option>`,
      )
      .join("");

    card.innerHTML = `
      <div class="lyrics-section-toolbar">
        <span class="lyrics-section-index">${index + 1}</span>
        <select class="section-type form-select" aria-label="구간 유형">${typeOptions}</select>
        <div class="lyrics-section-actions">
          <button type="button" class="btn-icon-action" data-act="up" title="위로">↑</button>
          <button type="button" class="btn-icon-action" data-act="down" title="아래로">↓</button>
          <button type="button" class="btn-icon-action btn-icon-action--danger" data-act="remove" title="삭제">✕</button>
        </div>
      </div>
      <div class="section-lyrics-wrap${def.instrumental ? " is-hidden" : ""}">
        <textarea class="section-lyrics form-textarea" rows="4" placeholder="이 구간에서 부를 가사만 입력하세요">${escapeText(sec.lyrics || "")}</textarea>
      </div>
      <div class="section-instrumental-wrap${def.instrumental ? "" : " is-hidden"}">
        <label class="form-label form-label-sm">연주 설명 <span class="form-label-note">(가사 아님 · 스타일 설명에만 반영)</span></label>
        <input type="text" class="section-inst-desc form-input" placeholder="예: 피아노 솔로, 잔잔한 스트링" value="${escapeAttr(sec.instDesc || "")}">
        <p class="form-hint">이 구간은 <strong>[Instrumental]</strong> 태그만 전달됩니다. 설명은 노래 가사로 불리지 않습니다.</p>
      </div>
    `;

    const typeEl = card.querySelector(".section-type");
    typeEl?.addEventListener("change", () => {
      syncSectionsFromDom();
      const i = sections.findIndex((s) => s.id === sec.id);
      if (i >= 0) {
        sections[i].type = typeEl.value;
        updateSectionCardForType(card, sections[i]);
      }
      updatePreviews();
    });

    card.querySelector(".section-lyrics")?.addEventListener("input", updatePreviews);
    card.querySelector(".section-inst-desc")?.addEventListener("input", updatePreviews);

    card.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        syncSectionsFromDom();
        const i = sections.findIndex((s) => s.id === sec.id);
        if (i < 0) return;
        const act = btn.getAttribute("data-act");
        if (act === "remove") {
          if (sections.length <= 1) return;
          sections.splice(i, 1);
          card.remove();
          refreshSectionIndices();
        } else if (act === "up" && i > 0) {
          const tmp = sections[i - 1];
          sections[i - 1] = sections[i];
          sections[i] = tmp;
          moveSectionCardDom(sec.id, "up");
        } else if (act === "down" && i < sections.length - 1) {
          const tmp = sections[i + 1];
          sections[i + 1] = sections[i];
          sections[i] = tmp;
          moveSectionCardDom(sec.id, "down");
        } else {
          return;
        }
        updatePreviews();
      });
    });

    return card;
  }

  function renderAllSections() {
    if (!$sectionsList) return;
    $sectionsList.replaceChildren();
    sections.forEach((sec, idx) => {
      $sectionsList.appendChild(renderSectionCard(sec, idx));
    });
    updatePreviews();
  }

  function buildChip(container, item, { group = "default" } = {}) {
    if (!container) return;
    const label = typeof item === "string" ? item : item.label;
    const caption = typeof item === "string" ? item : item.caption;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "compose-chip";
    btn.dataset.caption = caption;
    btn.dataset.group = group;
    btn.textContent = label;
    btn.addEventListener("click", () => {
      btn.classList.toggle("is-selected");
      updatePreviews();
    });
    container.appendChild(btn);
  }

  function syncVocalExtrasVisibility() {
    const isInstrumental = ($vocalType?.value || "female") === "none";
    $vocalStyleRow?.classList.toggle("is-hidden", isInstrumental);
    $vocalRefRow?.classList.toggle("is-hidden", isInstrumental);
  }

  GENRE_OPTIONS.forEach((g) => buildChip($genreChips, g, { group: "genre" }));
  INSTRUMENT_OPTIONS.forEach((item) => buildChip($instrumentChips, item, { group: "instrument" }));
  VOCAL_STYLE_OPTIONS.forEach((item) => buildChip($vocalStyleChips, item, { group: "vocal-style" }));

  if ($tempoPreset) {
    $tempoPreset.innerHTML = Object.entries(TEMPO_PRESETS)
      .map(([key, p]) => `<option value="${key}">${p.label}</option>`)
      .join("");
    $tempoPreset.value = "medium";
    $tempoPreset.addEventListener("change", () => {
      const custom = $tempoPreset.value === "custom";
      $bpmCustomRow?.classList.toggle("is-hidden", !custom);
      updatePreviews();
    });
  }

  if ($vocalType) {
    $vocalType.innerHTML = VOCAL_TYPE_OPTIONS.map(
      (o) => `<option value="${o.value}">${o.label}</option>`,
    ).join("");
    $vocalType.addEventListener("change", () => {
      syncVocalExtrasVisibility();
      updatePreviews();
    });
    syncVocalExtrasVisibility();
  }

  $mood?.addEventListener("input", updatePreviews);
  $bpmCustom?.addEventListener("input", updatePreviews);
  document.getElementById("vocal-lang")?.addEventListener("change", updatePreviews);

  $btnAddSection?.addEventListener("click", () => {
    syncSectionsFromDom();
    const sec = createSection("verse");
    sections.push(sec);
    appendSectionCard(sec, sections.length - 1);
    updatePreviews();
  });

  renderAllSections();

  return {
    compileForGeneration(vocalLanguage = "ko") {
      syncSectionsFromDom();
      const capState = readCaptionState();
      const vocalType = capState.vocalType || "female";
      return {
        caption: compileCaption(capState, vocalLanguage),
        lyrics: compileLyrics(sections),
        bpm: resolveBpm(capState),
        vocal_type: vocalType,
        instrumental: vocalType === "none",
      };
    },
    validateForGeneration() {
      syncSectionsFromDom();
      const capState = readCaptionState();
      const vocalLang = document.getElementById("vocal-lang")?.value || "ko";
      const cap = compileCaption(capState, vocalLang);
      if (!cap.trim()) {
        return { ok: false, message: "장르·템포·악기·분위기 중 하나 이상을 선택하거나 입력하세요." };
      }

      const vocalType = $vocalType?.value || "female";
      const hasVocalLines = sections.some(
        (s) => s.type !== "instrumental" && String(s.lyrics || "").trim(),
      );

      if (vocalType === "none") {
        return { ok: true };
      }

      if (!hasVocalLines) {
        return {
          ok: false,
          message: "Verse·Chorus 등에 가사를 입력하세요. 연주만 원하면 보컬 타입을 「보컬 없음」으로 바꾸세요.",
        };
      }

      const lyrics = compileLyrics(sections);
      if (!lyrics.trim()) {
        return { ok: false, message: "가사 구간을 확인하세요." };
      }
      return { ok: true };
    },
    updatePreviews,
  };
}

function escapeText(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s) {
  return escapeText(s).replace(/"/g, "&quot;");
}
