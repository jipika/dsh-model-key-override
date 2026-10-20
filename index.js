/**
 * dsh-model-key-override —— 同一个 provider 下，给单个模型配「专属 key」。
 *
 * ## 形态（用户要的那种）
 * 官方模型页照常用。点开某个模型 → 填一把「模型专属 key」：
 *   · 填了 → 这个模型的请求用它；
 *   · 没填 → 照旧走供应商那把 key。
 *
 * ## 怎么做到的（零侵入）
 * 不换 baseURL、不起代理端口、不改安装版：本插件在**本进程内**包一层 fetch，
 * 在请求出网前按请求体里的 `model` 把授权头换成该模型的专属 key。
 *
 *     pi-ai provider（配置完全不动）
 *        └─ 出网前：本插件判定「属于哪个 provider 的这个模型」→ 查专属 key
 *             → 有则替换授权头，无则原样放行（供应商那把照旧）
 *
 * 专属 key 存在 DSH 凭据库里，引用名由 provider + model 推导：
 *     <refPrefix><PROVIDER>_<MODEL>    （默认 prefix = `MK_`，非字母数字折成 `_`）
 * 例：provider `gpt` 的模型 `gpt-5.6-terra` → `MK_GPT_GPT_5_6_TERRA`。
 *
 * ## 归属判定（为什么不能只看 URL）
 * 多个 provider 常共用同一个 host（本机就有 grok / claude / heihei 三个共用
 * cf.heilovehei.com 的情形），只按 baseURL 前缀会把 claude 的请求错认成 heihei，
 * 于是用户在 claude 卡片里填的 key 永远命中不到。所以判定按这个顺序：
 *   ① 该模型**唯一属于**某个 provider（模型目录来自各 route 的 `listModels`）→ 用它；
 *   ② 否则用 URL 最长前缀匹配到的 provider；两侧一致时那是同一个答案。
 *   ③ 两者都给不出答案 → 原样放行，绝不乱换 key。
 * 同名模型跨 provider（如 deepseek-official 与 deepseek-account 都有 deepseek-flash）
 * 走 ②，由 URL 分辨。
 *
 * ## 配置（profile 的 cordis.patch.yml，全部可选）
 *     - id: model-key-override
 *       name: 'dsh-model-key-override'
 *       config:
 *         enabled: true
 *         refPrefix: MK_
 *         providers: []        # 只对这些 provider 生效；空 = 全部
 *         allowHosts: []       # 额外允许拦截的上游 host（一般不用填）
 *         cacheMs: 3000        # 专属 key 解析缓存（毫秒）
 *
 * ## 安全与边界
 * · 只在能确定归属的请求上动手；判不出来就原样放行；
 * · 专属 key 只在内存里参与拼头，不落盘、不进日志（诊断只记引用名）。
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Stable Cordis plugin name. */
export const name = "dsh-model-key-override";

/** 需要 llm 服务来枚举 provider 及其 baseURL（核心服务，恒在）。 */
export const inject = ["llm"];

const DEFAULTS = {
  enabled: true,
  refPrefix: "MK_",
  providers: [],
  allowHosts: [],
  cacheMs: 3000,
  /**
   * 诊断开关：默认只记「真的换了 key」与异常；打开后连「判定给了谁但没专属 key」
   * 也记一条（key-missing），用来排查“为什么我的专属 key 没生效”。
   * 日常开着会为每个请求写一行，所以默认关。
   */
  debug: false,
  /**
   * 追踪开关：为**每个带 model 的出网请求**记 http / pass 行（含脱敏 URL、模型、端点表大小），
   * 用来排查“请求到底有没有进拦截器、端点表当时是不是空的”。只给排障用，平时关。
   * 也可用标志文件 `$DSH_HOME/model-key-override-trace` 临时打开（免改配置、免重启即可关）。
   */
  trace: false,
};

const TRACE_FILE = join(
  process.env.DSH_HOME || join(homedir(), ".dsh"),
  "model-key-override-trace",
);

/** 标志文件优先，其次配置；1 秒缓存，避免每个请求都 stat。 */
let traceCache = { at: 0, on: false };
function traceOn() {
  if (Date.now() - traceCache.at < 1000) return traceCache.on;
  let on = false;
  try { on = existsSync(TRACE_FILE); } catch { /* ignore */ }
  traceCache = { at: Date.now(), on };
  return on;
}

/** 只保留 origin + path：丢掉 query/hash，避免把 ?key= 之类的凭据写进诊断文件。 */
function originPath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 120);
  } catch {
    return String(url).split("?")[0].split("#")[0].slice(0, 120);
  }
}

const DIAG = process.env.MODEL_KEY_OVERRIDE_DIAG
  || join(process.env.DSH_HOME || join(homedir(), ".dsh"), "model-key-override-diag.ndjson");

/** 追加诊断；绝不拖垮请求路径。 */
function diag(event, extra = {}) {
  try {
    mkdirSync(DIAG.slice(0, DIAG.lastIndexOf("/")), { recursive: true });
    appendFileSync(DIAG, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...extra })}\n`);
  } catch { /* ignore */ }
}

/** 合并默认值与用户配置。 */
export function resolveConfig(rawConfig) {
  const cfg = { ...DEFAULTS, ...(rawConfig || {}) };
  if (process.env.MODEL_KEY_OVERRIDE_ENABLED === "0") cfg.enabled = false;
  cfg.enabled = cfg.enabled !== false;
  cfg.refPrefix = typeof cfg.refPrefix === "string" && cfg.refPrefix.length > 0 ? cfg.refPrefix : DEFAULTS.refPrefix;
  cfg.providers = Array.isArray(cfg.providers) ? cfg.providers.filter(p => typeof p === "string" && p.length > 0) : [];
  cfg.allowHosts = Array.isArray(cfg.allowHosts) ? cfg.allowHosts.filter(p => typeof p === "string" && p.length > 0) : [];
  cfg.cacheMs = Number.isFinite(cfg.cacheMs) && cfg.cacheMs >= 0 ? cfg.cacheMs : DEFAULTS.cacheMs;
  cfg.debug = cfg.debug === true;
  return cfg;
}

/**
 * 一个模型专属 key 的引用名。
 * @param prefix - 引用名前缀（默认 `MK_`）。
 * @param provider - provider 路由名。
 * @param model - 模型 id。
 * @returns 形如 `MK_GPT_GPT_5_6_TERRA` 的引用名。
 */
export function refFor(prefix, provider, model) {
  const stem = `${provider}_${model}`
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${prefix}${stem === "" ? "MODEL" : stem}`;
}

/** 从 requests 用的 headers 里读一个头（大小写无关；兼容 Headers 与普通对象）。 */
export function headerOf(headers, name) {
  if (headers === undefined || headers === null) return undefined;
  if (typeof headers.get === "function") {
    const direct = headers.get(name);
    if (direct !== undefined) return direct;
    return headers.get(name.toLowerCase()) ?? undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value.join(", ") : value;
  }
  return undefined;
}

/**
 * 换掉请求的授权头，返回新的 headers（Headers 进 Headers 出，对象进对象出）。
 * @param headers - 原始 headers。
 * @param headerName - 要写的头名（authorization / x-api-key）。
 * @param write - 头值（已含前缀，如 `Bearer sk-…`）。
 * @returns 新的 headers 值。
 */
export function withHeader(headers, headerName, write) {
  if (headers !== undefined && headers !== null && typeof headers.get === "function") {
    const next = new Headers(headers);
    for (const stale of ["authorization", "x-api-key", "api-key"]) {
      if (stale !== headerName.toLowerCase()) next.delete(stale);
    }
    next.set(headerName, write);
    return next;
  }
  const next = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (["authorization", "x-api-key", "api-key"].includes(key.toLowerCase())
      && key.toLowerCase() !== headerName.toLowerCase()) continue;
    next[key] = value;
  }
  next[headerName] = write;
  return next;
}

/** 该 provider 的授权头形态：Anthropic 协议用 x-api-key，其余用 Bearer authorization。 */
export function authStyleOf(api) {
  return typeof api === "string" && api.startsWith("anthropic")
    ? { header: "x-api-key", prefix: "" }
    : { header: "authorization", prefix: "Bearer " };
}

/**
 * 遍历 llm 的 adapter 注册表，收集 provider → { baseURL, api }。
 * 同一个 adapter 实例常服务多个 route，所以按 route 从它自己的 profiles() 里取那一条，
 * 而不是把整张 profiles 表摊平（否则每个 provider 会被重复收集）。
 * @returns {Array<{provider: string, baseURL: string, api?: string}>}
 */
export function providerEndpoints(ctx) {
  const found = [];
  const seen = new Set();
  const map = ctx?.llm?.adapters;
  if (!(map instanceof Map)) return found;
  for (const [route, registration] of map) {
    const profiles = registration?.adapter?.config?.profiles;
    if (typeof profiles !== "function") continue;
    let resolved;
    try { resolved = profiles(); } catch { continue; }
    if (!(resolved instanceof Map)) continue;
    const id = typeof registration?.provider?.id === "string" ? registration.provider.id : route;
    if (seen.has(id)) continue;
    const profile = resolved.get(id);
    const baseURL = typeof profile?.baseURL === "string" ? profile.baseURL : undefined;
    if (baseURL === undefined || baseURL.length === 0) continue;
    seen.add(id);
    found.push({
      provider: id,
      baseURL: baseURL.replace(/\/+$/, ""),
      ...(typeof profile.api === "string" ? { api: profile.api } : {}),
    });
  }
  return found;
}

/** 请求 URL 属于哪个 endpoint（最长前缀优先，避免重叠 baseURL 误判）。 */
export function endpointFor(endpoints, url) {
  let best;
  for (const endpoint of endpoints) {
    if (!url.startsWith(endpoint.baseURL)) continue;
    if (best === undefined || endpoint.baseURL.length > best.baseURL.length) best = endpoint;
  }
  return best;
}

/**
 * 惰性模型归属表：模型 id → 拥有它的 provider 集合。
 * 目录来自各 route 的 `listModels`；构建失败或尚未就绪时为空表（判定会自动退回 URL）。
 * @param ctx - 宿主上下文。
 * @returns {{ get(): Promise<Map<string, Set<string>>>, invalidate(): void }}
 */
export function createOwnershipIndex(ctx) {
  let cached;
  const build = async () => {
    const owners = new Map();
    const map = ctx?.llm?.adapters;
    if (!(map instanceof Map)) return owners;
    for (const [route, registration] of map) {
      const adapter = registration?.adapter;
      if (typeof adapter?.listModels !== "function") continue;
      try {
        const list = await adapter.listModels(route);
        for (const info of list ?? []) {
          const id = typeof info?.id === "string" ? info.id : undefined;
          if (id === undefined || id.length === 0) continue;
          if (!owners.has(id)) owners.set(id, new Set());
          owners.get(id).add(route);
        }
      } catch { /* 该 route 的目录不可读：不参与归属判定 */ }
    }
    return owners;
  };
  return {
    get() {
      if (cached === undefined) {
        const pending = build();
        cached = pending;
        // 空目录不固化：provider 目录可能尚未就绪（插件装配早于 adapter 注册），
        // 把空表缓存住会让之后每个请求都判不出归属，模型级 key 随之全部失效。
        const drop = () => { if (cached === pending) cached = undefined; };
        pending.then((map) => { if (map.size === 0) drop(); }, drop);
      }
      return cached;
    },
    invalidate() { cached = undefined; },
  };
}

/**
 * 取 fetch 调用的请求体文本。体有三种藏法：
 *   ① `init.body` 是字符串（最直白，多数 SDK）；
 *   ② `init.body` 是字节视图 / ArrayBuffer（少数 SDK）；
 *   ③ 根本没有 `init.body`，体挂在 `Request` 对象上（`fetch(new Request(url, { body }))`）。
 * 只看 ① 会把 ③ 误判成「无 model」而整体放行，模型级 key 随之全部失效，
 * 所以这里按形态兜住，并且**永不抛**：看不懂就返回没有文本，让调用方原样放行。
 * @returns {Promise<{kind: string, text?: string}>}
 */
async function readBodyText(input, init) {
  try {
    const raw = init?.body;
    if (typeof raw === "string") return { kind: "string", text: raw };
    if (raw instanceof ArrayBuffer) return { kind: "bytes", text: new TextDecoder().decode(raw) };
    if (ArrayBuffer.isView(raw)) return { kind: "bytes", text: new TextDecoder().decode(raw) };
    if (raw !== undefined && raw !== null) {
      // 流 / FormData 之类绝不主动消费：读掉就等于吞了请求体。
      const stream = typeof raw === "object" && typeof raw.getReader === "function";
      return { kind: stream ? "stream" : "other" };
    }
    const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
    if (request === undefined) return { kind: "none" };
    if (request.bodyUsed) return { kind: "request-used" };
    // clone() 复制一份再读，原 body 不被消费；读失败也照常放行。
    return { kind: "request", text: await request.clone().text() };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * 决定这次请求属于哪个 provider（以及用哪种授权头形态）。
 * 模型唯一归属优先；否则用 URL 最长前缀；两者都给不出答案时不干预。
 * @returns {{provider: string, endpoint?: object, by: string} | undefined}
 */
export function decideProvider({ model, url, endpoints, owners }) {
  const byUrl = endpointFor(endpoints, url);
  const candidates = owners?.get?.(model);
  if (candidates !== undefined && candidates.size === 1) {
    const only = [...candidates][0];
    const endpoint = endpoints.find(entry => entry.provider === only) ?? byUrl;
    return { provider: only, ...(endpoint === undefined ? {} : { endpoint }), by: byUrl?.provider === only ? "model+url" : "model" };
  }
  if (byUrl !== undefined) {
    const agrees = candidates === undefined || candidates.has(byUrl.provider);
    return { provider: byUrl.provider, endpoint: byUrl, by: agrees ? "model+url" : "url" };
  }
  return undefined;
}

/**
 * 安装出网拦截。
 * @param options.ctx - 宿主上下文（读 credentials）。
 * @param options.config - 已归一化配置。
 * @param options.endpoints - 惰性端点表（装配顺序无关：每次请求时求值）。
 * @param options.owners - 惰性模型归属表。
 * @returns {{ restore(): void, stats(): object }}
 */
export function installInterceptor({ ctx, config, endpoints, owners }) {
  const originalFetch = globalThis.fetch;
  const cache = new Map();
  const stats = { seen: 0, overridden: 0, skipped: 0 };
  let endpointsLogged = false;

  const readOwnKey = async (ref) => {
    const hit = cache.get(ref);
    if (hit !== undefined && Date.now() - hit.at < config.cacheMs) return hit.value;
    let value;
    const credentials = ctx.get?.("credentials");
    if (credentials?.resolve) {
      try {
        const described = await credentials.resolve(ref);
        if (typeof described?.value === "string" && described.value.length > 0) value = described.value;
      } catch (e) {
        diag("credential-resolve-error", { ref, msg: String(e?.message ?? e).slice(0, 120) });
      }
    }
    if (value === undefined) {
      const ambient = process.env[ref];
      if (typeof ambient === "string" && ambient.length > 0) value = ambient;
    }
    cache.set(ref, { value, at: Date.now() });
    return value;
  };

  globalThis.fetch = async (input, init) => {
    try {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      if (!/^https?:/.test(url)) return originalFetch(input, init);
      // 体可能藏在 init.body（字符串 / 字节）或 Request 对象里，见 readBodyText。
      const body = await readBodyText(input, init);
      const trace = traceOn();
      if (trace) diag("http", { url: originPath(url), body: body.kind, init: init !== undefined });
      let model;
      if (body.text !== undefined) {
        try { model = JSON.parse(body.text)?.model; } catch { model = undefined; }
      }
      if (typeof model !== "string" || model.length === 0) {
        if (trace) diag("pass", { reason: "no-model", url: originPath(url), body: body.kind });
        return originalFetch(input, init);
      }

      const known = endpoints();
      if (!endpointsLogged && known.length > 0) {
        endpointsLogged = true;
        diag("endpoints-ready", { providers: known.map(entry => entry.provider) });
      }
      const allowed = config.allowHosts.some(host => url.includes(host));
      if (!allowed && !known.some(entry => url.startsWith(entry.baseURL))) {
        if (trace) diag("pass", { reason: "url-mismatch", model, table: known.length, url: originPath(url) });
        else if (config.debug) diag("unmatched", { url: originPath(url), endpoints: known.length });
        return originalFetch(input, init);
      }

      let ownerTable;
      try { ownerTable = await owners.get(); } catch { ownerTable = undefined; }
      const decision = decideProvider({ model, url, endpoints: known, owners: ownerTable });
      if (decision === undefined) {
        stats.skipped += 1;
        if (trace) diag("pass", { reason: "undecided", model, table: known.length });
        return originalFetch(input, init);
      }
      if (config.providers.length > 0 && !config.providers.includes(decision.provider)) {
        stats.skipped += 1;
        if (trace) diag("pass", { reason: "not-in-allowlist", model, provider: decision.provider });
        return originalFetch(input, init);
      }

      stats.seen += 1;
      const ref = refFor(config.refPrefix, decision.provider, model);
      const own = await readOwnKey(ref);
      if (own === undefined) {
        stats.skipped += 1;
        if (trace || config.debug) diag("key-missing", { provider: decision.provider, model, ref, by: decision.by });
        return originalFetch(input, init);
      }
      const style = authStyleOf(decision.endpoint?.api);
      // `fetch(new Request(url, init))` 形态下 init 可能没有 headers：基座必须取
      // input.headers，否则传下去的 headers 只有 Authorization，Content-Type 等
      // 会被整体替换掉（Request(input, init) 的语义是覆盖而非合并）。
      const baseHeaders = init?.headers
        ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
      const nextInit = { ...(init ?? {}) };
      nextInit.headers = withHeader(baseHeaders, style.header, `${style.prefix}${own}`);
      stats.overridden += 1;
      diag("overridden", { provider: decision.provider, model, ref, by: decision.by, header: style.header });
      return originalFetch(input, nextInit);
    } catch (e) {
      diag("interceptor-error", { msg: String(e?.message ?? e).slice(0, 160) });
      return originalFetch(input, init);
    }
  };

  return {
    restore() { globalThis.fetch = originalFetch; },
    stats() { return { ...stats }; },
  };
}

/**
 * Cordis 入口。
 * @param ctx - 宿主上下文。
 * @param rawConfig - profile cordis.patch.yml 里的 config 段。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  if (!config.enabled) { diag("disabled"); return; }
  let endpointCache;
  const endpoints = () => {
    // 空表不固化：插件的 apply 常早于 adapter 注册，那一刻枚举必然为空。
    // 若把空数组当成有效快照（`??=` 对 [] 不会重新求值），第一道门会永久放行
    // 所有请求 —— 模型级 key 全部失效，heihei 这类分组网关会直接 404。
    // 能发出 LLM 请求时 adapters 必然已注册，所以重算一次即可拿到真表。
    if (endpointCache === undefined || endpointCache.length === 0) {
      endpointCache = providerEndpoints(ctx);
    }
    return endpointCache;
  };
  const owners = createOwnershipIndex(ctx);
  // adapters 变化（provider 增删/配置改动）后两张表都失效：装配顺序无关。
  ctx.on?.("llm/adapters-updated", () => { endpointCache = undefined; owners.invalidate(); });
  const interceptor = installInterceptor({ ctx, config, endpoints, owners });
  ctx.effect?.(() => () => {
    interceptor.restore();
    diag("restored", interceptor.stats());
  });
  // 不在 apply 时预热端点表：装配顺序上插件常早于 llm-pi-ai，预热只会读到空表。
  // 真实端点表由首个请求惰性建立，并由拦截器记一条 endpoints-ready 便于排查。
  diag("installed", { refPrefix: config.refPrefix, providers: null, note: "lazy" });
}
