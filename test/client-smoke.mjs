/**
 * 冒烟：用最小 DOM 替身加载 client.js，验证
 *   ① bundle 能加载、inject 含 remote（否则会重现 cannot get property "remote" without inject）
 *   ② apply 不抛，且打出带 rev 的加载日志（用户靠它判断浏览器拿到的是不是新 bundle）
 *   ③ 注入到模型展开区的节点结构 = 标题 / 输入框（独占一行）/ 备注行，且带 data-mko-rev
 *   ④ 重复扫描（模拟 React 重渲染）不会叠出第二套控件
 * 运行：node test/client-smoke.mjs
 */
import { readFileSync } from "node:fs";

/** 极简元素替身：够跑 client.js 用到的 API。 */
function makeEl(tag = "div", className = "") {
  const node = {
    tagName: tag.toUpperCase(),
    className,
    children: [],
    listeners: {},
    attrs: {},
    textContent: "",
    value: "",
    placeholder: "",
    type: "",
    autocomplete: "",
    disabled: false,
    id: "",
    style: {},
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    append(...kids) { for (const k of kids) this.appendChild(k); },
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    querySelector(selector) { return search(this, selector)[0] ?? null; },
    querySelectorAll(selector) { return search(this, selector); },
    closest(selector) { return matches(node, selector) ? node : (node.parentNode?.closest?.(selector) ?? null); },
    focus() {},
  };
  return node;
}
function allDescendants(root) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } };
  walk(root);
  return out;
}
function matches(node, selector) {
  const attr = selector.match(/^\[([a-zA-Z-]+)\*="([^"]+)"\]$/);
  if (attr) return String(node.attrs[attr[1]] ?? node.className ?? "").includes(attr[2]);
  if (selector === "input") return node.tagName === "INPUT";
  if (selector.startsWith('[') && selector.endsWith(']') && selector.includes('*=') === false) {
    const name = selector.slice(1, -1);
    return Object.prototype.hasOwnProperty.call(node.attrs, name);
  }
  return false;
}
function search(root, selector) {
  return allDescendants(root).filter(node => matches(node, selector));
}

// ── 造一个「官方模型卡片」的最小结构 ────────────────────────────────────────
const card = makeEl("div", "_editor_abc123");
const route = makeEl("span", "_editorRoute_abc123");
route.textContent = "company";
card.appendChild(route);

const entry = makeEl("div", "_modelEntry_abc123");
const row = makeEl("div", "_modelRow_abc123");
const idInput = makeEl("input");
idInput.value = "glm-5.3-flash";
row.appendChild(idInput);
const advanced = makeEl("div", "_modelAdvanced_abc123");
entry.appendChild(row);
entry.appendChild(advanced);
card.appendChild(entry);

// ── 环境替身 ────────────────────────────────────────────────────────────────
let spec;
const logs = [];
const originalInfo = console.info;
console.info = (...args) => { logs.push(args.join(" ")); };
globalThis.window = { __ModuleLoader__: { load: (s) => { spec = s; } } };
globalThis.document = {
  head: makeEl("head"),
  documentElement: makeEl("html"),
  addEventListener() {},
  createElement: (tag) => makeEl(tag),
  getElementById: () => null,
  querySelectorAll: (selector) => (matches(entry, selector) ? [entry] : []),
};
globalThis.MutationObserver = class { observe() {} };
globalThis.requestAnimationFrame = (cb) => { cb(); return 0; };
globalThis.Headers = class {};

const src = readFileSync(new URL("../client.js", import.meta.url), "utf8");
eval(src);

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};

check("模块 id", spec.id, "dsh-model-key-override");

const mod = spec.factory(() => { throw new Error("不该 require 任何模块"); });
check("inject 含 remote（修掉 cannot get property remote）", mod.inject, ["remote", "remote.credentials"]);

const calls = [];
mod.apply({
  remote: {
    credentials: {
      describe: async (refs) => { calls.push(["describe", refs]); return { ok: true, value: { [refs[0]]: { configured: false, writable: true } } }; },
      set: async (ref, value) => { calls.push(["set", ref, value]); return { ok: true }; },
      unset: async (ref) => { calls.push(["unset", ref]); return { ok: true }; },
    },
  },
});
await new Promise(resolve => setTimeout(resolve, 0));

check("加载日志带 rev（用户判断 bundle 新旧用）", logs.some(line => /client rev \d+\.\d+\.\d+/.test(line)), true);

const injected = advanced.children.filter(child => child.attrs["data-mko-field"] !== undefined);
check("注入了一个字段块", injected.length, 1);
const field = injected[0];
check("字段块声明了引用名", field.attrs["data-mko-ref"], "MK_COMPANY_GLM_5_3_FLASH");
check("字段块带 rev 标记", field.attrs["data-mko-rev"], "0.3.0");
check("结构顺序 = 标题 / 输入框 / 备注行", field.children.map(c => c.attrs["data-mko-label"] !== undefined ? "label"
  : c.attrs["data-mko-input"] !== undefined ? "input"
    : c.attrs["data-mko-foot"] !== undefined ? "foot" : "?"), ["label", "input", "foot"]);
check("标题文案含 provider 与模型", field.children[0].textContent, "模型专属 key（company / glm-5.3-flash）");
check("输入框是整行 block", /width:100%/.test(String(field.children[1].type)) || field.children[1].attrs["data-mko-input"] !== undefined, true);
check("备注行里是 状态 + 清除 两个元素", field.children[2].children.length, 2);
check("启动时读了一次凭据状态", calls.filter(c => c[0] === "describe").length, 1);

// 模拟 React 重渲染：同一个展开区再扫一次
const docQuery = globalThis.document.querySelectorAll;
globalThis.document.querySelectorAll = (selector) => (matches(entry, selector) ? [entry] : []);
mod.apply({ remote: { credentials: { describe: async () => ({ ok: true, value: {} }), set: async () => ({ ok: true }), unset: async () => ({ ok: true }) } } });
await new Promise(resolve => setTimeout(resolve, 0));
check("重复扫描不叠第二套控件", advanced.children.filter(c => c.attrs["data-mko-field"] !== undefined).length, 1);

console.info = originalInfo;
console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
