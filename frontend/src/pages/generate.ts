import { PhotoUploader } from "../components/uploader.js";
import { notifications } from "../components/notifications.js";
import { uploadPhoto, startGeneration, getGenerationStatus, sleep, getToken } from "../api.js";

const ENHANCE_TEXT = `REMASTER AND UPSCALE. Priority: High-fidelity facial reconstruction. Maintain 100% identical facial structure, bone shape, and expression of the person in the source image. CRITICAL: Avoid all skin smoothing, airbrushing, or artificial blurring. Render hyper-realistic epidermal textures, including visible skin pores, fine natural lines, and subtle micro-details. Eyes must be crystal clear with sharp iris details and individual eyelashes. Hair must have distinct, sharp strands. Lighting: Professional studio key light. Technical specs: Shot on 85mm macro lens, f/2.8, ISO 100, 8k resolution, photorealistic masterpiece. `;

const GRANITE_TEXT = `A photo of a high-resolution laser engraving on a polished black granite slab. The texture must be rich and deep, with varying depths of engraving creating an intricate grayscale. The entire image should look like it's carven into stone. Re-render the subject with stippling and detailed hatching lines to create form and shadow, giving it an old-world, historical appearance like a classic etching. Ensure every detail of clothing, features, or elements is sharp and clear. The pose and key features must be preserved, but transformed into a classic engraved style. Single, directional light from the front, mimicking a strong candle flame, illuminating the engraved grooves and casting soft, detailed shadows. Fine-detail engraving, hyperrealistic stippling, etched, grayscale, black granite texture, memorial, commemorative, intricately detailed, no watermarks, classic art, laser etching.`;

export interface GenerationResult {
  generationId: number;
  resultUrl: string;
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
  engrave:       { field: "additional", text: "prepare for laser engraving, high contrast, подготовить под гравировку" },
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
  if (role !== "engraver") disableInvertPreview();
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
       + base;
}

function updateGenerateBtn(): void {
  const btn = document.getElementById("generate-btn") as HTMLButtonElement | null;
  if (!btn) return;
  const additional = (document.getElementById("field-additional") as HTMLTextAreaElement | null)?.value.trim() ?? "";
  btn.disabled = !hasPhoto || (additional.length === 0 && !enhanceActive && !graniteActive);
}

async function handleGenerate(navigate: Navigate): Promise<void> {
  const photo = uploader.getPhoto();
  if (!photo) { notifications.error("Пожалуйста, загрузите фото"); return; }

  if (!getToken()) {
    if (currentOnNeedAuth) currentOnNeedAuth(() => void handleGenerate(navigate));
    return;
  }

  const prompt = buildMergedPrompt();

  setLoading(true);
  showStatus("⏳ Загружаем фото…");
  const startedAt = Date.now();

  try {
    const uploadUrl = await uploadPhoto(photo.file);
    showStatus("⏳ Запускаем обработку…");

    const { generation_id } = await startGeneration(uploadUrl, prompt);
    await currentOnGenerationStarted?.().catch(() => undefined);
    showStatus("⏳ Обрабатываем фото… (это занимает до 3 минут)");

    const resultUrl = await pollGeneration(generation_id);
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);

    hideStatus();
    notifications.success("Фото обработано!");
    navigate("results", { generationId: generation_id, resultUrl, prompt, originalDataUrl: photo.dataUrl, elapsedSeconds });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Неизвестная ошибка";
    notifications.error(`Ошибка: ${msg}`);
    hideStatus();
  } finally {
    setLoading(false);
  }
}

async function pollGeneration(id: number): Promise<string> {
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const { status, result_url } = await getGenerationStatus(id);
    if (status === "completed" && result_url) return result_url;
    if (status === "failed") throw new Error("Обработка завершилась с ошибкой, деньги возвращены на счёт");
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
