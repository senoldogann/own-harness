const PLACEHOLDER_API_KEY = "harness-local"

export function chatToResponsesBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null) {
    return body
  }
  const record = asRecord(body)
  const result: Record<string, unknown> = {
    model: record.model,
    input: toResponsesInput(record.messages),
    stream: record.stream === true
  }
  copyNumber(record, result, "temperature")
  copyNumber(record, result, "top_p")
  copyNumber(record, result, "frequency_penalty")
  copyNumber(record, result, "presence_penalty")
  copyNumber(record, result, "max_tokens", "max_output_tokens")
  copyValue(record, result, "stop")
  copyValue(record, result, "user")
  if (Array.isArray(record.tools)) {
    result.tools = record.tools.map(toResponsesTool)
  }
  copyValue(record, result, "tool_choice")
  return result
}

export function responsesToChatCompletions(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined
  }
  const record = asRecord(body)
  const output = Array.isArray(record.output) ? record.output : []
  const content = output.map(responseOutputText).filter((text) => text.length > 0).join("")
  const usage = toChatUsage(record.usage)
  return JSON.stringify({
    id: typeof record.id === "string" ? record.id : "chatcmpl-translated",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof record.model === "string" ? record.model : "",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content
        },
        finish_reason: "stop"
      }
    ],
    ...(usage === undefined ? {} : { usage })
  })
}

export function translateSseLine(line: string, model: string): string {
  const trimmed = line.trim()
  if (!trimmed.startsWith("data:")) {
    return line
  }
  const payload = trimmed.slice(5).trim()
  if (payload === "[DONE]" || payload.length === 0) {
    return line
  }
  const parsed = parseJsonObject(payload)
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return line
  }
  const event = asRecord(parsed)
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
    return sseJson(chatDeltaChunk(model, event.delta))
  }
  if (event.type === "response.completed") {
    const usage = toChatUsage(event.usage) ?? toChatUsage(asRecord(event.response).usage)
    return `${sseJson(chatFinalChunk(model, usage))}\n\ndata: [DONE]`
  }
  if (event.type === "response.failed") {
    return `${sseJson(chatFinalChunk(model, undefined))}\n\ndata: [DONE]`
  }
  return ""
}

export function translateSseBlock(block: string, model: string): string {
  return block.split("\n").map((line) => translateSseLine(line, model)).join("\n")
}

export function isPlaceholderApiKey(value: string | undefined): boolean {
  return value === PLACEHOLDER_API_KEY
}

function toResponsesInput(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return messages
  }
  return messages.map((message) => {
    if (typeof message !== "object" || message === null) {
      return message
    }
    const record = asRecord(message)
    return {
      role: typeof record.role === "string" ? record.role : "user",
      content: messageContentText(record.content)
    }
  })
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") {
    return content
  }
  if (Array.isArray(content)) {
    const text = content
      .filter((part): part is Record<string, unknown> =>
        typeof part === "object" && part !== null
      )
      .map((part) => asRecord(part).text)
      .filter((value): value is string => typeof value === "string")
      .join("")
    if (text.length > 0) {
      return text
    }
  }
  return JSON.stringify(content)
}

function toResponsesTool(tool: unknown): unknown {
  if (typeof tool !== "object" || tool === null) {
    return tool
  }
  const record = asRecord(tool)
  if (record.type !== "function") {
    return tool
  }
  const fn = typeof record.function === "object" && record.function !== null
    ? asRecord(record.function)
    : {}
  return {
    type: "function",
    name: typeof fn.name === "string" ? fn.name : "",
    description: typeof fn.description === "string" ? fn.description : undefined,
    parameters: fn.parameters
  }
}

function responseOutputText(item: unknown): string {
  if (typeof item !== "object" || item === null) {
    return ""
  }
  const record = asRecord(item)
  if (typeof record.text === "string") {
    return record.text
  }
  if (Array.isArray(record.content)) {
    return record.content
      .filter((part): part is Record<string, unknown> =>
        typeof part === "object" && part !== null
      )
      .map((part) => asRecord(part).text)
      .filter((value): value is string => typeof value === "string")
      .join("")
  }
  if (typeof record.content === "string") {
    return record.content
  }
  return ""
}

function toChatUsage(value: unknown): {
  readonly prompt_tokens: number
  readonly completion_tokens: number
  readonly total_tokens: number
} | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined
  }
  const record = asRecord(value)
  const input = nonnegativeInteger(record.input_tokens)
  const output = nonnegativeInteger(record.output_tokens)
  if (input === 0 && output === 0) {
    return undefined
  }
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output
  }
}

function chatDeltaChunk(model: string, content: string): Record<string, unknown> {
  return {
    id: "chatcmpl-translated",
    object: "chat.completion.chunk",
    model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null
      }
    ]
  }
}

function chatFinalChunk(model: string, usage: ReturnType<typeof toChatUsage>): Record<string, unknown> {
  return {
    id: "chatcmpl-translated",
    object: "chat.completion.chunk",
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop"
      }
    ],
    ...(usage === undefined ? {} : { usage })
  }
}

function sseJson(value: unknown): string {
  return `data: ${JSON.stringify(value)}`
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

function copyNumber(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  targetKey = key
): void {
  if (typeof source[key] === "number") {
    target[targetKey] = source[key]
  }
}

function copyValue(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string
): void {
  if (source[key] !== undefined) {
    target[key] = source[key]
  }
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
}
