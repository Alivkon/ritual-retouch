import { notifications } from "./notifications.js";

export interface UploadedPhoto {
  file: File;
  dataUrl: string;
}

type ChangeCallback = (photo: UploadedPhoto | null) => void;

export class PhotoUploader {
  private photo: UploadedPhoto | null = null;
  private onChange: ChangeCallback = () => undefined;

  init(onChange: ChangeCallback): void {
    this.onChange = onChange;
    const input = document.getElementById("photo-input") as HTMLInputElement | null;
    const zone = document.getElementById("upload-zone");

    input?.addEventListener("change", () => {
      if (input.files) this.handleFiles(input.files);
    });

    zone?.addEventListener("click", () => input?.click());

    document.getElementById("clear-photo")?.addEventListener("click", () => this.clear());

    zone?.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    });
    zone?.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone?.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
      const dt = (e as DragEvent).dataTransfer;
      if (dt?.files) this.handleFiles(dt.files);
    });
  }

  private handleFiles(files: FileList): void {
    const file = files[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      notifications.error("Пожалуйста, выберите изображение");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      notifications.error("Размер файла не должен превышать 10MB");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      this.photo = { file, dataUrl };
      this.showPreview(dataUrl);
      this.onChange(this.photo);
    };
    reader.readAsDataURL(file);
  }

  private showPreview(src: string): void {
    const img = document.getElementById("preview-image") as HTMLImageElement | null;
    if (img) img.src = src;
    const placeholder = document.getElementById("upload-placeholder");
    if (placeholder) placeholder.style.display = "none";
    const preview = document.getElementById("upload-preview");
    if (preview) preview.style.display = "flex";
  }

  clear(): void {
    this.photo = null;
    const input = document.getElementById("photo-input") as HTMLInputElement | null;
    if (input) input.value = "";
    const placeholder = document.getElementById("upload-placeholder");
    if (placeholder) placeholder.style.display = "block";
    const preview = document.getElementById("upload-preview");
    if (preview) preview.style.display = "none";
    this.onChange(null);
  }

  getPhoto(): UploadedPhoto | null {
    return this.photo;
  }
}
