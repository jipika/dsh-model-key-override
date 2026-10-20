/**
 * dsh-model-key-override —— 浏览器半边：在官方模型卡片里，给每个模型加一个
 * 「模型专属 key」输入框（点开模型展开处就是它）。
 *
 * 版本标识：REV。每次改动都递增 —— 页面硬刷新后看 Console 有没有
 * `[dsh-model-key-override] client rev <REV>` 这一行，就能区分「bundle 没更新」
 * 与「代码本身没生效」，避免误判。注入的节点上也带 data-mko-rev，便于在
 * DevTools 里直接确认。
 *
 * 行为：填了 → 该模型用这把 key；留空/清除 → 走供应商那把（host 半边按引用名判断，
 * 没有引用就原样放行）。key 值写进 DSH 凭据库（复用官方 remote.credentials），
 * 引用名 = <prefix><PROVIDER>_<MODEL>，与 host 半边推导规则逐字一致。
 *
 * 布局：标题一行 → **输入框独占一行** → 备注（状态 + 清除）一行。标题与清除按钮
 * 的位置是按官方同类字段的节奏自拟的（用户原话只要求"输入框独占一行、备注在下面"）。
 *
 * 注入策略：官方模型卡片没有插件扩展点，所以用 MutationObserver 在官方把模型行
 * 展开区（[class*="_modelAdvanced"]）渲染出来之后往里追加一个字段；class 用属性
 * 子串匹配（CSS Module 的 hash 前缀会变、后缀名不变）。注入前有幂等检查，重复渲染
 * 不会叠出第二套控件。
 *
 * inject 必须同时声明 `remote` 与 `remote.credentials`：cordis 的属性访问受注入保护，
 * 只声明子服务会在读 ctx.remote 时抛 `cannot get property "remote" without inject`
 * （官方 dsh-client-ui-settings-models 的 src/client/index.ts:67-70 正是两个都写）。
 */
window.__ModuleLoader__.load({
	id: "dsh-model-key-override",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 前端版本号：每次改这个文件都 +1，用于确认浏览器拿到的是不是新 bundle。 */
		const REV = "0.3.0";
		/** 与 host 半边 index.js 的 refFor 必须逐字一致。 */
		const PREFIX = "MK_";
		const MARK = "data-mko";
		const STYLE_ID = "dsh-mko-style";
		const CSS = [
			// 整块占满一行，纵向排：标题 / 输入框 / 备注
			`[${MARK}-field]{display:flex;flex-direction:column;gap:6px;width:100%;}`,
			`[${MARK}-label]{font-size:11px;opacity:.7;line-height:1.4;}`,
			// 输入框独占一行
			`[${MARK}-input]{display:block;width:100%;box-sizing:border-box;padding:6px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit;font-size:12px;line-height:1.4;}`,
			`[${MARK}-input]:focus{outline:none;border-color:rgba(127,127,127,.6);}`,
			// 备注行：状态在左、清除在右
			`[${MARK}-foot]{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;line-height:1.4;}`,
			`[${MARK}-status]{opacity:.6;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}`,
			`[${MARK}-clear]{flex:none;background:transparent;border:none;padding:0;color:inherit;opacity:.55;cursor:pointer;font-size:11px;text-decoration:underline;}`,
			`[${MARK}-clear]:hover{opacity:.9;}`,
			`[${MARK}-clear]:disabled{opacity:.25;cursor:default;text-decoration:none;}`,
		].join("\n");

		const refFor = (provider, model) => {
			const stem = `${provider}_${model}`
				.toUpperCase()
				.replace(/[^A-Z0-9]+/g, "_")
				.replace(/^_+|_+$/g, "");
			return `${PREFIX}${stem === "" ? "MODEL" : stem}`;
		};

		/** 这张卡片对应的 provider 路由名（route 标签优先，退回标题）。 */
		function providerOf(entry) {
			const card = entry.closest('[class*="_editor"]');
			if (card === null) return undefined;
			const route = card.querySelector('[class*="_editorRoute"]');
			const routeText = route?.textContent?.trim();
			if (routeText) return routeText;
			const title = card.querySelector('[class*="_editorTitle"]');
			return title?.textContent?.trim() || undefined;
		}

		/** 这一行当前的模型 id（模型行第一个输入框就是 id 字段）。 */
		function modelIdOf(entry) {
			const row = entry.querySelector('[class*="_modelRow"]');
			const input = row?.querySelector("input");
			return input?.value?.trim() || undefined;
		}

		/** 已存状态的一次读取；失败只影响提示文案，绝不抛给调用方。 */
		async function describe(ctx, ref) {
			try {
				const remote = ctx.remote;
				if (remote === undefined) return { error: "远程接口不可用" };
				const answer = await remote.credentials.describe([ref]);
				if (!answer.ok) return { error: answer.error?.message ?? "读取失败" };
				const info = answer.value?.[ref];
				return { configured: info?.configured === true, writable: info?.writable !== false };
			} catch (e) {
				return { error: String(e?.message ?? e) };
			}
		}

		/** 把一段文案写进状态位。 */
		function setStatus(node, text) {
			node.textContent = text;
		}

		function decorate(entry, ctx) {
			const advanced = entry.querySelector('[class*="_modelAdvanced"]');
			if (advanced === null) return;
			// 幂等：这一行的展开区已经注入过就跳过（React 重渲染只搬动节点，不会叠第二套）
			if (advanced.querySelector(`[${MARK}-field]`) !== null) return;
			const provider = providerOf(entry);
			const model = modelIdOf(entry);
			if (provider === undefined || model === undefined) return;
			const ref = refFor(provider, model);

			const field = document.createElement("div");
			field.setAttribute(`${MARK}-field`, ref);
			field.setAttribute(`${MARK}-ref`, ref);
			field.setAttribute(`${MARK}-rev`, REV);

			const label = document.createElement("label");
			label.setAttribute(`${MARK}-label`, "");
			label.textContent = `模型专属 key（${provider} / ${model}）`;

			const input = document.createElement("input");
			input.setAttribute(`${MARK}-input`, "");
			input.type = "password";
			input.autocomplete = "new-password";
			input.placeholder = "留空 = 用供应商的 key";
			input.setAttribute("aria-label", `模型专属 key ${model}`);

			const foot = document.createElement("div");
			foot.setAttribute(`${MARK}-foot`, "");
			const status = document.createElement("span");
			status.setAttribute(`${MARK}-status`, "");
			const clear = document.createElement("button");
			clear.type = "button";
			clear.setAttribute(`${MARK}-clear`, "");
			clear.textContent = "清除";
			clear.title = "清除这把专属 key，改回供应商的 key";
			foot.append(status, clear);

			field.append(label, input, foot);
			advanced.append(field);

			const refresh = async () => {
				const state = await describe(ctx, ref);
				if (state.error !== undefined) {
					setStatus(status, state.error);
					return;
				}
				if (state.configured) {
					setStatus(status, "已配置专属 key · 输入新值可替换");
					input.placeholder = "输入新值可替换";
				} else {
					setStatus(status, "未配置 · 走供应商 key");
					input.placeholder = "留空 = 用供应商的 key";
				}
				input.disabled = state.writable === false;
				clear.disabled = state.writable === false || !state.configured;
			};

			input.addEventListener("change", async () => {
				const value = input.value.trim();
				if (value.length === 0) return;
				setStatus(status, "保存中…");
				try {
					const answer = await ctx.remote.credentials.set(ref, value);
					if (answer.ok) {
						input.value = "";
						await refresh();
					} else {
						setStatus(status, answer.error?.message ?? "保存失败");
					}
				} catch (e) {
					setStatus(status, String(e?.message ?? e));
				}
			});

			clear.addEventListener("click", async () => {
				setStatus(status, "清除中…");
				try {
					const answer = await ctx.remote.credentials.unset(ref);
					if (answer.ok) await refresh();
					else setStatus(status, answer.error?.message ?? "清除失败");
				} catch (e) {
					setStatus(status, String(e?.message ?? e));
				}
			});

			void refresh();
		}

		/** 扫描全部模型行；只在展开区已渲染时注入。 */
		function scan(ctx) {
			for (const entry of document.querySelectorAll('[class*="_modelEntry"]')) {
				decorate(entry, ctx);
			}
		}

		function apply(ctx) {
			console.info(`[dsh-model-key-override] client rev ${REV} 已加载`);
			if (!document.head) {
				document.addEventListener("DOMContentLoaded", () => { apply(ctx); }, { once: true });
				return;
			}
			let style = document.getElementById(STYLE_ID);
			if (style === null) {
				style = document.createElement("style");
				style.id = STYLE_ID;
				document.head.appendChild(style);
			}
			style.textContent = CSS;

			let scheduled = false;
			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				requestAnimationFrame(() => {
					scheduled = false;
					scan(ctx);
				});
			};
			new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
			schedule();
		}

		exports.name = "dsh-model-key-override/client";
		exports.inject = ["remote", "remote.credentials"];
		exports.apply = apply;
		return module.exports;
	},
});
