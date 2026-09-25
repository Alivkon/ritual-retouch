import { PhotoUploader } from "../components/uploader.js";
import { notifications } from "../components/notifications.js";
import { uploadPhoto, startGeneration, getGenerationStatus, sleep, getToken } from "../api.js";

const ENHANCE_TEXT = `REMASTER AND UPSCALE. Priority: High-fidelity facial reconstruction. Maintain 100% identical facial structure, bone shape, and expression of the person in the source image. CRITICAL: Avoid all skin smoothing, airbrushing, or artificial blurring. Render hyper-realistic epidermal textures, including visible skin pores, fine natural lines, and subtle micro-details. Eyes must be crystal clear with sharp iris details and individual eyelashes. Hair must have distinct, sharp strands. Lighting: Professional studio key light. Technical specs: Shot on 85mm macro lens, f/2.8, ISO 100, 8k resolution, photorealistic masterpiece. `;

const DETAIL_TEXT = `Профессиональная высококлассная реставрация старой фотографии, абсолютное сохранение черт лица и идентичности человека с оригинала, точное восстановление текстуры оригинальной одежды, естественная колоризация, максимальная резкость, 8k, высокая детализация, реалистичная текстура кожи, качество студийного сканирования. Отрицательный промпт (Negative prompt): галлюцинации нейросети, искаженные черты лица, измененная внешность, современная одежда, мультяшный стиль, артефакты, водяные знаки. `;

const BW_RESTORE_TEXT = `Профессиональная высококлассная реставрация старой фотографии, абсолютное сохранение черт лица и идентичности человека с оригинала, точное восстановление текстуры оригинальной одежды, черно-белое фото, максимальная резкость, 8k, высокая детализация, реалистичная текстура кожи, качество студийного сканирования. Отрицательный промпт (Negative prompt): галлюцинации нейросети, искаженные черты лица, измененная внешность, современная одежда, мультяшный стиль, артефакты, водяные знаки. `;

const GRANITE_TEXT = `A photo of a high-resolution laser engraving on a polished black slab. The texture must be rich and deep, with varying depths of engraving creating an intricate grayscale. The entire image should look like it's carven into stone. Re-render the subject with stippling and detailed hatching lines to create form and shadow, like a classic etching. Ensure every detail of clothing, features, or elements is sharp and clear. The pose and key features must be preserved. Diffused, non-point light from the front, illuminating the engraved grooves and casting soft. Fine-detail engraving, hyperrealistic stippling, etched, grayscale, the texture of absolutely black granite without light spots, memorial, commemorative, intricately detailed, no watermarks, classic art, laser etching.`;

const ENGRAVE_MACHINE_TEXT = `**Основное техническое требование (Фон и Общее):**
Это изображение должно служить безупречным, лишенным шумов цифровым чертежом для прямого импорта в ЧПУ или лазерный гравировальный станок. ВЕСЬ ФОН должен быть абсолютно чистой, глубокой, чисто-черной пустотой (чистый RGB 0,0,0 или цифровой ноль данных). Изображение является точной тональной картой точек гравировки, где глубина и плотность точек напрямую управляются градиентами. Конечная цель — мастерская, фотореалистичная гравировка на черной каменной плите, где «зернистость» микроскопична и создает гладкие градиенты.
**Стиль и Устранение Зернистости:**
Мастерская, высокоточная, фотореалистичная гравировка. Вся форма должна быть определена мягкими, непрерывными тональными переходами, выполненными с использованием ультратонкого *микро*-стипплинга (микро-точек) и тонкой штриховки с переменной глубиной. 
* **КРИТИЧЕСКОЕ ТРЕБОВАНИЕ:** Минимизировать крупный зернистый шум. Заменить крупный стипплинг более плотной, микроскопической матрицей точек, создающей гладкие тональные градиенты.
**Субъект 
Мастерски выполненная, чистая репродукция портрета. Портрет должен быть полностью рендерирован с сохранением всех ключевых черт, текстуры кожи и деталей одежды, без водяных знаков. 
**Критическое требование к форме (Устранение жесткости):**
* **НИКАКИХ ЖЕСТКИХ, ВЕКТОРНЫХ ОБВОДНЫХ ЛИНИЙ ИЛИ ОБЩИХ КОНТУРОВ.** Границы лица, шеи, волос и одежды должны определяться *только* тональными переходами и тенями. Используйте плавные переходы между разными зонами (например, от волос к лицу).
**Детализация:**
Каждая деталь должна быть четко определена высокоплотной матрицей точек или тонкой штриховкой.
* **Волосы:** Тонкая, переменная штриховка для определения прядей.
* **Лицо:** Мягкий микро-стипплинг для кожи, сохраняющий текстуру и поры.
**Освещение:**
Четкое фронтальное, оптимизированное для создания глубокого, четкого рельефа гравировки.
**Композиция и Использование:**
Центрированная, сфокусированная композиция. Весь файл оптимизирован для прямого парсинга команд высокоточным гравировальным станком.
**Дополнительные технические ключевые слова:**
Universal master-engraving map, high-precision micro-stippling, photo-realistic etching, zero background void, smooth tonal gradients, flawless black surface, detailed skin texture, CNC/Laser print-ready, clean data-map.`;

export interface GenerationResult {
  generationId: number;
  resultUrl: string;
  sourceUrl?: string;
  prompt: string;
  originalDataUrl: string;
  elapsedSeconds: number;
}

type Navigate = (page: string, data?: GenerationResult) => void;
type RoleMode = "designer" | "manager" | "engraver";

const uploader = new PhotoUploader();
let hasPhoto = false;
let generateInitialized = false;
let currentRole: RoleMode = "designer";
let invertPreviewActive = false;
let currentOnNeedAuth: ((onSuccess: () => void) => void) | undefined;
let currentOnGenerationStarted: (() => Promise<void>) | undefined;
let enhanceActive = false;
let graniteActive = false;
let engraveActive = false;
let detailActive = false;
let bwRestoreActive = false;

interface PresetDef {
  field: "clothing" | "pose" | "background" | "additional";
  text: string;
  autofill?: boolean;
  invertPreview?: boolean;
}

const PRESET_DEFINITIONS: Record<string, PresetDef> = {
  detail:        { field: "additional", text: "enhance fine detail, повысить детализацию" },
  denoise:       { field: "additional", text: "remove digital noise and grain, удалить шум" },
  ceramic:       { field: "additional", text: "prepare for photo-ceramic production, подготовить под фотокерамику" },
  bw:            { field: "additional", text: "professional black and white portrait, черно-белый портрет" },
  clean_bg:      { field: "additional", text: "clean and neutralize background, очистить фон" },
  contrast:      { field: "additional", text: "enhance contrast, усилить контраст" },
  business:      { field: "clothing",   text: "деловой костюм" },
  fullbody:      { field: "pose",       text: "в полный рост, одна рука в кармане", autofill: true },
  light_bg:      { field: "background", text: "светлый нейтральный фон" },
  bw_photo:      { field: "additional", text: "black and white memorial portrait, черно-белое фото" },
  monument:      { field: "additional", text: "suitable for memorial monument portrait, для памятника" },
  ceramic_mgr:   { field: "additional", text: "prepare for photo-ceramic, для фотокерамики" },
  contrast_eng:  { field: "additional", text: "maximum contrast for engraving, усилить контраст" },
  bw_eng:        { field: "additional", text: "strict black and white mode for engraving" },
  clean_bg_eng:  { field: "additional", text: "remove all background for clean engraving silhouette" },
  cnc:           { field: "additional", text: "optimize for CNC and laser cutter, подготовить для ЧПУ" },
  stone_invert:  { field: "additional", text: "white portrait on black granite, inverted high contrast engraving, белый рисунок на чёрном камне", invertPreview: true },
};

export function initGenerate(
  navigate: Navigate,
  onNeedAuth?: (onSuccess: () => void) => void,
  onGenerationStarted?: () => Promise<void>,
): void {
  currentOnNeedAuth = onNeedAuth;
  currentOnGenerationStarted = onGenerationStarted;

  if (generateInitialized) return;
  generateInitialized = true;

  uploader.init((photo) => {
    hasPhoto = photo !== null;
    updateGenerateBtn();
  });

  document.querySelectorAll<HTMLButtonElement>(".segment-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const role = btn.dataset["role"] as RoleMode | undefined;
      if (role) switchRole(role);
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => handlePresetClick(btn));
  });

  ["field-clothing", "field-pose", "field-background", "field-additional"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateGenerateBtn);
  });

  document.getElementById("generate-btn")?.addEventListener("click", () => {
    void handleGenerate(navigate);
  });

  const enhanceBtn = document.getElementById("enhance-portrait-btn") as HTMLButtonElement | null;
  const graniteBtn = document.getElementById("granite-btn") as HTMLButtonElement | null;
  const engraveBtn = document.getElementById("engrave-machine-btn") as HTMLButtonElement | null;
  const detailBtn = document.getElementById("detail-enhance-btn") as HTMLButtonElement | null;
  const bwRestoreBtn = document.getElementById("bw-restore-btn") as HTMLButtonElement | null;

  enhanceBtn?.addEventListener("click", () => {
    enhanceActive = !enhanceActive;
    enhanceBtn.classList.toggle("active", enhanceActive);
    updateGenerateBtn();
  });

  graniteBtn?.addEventListener("click", () => {
    graniteActive = !graniteActive;
    graniteBtn.classList.toggle("active", graniteActive);
    updateGenerateBtn();
  });

  engraveBtn?.addEventListener("click", () => {
    engraveActive = !engraveActive;
    engraveBtn.classList.toggle("active", engraveActive);
    updateGenerateBtn();
  });

  detailBtn?.addEventListener("click", () => {
    detailActive = !detailActive;
    detailBtn.classList.toggle("active", detailActive);
    updateGenerateBtn();
  });

  bwRestoreBtn?.addEventListener("click", () => {
    bwRestoreActive = !bwRestoreActive;
    bwRestoreBtn.classList.toggle("active", bwRestoreActive);
    updateGenerateBtn();
  });
}

function switchRole(role: RoleMode): void {
  currentRole = role;
  document.querySelectorAll<HTMLButtonElement>(".segment-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset["role"] === role);
  });
  const ids: Record<RoleMode, string> = {
    designer: "presets-designer",
    manager: "presets-manager",
    engraver: "presets-engraver",
  };
  for (const [r, id] of Object.entries(ids)) {
    const el = document.getElementById(id);
    if (el) el.style.display = r === role ? "" : "none";
  }
  const engraverRow = document.getElementById("engraver-enhance-row");
  if (engraverRow) engraverRow.style.display = role === "engraver" ? "" : "none";

  if (role !== "engraver") {
    disableInvertPreview();
    if (engraveActive) {
      engraveActive = false;
      const engraveBtn = document.getElementById("engrave-machine-btn") as HTMLButtonElement | null;
      engraveBtn?.classList.remove("active");
      updateGenerateBtn();
    }
  }
}

function handlePresetClick(btn: HTMLButtonElement): void {
  const presetKey = btn.dataset["preset"] ?? "";
  const def = PRESET_DEFINITIONS[presetKey];
  if (!def) return;

  const isActive = btn.classList.toggle("active");

  const fieldEl = document.getElementById(`field-${def.field}`) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!fieldEl) return;

  if (def.autofill) {
    fieldEl.value = isActive ? def.text : "";
    return;
  }

  if (isActive) {
    fieldEl.value = fieldEl.value ? fieldEl.value + ", " + def.text : def.text;
  } else {
    fieldEl.value = fieldEl.value
      .replace(new RegExp(",?\\s*" + escapeRegex(def.text), "g"), "")
      .trim()
      .replace(/^,\s*/, "");
  }

  if (def.invertPreview) {
    if (isActive) enableInvertPreview();
    else disableInvertPreview();
  }

  updateGenerateBtn();
}

function buildMergedPrompt(): string {
  const clothing = (document.getElementById("field-clothing") as HTMLInputElement | null)?.value.trim() ?? "";
  const pose = (document.getElementById("field-pose") as HTMLInputElement | null)?.value.trim() ?? "";
  const background = (document.getElementById("field-background") as HTMLInputElement | null)?.value.trim() ?? "";
  const additional = (document.getElementById("field-additional") as HTMLTextAreaElement | null)?.value.trim() ?? "";

  const roleSuffix: Record<RoleMode, string> = {
    designer: "",
    manager:  "",
    engraver: "focus on high contrast engraving-ready output",
  };

  const parts: string[] = [];
  if (clothing)                   parts.push(`Одежда: ${clothing}`);
  if (pose)                       parts.push(`Поза: ${pose}`);
  if (background)                 parts.push(`Фон: ${background}`);
  if (additional)                 parts.push(`Дополнительно: ${additional}`);
  if (roleSuffix[currentRole])    parts.push(roleSuffix[currentRole]);

  const base = parts.join("\n");
  return (enhanceActive ? ENHANCE_TEXT : "")
       + (graniteActive ? GRANITE_TEXT : "")
       + (engraveActive ? ENGRAVE_MACHINE_TEXT : "")
       + (detailActive ? DETAIL_TEXT : "")
       + (bwRestoreActive ? BW_RESTORE_TEXT : "")
       + base;
}

function updateGenerateBtn(): void {
  const btn = document.getElementById("generate-btn") as HTMLButtonElement | null;
  if (!btn) return;
  const clothing  = (document.getElementById("field-clothing")    as HTMLInputElement    | null)?.value.trim() ?? "";
  const pose      = (document.getElementById("field-pose")        as HTMLInputElement    | null)?.value.trim() ?? "";
  const background = (document.getElementById("field-background") as HTMLInputElement    | null)?.value.trim() ?? "";
  const additional = (document.getElementById("field-additional") as HTMLTextAreaElement | null)?.value.trim() ?? "";
  const hasText = clothing.length > 0 || pose.length > 0 || background.length > 0 || additional.length > 0;
  btn.disabled = !hasPhoto || (!hasText && !enhanceActive && !graniteActive && !engraveActive && !detailActive && !bwRestoreActive);
}

// Провал в первые ~30 секунд означает, что KIE.ai отказал сразу (сервер занят) —
// такой запрос имеет смысл автоматически повторить. Поздний провал чаще связан
// с самим фото/промптом, повтор сожжёт ещё 3 минуты впустую.
const EARLY_FAIL_THRESHOLD_MS = 30_000;

class GenerationFailedError extends Error {
  constructor(public readonly earlyFail: boolean) {
    super("Generation failed");
  }
}

async function handleGenerate(navigate: Navigate, attempt = 0): Promise<void> {
  const photo = uploader.getPhoto();
  if (!photo) { notifications.error("Пожалуйста, загрузите фото"); return; }

  if (!getToken()) {
    if (currentOnNeedAuth) currentOnNeedAuth(() => void handleGenerate(navigate));
    return;
  }

  const prompt = buildMergedPrompt();

  if (prompt.length > 5000) {
    notifications.error("Количество символов в промте более 5000 символов. Пожалуйста уменьшите длину запроса");
    return;
  }

  setLoading(true);
  hideErrorHint();
  showStatus("⏳ Загружаем фото…");
  const startedAt = Date.now();

  try {
    const uploadUrl = await uploadPhoto(photo.file);
    showStatus("⏳ Запускаем обработку…");

    const { generation_id } = await startGeneration(uploadUrl, prompt);
    await currentOnGenerationStarted?.().catch(() => undefined);
    showStatus("⏳ Обрабатываем фото… (это занимает до 3 минут)");

    const generation = await pollGeneration(generation_id);
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);

    hideStatus();
    notifications.success("Фото обработано!");
    navigate("results", {
      generationId: generation_id,
      resultUrl: generation.resultUrl,
      sourceUrl: generation.sourceUrl,
      prompt,
      originalDataUrl: photo.dataUrl,
      elapsedSeconds,
    });
  } catch (err: unknown) {
    if (err instanceof GenerationFailedError && err.earlyFail && attempt === 0) {
      showStatus("⏳ Сервер занят, автоматически повторяем попытку…");
      await sleep(1000);
      await handleGenerate(navigate, attempt + 1);
      return;
    }
    if (err instanceof GenerationFailedError) {
      notifications.error(
        err.earlyFail
          ? "Сервер сейчас перегружен. Генерация не списана. Пожалуйста, нажмите «Обработать фото» ещё раз через несколько секунд."
          : "Обработка завершилась с ошибкой, генерация не списана. Попробуйте нажать «Обработать фото» ещё раз.",
      );
    } else {
      const msg = err instanceof Error ? err.message : "Неизвестная ошибка";
      notifications.error(`Ошибка: ${msg}`);
    }
    showErrorHint();
    hideStatus();
  } finally {
    setLoading(false);
  }
}

async function pollGeneration(id: number): Promise<{ resultUrl: string; sourceUrl?: string }> {
  const pollStartedAt = Date.now();
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const { status, result_url, source_url } = await getGenerationStatus(id);
    if (status === "completed" && result_url) {
      return { resultUrl: result_url, sourceUrl: source_url ?? undefined };
    }
    if (status === "failed") {
      throw new GenerationFailedError(Date.now() - pollStartedAt < EARLY_FAIL_THRESHOLD_MS);
    }
  }
  throw new Error("Превышено время ожидания (3 минуты)");
}

function setLoading(on: boolean): void {
  const btn = document.getElementById("generate-btn") as HTMLButtonElement | null;
  const spinner = document.getElementById("btn-spinner");
  const label = document.getElementById("btn-label");
  if (btn) btn.disabled = on || !hasPhoto;
  if (spinner) spinner.style.display = on ? "inline-block" : "none";
  if (label) label.textContent = on ? "Идет обработка" : "Обработать фото";
}

function showStatus(text: string): void {
  const el = document.getElementById("status-message");
  if (el) { el.textContent = text; el.style.display = "block"; }
}

function hideStatus(): void {
  const el = document.getElementById("status-message");
  if (el) el.style.display = "none";
}

function showErrorHint(): void {
  const el = document.getElementById("generation-error-hint");
  if (el) el.style.display = "block";
}

function hideErrorHint(): void {
  const el = document.getElementById("generation-error-hint");
  if (el) el.style.display = "none";
}

function enableInvertPreview(): void {
  invertPreviewActive = true;
  document.getElementById("upload-preview")?.classList.add("engraving-preview");
}

function disableInvertPreview(): void {
  invertPreviewActive = false;
  document.getElementById("upload-preview")?.classList.remove("engraving-preview");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
