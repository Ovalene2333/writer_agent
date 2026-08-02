import { modelFetch } from "../model_fetch.js";
import type { ModelConfig } from "../types.js";
import type { ToolHandlerArgs } from "./types.js";

type ImageGenerationResponse = {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: { message?: string };
};

const IMAGE_SIZES = new Set(["auto", "1024x1024", "1536x1024", "1024x1536"]);
const IMAGE_QUALITIES = new Set(["auto", "low", "medium", "high"]);

function imageEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/images/generations`;
}

function imageMime(response: Response): string {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType && contentType.startsWith("image/") ? contentType : "image/png";
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
  const url = new URL(result.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("生图模型返回了不安全的图片 URL");
  const response = await modelFetch(url, { method: "GET", signal }, model.proxyUrl);
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
  const size = typeof input.size === "string" && IMAGE_SIZES.has(input.size) ? input.size : "auto";
  const quality = typeof input.quality === "string" && IMAGE_QUALITIES.has(input.quality) ? input.quality : "auto";
  const model = generator.model;
  if (!model.apiKey && !model.baseUrl.includes("localhost") && !model.baseUrl.includes("127.0.0.1")) {
    return JSON.stringify({ code: "IMAGE_API_KEY_MISSING", error: "生图模型未配置 API Key" });
  }
  const response = await modelFetch(imageEndpoint(model.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: model.model, prompt, size, quality, output_format: "png", n: 1 }),
    signal: generator.signal,
  }, model.proxyUrl);
  const body = await response.json().catch(() => ({})) as ImageGenerationResponse;
  if (!response.ok) {
    throw new Error(body.error?.message?.trim() || `生图请求失败（HTTP ${response.status}）`);
  }
  const item = body.data?.[0];
  if (!item) throw new Error("生图模型没有返回图片");
  const image = await readGeneratedImage(model, item, generator.signal);
  const attachment = store.saveGeneratedImageAttachment(sessionId, {
    name: typeof input.name === "string" ? input.name : undefined,
    ...image,
  });
  (context.generatedAttachments ??= []).push(attachment);
  return JSON.stringify({
    status: "generated",
    attachmentId: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
  });
}
