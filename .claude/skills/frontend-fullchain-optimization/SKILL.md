---
name: frontend-fullchain-optimization
description: Frontend full-chain performance optimization guide based on Web Vitals metrics. Provides metric thresholds, diagnostic methods, and optimization strategies for LCP, FCP, INP, CLS, TTFB, TBT. Use when optimizing frontend performance, analyzing Web Vitals, reducing page load time, fixing layout shifts, improving interaction responsiveness, or reviewing frontend code for performance issues.
---

# Frontend Full-Chain Performance Optimization Guide / 前端全链路性能优化指南

A frontend performance diagnostic and optimization system based on Web Vitals core metrics. Core principle: **User-centric — optimization is about doing less, not more.**

基于 Web Vitals 核心指标的前端性能诊断与优化体系。核心原则：**以用户为中心，优化就是做减法**。

## Metric Threshold Quick Reference / 指标阈值速查

| Metric / 指标 | Good | Needs Improvement | Poor | Unit / 单位 | Focus / 关注点 |
|------|------|-------------------|------|------|--------|
| LCP | ≤ 2.5s | 2.5s - 4s | > 4s | Time / 时间 | Largest Contentful Paint / 最大内容渲染 |
| FCP | ≤ 1.8s | 1.8s - 3s | > 3s | Time / 时间 | First Contentful Paint / 首次内容绘制 |
| INP | ≤ 200ms | 200ms - 500ms | > 500ms | Time / 时间 | Interaction to Next Paint / 交互响应延迟 |
| CLS | ≤ 0.1 | 0.1 - 0.25 | > 0.25 | Score / 分数 | Visual Stability / 视觉稳定性 |
| TTFB | ≤ 800ms | 800ms - 1.8s | > 1.8s | Time / 时间 | Time to First Byte / 首字节时间 |
| FID | ≤ 100ms | 100ms - 300ms | > 300ms | Time / 时间 | First Input Delay / 首次输入延迟 |
| TBT | Tasks > 50ms are long tasks | — | — | Time / 时间 | Total Blocking Time / 总阻塞时间 |

**Measurement advice**: Don't rely on a single P75. Combine P60/P75/P90/P99 percentiles with daily avg/max/min trend lines. Desktop: target P98+; Mobile core pages: target P95–P99.

**衡量建议**：不使用单一 P75，应综合 P60/P75/P90/P99 四个百分位 + 日均/最大/最小值折线图判断。PC 端建议 P98+，移动端核心页面建议 P95-P99。

## Diagnostic Decision Tree / 诊断决策树

```
Page loads slowly? / 页面加载慢？
├── TTFB > 800ms → Network/server issue → See "TTFB Optimization"
│                → 网络/服务器问题 → 见「TTFB 优化」
├── FCP > 1.8s → Resource blocking/large files → See "FCP Optimization"
│              → 资源阻塞/文件过大 → 见「FCP 优化」
├── LCP > 2.5s
│   ├── TTFB & FCP normal → Slow viewport resource loading → See "LCP Optimization"
│   │                     → 视口资源加载慢 → 见「LCP 优化」
│   └── TTFB or FCP abnormal → Fix upstream metrics first
│                            → 先解决上游指标
├── INP > 200ms → Long tasks blocking main thread → See "INP Optimization"
│               → 长任务阻塞主线程 → 见「INP 优化」
├── CLS > 0.1 → Layout shifts → See "CLS Optimization"
│             → 布局偏移 → 见「CLS 优化」
└── Lighthouse Performance Score / Lighthouse 性能分数
    ├── > 80: Few issues / 问题较少
    ├── 60-80: Needs focused analysis, priority: FCP → LCP → CLS
    │        需重点分析，优先级 FCP → LCP → CLS
    └── < 60: Severe issues, full audit required
           严重问题，全面排查
```

## INP Optimization (Interaction Responsiveness) / INP 优化（交互响应）

**Diagnosis**: Chrome Performance panel — look for long tasks (> 50ms, highlighted red); inspect event handler duration in the flame chart.

**诊断方法**：Chrome Performance 面板查看长任务（> 50ms 标红），观察火焰图中事件处理函数耗时。

**Strategy — Break long tasks into shorter ones / 优化策略 — 拆分长任务为多个短任务**：

| Method / 方法 | Mechanism / 机制 | Use Case / 适用场景 |
|------|------|----------|
| `setTimeout(fn, 0)` | Creates a new macrotask at the end of the queue / 创建新宏任务到队列末尾 | Non-urgent network requests, DB operations / 非紧急的网络请求、数据库操作 |
| `Promise.resolve().then(fn)` | Creates a microtask, runs immediately after current macrotask / 创建微任务，当前宏任务后立即执行 | Secondary tasks needing faster execution / 需要较快执行的次要任务 |
| `requestAnimationFrame(fn)` | Runs before next repaint / 下次重绘前执行 | Rendering-related tasks / 与渲染相关的任务 |
| `requestIdleCallback(fn)` | Lowest priority, runs when main thread is idle / 最低优先级，主线程空闲时执行 | Analytics, logging / 埋点、日志上报 |
| `scheduler.postTask(fn, {priority})` | Fine-grained priority control / 精确控制优先级 | Scenarios requiring precise scheduling / 需要精细调度的场景 |

**postTask priorities**: `user-blocking` (high) > `user-visible` (medium) > `background` (low)

**postTask 优先级**：`user-blocking`（高）> `user-visible`（中）> `background`（低）

**Layout & Rendering Optimization / 布局与渲染优化**：
- Reduce `calc()` usage frequency; avoid unnecessary pseudo-class selectors (`nth-child`, `nth-last-child`, `not()`) / 减少 `calc()` 使用频率，避免不必要的伪类选择器
- Avoid frequent JS modifications to element position/size; use className or cssText for batch updates / 避免频繁 JS 修改元素位置/大小，改用 className 或 cssText 批量修改
- Avoid alternating DOM read/write in loops (layout thrashing): cache reads into variables first, then batch write / 避免循环体内交替读写 DOM 属性（布局抖动）：先读取缓存到变量，再批量写入
- Use skeleton screens for lazy-loaded content / 延迟加载的内容块使用骨架屏占位
- Use `<></>` (Fragment) instead of meaningless `<div>` wrappers / 使用 `<></>` (Fragment) 替代无意义的 `<div>` 包裹层
- DOM nodes > 800: caution; > 1400: excessive / DOM 节点 > 800 需警惕，> 1400 过大
- Use virtualization for long lists (react-window / vue-virtual-scroll-list) / 长列表使用虚拟化
- Swiper lists: preload only current item ± 1 / swiper 列表使用预加载策略（仅加载当前项 ± 1）

**CSS Optimization / CSS 优化**：
- Avoid `table` layout; reduce deeply nested CSS selectors / 避免 `table` 布局，减少深层级 CSS 选择器
- Use GPU-accelerated animations: `transform`/`opacity` trigger compositing layer; avoid `top`/`left` which trigger reflow / 利用 GPU 渲染动画：使用 `transform`/`opacity` 触发合成层，避免 `top`/`left` 触发重排
- Use semantic HTML elements; avoid meaningless tags (e.g., use `<button>` not `<div>` for buttons) / 语义化 HTML 元素，避免无意义标签

## TTFB Optimization (Network & Server) / TTFB 优化（网络与服务器）

**Diagnostic formula**: `TTFB ≈ HTTP request time + Server processing time + HTTP response time`

**诊断公式**：`TTFB ≈ HTTP请求时间 + 服务器处理时间 + HTTP响应时间`

**Diagnosis**: DevTools Network panel → click request → Timing → "Waiting for server response" = TTFB.

**诊断方法**：DevTools Network 面板 → 点击请求 → Timing → "Waiting for server response" 即 TTFB。

**TTFB differences by page type**: Static pages (CDN direct, fastest) < SPA (tiny HTML shell, near-static) < SSR (Node.js computation required, slowest). Adjust baseline by page type.

**三种页面类型 TTFB 差异**：纯静态页面（CDN 直出，最快）< SPA 单页面（HTML 壳很小，接近静态）< SSR 服务端渲染（Node.js 需运行计算，最慢）。

| Direction / 方向 | Strategy / 策略 |
|------|------|
| General / 通用 | CDN acceleration (solves 90%+; proactively purge CDN cache after deploys), HTTP/2 multiplexing, Gzip compression, code splitting & dynamic imports / CDN 加速（解决 90%+ 问题，发布新版本后主动通知 CDN 刷新缓存）、HTTP/2 多路复用、Gzip 压缩、代码分包与动态加载 |
| UX / 体验 | Web Workers for heavy requests, DNS prefetch `<link rel="dns-prefetch">`, preconnect `<link rel="preconnect">` / Web Worker 处理耗时请求、DNS 预解析、预连接 |
| Server (SSR) / 服务器 | Internal network for APIs, Redis cache for low-frequency data, reduce redirects, pre-generate static pages at build time / 接口走内网、Redis 缓存低频变更数据、减少重定向、构建时预生成静态页 |
| Resource Caching / 资源缓存 | App hot-update: pre-download HTML/JS/CSS locally (TTFB ≈ 0), PWA Service Worker offline cache / APP 热更新预下载 HTML/JS/CSS 到本地（TTFB ≈ 0）、PWA Service Worker 离线缓存 |

## FCP Optimization (White Screen & First Content) / FCP 优化（白屏与首次内容）

**Diagnostic formula**: `FCP ≈ TTFB + Resource download time + DOM parse time + Render time`

**诊断公式**：`FCP ≈ TTFB + 资源下载时间 + DOM解析时间 + 渲染时间`

**White screen time ≈ FCP time**. Target: instant open (< 1s). / **白屏时间 ≈ FCP 时间**。目标：秒开（< 1s）。

| Strategy / 策略 | Details / 详情 |
|------|------|
| Remove render-blocking resources / 移除阻塞渲染的资源 | Add `defer` or `async` to script tags; non-critical JS → NPM bundle or framework components (e.g., `next/script`) / script 标签加 `defer` 或 `async`；非关键 JS 改用 NPM 打包或框架组件 |
| Reduce JS/CSS size / 减少 JS/CSS 体积 | Remove unused code, Tree Shaking, code splitting / 删除未使用代码、Tree Shaking、代码分割 |
| Control network payload / 控制网络负载 | Compress above-fold images, use WebP/AVIF, lazy-load videos with placeholders / 首屏图片压缩、使用 WebP/AVIF 格式、视频改为延迟加载 + 占位符 |
| Caching strategy / 缓存策略 | `Cache-Control: max-age=31536000` (static assets cached 1 year); JS/CSS as needed / 静态资源缓存 1 年；JS/CSS 按需设置 |
| Shorten critical request depth / 缩短关键请求深度 | Reduce nested resource dependencies (e.g., CSS @import chains); flatten critical resource request chains / 减少依赖资源的嵌套层级，扁平化关键资源请求链 |
| Font optimization / 字体优化 | See "Font Optimization Strategies" below / 见下方「字体优化详细策略」 |
| White screen solutions / 白屏方案 | PWA (international markets); App hot-update local loading (domestic markets) / PWA（海外市场）；APP 热更新本地加载（国内市场） |

## Font Optimization Strategies / 字体优化详细策略

| Approach / 方案 | Description / 说明 |
|------|------|
| Limit font count / 限制字体数量 | Use only one custom font + system font fallback; don't use different Web Fonts for body and p / 仅使用一套自定义字体 + 系统字体备选 |
| Prefer WOFF2 / 优先 WOFF2 格式 | 30% better compression than WOFF, supported by all modern browsers / 比 WOFF 压缩提升 30%，兼容所有现代浏览器 |
| `unicode-range` subsetting / 子集化 | Define character ranges (e.g., CJK U+4E00-9FA5); browser downloads only needed subsets / 定义字符范围，浏览器按需下载部分字符 |
| `local()` local fonts / 本地字体 | For apps with bundled fonts: `src: local('Font Name'), url(...)` reads local font first, no network request / APP 内置字体场景：优先读取本地已安装字体 |
| `font-display` strategy / 策略 | `swap`: system font first then replace (lowest CLS); `optional`: with preload (no re-layout on failure); `block`: wait (blocks rendering); `fallback`/`auto`: compromise |
| CSS Font Loading API | `new FontFace()` + `font.load()` + `document.fonts.ready.then()` — programmatic control of font download timing and swap logic / 用 JS 控制字体下载时机和替换逻辑 |
| Slow network fallback / 低速网络降级 | Use `navigator.connection` to detect; slow users get system default fonts / 结合 `navigator.connection` 判断，低速用户直接使用系统默认字体 |

## LCP Optimization (Largest Contentful Paint) / LCP 优化（最大内容渲染）

**Diagnosis**: Performance panel — find the LCP marker element; Lighthouse report "Largest Contentful Paint element" entry.

**诊断方法**：Performance 面板查看 LCP 标记元素，Lighthouse 报告中 "Largest Contentful Paint element" 项。

**4 element types LCP can mark / LCP 可标记的 4 种元素类型**：
1. `<img>` elements (most common) and `<image>` within SVG / `<img>` 图片元素（最常见）及 SVG 中的 `<image>`
2. `<video>` `poster` attribute image or first frame / `<video>` 的 `poster` 属性图或第一帧画面
3. Elements with CSS `url()` background images / CSS `url()` 函数加载的背景图片元素
4. Block-level elements containing text nodes / 包含文本节点的块级元素

**Key insights / 核心判断**：
- LCP time is always ≥ FCP time / LCP 时间一定 ≥ FCP 时间
- If TTFB and FCP are normal but LCP is abnormal → problem is viewport resource loading / 如 TTFB 和 FCP 正常但 LCP 异常 → 问题在视口资源加载
- SPA: FCP matters more than LCP; SSR/MPA: LCP matters more than FCP / SPA 项目：FCP 比 LCP 更重要；SSR/多页面项目：LCP 比 FCP 更重要

| Strategy / 策略 | Details / 详情 |
|------|------|
| Preload LCP image / 预加载 LCP 图片 | `<link rel="preload" href="..." as="image">` |
| Framework image components / 框架图片组件 | Use `next/image` (includes priority & format optimization); set `priority={true}` |
| Split large images / 拆分大图 | Slice large background images into smaller pieces / 将大尺寸背景图切割为多张小图 |
| Image format / 图片格式 | PNG/JPEG → WebP/AVIF, saves 30%+ size / 可节省 30%+ 体积 |
| Cloud image params / 云端图片参数 | Dynamically set image size/quality/format per device (e.g., Alibaba Cloud OSS params) / 根据设备动态设置图片大小/质量/格式 |
| Rich text images / 富文本图片 | Extract image URLs from content, set `<link rel="preload">` in advance / 提取内容中的图片 URL，提前设置 `<link rel="preload">` |
| Avoid duplicate preloads / 避免重复预加载 | When using framework image components (e.g., `next/image`) with `priority`, don't also add manual `<link rel="preload">` — duplicates waste bandwidth / 两者重复会浪费带宽 |

**Sampling advice**: PV < 1M → full LCP collection; above that → ratio sampling or threshold-based reporting.

**采样建议**：PV < 100 万全量统计 LCP；超过则采用比率采样或超阈值上报。

## CLS Optimization (Layout Shift) / CLS 优化（布局偏移）

**Diagnostic formula**: `Layout shift score = Impact fraction × Distance fraction`, `CLS = SUM(all shift scores)`

**诊断公式**：`布局偏移分数 = 影响比例 × 距离分数`，`CLS = SUM(所有偏移分数)`

**Key conclusion**: The farther the element shifts + the more viewport area affected → higher CLS.

**核心结论**：元素偏移距离越远 + 影响视口面积越大 → CLS 越高。

| Scenario / 场景 | Optimization Strategy / 优化策略 |
|------|----------|
| Images / 图片 | Set `width`/`height` on all `<img>`; use `aspect-ratio` for mobile; use `srcset`/`<picture>` for responsive images / 所有 `<img>` 设置 `width`/`height`；移动端用 `aspect-ratio`；用 `srcset`/`<picture>` 做响应式图片 |
| Dynamic content / 动态内容 | Reserve fixed-size placeholder containers for ads/iframes; avoid inserting content at top of viewport without interaction; inserting near bottom has less CLS impact / 为广告位/iframe 等预留固定尺寸的占位容器；避免在视口顶部无交互插入内容 |
| CSS animations / CSS 动画 | Use `transform` instead of `top/left/width/height`; use `transform: scale()` instead of changing dimensions / 用 `transform` 代替 `top/left/width/height`；用 `transform: scale()` 代替改变尺寸 |
| Fonts / 字体 | `font-display: optional` + preload; or `font-display: swap` to reduce CLS impact |

## General Optimization Tips / 通用优化技巧

| Tip / 技巧 | Description / 说明 |
|------|------|
| Network awareness / 网络感知 | `navigator.connection.effectiveType` to detect 2G/3G/4G; degrade for slow users (smaller images, system fonts, less loading) / 判断 2G/3G/4G，低速用户降级 |
| SVG icons / SVG 图标 | All small icons (< 5KB / < 50px) should use SVG instead of images to reduce async requests / 所有小图标用 SVG 替代图片，减少异步请求 |
| Responsive degradation / 响应式降级 | CSS media queries split CSS by screen size; skip background images on small screens / CSS 媒体查询按屏幕尺寸分 CSS 文件，小屏不加载背景图 |
| Cache-first / 缓存优先 | Cache list data in LocalStorage; render cache first then async refresh to reduce white screen / LocalStorage 缓存列表数据，先渲染缓存再异步刷新 |
| Request merging / 请求合并 | Merge resources, reduce HTTP request count and domain count / 合并资源、减少 HTTP 请求数、减少域名数 |
| Rendering mode / 渲染模式 | Choose SSR (fast first paint) / CSR (strong interactivity) / SSG (static content) by scenario / 根据场景选择 SSR/CSR/SSG |

## Practical Examples with External Services / 外部服务实战示例

The following examples demonstrate how to implement strategies with CDN, OSS, Redis, and other external services.

以下示例用于把策略落地，尤其是涉及 CDN、OSS、Redis 等外部服务时的可执行写法。

### Example 1: Alibaba Cloud OSS — Adaptive Image Quality by Network / 示例 1：阿里云 OSS 按网络质量返回不同图片

Use case: Prioritize visible content for slow-network users; reduce image size and download time.

适用场景：低网速用户优先保证可见内容，减少图片体积和下载耗时。

```javascript
const BASE_IMAGE_URL =
  "https://oss-console-img-demo-cn-hangzhou.oss-cn-hangzhou.aliyuncs.com/example.jpg";

function getNetworkLevel() {
  const connection = navigator.connection || {};
  const type = connection.effectiveType || "4g";
  // Slow network: slow-2g / 2g / 3g
  if (/slow-2g|2g|3g/.test(type)) return "slow";
  return "fast";
}

function buildOssImageUrl(baseUrl) {
  const level = getNetworkLevel();
  // OSS image processing params: lower resolution + quality for slow networks
  const ossParams =
    level === "slow"
      ? "x-oss-process=image/resize,w_100/quality,q_60/format,webp"
      : "x-oss-process=image/resize,w_300/quality,q_82/format,webp";

  return `${baseUrl}?${ossParams}`;
}

function updateHeroImage(imgEl) {
  imgEl.src = buildOssImageUrl(BASE_IMAGE_URL);
}

const heroImage = document.querySelector("#hero-image");
if (heroImage) {
  updateHeroImage(heroImage);
  // Update resource strategy on network change
  navigator.connection?.addEventListener("change", () => updateHeroImage(heroImage));
}
```

### Example 2: CDN Proactive Purge (Post-Deploy) / 示例 2：CDN 主动刷新（版本发布后）

Use case: Prevent CDN serving stale resources after SPA deployment, avoiding version inconsistencies.

适用场景：SPA 发版后避免 CDN 继续回源旧资源导致线上用户版本不一致。

```bash
# Executed by CI/CD or server-side — never expose keys in frontend
# Example: proactively purge entry HTML and critical static assets after deploy
curl -X POST "https://your-cdn-provider.example.com/purge" \
  -H "Authorization: Bearer $CDN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "urls": [
      "https://example.com/index.html",
      "https://example.com/assets/app.abc123.js",
      "https://example.com/assets/app.abc123.css"
    ]
  }'
```

### Example 3: SSR + Redis Cache to Reduce TTFB / 示例 3：SSR + Redis 缓存减少 TTFB

Use case: SSR pages reading low-frequency config or first-screen data; reduce DB/remote API latency per request.

适用场景：SSR 页面读取低频变更配置或首屏数据，减少每次都查数据库/远程接口的耗时。

```javascript
// Node.js (SSR) example
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);

export async function getHomepageData() {
  const cacheKey = "homepage:data:v1";
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // Assume this is a slow API or DB query
  const data = await fetch("https://api.example.com/homepage").then((r) => r.json());

  // Cache for 60s to reduce backend pressure under high concurrency
  await redis.set(cacheKey, JSON.stringify(data), "EX", 60);
  return data;
}
```

## Tool Usage Recommendations / 工具使用建议

| Tool Mode / 工具模式 | Use Case / 适用场景 |
|----------|----------|
| Lighthouse Navigation mode / 导航模式 | Full process analysis from request to load complete for a single page / 单页面从请求到加载完成的全流程分析 |
| Lighthouse Timespan mode / 时间跨度模式 | INP/CLS analysis for SPA route transitions and form interactions / SPA 路由切换和表单交互的 INP/CLS 分析 |
| Lighthouse Snapshot mode / 快照模式 | Analysis of campaigns, animations, and changing-state pages / 活动 H5、动画等变化过程分析 |
| Performance panel / 面板 | Flame chart for long tasks, timeline for resource loading order, frame-by-frame layout shift analysis / 火焰图查看长任务、时序图分析资源加载顺序、逐帧分析布局偏移 |
| Network panel / 面板 | Request count/total size/TTFB/queue time — determine if CDN/prefetch/HTTP2 is needed / 请求数量/总大小/TTFB/排队时间，判断是否需要 CDN/预解析/HTTP2 |

**Key Analysis Paths / 关键分析路径**：
1. FCP appears late → Check JS/CSS load time; for SSR check server API latency / FCP 出现晚 → 排查 JS/CSS 加载时间，SSR 检查服务端接口耗时
2. Long gap between FP and FCP → Check long tasks blocking rendering / FP 到 FCP 间隔长 → 排查长任务阻塞渲染
3. Large gap between FCP and LCP → Too many or too large viewport resources; SSR underutilized / FCP 到 LCP 间隔大 → 视口资源过多或大文件
4. CLS spikes multiple times → Total > 0.25 needs priority fix / CLS 值多次出现 → 总值 > 0.25 需重点优化

## Monitoring & Governance Loop / 监控治理闭环

> Optimization extends beyond the rendering pipeline to include: Collection → Reporting → Query → Alerting → Decision → Verification.
>
> 优化不只在渲染链路，也包含"采集 -> 上报 -> 查询 -> 告警 -> 决策 -> 验证"的闭环优化。

### Reporting Optimization / 上报优化
- Priority: `GIF` (compatible, non-blocking) > `sendBeacon` (unload phase) > `fetch/xhr` (fallback)
- Trigger strategy: Real-time for high-value errors; throttled queue (e.g., 1s) for high-frequency errors
- Data governance: Sanitize sensitive fields (tokens, phone numbers, emails) before reporting

### Rules & Alerting / 规则与告警优化
- Query dimensions must cover: `uid`, `fpId`, `appId`, `pid`, `type`, `level`, `dataId`
- Continuously tune alert thresholds by traffic cycle; don't use one-time fixed thresholds
- Loop: Alert → Locate → Canary fix → Metric regression verification → Rule update/retire

### Error Localization / 异常定位优化
- Request layer: Intercept `fetch/xhr`; collect status codes, timeouts, aborts, latency / 请求层：拦截 `fetch/xhr`，采集状态码、超时、中断、耗时
- Resource layer: Global `error` + `PerformanceObserver(resource)` to collect failures and slow resources / 资源层：全局 `error` + `PerformanceObserver(resource)` 采集失败与慢资源
- Behavior layer: `breadcrumb` saving recent key actions (e.g., 10–100 entries) / 行为层：`breadcrumb` 保存最近关键行为
- Correlation layer: Inject `sw8/traceId`; combine `fpId + uid + appId + pid` to link frontend and backend traces / 关联层：注入 `sw8/traceId`，串联前后端链路

### Automation / 自动化优化
- Run Lighthouse (navigation/timespan mode) in CI after deploy; push reports to team notifications / 发布后 CI 运行 Lighthouse 并推送报告到群通知
- Use Resource Timing / Server Timing to analyze resource phase durations; assist in locating TTFB/FCP/LCP root causes / 使用 Resource Timing / Server Timing 分析资源阶段耗时

## Full Code Example Index (by chapter) / 全册代码示例索引（按文档）

> The following lists chapters with code examples across the full series. Chapters without code blocks are noted.
>
> 以下列出全册涉及代码的章节与代表性示例。无代码围栏的章节已注明"无代码块"。

### Fundamentals & Models / 基础与模型

- `02-重要性：为什么要对前端服务做全链路的监控和优化？.md` (1 block)
```tsx
<form className="space-y-6" action="#" method="POST">
  {/* Login interaction node / 登录交互节点 */}
</form>
```

- `04-数据结构（上）：如何设计全链路数据模型.md` (8 blocks)
```ts
type BaseTrace = {
  traceId: string;
  level: string;
}
```

- `05-数据结构（下）：如何设计页面业务问题相关的数据结构？.md` (12 blocks)
```ts
type TracePerf = {
  id: string;
  LCP?: number;
  FCP?: number;
}
```

- `06-指纹ID：如何通过指纹ID关联全链路日志？.md` (5 blocks)
```ts
export const getFingerprintId = (content: string) => {
  const canvas = document.createElement("canvas");
  return canvas.toDataURL();
}
```

### Metric Collection & Integration / 指标采集与集成

- `07-网页指标：为何要用WebVitals分析Web应用的用户体验？.md` (2 blocks)
```js
const timing = window.performance.timing;
const ttfbTime = timing.responseStart - timing.requestStart;
```

- `08-网页指标：如何快速把WebVitals集成到实际项目？.md` (9 blocks)
```ts
import { onLCP, onCLS, onINP } from "web-vitals";
onLCP(console.log);
onCLS(console.log);
onINP(console.log);
```

### Error Collection & Reporting / 异常采集与上报

- `09-接口指标：监听接口状态，收集页面接口异常数据.md` (8 blocks)
```ts
window.fetch = interceptFetch({
  onError: (error) => console.log(error),
});
```

- `10-资源和脚本异常指标：监听资源和脚本状态，收集异常数据.md` (11 blocks)
```ts
this.observer = new PerformanceObserver((list) => {
  list.getEntries().forEach((entry) => this.handleObserverResource(entry));
});
```

- `11-用户行为指标：如何有效监听用户交互行为？.md` (7 blocks)
```ts
window.addEventListener("click", (event) => {
  traceSdk.saveBreadcrumb({ name: "click", type: "user" });
});
```

- `12-自定义指标：如何通过自定义指标，监控前端页面更多状态.md` (13 blocks)
```ts
try {
  JSON.parse(result);
} catch (err) {
  traceSDK.error(err.message, "JSON.parse");
}
```

- `13-关联后端：如何通过Skywalking把接口关联到后端服务？.md` (9 blocks)
```ts
args[1].headers["sw8"] = values; // Inject trace header / 注入链路头
```

- `14-数据上报方案：如何在不影响用户体验下实现数据上报？.md` (7 blocks)
```ts
navigator.sendBeacon(url, JSON.stringify(data));
```

- `15-何为监控：让监控成为快速发现问题的重要方法.md` (5 blocks)
```ts
await fetch(webhook, { method: "POST", body: JSON.stringify(message) });
```

- `16-监控规则：设定有效的查询条件规则.md` (12 blocks)
```sql
level:"error" | select uid, fpId, appId, count(traceId) as total group by uid, fpId, appId
```

### Performance Optimization Practice / 性能优化实战

- `19-卡顿：页面响应卡顿是什么原因造成的？.md` (6 blocks)
```js
requestIdleCallback(() => {
  sendAnalytics(30); // Low priority task / 低优先级任务
});
```

- `20-渲染：如何优化布局和渲染，提升网页响应速度？.md` (9 blocks)
```js
let left = el.offsetLeft;
for (let i = 0; i < len; i++) {
  left += 10; el.style.left = left + "px";
}
```

- `21-首字节：有效衡量网页首字节时间指标.md` (1 block)
```ts
if (entry.responseStart > 1800) ttfbLevel = TraceDataSeverity.Error;
```

- `22-加载速度：提升网页首字节时间的问题.md` (3 blocks)
```xml
<link rel="dns-prefetch" href="https://static001.geekbang.org" />
<link rel="preconnect" href="https://static001.geekbang.org" />
```

- `23-白屏：如何优化APP内前端白屏时间？.md` (1 block)
```js
navigator.serviceWorker.register("/service-worker.js");
```

- `24-跳出率：如何快速显示页面内容，降低跳出率？.md` (5 blocks)
```xml
<script defer src="https://static-ai.61info.com/pjx/ai/lib/sensorsdata.min.js"></script>
```

- `25-字体：解决自定义字体加载问题.md` (5 blocks)
```css
@font-face {
  font-family: "Awesome Font";
  font-display: swap;
}
```

- `27-图片：调整策略，优化图片加载问题.md` (2 blocks)
```tsx
<Image src={url} width={400} height={4667} priority={true} alt="LCP image" />
```

- `28-视觉：避免发生布局偏移影响用户交互.md` (5 blocks)
```xml
<img src="cls-of-image.jpg" width="400" height="160" alt="cls" />
```

- `29-经验：优化就是减少请求数量和质量.md` (7 blocks)
```js
if (!netSpeed) ossParams = "x-oss-process=image/resize,w_100/quality,q_60";
```

### Chapters without Code Blocks / 无代码块章节

- `01-前世今生：前端全链路的演进历程.md`
- `03-全链路流程：前端全链路的关键路径有哪些？.md`
- `17-数据可视化：可视化监控真的重要吗？.md`
- `18-告警与决策：如何解决监控警告中焦虑的问题？.md`
- `26-视口：可视内容对全链路的重要性.md`
- `30-工具：最容易被忽视的工具和定位问题路径.md`

## Standalone Usage Mode / 独立使用模式（不依赖外部文档）

This Skill contains executable judgment criteria, optimization strategies, code examples, and external service implementation patterns. It can be used independently without requiring access to any course documents.

本 Skill 已包含可直接执行的判断标准、优化策略、代码示例和外部服务落地方案。后续优化任务中，可只依赖本文件执行，不要求访问任何课程文档。

### Standard Execution Flow / 标准执行流程

1. **Collect current state / 收集现状**
   - Get core metrics: LCP/FCP/INP/CLS/TTFB (at least P75 and daily average)
   - Gather evidence from Network + Performance + Lighthouse
2. **Determine priority / 判定优先级**
   - Fix worst metrics (Poor) first, then Needs Improvement
   - Suggested order: `FCP → LCP → CLS → INP → TTFB` (adjust per business needs)
3. **Match strategy / 匹配策略**
   - Follow this Skill's diagnostic decision tree to select the corresponding optimization branch
   - For external services, prefer the "Practical Examples" section above
4. **Implement & verify / 实施与验证**
   - Small incremental commits; one type of optimization per change
   - Re-test 2–3 times using median values to confirm real improvement
5. **Document & prevent regression / 沉淀与防回归**
   - Record metrics before and after changes
   - Add key checks to CI (Lighthouse / performance budgets)

### Delivery Template / 交付模板（每次优化建议按此输出）

```markdown
## Optimization Target / 优化目标
- Page/Feature / 页面/功能：
- Target Metric / 目标指标：
- Current Value / 当前值：
- Target Value / 目标值：

## Evidence / 问题证据
- Network evidence / Network 证据：
- Performance evidence / Performance 证据：
- Lighthouse evidence / Lighthouse 证据：

## Execution Strategy / 执行策略
- Approach / 采用方案：
- External services involved / 涉及外部服务：
- Risk & rollback / 风险与回滚：

## Result Verification / 结果验证
- Before / 优化前：
- After / 优化后：
- Conclusion / 结论：
```

### Usage Constraints / 使用约束

- Don't sacrifice core functionality correctness for perceived speed / 不为了"看起来快"牺牲核心功能正确性
- Don't treat a single user's anomaly as a global performance issue / 不把单个用户异常当成全局性能问题
- Don't claim optimization success without verification / 不在未验证前宣称优化成功
