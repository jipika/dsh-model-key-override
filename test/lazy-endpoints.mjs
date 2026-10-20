/**
 * 时序回归：插件的 apply 早于 llm adapter 注册时，端点表不能被固化成空数组。
 *
 * 背景（2026-10-19 实测）：cordis.patch.yml 里 model-key-override 排在 llm-pi-ai 之前，
 * 旧实现 `endpointCache ??= providerEndpoints(ctx)` 会把 apply 时读到的空数组永久缓存，
 * 第一道门（allowHosts 为空 + 端点表为空）随后放行所有 LLM 请求 → 全退回 provider 级 key
 * → 分组网关对不在该分组的模型回 404 model_not_found（本例 swe-2）。
 *
 * 这里刻意**不触发** `llm/adapters-updated`，以证明修复不再依赖该事件的时序。
 * 运行：MODEL_KEY_OVERRIDE_DIAG=/tmp/mko-test.ndjson node test/lazy-endpoints.mjs
 */
import { createServer } from "node:http";
import { apply } from "../index.js";

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};

// ── mock 上游：记录每次请求实际收到的授权头 ──────────────────────────────────
const seen = [];
const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let model;
    try { model = JSON.parse(body).model; } catch { model = undefined; }
    seen.push({ model, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((resolve) => { upstream.listen(0, "127.0.0.1", resolve); });
const port = upstream.address().port;
const baseURL = `http://127.0.0.1:${port}/v1`;

// ── 目录：首次 listModels 返回空（模拟未就绪），之后返回真实模型 ────────────
let listCalls = 0;
const adapter = {
  config: {
    profiles: () => new Map([["gw", { baseURL, api: "openai-completions" }]]),
  },
  listModels: async () => {
    listCalls += 1;
    return listCalls === 1 ? [] : [{ id: "model-a" }];
  },
};

const KEYS = { MK_GW_MODEL_A: "own-key-a" };
const ctx = {
  // apply 时 adapters 还是空的：与 desktop 的真实装配顺序一致
  llm: { adapters: new Map() },
  get: (service) => (service === "credentials" ? {
    resolve: async (ref) => (KEYS[ref] === undefined ? undefined : { value: KEYS[ref] }),
  } : undefined),
  on: () => {},
  effect: () => {},
};

apply(ctx, { cacheMs: 0 });

// ── 之后 llm-pi-ai 才注册 adapter（且不发 llm/adapters-updated）──────────────
const registration = { provider: { id: "gw", name: "gw" }, adapter };
ctx.llm.adapters.set("gw", registration);

const call = (model) => globalThis.fetch(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer vendor-key" },
  body: JSON.stringify({ model, messages: [] }),
});

// 目录尚未就绪（listModels 首次为空）也不该影响 URL 归属判定
await (await call("model-a")).text();
check("注册后首个请求：按 URL 归属命中专属 key", seen.at(-1).auth, "Bearer own-key-a");

// 第二次请求应复用目录（空表不固化后，第二次能拿到真实归属）
await (await call("model-a")).text();
check("第二次请求：仍命中专属 key", seen.at(-1).auth, "Bearer own-key-a");
check("归属目录只在必要时重建（首次空 + 第二次成功 = 2 次）", listCalls, 2);

// 未配专属 key 的模型原样放行
await (await call("model-other")).text();
check("无专属 key → 供应商 key 不动", seen.at(-1).auth, "Bearer vendor-key");

// 端点表非空后，落在已知 baseURL 之外的请求仍不干预
const otherSeen = [];
const other = createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => { otherSeen.push(req.headers.authorization); res.writeHead(200); res.end("{}"); });
});
await new Promise((resolve) => { other.listen(0, "127.0.0.1", resolve); });
await (await fetch(`http://127.0.0.1:${other.address().port}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer vendor-key" },
  body: JSON.stringify({ model: "model-a", messages: [] }),
})).text();
check("未知上游 → 授权头原样不动", otherSeen.at(-1), "Bearer vendor-key");

await new Promise((resolve) => { other.close(resolve); });
await new Promise((resolve) => { upstream.close(resolve); });

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
