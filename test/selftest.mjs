/**
 * dsh-model-key-override 自测 —— 不经 DSH，直接验证换 key 引擎：
 *   ① 模型有专属 key → 用专属的（Authorization 被替换）
 *   ② 模型没有专属 key → 原样放行（供应商那把不动）
 *   ③ 引用名推导规则（provider + model → MK_…）
 *   ④ 非目标上游的请求完全不碰
 *   ⑤ Headers 实例与普通对象两种 headers 形态都能换
 * 运行：node test/selftest.mjs
 */
import {
  resolveConfig, installInterceptor, refFor, withHeader, authStyleOf,
  providerEndpoints, endpointFor, decideProvider,
} from "../index.js";

const KEYS = { "MK_GW_MODEL_A": "own-key-a", "MK_GW_MODEL_B": "own-key-b" };
const ctx = {
  get: (service) => (service === "credentials" ? {
    resolve: async (ref) => (KEYS[ref] === undefined ? undefined : { value: KEYS[ref] }),
  } : undefined),
};

const ENDPOINTS = [{ provider: "gw", baseURL: "http://gw.test/v1", api: "openai-completions" }];

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};

check("引用名推导：provider + model", refFor("MK_", "gw", "model-a"), "MK_GW_MODEL_A");
check("引用名推导：含点/横线折成下划线", refFor("MK_", "gpt", "gpt-5.6-terra"), "MK_GPT_GPT_5_6_TERRA");
check("授权头形态：Anthropic 用 x-api-key", authStyleOf("anthropic-messages"), { header: "x-api-key", prefix: "" });
check("授权头形态：其它用 Bearer authorization", authStyleOf("openai-completions"), { header: "authorization", prefix: "Bearer " });
check("端点匹配：最长前缀优先", endpointFor(
  [{ provider: "a", baseURL: "http://gw.test" }, { provider: "b", baseURL: "http://gw.test/v1" }],
  "http://gw.test/v1/chat/completions",
)?.provider, "b");
check("headers 替换：普通对象", (() => {
  const next = withHeader({ authorization: "Bearer old", "x-trace": "1" }, "authorization", "Bearer new");
  return {
    authorization: next.authorization,
    trace: next["x-trace"],
    authKeys: Object.keys(next).filter(k => k.toLowerCase() === "authorization").length,
  };
})(), { authorization: "Bearer new", trace: "1", authKeys: 1 });
check("headers 替换：Headers 实例", (() => {
  const next = withHeader(new Headers({ authorization: "Bearer old", "x-trace": "1" }), "x-api-key", "own");
  return [next.get("x-api-key"), next.get("authorization"), next.get("x-trace")];
})(), ["own", null, "1"]);

// ── 归属判定：共享 host / 同名模型 / 兜底 ────────────────────────────────────
const SHARED = [
  { provider: "claude", baseURL: "https://cf.heilovehei.com", api: "anthropic-messages" },
  { provider: "heihei", baseURL: "https://cf.heilovehei.com/v1", api: "openai-completions" },
  { provider: "grok", baseURL: "https://cf.heilovehei.com", api: "openai-completions" },
];
const ownersOf = (pairs) => new Map(Object.entries(pairs).map(([id, list]) => [id, new Set(list)]));

check("共享 host：claude 的模型归属唯一 → 判给 claude（不被 /v1 的长前缀抢走）",
  decideProvider({
    model: "claude-opus-5-5",
    url: "https://cf.heilovehei.com/v1/messages",
    endpoints: SHARED,
    owners: ownersOf({ "claude-opus-5-5": ["claude"] }),
  })?.provider, "claude");
check("共享 host：grok 的模型 → grok",
  decideProvider({
    model: "grok-5",
    url: "https://cf.heilovehei.com/chat/completions",
    endpoints: SHARED,
    owners: ownersOf({ "grok-5": ["grok"] }),
  })?.provider, "grok");
check("共享 host：heihei 的模型走自己的 /v1 前缀 → heihei",
  decideProvider({
    model: "heihei-model",
    url: "https://cf.heilovehei.com/v1/chat/completions",
    endpoints: SHARED,
    owners: ownersOf({ "heihei-model": ["heihei"] }),
  })?.provider, "heihei");
check("同名模型跨 provider → 由 URL 分辨（deepseek-flash 两处都有）",
  decideProvider({
    model: "deepseek-flash",
    url: "https://api.deepseek.com/account/v1/chat/completions",
    endpoints: [
      { provider: "deepseek-official", baseURL: "https://api.deepseek.com/v1" },
      { provider: "deepseek-account", baseURL: "https://api.deepseek.com/account/v1" },
    ],
    owners: ownersOf({ "deepseek-flash": ["deepseek-official", "deepseek-account"] }),
  })?.provider, "deepseek-account");
check("归属表为空 → URL 兜底",
  decideProvider({
    model: "whatever",
    url: "http://127.0.0.1:18099/v1/chat/completions",
    endpoints: [{ provider: "gw", baseURL: "http://127.0.0.1:18099/v1" }],
    owners: new Map(),
  })?.provider, "gw");
check("两边都判不出来 → 不干预（返回 undefined）",
  decideProvider({ model: "whatever", url: "https://unknown.test/v1/x", endpoints: SHARED, owners: new Map() }), undefined);

// 端点去重：同一个 adapter 实例服务多个 route 时，每个 provider 只应被收集一次
const sharedAdapter = {
  config: {
    profiles: () => new Map([
      ["claude", { baseURL: "https://cf.heilovehei.com", api: "anthropic-messages" }],
      ["grok", { baseURL: "https://cf.heilovehei.com", api: "openai-completions" }],
    ]),
  },
};
const fakeCtx = {
  llm: {
    adapters: new Map([
      ["claude", { provider: { id: "claude", name: "claude" }, adapter: sharedAdapter }],
      ["grok", { provider: { id: "grok", name: "grok" }, adapter: sharedAdapter }],
    ]),
  },
};
check("端点收集：同一 adapter 多 route → 每个 provider 只收一次",
  providerEndpoints(fakeCtx).map(entry => entry.provider), ["claude", "grok"]);

// ── 引擎：真起 fetch 拦截，用本地 http 服务器看实际收到的头 ────────────────
import { createServer } from "node:http";
const seen = [];
const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    seen.push({ model: (() => { try { return JSON.parse(body).model; } catch { return undefined; } })(), auth: req.headers.authorization, apiKey: req.headers["x-api-key"] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((resolve) => { upstream.listen(0, "127.0.0.1", resolve); });
const port = upstream.address().port;

const config = resolveConfig({ cacheMs: 0 });
// 把被测端点指向真实 mock 服务器
const endpoints = () => [{ provider: "gw", baseURL: `http://127.0.0.1:${port}/v1`, api: "openai-completions" }];
const interceptor = installInterceptor({ ctx, config, endpoints });

const call = (model, headers = { authorization: "Bearer vendor-key" }) => globalThis.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ model, messages: [] }),
});

await (await call("model-a")).text();
check("模型有专属 key → 换成专属", seen.at(-1).auth, "Bearer own-key-a");

await (await call("model-b")).text();
check("模型有权属 key B → 换成 B", seen.at(-1).auth, "Bearer own-key-b");

await (await call("model-unknown")).text();
check("模型没有专属 key → 原样走供应商", seen.at(-1).auth, "Bearer vendor-key");

// 非目标上游（另一个 mock，不在端点表里）：即使 model 有专属 key 也不该被动
const otherSeen = [];
const other = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    otherSeen.push({ auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((resolve) => { other.listen(0, "127.0.0.1", resolve); });
await (await fetch(`http://127.0.0.1:${other.address().port}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer vendor-key" },
  body: JSON.stringify({ model: "model-a", messages: [] }),
})).text();
check("非目标上游 → 授权头原样不动", otherSeen.at(-1).auth, "Bearer vendor-key");
await new Promise((resolve) => { other.close(resolve); });

await (await call("model-a", { "x-api-key": "vendor-x" })).text();
check("无 authorization 的请求也能补上专属 key", seen.at(-1).auth, "Bearer own-key-a");

interceptor.restore();
await new Promise((resolve) => { upstream.close(resolve); });

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
