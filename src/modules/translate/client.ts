/**
 * OpenAI-compatible chat client.
 *
 * Uses `Zotero.HTTP.request`, which is a privileged XHR: there is no domain
 * allowlist and the same-origin policy does not apply, so any endpoint the user
 * configures can be reached. Three of its defaults are wrong for batch
 * translation and are overridden here: the content type, the 5xx retry ceiling
 * (one hour by default), and the timeout.
 */

import { joinURL } from "./providers";
import type { ProviderProfile } from "../../utils/prefs";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  profile: ProviderProfile;
  messages: ChatMessage[];
  /** Ask the endpoint for a JSON object response when it supports it. */
  jsonMode?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  content: string;
  /** Token usage when the endpoint reports it. */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

/** Raised for a non-2xx reply, carrying enough detail to be actionable. */
export class ApiError extends Error {
  public readonly status: number;
  public readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Send one chat completion request.
 *
 * @param request - profile, messages and transport options.
 * @returns the assistant message and any usage the endpoint reported.
 * @throws {ApiError} when the endpoint answers with a non-2xx status.
 */
export async function complete(request: CompletionRequest): Promise<CompletionResult> {
  const { profile, messages, jsonMode, timeoutMs = 120_000, signal } = request;
  if (!profile.baseURL) {
    throw new Error("No base URL configured. Open the plugin settings first.");
  }
  if (!profile.model) {
    throw new Error("No model configured. Open the plugin settings first.");
  }

  const headers: Record<string, string> = {
    // Zotero.HTTP.request defaults to form-urlencoded, which most LLM
    // endpoints reject outright.
    "Content-Type": "application/json",
    ...(profile.extraHeaders ?? {}),
  };
  if (profile.apiKey) {
    headers.Authorization = `Bearer ${profile.apiKey}`;
  }

  const payload: Record<string, unknown> = {
    model: profile.model,
    messages,
    temperature: profile.temperature ?? 0.2,
    ...(profile.maxTokens ? { max_tokens: profile.maxTokens } : {}),
    ...(profile.extraBody ?? {}),
  };
  if (jsonMode && profile.jsonMode !== false) {
    payload.response_format = { type: "json_object" };
  }

  const url = joinURL(profile.baseURL, "/chat/completions");
  let xhr: XMLHttpRequest;
  try {
    xhr = await Zotero.HTTP.request("POST", url, {
      body: JSON.stringify(payload),
      headers,
      responseType: "text",
      // Allow every status through so the error body can be surfaced instead of
      // being swallowed by the default rejection.
      successCodes: false,
      timeout: timeoutMs,
      // The default retries 5xx for up to an hour; batch translation must stay
      // responsive, so retries are handled by the caller.
      errorDelayMax: 0,
      ...(signal
        ? {
            cancellerReceiver: (cancel: () => void) => {
              signal.addEventListener("abort", cancel, { once: true });
            },
          }
        : {}),
    });
  } catch (error) {
    throw new Error(
      `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = typeof xhr.response === "string" ? xhr.response : xhr.responseText;
  const body = text ?? "";
  if (xhr.status < 200 || xhr.status >= 300) {
    throw new ApiError(
      xhr.status,
      body,
      `The service replied ${xhr.status}. ${summarizeError(body)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ApiError(xhr.status, body, "The service did not return JSON.");
  }
  return readCompletion(parsed);
}

/** Pull the assistant text out of an OpenAI-shaped response. */
function readCompletion(payload: unknown): CompletionResult {
  const data = payload as {
    choices?: Array<{
      message?: { content?: string | Array<{ type?: string; text?: string }> };
      text?: string;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    error?: { message?: string };
  };
  if (data?.error?.message) {
    throw new Error(`The service reported an error: ${data.error.message}`);
  }
  const choice = data?.choices?.[0];
  const raw = choice?.message?.content ?? choice?.text;
  let content = "";
  if (typeof raw === "string") {
    content = raw;
  } else if (Array.isArray(raw)) {
    content = raw
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  if (!content) {
    throw new Error("The service returned an empty completion.");
  }
  return {
    content,
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined,
  };
}

/** Extract a short, human-readable reason from an error body. */
function summarizeError(body: string | undefined): string {
  if (!body) {
    return "";
  }
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    const message = parsed.error?.message ?? parsed.message;
    if (message) {
      return message;
    }
  } catch {
    // Not JSON; fall through to the raw excerpt.
  }
  return body.slice(0, 300);
}

/**
 * Verify that a profile can actually complete a request.
 *
 * @param profile - profile to test.
 * @returns a short human-readable outcome.
 */
export async function testConnection(profile: ProviderProfile): Promise<string> {
  const started = Date.now();
  const result = await complete({
    profile,
    messages: [
      { role: "system", content: "Reply with the single word: ok" },
      { role: "user", content: "ping" },
    ],
    timeoutMs: 30_000,
  });
  const elapsed = Date.now() - started;
  return `Connected in ${elapsed} ms. Model replied: ${result.content.trim().slice(0, 60)}`;
}
