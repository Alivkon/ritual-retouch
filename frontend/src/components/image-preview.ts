let initialized = false;
let overlay: HTMLElement | null = null;
let image: HTMLImageElement | null = null;
let closeButton: HTMLButtonElement | null = null;
let previousFocus: HTMLElement | null = null;
let previousOverflow = "";

function ensurePreview(): void {
  if (initialized) return;
  initialized = true;
  overlay = document.createElement("div");
  overlay.className = "image-preview";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.display = "none";
  overlay.innerHTML = `
    <button class="image-preview-close" type="button" aria-label="Закрыть">x</button>
    <div class="image-preview-frame" role="dialog" aria-modal="true">
      <img class="image-preview-img" alt="">
      <div class="image-preview-error" style="display:none">Ссылка на изображение устарела. Обновите галерею.</div>
    </div>`;
  document.body.appendChild(overlay);
  image = overlay.querySelector(".image-preview-img");
  closeButton = overlay.querySelector(".image-preview-close");

  closeButton?.addEventListener("click", closeImagePreview);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeImagePreview();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && overlay?.classList.contains("active")) closeImagePreview();
  });
}

export function openImagePreview(src: string, alt = ""): void {
  ensurePreview();
  if (!overlay || !image) return;
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousOverflow = document.body.style.overflow;
  const error = overlay.querySelector<HTMLElement>(".image-preview-error");
  if (error) error.style.display = "none";
  image.style.display = "block";
  image.alt = alt;
  image.onerror = () => {
    image!.style.display = "none";
    if (error) error.style.display = "block";
  };
  image.onload = () => {
    if (error) error.style.display = "none";
    image!.style.display = "block";
  };
  image.src = src;
  overlay.style.display = "flex";
  overlay.classList.add("active");
  overlay.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  closeButton?.focus();
}

export function closeImagePreview(): void {
  if (!overlay) return;
  overlay.classList.remove("active");
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.display = "none";
  document.body.style.overflow = previousOverflow;
  if (image) {
    image.removeAttribute("src");
    image.onerror = null;
    image.onload = null;
  }
  previousFocus?.focus();
  previousFocus = null;
}
