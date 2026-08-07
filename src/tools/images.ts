import { modelFetch, modelRequestOptions } from "../model_fetch.js";
import { ProviderError, isProviderError } from "../provider_error.js";
import { ToolDependencyError } from "../tool_failure.js";
import type { ModelConfig } from "../types.js";
import type { ToolHandlerArgs } from "./types.js";

type ImageGenerationResponse = {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: { message?: string };
};

const IMAGE_SIZES = new Set(["auto", "1024x1024", "1536x1024", "1024x1536"]);
const IMAGE_QUALITIES = new Set(["auto", "low", "medium", "high"]);
const IMAGE_REFERENCE_MAX_ATTACHMENTS = 4;

class NonRetryableImageRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableImageRequestError";
  }
}

function imageEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/images/generations`;
}

function imageEditEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/images/edits`;
}

function imageMime(response: Response): string {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType && contentType.startsWith("image/") ? contentType : "image/png";
}

function imageErrorMessage(body: ImageGenerationResponse, status: number): string {
  const message = body.error?.message?.trim();
  return message || `生图请求失败（HTTP ${status}）`;
}

function parseImageResponse(text: string): ImageGenerationResponse {
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as ImageGenerationResponse;
  } catch { /* non-JSON error bodies are handled by status text */ }
  return {};
}

async function postImageGeneration(
  model: ModelConfig,
  endpoint: string,
  body: BodyInit,
  signal: AbortSignal | undefined,
): Promise<ImageGenerationResponse> {
  try {
    // 429/5xx/network retries are handled by modelFetch transport.
    const response = await modelFetch(endpoint, {
      method: "POST",
      headers: {
        ...(typeof body === "string" ? { "content-type": "application/json" } : {}),
        ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
      },
      body,
      signal,
    }, modelRequestOptions(model, { priority: "low" }));
    const responseText = await response.text();
    const parsed = parseImageResponse(responseText);
    if (response.ok) return parsed;
    const message = imageErrorMessage(parsed, response.status);
    if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404 || response.status === 422) {
      throw new NonRetryableImageRequestError(message);
    }
    throw new ProviderError(
      response.status === 429 ? "PROVIDER_RATE_LIMIT" : "PROVIDER_UNAVAILABLE",
      message,
      { httpStatus: response.status, retryable: true },
    );
  } catch (error) {
    if (error instanceof NonRetryableImageRequestError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (isProviderError(error) && error.code === "PROVIDER_AUTH") {
      throw new NonRetryableImageRequestError(error.message);
    }
    const message = error instanceof Error ? error.message : String(error || "生图服务未返回结果");
    throw new ToolDependencyError(
      "IMAGE_PROVIDER_UNAVAILABLE",
      `${message}；生图请求经供应商传输层重试后仍未成功。`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

type ReferenceImage = { id: string; mimeType: string; bytes: Buffer };

function resolveReferenceImages(
  value: unknown,
  store: ToolHandlerArgs["store"],
  sessionId: string,
): { references: ReferenceImage[]; error?: string } {
  if (value === undefined) return { references: [] };
  if (!Array.isArray(value)) return { references: [], error: "参考图必须是附件 ID 数组" };
  if (value.length > IMAGE_REFERENCE_MAX_ATTACHMENTS) {
    return { references: [], error: `单次最多使用 ${IMAGE_REFERENCE_MAX_ATTACHMENTS} 张参考图` };
  }
  const ids = [...new Set(value
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map(id => id.trim()))];
  if (!ids.length || ids.length !== value.length) {
    return { references: [], error: "参考图必须是非空、无重复的附件 ID" };
  }
  const references: ReferenceImage[] = [];
  for (const id of ids) {
    const resolved = store.resolveAttachmentBytes(sessionId, id);
    if (!resolved) return { references: [], error: `参考图不可用或不属于当前会话：${id}` };
    references.push({ id, ...resolved });
  }
  return { references };
}

function imageRequestForm(
  model: ModelConfig,
  prompt: string,
  size: string,
  quality: string,
  references: readonly ReferenceImage[],
): FormData {
  const form = new FormData();
  form.set("model", model.model);
  form.set("prompt", prompt);
  form.set("size", size);
  form.set("quality", quality);
  form.set("output_format", "png");
  form.set("n", "1");
  for (const reference of references) {
    const bytes = new Uint8Array(reference.bytes.byteLength);
    bytes.set(reference.bytes);
    form.append(
      "image[]",
      new Blob([bytes], { type: reference.mimeType }),
      `reference-${reference.id}.${reference.mimeType.split("/")[1] || "png"}`,
    );
  }
  return form;
}

function readDataImageUrl(url: string): { bytes: Buffer; mimeType: string } | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(url.trim());
  if (!match) return undefined;
  const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!bytes.length) throw new Error("生图模型返回了无效 data URL");
  return { bytes, mimeType: match[1].toLowerCase() };
}

async function readGeneratedImage(
  model: ModelConfig,
  result: NonNullable<ImageGenerationResponse["data"]>[number],
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (result.b64_json) {
    const bytes = Buffer.from(result.b64_json.replace(/\s+/g, ""), "base64");
    if (!bytes.length) throw new Error("生图模型返回了无效 base64");
    return { bytes, mimeType: "image/png" };
  }
  if (!result.url) throw new Error("生图模型响应缺少 b64_json 或 url");
  const dataUrl = readDataImageUrl(result.url);
  if (dataUrl) return dataUrl;
  const url = new URL(result.url, `${model.baseUrl.replace(/\/+$/, "")}/`);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("生图模型返回了不安全的图片 URL");
  const response = await modelFetch(url, { method: "GET", signal }, modelRequestOptions(model, { priority: "low" }));
  if (!response.ok) throw new Error(`下载生成图片失败（HTTP ${response.status}）`);
  return { bytes: Buffer.from(await response.arrayBuffer()), mimeType: imageMime(response) };
}

export async function handleGenerateImage({ input, store, sessionId, context }: ToolHandlerArgs): Promise<string> {
  if (context.permissionMode === "plan") {
    return JSON.stringify({ code: "PERMISSION_DENIED", error: "规划模式不执行生图调用" });
  }
  const generator = context.imageGenerator;
  if (!generator) return JSON.stringify({ code: "IMAGE_MODEL_NOT_CONFIGURED", error: "未配置生图模型" });
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) return JSON.stringify({ code: "INVALID_IMAGE_PROMPT", error: "生图提示词不能为空" });
  if (prompt.length > 32_000) return JSON.stringify({ code: "IMAGE_PROMPT_TOO_LONG", error: "生图提示词不能超过 32000 字符" });
  const referenceInput = resolveReferenceImages(input.referenceAttachmentIds, store, sessionId);
  if (referenceInput.error) return JSON.stringify({ code: "INVALID_IMAGE_REFERENCE", error: referenceInput.error });
  const references = referenceInput.references;
  const size = typeof input.size === "string" && IMAGE_SIZES.has(input.size) ? input.size : "auto";
  const quality = typeof input.quality === "string" && IMAGE_QUALITIES.has(input.quality) ? input.quality : "auto";
  const model = generator.model;
  if (!model.apiKey && !model.baseUrl.includes("localhost") && !model.baseUrl.includes("127.0.0.1")) {
    return JSON.stringify({ code: "IMAGE_API_KEY_MISSING", error: "生图模型未配置 API Key" });
  }
  const body = await postImageGeneration(
    model,
    references.length
      ? imageEditEndpoint(model.baseUrl)
      : imageEndpoint(model.baseUrl),
    references.length
      ? imageRequestForm(model, prompt, size, quality, references)
      : JSON.stringify({ model: model.model, prompt, size, quality, output_format: "png", n: 1 }),
    generator.signal,
  );
  const item = body.data?.[0];
  if (!item) throw new Error("生图模型没有返回图片");
  const image = await readGeneratedImage(model, item, generator.signal);
  const attachment = store.saveGeneratedImageAttachment(sessionId, {
    name: typeof input.name === "string" ? input.name : undefined,
    ...image,
    imageGeneration: {
      finalPrompt: prompt,
      ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
      ...(references.length ? { referenceAttachmentIds: references.map(reference => reference.id) } : {}),
    },
  });
  (context.generatedAttachments ??= []).push(attachment);
  return JSON.stringify({
    status: "generated",
    attachmentId: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    finalPrompt: prompt,
    ...(references.length ? { referenceAttachmentIds: references.map(reference => reference.id) } : {}),
    ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
  });
}
