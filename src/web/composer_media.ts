/** Composer 附图：类型校验、base64 编码、附件 URL。 */
import { apiUrl, getAccessToken } from "./connection";
import { MULTIMODAL_MAX_BYTES, MULTIMODAL_MIME, type PendingAttachment } from "./types";

export function isSupportedComposerImage(file: File): boolean {
  return MULTIMODAL_MIME.has(file.type.toLowerCase());
}

export async function fileToPendingAttachment(file: File): Promise<PendingAttachment> {
  if (!isSupportedComposerImage(file)) throw new Error(`不支持的图片类型：${file.type || file.name}`);
  if (file.size > MULTIMODAL_MAX_BYTES) throw new Error("单张图片不能超过 4MB");
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return {
    localId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || "image.png",
    mimeType: file.type === "image/jpg" ? "image/jpeg" : file.type,
    size: file.size,
    dataBase64: btoa(binary),
    previewUrl: URL.createObjectURL(file),
  };
}

export function attachmentImageUrl(sessionId: string, attachmentId: string): string {
  const token = getAccessToken() || "";
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return apiUrl(`/api/session/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}${query}`);
}
