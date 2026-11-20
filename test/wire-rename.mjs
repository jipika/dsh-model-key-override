/**
 * 线上工具名改名（wire-rename）回归测试。
 *
 * 覆盖：请求改名（tools / 历史 tool_calls / tool 消息 / tool_choice），正文与参数不动，
 * 未声明原名或撞名时不动；SSE 按 5 字节切块（含中文、工具名被切开）仍能还原；
 * 经拦截器的 Request 形态与字符串形态都生效，host 不匹配时原样放行。
 * 运行：MODEL_KEY_OVERRIDE_DIAG=/tmp/mko-wire-test.ndjson node test/wire-rename.mjs
 */
import { createServer } from "node:http";
import { installInterceptor, resolveConfig } from "../index.js";
import { renameRequestBody, resolveWireRename, restoreJsonText, sseRestorer } from "../wire-rename.js";

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};
const NAMES = { web_search: "search_web" };

// ── 配置归一化 ───────────────────────────────────────────────────────────────
check("默认关闭（没配 hosts）", resolveWireRename(undefined).enabled, false);
check("配了 hosts 即开启，默认映射 web_search→search_web",
  resolveWireRename({ hosts: ["Example.COM"] }),
  { enabled: true, hosts: ["example.com"], names: NAMES });
check("enabled:false 可显式关闭", resolveWireRename({ hosts: ["a.com"], enabled: false }).enabled, false);

// ── 请求改写 ─────────────────────────────────────────────────────────────────
const request = {
  model: "m",
  stream: true,
  messages: [
    { role: "user", content: "请用 web_search 搜一下" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{\"queries\":[\"a\"]}" } }] },
    { role: "tool", tool_call_id: "c1", name: "web_search", content: "结果" },
  ],
  tools: [
    { type: "function", function: { name: "web_search", description: "Search the web", parameters: { type: "object", properties: { queries: { type: "array", items: { type: "string" } } }, required: ["queries"] } } },
    { type: "function", function: { name: "read_page", parameters: { type: "object", properties: { url: { type: "string" } } } } },
  ],
  tool_choice: { type: "function", function: { name: "web_search" } },
};
const renamed = renameRequestBody(JSON.stringify(request), NAMES);
const sent = JSON.parse(renamed.text);
check("tools 里的 web_search 改成 search_web", sent.tools.map(tool => tool.function.name), ["search_web", "read_page"]);
check("历史 tool_calls 同步改名", sent.messages[1].tool_calls[0].function.name, "search_web");
check("tool 消息的 name 同步改名", sent.messages[2].name, "search_web");
check("tool_choice 同步改名", sent.tool_choice.function.name, "search_web");
check("用户正文不动", sent.messages[0].content, "请用 web_search 搜一下");
check("历史参数不动", sent.messages[1].tool_calls[0].function.arguments, "{\"queries\":[\"a\"]}");
check("forward 只含实际生效的映射", renamed.forward, NAMES);
check("没声明 web_search 工具的请求不动",
  renameRequestBody(JSON.stringify({ model: "m", messages: [{ role: "user", content: "web_search" }] }), NAMES), undefined);
check("已有同名别名（会撞名）时不动",
  renameRequestBody(JSON.stringify({ tools: [{ function: { name: "web_search" } }, { function: { name: "search_web" } }] }), NAMES), undefined);
check("非 JSON 体不动", renameRequestBody("\"web_search\" not json", NAMES), undefined);

// ── 响应还原 ─────────────────────────────────────────────────────────────────
const REVERSE = { search_web: "web_search" };
const sse = [
  "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"我来搜 search_web\"}}]}",
  "",
  "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c9\",\"type\":\"function\",\"function\":{\"name\":\"search_web\",\"arguments\":\"\"}}]}}]}",
  "",
  "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"queries\\\":[\\\"q\\\"]}\"}}]}}]}",
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

async function pipeInChunks(text, size) {
  const bytes = new TextEncoder().encode(text);
  const source = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
  return new Response(source.pipeThrough(sseRestorer(REVERSE))).text();
}
const restored = await pipeInChunks(sse, 5);
check("SSE 5 字节切块：工具名还原成 web_search", restored.includes("\"name\":\"web_search\""), true);
check("SSE 5 字节切块：不再残留 search_web 工具名", restored.includes("\"name\":\"search_web\""), false);
check("SSE：正文里的 search_web 字样不动（中文跨块也完整）", restored.includes("我来搜 search_web"), true);
check("SSE：参数行逐字节不变", restored.split("\n")[4], sse.split("\n")[4]);
check("SSE：[DONE] 与空行结构不变", restored.split("\n").length, sse.split("\n").length);
check("非流式 JSON 还原",
  JSON.parse(restoreJsonText(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "search_web", arguments: "{}" } }] } }] }), REVERSE))
    .choices[0].message.tool_calls[0].function.name,
  "web_search");

// ── 经拦截器的端到端（本地 mock 上游） ────────────────────────────────────────
const seen = [];
const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const parsed = JSON.parse(body);
    seen.push({
      tools: (parsed.tools ?? []).map(tool => tool.function?.name),
      lengthOk: req.headers["content-length"] === undefined || Number(req.headers["content-length"]) === Buffer.byteLength(body),
      raw: body,
    });
    const mode = new URL(req.url, "http://local").searchParams.get("mode");
    if (mode === "json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "search_web", arguments: "{\"queries\":[\"q\"]}" } }] } }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const step = () => {
      if (i >= sse.length) { res.end(); return; }
      res.write(sse.slice(i, i + 7));
      i += 7;
      setImmediate(step);
    };
    step();
  });
});
await new Promise((resolve) => { upstream.listen(0, "127.0.0.1", resolve); });
const base = `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`;
const fakeDeps = { ctx: {}, endpoints: () => [], owners: { get: async () => new Map() } };

let interceptor = installInterceptor({ ...fakeDeps, config: resolveConfig({ wireRename: { hosts: ["127.0.0.1"] } }) });
try {
  const viaRequest = await fetch(new Request(`${base}?mode=sse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  }));
  const text = await viaRequest.text();
  check("Request 形态：上游收到 search_web", seen.at(-1).tools, ["search_web", "read_page"]);
  check("Request 形态：content-length 与实际体一致", seen.at(-1).lengthOk, true);
  check("Request 形态：SSE 回来是 web_search", text.includes("\"name\":\"web_search\"") && !text.includes("\"name\":\"search_web\""), true);
  check("Request 形态：响应 url 保留", viaRequest.url, `${base}?mode=sse`);

  const viaString = await fetch(`${base}?mode=json`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const json = await viaString.json();
  check("字符串形态：上游收到 search_web", seen.at(-1).tools, ["search_web", "read_page"]);
  check("字符串形态：JSON 回来是 web_search", json.choices[0].message.tool_calls[0].function.name, "web_search");

  const plain = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "read_page" } }] });
  await (await fetch(`${base}?mode=json`, { method: "POST", headers: { "content-type": "application/json" }, body: plain })).text();
  check("不含 web_search 的请求体逐字节透传", seen.at(-1).raw, plain);
} finally {
  interceptor.restore();
}

interceptor = installInterceptor({ ...fakeDeps, config: resolveConfig({ wireRename: { hosts: ["example.invalid"] } }) });
try {
  await (await fetch(`${base}?mode=json`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) })).text();
  check("host 不匹配：上游收到原名 web_search", seen.at(-1).tools, ["web_search", "read_page"]);
} finally {
  interceptor.restore();
}

upstream.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
