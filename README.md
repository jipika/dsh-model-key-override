# dsh-model-key-override

**给单个模型配「专属 key」：填了就用它，没填就走供应商那把。**

和 DSH 原生行为的唯一差别：原来一个 provider 只有一把 key，现在某个模型可以自带一把。
provider、模型列表、baseURL、协议全都不用动。

---

## 已实测（2026-10-11，desktop 真实宿主）

| 步骤 | 结果 |
| --- | --- |
| 基线：`grok/grok-4.6` 与 `grok/grok-4.7` 都未配专属 key | 两个都正常回复 `PONG` |
| 注入 `MK_GROK_GROK_4_6=mk-test-invalid`（假 key）后调 `grok-4.6` | **失败**；诊断记 `overridden provider=grok model=grok-4.6 ref=MK_GROK_GROK_4_6 by=model+url` |
| 同一时刻调 `grok-4.7`（同 provider、无专属 key） | **照常回复 `PONG`** —— 完全不受影响 |
| 删掉那条引用后再调 `grok-4.6` | 恢复 `PONG` |

全程安装版 `app.asar` 未被触碰；插件自带自测 19/19（含共享 host 归属、同名模型跨 provider、Headers/对象两种头形态）。

## 怎么用

1. 设置 → **模型** → 找到目标 provider（如 `GPT`）→ **编辑** → 点开某个模型的展开箭头；
2. 展开处会多一个 **「模型专属 key（<provider> / <model>）」** 输入框；
3. 粘一把 key 进去 → 失焦即保存（状态显示「已保存专属 key」）；
4. 想还原成供应商的 key：点 **清除**（状态变回「未配置 · 走供应商 key」）。

没填的模型、没展开过的模型、其它 provider —— 行为与以前完全一样。

## 底下的机制（出问题时用得着）

- key 存在 **DSH 凭据库**（`~/.dsh/.credentials.yaml`），引用名由 provider 与模型 id 推导：

  ```
  <refPrefix><PROVIDER>_<MODEL>     ← 大写，非字母数字折成 _
  例：provider `gpt` + 模型 `gpt-5.6-terra` → MK_GPT_GPT_5_6_TERRA
  ```

  UI 会自动算好这个引用名；**万一 UI 注入失效**（官方改版），你手工往凭据库加一条同名
  引用，效果与 UI 填写完全相同 —— 这就是逃生通道。

- host 半边在**本进程内**包一层 fetch：请求出网前，按请求体里的 `model` 找到上面对应的
  引用；有值就替换授权头（`authorization: Bearer …`，Anthropic 协议用 `x-api-key`），
  没值就**原样放行**。只对「已配置 provider 的 baseURL 前缀」匹配上的请求生效。

## 配置（profile 的 `cordis.patch.yml`，全部可选）

```yaml
- insert:
    - id: model-key-override
      name: 'dsh-model-key-override'
      config:
        enabled: true      # 关掉 = 完全回到原生行为
        refPrefix: MK_     # 引用名前缀（改了就两边都要跟着改）
        providers: []      # 只对这些 provider 生效；空 = 全部（自动识别）
        allowHosts: []     # 额外允许拦截的上游 host，一般不用
        cacheMs: 3000      # 专属 key 解析缓存（毫秒）；改完 key 最多这么久生效
        debug: false       # 打开后，连“判定给了谁但没有专属 key”也记一条，排查用
```

## 自查

```bash
tail -f ~/.dsh/model-key-override-diag.ndjson
# overridden → provider / model / ref / header   （这条请求用了专属 key）
# skipped    → 没有专属 key，原样走供应商
```

`installed` 行里 `providers: []` 是正常的：插件加载时 llm 可能还没装配完，端点表是
惰性的，第一次请求时才解析（诊断里的 `provider` 字段证明它认出来了）。

## 排错

| 现象 | 原因 / 处置 |
| --- | --- |
| 展开模型看不到输入框 | ① 插件没加载（`diag` 文件不存在）→ 重启应用；② 官方改了模型页 DOM 的 class 后缀 → 需要跟着修 `client.js` 里的选择器 |
| 填了 key 但请求仍用供应商的 | `tail` 诊断看有没有 `overridden`：没有 → 打开 `debug: true` 重启，再看 `key-missing` 行里的 `provider` / `ref` / `by`——`by: model` 表示按模型归属判定，`by: url` 表示退回上游前缀判定；`ref` 与你填的引用名不一致就是前缀或 provider 名对不上 |
| 想临时关掉 | `config.enabled: false` + 重启（或直接点 UI 里的「清除」） |
| 保存报「设置不可写」 | 该部署的凭据库只读（`describe` 返回 `writable: false`） |

## 自测（不需要 DSH）

```bash
node ~/.dsh/local-plugins/dsh-model-key-override/test/selftest.mjs
```

覆盖：引用名推导 / 授权头形态（Bearer 与 x-api-key）/ 端点最长前缀匹配 / Headers 与
普通对象两种 headers 形态 / 有专属 key 替换 / 无专属 key 原样放行 / 非目标上游不碰。

## 回滚

删掉 `cordis.patch.yml` 里的 insert 块 + `package.json` 的依赖行 + 重启应用。
凭据库里已存的 `MK_*` 引用留着无害（插件不在就没有东西去读它们）。

---

## ☕ 赞赏支持

如果 dsh-model-key-override 对你的研究与测试有所帮助，欢迎请作者喝杯咖啡 ☕

<p align="center">
  <img src="assets/sponsor.jpg" width="260" alt="微信赞赏码" />
  <img src="assets/afdian_reward.jpg" width="200" alt="爱发电赞助码" />
</p>

<p align="center">
  <b>给项目点个 Star ⭐</b> 同样是对开发者最大的鼓励！
</p>
