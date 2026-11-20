/**
 * 线上工具名改名（wire rename）：只对配置里列出的上游 host 生效。
 *
 * 背景（2026-11-05 实测）：heihei 中转上的 claude-opus-5-5 碰到名字恰好叫 `web_search`
 * 的工具，回来的 tool_call 参数恒为 `{}`；同一 schema 换个名字（如 `search_web`）就正常。
 * 所以出网前把请求里的工具名换成别名，响应回来再换回原名。DSH 内部、会话历史、
 * 提示词都保持原名，只有线上那一段看到别名。
 *
 * 只改 JSON 里键名为 `name`、值恰好等于映射表里某个名字的字符串，覆盖：
 *   请求：tools[].function.name、历史 assistant tool_calls[].function.name、
 *         tool_choice.function.name、tool 消息的 name；
 *   响应：SSE `data:` 行里的 delta.tool_calls[].function.name，以及非流式
 *         message.tool_calls[].function.name。
 * 请求里的 tools 本身不含原名、或已经有同名别名（会撞名）时，整条请求原样放行。
 */

const DEFAULT_NAMES = Object.freeze({ web_search: "search_web" });

/**
 * 归一化 `wireRename` 配置段。hosts 为空即整体关闭（默认关闭）。
 * @param raw - profile 里的 `wireRename` 段：`{ enabled?, hosts: string[], names?: Record<string, string> }`。
 * @returns {{ enabled: boolean, hosts: string[], names: Record<string, string> }}
 */
export function resolveWireRename(raw) {
  const hosts = Array.isArray(raw?.hosts)
    ? raw.hosts.filter(host => typeof host === "string" && host.length > 0).map(host => host.toLowerCase())
    : [];
  const source = raw?.names !== null && typeof raw?.names === "object" ? raw.names : DEFAULT_NAMES;
  const names = {};
  for (const [native, wire] of Object.entries(source)) {
    if (typeof wire === "string" && wire.length > 0 && wire !== native) names[native] = wire;
  }
  const enabled = raw?.enabled !== false && hosts.length > 0 && Object.keys(names).length > 0;
  return { enabled, hosts, names };
}

/** URL 的 hostname 是否等于某个配置 host，或是它的子域。 */
export function hostMatches(url, hosts) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return hosts.some(entry => host === entry || host.endsWith(`.${entry}`));
}

/**
 * 原地把对象树里 `name: <表中的名字>` 换成映射值。
 * @returns 是否改动过。
 */
export function renameKeyedNames(node, table) {
  let changed = false;
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) if (item !== null && typeof item === "object") visit(item);
      return;
    }
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (key === "name" && typeof child === "string" && Object.hasOwn(table, child)) {
        value[key] = table[child];
        changed = true;
      } else if (child !== null && typeof child === "object") {
        visit(child);
      }
    }
  };
  if (node !== null && typeof node === "object") visit(node);
  return changed;
}

/** 请求体 tools 里声明的工具名（兼容 `{function:{name}}` 与扁平 `{name}`）。 */
function declaredToolNames(body) {
  const names = new Set();
  if (!Array.isArray(body?.tools)) return names;
  for (const tool of body.tools) {
    const name = tool?.function?.name ?? tool?.name;
    if (typeof name === "string") names.add(name);
  }
  return names;
}

/**
 * 改写请求体文本。
 * @param text - 请求体 JSON 文本。
 * @param names - 原名 → 线上名。
 * @returns 无需改动时 `undefined`；否则 `{ text, forward }`，forward 是本次实际生效的映射。
 */
export function renameRequestBody(text, names) {
  if (typeof text !== "string" || text.length === 0) return undefined;
  if (!Object.keys(names).some(name => text.includes(`"${name}"`))) return undefined;
  let body;
  try { body = JSON.parse(text); } catch { return undefined; }
  const declared = declaredToolNames(body);
  const forward = {};
  for (const [native, wire] of Object.entries(names)) {
    if (declared.has(native) && !declared.has(wire)) forward[native] = wire;
  }
  if (Object.keys(forward).length === 0) return undefined;
  renameKeyedNames(body, forward);
  return { text: JSON.stringify(body), forward };
}

/** 映射表取反：线上名 → 原名。 */
export function invert(table) {
  return Object.fromEntries(Object.entries(table).map(([native, wire]) => [wire, native]));
}

/** 去掉 content-length：请求体长度变了，交给运行时重算。 */
function withoutLength(headers) {
  if (headers === undefined || headers === null) return headers;
  if (typeof headers.get === "function") {
    const next = new Headers(headers);
    next.delete("content-length");
    return next;
  }
  if (Array.isArray(headers)) return headers.filter(([key]) => String(key).toLowerCase() !== "content-length");
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-length"));
}

/**
 * 用新的请求体重建 fetch 参数。体在 `init.body` 时换 init；体挂在 `Request` 上时重建 Request。
 * @returns 重建后的 `{ input, init }`；看不懂这种形态时 `undefined`（调用方原样放行）。
 */
export function rebuildRequest(input, init, text) {
  if (init?.body !== undefined && init?.body !== null) {
    const headers = withoutLength(init.headers);
    return { input, init: { ...init, body: text, ...(headers === undefined ? {} : { headers }) } };
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return { input: new Request(input, { body: text, headers: withoutLength(input.headers) }), init };
  }
  return undefined;
}

/** 非流式 JSON 响应：含线上名才解析改写，否则原文返回。 */
export function restoreJsonText(text, reverse) {
  if (!Object.keys(reverse).some(name => text.includes(`"${name}"`))) return text;
  try {
    const body = JSON.parse(text);
    return renameKeyedNames(body, reverse) ? JSON.stringify(body) : text;
  } catch {
    return text;
  }
}

/**
 * SSE 还原流：按行缓冲（工具名可能被网络分包切开），只改含线上名的 `data:` 行，
 * 其余字节原样透传。
 */
export function sseRestorer(reverse) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const needles = Object.keys(reverse).map(name => `"${name}"`);
  let carry = "";
  const fixLine = (line) => {
    if (!line.startsWith("data:") || !needles.some(needle => line.includes(needle))) return line;
    const cr = line.endsWith("\r") ? "\r" : "";
    try {
      const payload = JSON.parse(line.slice(5));
      if (!renameKeyedNames(payload, reverse)) return line;
      return `data: ${JSON.stringify(payload)}${cr}`;
    } catch {
      return line;
    }
  };
  const fixBlock = block => block.split("\n").map(fixLine).join("\n");
  return new TransformStream({
    transform(chunk, controller) {
      carry += decoder.decode(chunk, { stream: true });
      const cut = carry.lastIndexOf("\n");
      if (cut < 0) return;
      const ready = carry.slice(0, cut + 1);
      carry = carry.slice(cut + 1);
      controller.enqueue(encoder.encode(fixBlock(ready)));
    },
    flush(controller) {
      carry += decoder.decode();
      if (carry.length > 0) controller.enqueue(encoder.encode(fixBlock(carry)));
    },
  });
}

/**
 * 把响应里的线上名换回原名。永不抛：出任何问题都返回原响应。
 * @param response - 上游响应。
 * @param reverse - 线上名 → 原名。
 * @returns 还原后的响应（SSE 为流式改写，不额外缓冲整段）。
 */
export async function restoreResponse(response, reverse) {
  try {
    if (!(response instanceof Response) || response.body === null) return response;
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    const isStream = type.includes("text/event-stream");
    if (!isStream && !type.includes("json")) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    const init = { status: response.status, statusText: response.statusText, headers };
    const next = isStream
      ? new Response(response.body.pipeThrough(sseRestorer(reverse)), init)
      : new Response(restoreJsonText(await response.text(), reverse), init);
    try { Object.defineProperty(next, "url", { value: response.url }); } catch { /* 只读也无妨 */ }
    return next;
  } catch {
    return response;
  }
}
