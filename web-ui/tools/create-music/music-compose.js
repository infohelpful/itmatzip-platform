/**
 * Create Music — 구조화 가사 + caption 컴파일 (ACE-Step 형식)
 */

function t(key, fallback) {
  return typeof window.itzT === "function" ? window.itzT(key, fallback) : fallback;
}

export const SECTION_TYPE_DEFS = {
  verse: { tag: "Verse", label: "절 (Verse)", i18nKey: "section.verse", instrumental: false },
  pre_chorus: { tag: "Pre-Chorus", label: "프리코러스 (Pre-Chorus)", i18nKey: "section.preChorus", instrumental: false },
  chorus: { tag: "Chorus", label: "후렴 (Chorus)", i18nKey: "section.chorus", instrumental: false },
  bridge: { tag: "Bridge", label: "브릿지 (Bridge)", i18nKey: "section.bridge", instrumental: false },
  outro: { tag: "Outro", label: "아웃트로 (Outro)", i18nKey: "section.outro", instrumental: false },
  intro: { tag: "Intro", label: "인트로 (Intro)", i18nKey: "section.intro", instrumental: false },
  instrumental: { tag: "Instrumental", label: "연주 (Instrumental)", i18nKey: "section.instrumental", instrumental: true },
};

/** label: UI 표시(한글), caption: ACE-Step caption용(영문 태그) */
export const GENRE_OPTIONS = [
  { label: "케이팝", caption: "K-pop", i18nKey: "genre.kpop" },
  { label: "팝", caption: "Pop", i18nKey: "genre.pop" },
  { label: "발라드", caption: "Ballad", i18nKey: "genre.ballad" },
  { label: "알앤비", caption: "R&B", i18nKey: "genre.rnb" },
  { label: "힙합", caption: "Hip-hop", i18nKey: "genre.hiphop" },
  { label: "록", caption: "Rock", i18nKey: "genre.rock" },
  { label: "로파이", caption: "Lo-fi", i18nKey: "genre.lofi" },
  { label: "EDM", caption: "EDM", i18nKey: "genre.edm" },
  { label: "재즈", caption: "Jazz", i18nKey: "genre.jazz" },
  { label: "시티팝", caption: "City pop", i18nKey: "genre.citypop" },
  { label: "어쿠스틱", caption: "Acoustic", i18nKey: "genre.acoustic" },
  { label: "오케스트라", caption: "Orchestral", i18nKey: "genre.orchestral" },
  { label: "시네마틱", caption: "Cinematic", i18nKey: "genre.cinematic" },
  { label: "뉴에이지", caption: "New Age", i18nKey: "genre.newage" },
  { label: "앰비언트", caption: "Ambient", i18nKey: "genre.ambient" },
  { label: "인디", caption: "Indie", i18nKey: "genre.indie" },
  { label: "트로트", caption: "Trot", i18nKey: "genre.trot" },
  { label: "신스웨이브", caption: "Synthwave", i18nKey: "genre.synthwave" },
  { label: "레트로", caption: "Retro", i18nKey: "genre.retro" },
  { label: "소울", caption: "Soul", i18nKey: "genre.soul" },
  { label: "펑크", caption: "Funk", i18nKey: "genre.funk" },
];

export const INSTRUMENT_OPTIONS = [
  { label: "피아노", caption: "piano", i18nKey: "inst.piano" },
  { label: "신시사이저", caption: "synthesizer", i18nKey: "inst.synth" },
  { label: "일렉트릭 피아노", caption: "electric piano", i18nKey: "inst.epiano" },
  { label: "어쿠스틱 기타", caption: "acoustic guitar", i18nKey: "inst.acguitar" },
  { label: "일렉트릭 기타", caption: "electric guitar", i18nKey: "inst.eguitar" },
  { label: "베이스", caption: "bass", i18nKey: "inst.bass" },
  { label: "바이올린", caption: "violin", i18nKey: "inst.violin" },
  { label: "첼로", caption: "cello", i18nKey: "inst.cello" },
  { label: "스트링 앙상블", caption: "string ensemble", i18nKey: "inst.strings" },
  { label: "드럼 킷", caption: "drum kit", i18nKey: "inst.drums" },
  { label: "웅장한 타악", caption: "epic percussion", i18nKey: "inst.perc" },
  { label: "비트 머신", caption: "beat machine", i18nKey: "inst.beat" },
  { label: "브라스", caption: "brass", i18nKey: "inst.brass" },
  { label: "색소폰", caption: "saxophone", i18nKey: "inst.sax" },
  { label: "플루트", caption: "flute", i18nKey: "inst.flute" },
];

export const TEMPO_PRESETS = {
  slow: { label: "느림 (~70 BPM)", bpm: 70, i18nKey: "tempo.slow" },
  medium: { label: "보통 (~110 BPM)", bpm: 110, i18nKey: "tempo.medium" },
  fast: { label: "빠름 (~140 BPM)", bpm: 140, i18nKey: "tempo.fast" },
  custom: { label: "직접 입력", bpm: null, i18nKey: "tempo.custom" },
};

export const VOCAL_TYPE_OPTIONS = [
  { value: "female", label: "여성 보컬", i18nKey: "vocal.female" },
  { value: "male", label: "남성 보컬", i18nKey: "vocal.male" },
  { value: "duet", label: "듀엣", i18nKey: "vocal.duet" },
  { value: "none", label: "보컬 없음 (연주)", i18nKey: "vocal.none" },
];

/** label: UI(한글), caption: ACE-Step 권장 영문 태그 */
export const VOCAL_STYLE_OPTIONS = [
  { label: "부드러운", caption: "soft vocal", i18nKey: "vstyle.soft" },
  { label: "파워풀", caption: "powerful vocal", i18nKey: "vstyle.powerful" },
  { label: "숨결감", caption: "breathy vocal", i18nKey: "vstyle.breathy" },
  { label: "허스키", caption: "raspy vocal", i18nKey: "vstyle.raspy" },
  { label: "고음", caption: "falsetto vocal", i18nKey: "vstyle.falsetto" },
  { label: "합창", caption: "choir vocals", i18nKey: "vstyle.choir" },
  { label: "속삭임", caption: "whispered vocal", i18nKey: "vstyle.whisper" },
  { label: "감성적", caption: "emotional vocal", i18nKey: "vstyle.emotional" },
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
    if ($captionPreview) $captionPreview.textContent = cap || t("stylePreviewEmpty", "(스타일을 선택하세요)");
    if ($lyricsPreview) $lyricsPreview.textContent = lyr || t("lyricsPreviewEmpty", "(가사 구간을 입력하세요)");
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
          `<option value="${key}"${sec.type === key ? " selected" : ""}>${t(d.i18nKey, d.label)}</option>`,
      )
      .join("");

    card.innerHTML = `
      <div class="lyrics-section-toolbar">
        <span class="lyrics-section-index">${index + 1}</span>
        <select class="section-type form-select" aria-label="${escapeAttr(t("sectionTypeAria", "구간 유형"))}">${typeOptions}</select>
        <div class="lyrics-section-actions">
          <button type="button" class="btn-icon-action" data-act="up" title="${escapeAttr(t("moveUp", "위로"))}">↑</button>
          <button type="button" class="btn-icon-action" data-act="down" title="${escapeAttr(t("moveDown", "아래로"))}">↓</button>
          <button type="button" class="btn-icon-action btn-icon-action--danger" data-act="remove" title="${escapeAttr(t("remove", "삭제"))}">✕</button>
        </div>
      </div>
      <div class="section-lyrics-wrap${def.instrumental ? " is-hidden" : ""}">
        <textarea class="section-lyrics form-textarea" rows="4" placeholder="${escapeAttr(t("lyricsPh", "이 구간에서 부를 가사만 입력하세요"))}">${escapeText(sec.lyrics || "")}</textarea>
      </div>
      <div class="section-instrumental-wrap${def.instrumental ? "" : " is-hidden"}">
        <label class="form-label form-label-sm">${t("instDescLabel", '연주 설명 <span class="form-label-note">(가사 아님 · 스타일 설명에만 반영)</span>')}</label>
        <input type="text" class="section-inst-desc form-input" placeholder="${escapeAttr(t("instDescPh", "예: 피아노 솔로, 잔잔한 스트링"))}" value="${escapeAttr(sec.instDesc || "")}">
        <p class="form-hint">${t("instDescHint", "이 구간은 <strong>[Instrumental]</strong> 태그만 전달됩니다. 설명은 노래 가사로 불리지 않습니다.")}</p>
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
    const i18nKey = typeof item === "string" ? "" : item.i18nKey || "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "compose-chip";
    btn.dataset.caption = caption;
    btn.dataset.group = group;
    if (i18nKey) btn.dataset.i18nKey = i18nKey;
    btn.textContent = i18nKey ? t(i18nKey, label) : label;
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
      .map(([key, p]) => `<option value="${key}">${t(p.i18nKey, p.label)}</option>`)
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
      (o) => `<option value="${o.value}">${t(o.i18nKey, o.label)}</option>`,
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

  function relabelComposeUi() {
    root.querySelectorAll(".compose-chip[data-i18n-key]").forEach((btn) => {
      const key = btn.dataset.i18nKey;
      const item =
        GENRE_OPTIONS.find((g) => g.i18nKey === key) ||
        INSTRUMENT_OPTIONS.find((g) => g.i18nKey === key) ||
        VOCAL_STYLE_OPTIONS.find((g) => g.i18nKey === key);
      if (key) btn.textContent = t(key, item?.label || btn.textContent);
    });
    if ($tempoPreset) {
      Object.entries(TEMPO_PRESETS).forEach(([key, p]) => {
        const opt = $tempoPreset.querySelector(`option[value="${key}"]`);
        if (opt) opt.textContent = t(p.i18nKey, p.label);
      });
    }
    if ($vocalType) {
      VOCAL_TYPE_OPTIONS.forEach((o) => {
        const opt = $vocalType.querySelector(`option[value="${o.value}"]`);
        if (opt) opt.textContent = t(o.i18nKey, o.label);
      });
    }
    $sectionsList?.querySelectorAll(".lyrics-section-card").forEach((card) => {
      const typeEl = card.querySelector(".section-type");
      if (typeEl) {
        typeEl.setAttribute("aria-label", t("sectionTypeAria", "구간 유형"));
        Object.entries(SECTION_TYPE_DEFS).forEach(([key, d]) => {
          const opt = typeEl.querySelector(`option[value="${key}"]`);
          if (opt) opt.textContent = t(d.i18nKey, d.label);
        });
      }
      const up = card.querySelector('[data-act="up"]');
      const down = card.querySelector('[data-act="down"]');
      const removeBtn = card.querySelector('[data-act="remove"]');
      if (up) up.title = t("moveUp", "위로");
      if (down) down.title = t("moveDown", "아래로");
      if (removeBtn) removeBtn.title = t("remove", "삭제");
      const lyricsEl = card.querySelector(".section-lyrics");
      if (lyricsEl) lyricsEl.placeholder = t("lyricsPh", "이 구간에서 부를 가사만 입력하세요");
      const instLabel = card.querySelector(".section-instrumental-wrap .form-label");
      if (instLabel) {
        instLabel.innerHTML = t(
          "instDescLabel",
          '연주 설명 <span class="form-label-note">(가사 아님 · 스타일 설명에만 반영)</span>',
        );
      }
      const instEl = card.querySelector(".section-inst-desc");
      if (instEl) instEl.placeholder = t("instDescPh", "예: 피아노 솔로, 잔잔한 스트링");
      const instHint = card.querySelector(".section-instrumental-wrap .form-hint");
      if (instHint) {
        instHint.innerHTML = t(
          "instDescHint",
          "이 구간은 <strong>[Instrumental]</strong> 태그만 전달됩니다. 설명은 노래 가사로 불리지 않습니다.",
        );
      }
    });
    updatePreviews();
  }

  renderAllSections();
  document.addEventListener("itz:lang-change", relabelComposeUi);

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
        return { ok: false, message: t("needStyle", "장르·템포·악기·분위기 중 하나 이상을 선택하거나 입력하세요.") };
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
          message: t("needLyrics", "Verse·Chorus 등에 가사를 입력하세요. 연주만 원하면 보컬 타입을 「보컬 없음」으로 바꾸세요."),
        };
      }

      const lyrics = compileLyrics(sections);
      if (!lyrics.trim()) {
        return { ok: false, message: t("needLyricsCheck", "가사 구간을 확인하세요.") };
      }
      return { ok: true };
    },
    updatePreviews,
    relabel() {
      relabelComposeUi();
    },
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
