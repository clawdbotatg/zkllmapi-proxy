import { API_URL } from "./config.js";
import type { ReadyProof } from "./prove.js";

export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export async function callZkApi(
  proof: ReadyProof,
  messages: OpenAIMessage[],
  stream: boolean,
  options?: {
    model?: string;
    // E2EE: if set, messages have been pre-encrypted — send encrypted_messages instead
    encryptedMessages?: string;
    e2eeHeaders?: Record<string, string>;
  }
): Promise<Response> {
  const body: Record<string, any> = {
    proof: proof.proofHex,
    publicInputs: proof.publicInputs,
    nullifier_hash: proof.nullifierHashHex,
    root: proof.rootHex,
    depth: proof.depth,
    stream,
  };

  if (options?.model) body.model = options.model;

  if (options?.encryptedMessages) {
    // E2EE mode: server will forward this blob + headers to Venice blind
    body.encrypted_messages = options.encryptedMessages;
    body.messages = []; // empty — server must not try to read them
  } else {
    body.messages = messages;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options?.e2eeHeaders) {
    Object.assign(headers, options.e2eeHeaders);
  }

  return fetch(`${API_URL}/v1/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export function buildOpenAIResponse(veniceData: any, model: string): object {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: veniceData.choices?.[0]?.message?.content ?? "",
      },
      finish_reason: veniceData.choices?.[0]?.finish_reason ?? "stop",
    }],
    usage: veniceData.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export async function streamResponse(
  veniceResponse: Response,
  res: import("express").Response,
  model: string
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const contentType = veniceResponse.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    const reader = veniceResponse.body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } else {
    const data = await veniceResponse.json();
    const content = data.choices?.[0]?.message?.content ?? "";

    const chunk = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: { role: "assistant" as const, content },
        finish_reason: null,
      }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);

    const doneChunk = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" as const }] };
    res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
}
