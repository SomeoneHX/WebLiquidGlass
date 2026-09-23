# WebLiquidGlass

> 一个把 Android `Kyant0/AndroidLiquidGlass`（Liquid Glass / Backdrop）的 **Web Liquid Glass** 移植到 Web 的项目。

英文文档见 [`README.en.md`](./README.en.md)（用户脚本部分同样有完整英文版，见 [English §10](./README.en.md#10-userscript-liquid-glass-refraction)）。

---

## 1. 项目简介

**WebLiquidGlass** 是 Android 开源项目 [`Kyant0/AndroidLiquidGlass`](https://github.com/Kyant0/AndroidLiquidGlass)（一个面向 Compose Multiplatform 的可定制液态玻璃效果库，其 *Web Liquid Glass* 是一套液态玻璃演示集）的网页移植版。

目标不是"看起来像"，而是**逐效果、逐像素地 1:1 还原**原版在每个控件上做的事——模糊、折射、形变、高光、涟漪、弹簧动画——只是把 Kotlin/AGSL 的实现换成浏览器原生能力：

- **模糊 / 饱和 / 亮度**：直接用 CSS `backdrop-filter` 的 `blur()` / `saturate()` / `brightness()`，与上游一一对应；
- **折射（displacement）**：用 Canvas 2D 按圆角矩形 SDF 生成位移图，喂给 SVG `feDisplacementMap`，再拼进 `backdrop-filter: url(#id)`；
- **形变（deformation）**：直接用 CSS `transform: scale()/translate()` 驱动，浏览器按 Filter Effects L2 规范自动完成"反演采样"，等价于 Android 的 `InverseLayerScope`；
- **高光（highlight）**：Canvas 2D 逐像素烘焙 AGSL 高光 shader 的强度场（含方向性 bevel/rim 与加法混合）。

技术栈：**Vue 3 + TypeScript + Vite**，仅用 `npm` 管理。**纯 DOM + 浏览器原生技术，零 WebGL / 零 GLSL。**

---

## 2. 与原版的关系

| 维度 | Android 原版（`Kyant0/AndroidLiquidGlass`） | 本移植版 |
| --- | --- | --- |
| 语言 | Kotlin + Compose + AGSL shader | TypeScript + Vue 3 + Canvas 2D + CSS/SVG |
| 模糊 | `RenderEffect`（API ≥ 31） | CSS `backdrop-filter: blur()` |
| 折射 | `RuntimeShader`（`feDisplacementMap` 同族） | Canvas 生成的位移图 + SVG `feDisplacementMap` |
| 形变 | `InverseLayerScope` 手动反演 | CSS `transform`（浏览器自动反演） |
| 高光 | `AGSL` runtime shader + `BlendMode.Plus` | Canvas 2D 烘焙 + `mix-blend-mode: plus-lighter` |
| 演示承载 | `CatalogDestination` 状态机 | `src/core/destinations.ts` + Vue 组件切换 |

每个移植文件的**顶部注释都标注了它对应的 Kotlin 源文件路径**，便于对照上游实现。

上游仓库 `Kyant0/AndroidLiquidGlass` 的源码布局：
- Demo：`app/src/commonMain/kotlin/com/kyant/backdrop/catalog/`
- 库：`backdrop/src/commonMain/kotlin/com/kyant/backdrop/`

---

## 3. 技术路线与架构

### 3.1 分层：Vue 外壳 + 框架无关的 core

Vue **只承担外壳**：组件树、`props`、生命周期，以及一个全局失效信号。真正的核心逻辑全在 `src/core/` 里，是**框架无关的**——它与 Vue 唯一的耦合是 `src/core/animation.ts` 里的那个 `ref`（即 `animationRevision`）。

> 因此 `src/core/` 可以原样搬到 React / Svelte 等其它框架，只需重写外壳与那一个 `ref`。

**不要**引入 `vue-router` / `Pinia` / `<Transition>`：页面的"目的地"切换是手写状态机，所有形变都由手写 `requestAnimationFrame` 循环驱动。

### 3.2 玻璃渲染管线（GlassSurface）

每个 `GlassSurface` 由 5 层组成，**从下到上**：

1. **shadow canvas** —— 投影（drop shadow）；
2. **lens div（空节点）** —— 只承载 `backdrop-filter` + `clip-path`，**永远不能有子节点**（因为 `backdrop-filter` 会创建 backdrop root，子节点会被排除在 backdrop 之外）；
3. **overlay canvas** —— surface wash（表面染色）+ 非加法的 `Ambient` 高光；
4. **additive canvas** —— 按压高光 + 走 `BlendMode.Plus` 的高光环，使用 `mix-blend-mode: plus-lighter` 实现真正的**加法混合**；
5. **content** —— 真实 DOM 内容。

为什么高光要拆成两个画布？因为 **Canvas 做不到"加法"**。`globalCompositeOperation = 'lighter'` 只对*画布内部已有像素*生效；一张干净画布没有"底"可加，最终仍被浏览器按 `normal` 叠上去，结果是朝白的插值（`dst + a·(255−dst)`），而不是加法（`dst + a·255`）。所以凡是上游写 `BlendMode.Plus` 的东西，都必须画在带 `plus-lighter` 的 additive 画布上。

### 3.3 折射滤镜（glass-filter.ts）

`backdrop-filter` 只能采样元素**背后**已绘制的内容，所以玻璃**不需要**自己保存一份壁纸副本——浏览器替你抓取。模糊/饱和/亮度能 1:1 映射到 CSS 滤镜函数，但**折射**没有对应的 CSS 原语（"按向量场移动每个像素"），于是走 SVG 滤镜：

- 位移图在 Canvas 上按圆角矩形 **SDF** 生成（与 Android `RoundedRectRefractionShaderString` 同构）；
- `feDisplacementMap` 读取一张图，其中 **R = dx、G = dy**（128 = 不偏移），据此移动每个像素；
- **色散（chromatic aberration）**：上游 shader 沿折射偏移采样 7 次、带频谱权重。这里改用**三分支滤镜图**——红 `base·(1+i)`、绿 `base`、蓝 `base·(1−i)`，分别位移后 `feComposite arithmetic` 相加（3 次采样而非 7 次，白光守恒）。

位移图按 `(宽×高×圆角×折射深度×是否色散)` 做键缓存，相同形状共享一张位图；每帧只改最便宜的 `feDisplacementMap` 的 `scale` 来驱动动画。

同一条链还承载**烘焙 SDF 纹理**的折射（锁屏时钟）：位移图不是从圆角矩形解析求出，而是从纹理的 `r` / `gb` 通道解码得出，形状裁剪用纹理的 alpha 通道做 `mask-image`。见 §9。

### 3.4 高光系统（highlight-map / interactive-highlight）

上游给 `Default` / `Ambient` 高光建了 **AGSL shader** 并用 `paint.setRuntimeShader` —— 而 Android 的 Paint 会用*颜色 alpha* 调制 shader 输出，于是高光环 alpha = `样式颜色alpha · |⟨SDF外法线, (cos angle, sin angle)⟩| ^ falloff`。

- 直边恒为 `0.707`，圆帽一侧为 `1.0`、另一侧为 **0（高光断开）**；
- `Highlight.angle` / `falloff` 是这条公式的 uniform，不是装饰（`ControlCenterContent` 传 `falloff = 2`），随手丢掉会得到"每个组件一圈均匀白边"的错误效果；
- `Ambient` 与 `Default` 只差颜色，而那个差别**有语义**：`Ambient` 的 shader 是 `half4(t,t,t,1)·intensity`，AGSL 返回**预乘**值，于是 `d<0` 那半边是满强度黑——配 `SrcOver` 后 `d≥0` 提亮、`d<0` 压暗，所以 `Ambient` 是 **bevel（斜面）而不是 rim（描边）**；而 `Default` 是均匀白描边、`Plus` 混合。

实现见 `src/core/highlight-map.ts`：逐像素烘焙强度场 + 缓存，`paintRing` 用 `source-in` 把强度图乘进描边。**顺序要求先模糊几何、后乘强度图**，乘图前必须把 `scratch.filter` 复位为 `'none'`，否则会把场糊掉。

按压高光（`interactive-highlight.ts`）有两个分支：上游 `SDK_INT ≥ 33` 时画 `White@0.08·progress` 的平面铺底**加**跟随指针的径向光晕（`createRadialGradient` 即可表达 `smoothstep`）；否则单层 `0.25·progress`。Web 端两个分支**都要画**，且指针坐标必须用 `localPointerPosition()` 反解 CSS 变换（`getBoundingClientRect()` 给的是变换后的盒子，朴素 `clientX - rect.left` 会被拉伸量乘一遍，光点会漂离手指）。

### 3.5 动画与失效信号

- `Animatable` 等动画值是**普通 JS 对象**，由共享 `rAF` 循环步进；
- DOM / canvas 的失效信号是 `animationRevision`（`useFrameValue` 把它封装成 Vue `ref`）；
- **它必须是 Vue `ref`（响应式）**——一旦是普通 `number`，Vue 永不置脏，数学照算但 DOM/canvas 一帧都不更新，表现就是"所有控件点了没反应且无任何报错"。

### 3.6 形变与 transform 语义

`layerBlock` 与 `offset` 已合并成同一个 CSS `transform`：`GlassSurface.currentCssTransform()` = `translate(offset)` + `layerTransformToCss(t)`。

**关键规范事实**：`backdrop-filter` + `transform` **不会放大背景**。依据 Filter Effects Module Level 2：

- 渲染步骤会把元素 border box 变换到屏幕空间再裁剪 → 采样区 = 变换后的四边形（`scale(1.5)` 就取放大后的区域）；
- 随后对内部内容施加*逆变换* → 净效果 = 内容尺度不变、只是采样范围变大，背景被"钉"在屏幕上。

这正是液态玻璃的语义，而不是放大镜。换言之，Android 需要手动做的 `InverseLayerScope` 反演，**浏览器内部已经做了**，所以 `transform: scale()` 可以直接当形变用（且是合成层操作，性能优于改 `width/height`）。

---

## 4. 目录结构

```
WebLiquidGlass/
├── index.html
├── package.json
├── vite.config.ts            # base:'./'，别名 '@'→'./src'，dev 绑定 127.0.0.1:5173
├── tsconfig.json
├── public/                   # 壁纸等静态资源（useWallpaper 加载）
├── userscript/
│   └── liquid-glass-refract.user.js   # ★ 从 core/glass-filter.ts 提取的独立用户脚本（见 §10）
├── scripts/
│   └── stamp-userscript.mjs  # 发布时把 run number 打进脚本 @version（见 §10.6）
├── .github/workflows/deploy.yml       # Pages 部署：构建 Demo + 同步发布用户脚本
└── src/
    ├── main.ts               # createApp(App).mount('#app')
    ├── App.vue               # 外壳：destination 状态机 + 主题 + Back 按钮 + 布局 epoch
    ├── style.css             # 全局样式、安全区变量、明暗主题、user-select:none
    ├── core/                 # ★ 框架无关的真正主体（可搬到 React/Svelte）
    │   ├── animation.ts       # 共享 rAF 循环 + animationRevision(ref)
    │   ├── backdrop.ts        # Backdrop 退化为 { samples } —— 仅 RootBackdrop / EmptyBackdrop
    │   ├── draw-backdrop.ts   # 镜像 Compose drawBackdrop 的合成
    │   ├── glass-filter.ts    # 折射：Canvas SDF → feImage + feDisplacementMap（Chromium 专属）
    │   ├── highlight-map.ts   # 高光强度场逐像素烘焙 + 缓存（bevel/rim 方向性）
    │   ├── interactive-highlight.ts  # 按压高光两分支 + 指针坐标反解
    │   ├── destinations.ts    # CatalogDestination 类型（15 个目的地）
    │   ├── math.ts / geometry.ts / shapes.ts   # 数学与几何
    │   ├── color.ts           # argb(0xff34c759) 取 8 位 ARGB
    │   ├── damped-drag-animation.ts / drag-gestures.ts / transform-gestures.ts
    │   ├── velocity-tracker.ts / progress-converter.ts
    │   └── assets.ts
    ├── components/
    │   ├── GlassSurface.vue   # 5 层玻璃容器
    │   ├── LiquidButton.vue / LiquidToggle.vue / LiquidSlider.vue
    │   ├── LiquidBottomTabs.vue / LiquidBottomTab.vue
    │   ├── RippleSurface.vue  # 涟漪（依赖原生 @click）
    │   ├── BackdropDemoScaffold.vue
    │   └── FlightIcon.vue
    ├── composables/
    │   ├── useFrameValue.ts   # 把 animationRevision 映射成响应式 ref
    │   ├── useElementMetrics.ts  # 布局 epoch / getBoundingClientRect 反解
    │   ├── useTap.ts / useWallpaper.ts / backdrop-context.ts
    └── views/                # 14 个演示页（对应 14 个非 Home 目的地）
        ├── HomeContent.vue          # 目录网格
        ├── ButtonsContent.vue       # LiquidButton + 涟漪 + 玻璃
        ├── ToggleContent.vue        # 开关（thumb scaleY 形变 + bevel 高光）
        ├── SliderContent.vue        # 滑块（轨道 + thumb）
        ├── BottomTabsContent.vue    # 底部标签栏（玻璃指示器透镜折射条内内容）
        ├── DialogContent.vue        # 玻璃对话框
        ├── LockScreenContent.vue    # 媒体风格锁屏
        ├── ControlCenterContent.vue # iOS 风格控制中心（shadow=null，纵向拖拽）
        ├── MagnifierContent.vue     # 放大镜（backdrop 缩放 + 折射链）
        ├── GlassPlaygroundContent.vue  # 参数可调的玻璃实验台
        ├── AdaptiveLuminanceGlassContent.vue  # 亮度自适应玻璃
        ├── ProgressiveBlurContent.vue        # 渐进式模糊
        └── ScrollContainerContent.vue / LazyScrollContainerContent.vue
```

---

## 5. 环境要求与运行

**要求**：Node.js（本项目在 Node 24 下开发验证）+ `npm`。

```bash
# 安装依赖
npm install

# 启动开发服务器（http://127.0.0.1:5173）
npm run dev

# 类型检查（vue-tsc --noEmit）
npm run typecheck

# 生产构建（先 vue-tsc 再 vite build，产物在 dist/）
npm run build

# 预览构建产物（http://127.0.0.1:4173）
npm run preview

# 用户脚本：语法校验 / 按 CI 的方式打版到 dist/（详见 §10.6）
npm run check:userscript
npm run stage:userscript

# 折射探针（前两条纯 Node 零依赖；后两条用真实 Chromium，`probe:fidelity` 需要先 npm run dev）
npm run probe:map         # 编码层模型：位移图的 8 位阶梯（§10.10）
npm run probe:band        # 边缘带捷径 vs 全扫描，逐字节对照（§10.12）
npm run probe:render      # 采样层：相位标尺测出真实取样位置（§10.10）
npm run probe:fidelity    # 13 个目的地的渲染指纹，用于改动前后 A/B（§10.12）
```

`density = 1`，所以 Kotlin 里的 `xx.dp` 常量 1:1 映射成 CSS `px`，不做任何换算。

---

## 6. 浏览器兼容性

| 能力 | Chromium（Chrome/Edge 76+） | Safari / Firefox |
| --- | --- | --- |
| `backdrop-filter: blur()/saturate()/brightness()` | ✅ | ✅ |
| `backdrop-filter: url(#svg)`（折射） | ✅ | ❌（声明被接受但不绘制） |
| `mix-blend-mode: plus-lighter` | ✅ | ⚠️ 部分/需降级 |

折射（`url()` 进 `backdrop-filter`）是 **Chromium 扩展**。因此调用点**永远保留一条更早的 `blur()` 声明**作为降级；非 Chromium 引擎会忽略 `url()` 而只画模糊。色散能力通过 `isRefractionSupported()` 探测 UA 判断（`userAgentData.brands` 或 UA 正则），因为 `@supports` 在会解析但不绘制的引擎上会误报。

---

## 7. 源码对照表（节选）

| Web | 上游 Kotlin |
| --- | --- |
| `src/core/glass-filter.ts` | `Lens.kt` / `Shaders.kt`（折射、`RoundedRectRefractionShaderString`、`RoundedRectRefractionWithDispersionShaderString`） |
| `src/core/sdf-texture.ts` | `SdfShader.kt` + `SdfShaderString`（锁屏时钟的烘焙 SDF 纹理；见 §9） |
| `src/core/highlight-map.ts` | `HighlightStyle.kt`（AGSL `Ambient/Default` shader） |
| `src/core/backdrop.ts` | `LayerBackdrop` 体系（已退化为 Root/Empty） |
| `src/components/GlassSurface.vue` | Compose `Modifier` 玻璃链 |
| `src/App.vue` | `MainContent.kt` + `BackHandler.kt` |
| `src/core/destinations.ts` | `CatalogDestination` |
| `src/core/animation.ts` | Compose `Animatable` / `InfiniteAnimationPolicy` |

---

## 8. 已知限制与后续方向

- 折射在非 Chromium 浏览器上不可用（已降级为纯模糊）。
- 部分高频滤镜图有 96 张上限的 LRU 缓存（`mapCache`）。
- 站点若用 CSP 限制 `img-src`（不允许 `data:`），`<feImage>` 的位移图会被拒绝且**完全静默**——详见 [§10](#10-用户脚本liquid-glass-refraction)。
- 无头环境（`--dump-dom`）会饿死 `rAF`，弹簧动画只出极少帧——验证动画是否在跑应读 inline transform 是否随时间变化，而非看截图。
- **大面积玻璃仍然昂贵，且代价集中在一处**：每个玻璃表面都要为 `backdrop-filter` 维护一份独立的滤镜图（SDF → 位移图 → `feImage` + `feDisplacementMap`），其中**只有那条 `url(#…)` 位移图在花帧时间**——去掉它，一屏 20 个面就从 8.5 fps 回到 63 fps（与全部隐藏玻璃层同速）。所以约束是**同屏折射面的数量与面积**，不是 JS 或布局；实测、口径与已清掉的浪费见 [§11](#11-性能)。
- `colorControls` 的 `brightness` 在原版是**加法**（进颜色矩阵的常数项 `t = (0.5 − 0.5c + brightness)·255`），而 CSS 的 `brightness()` 是**乘法**；CSS `contrast(0.75)` 自带的常数 31.875 比原版的 6.375 大 25.5，中灰偏亮约 6%。时钟板已改为在滤镜里用 `feColorMatrix` 精确实现（见 §9），**其余页面仍是 CSS 版**。
- 后续可探索：把 `glass-filter` 的位移图生成移到 Worker、对非 Chromium 增加 WebGL 折射 fallback（若届时允许引入 WebGL）。

---

## 9. 时钟板：烘焙 SDF 纹理的折射（`LockScreenContent`）

原版锁屏那串 "12:45" 不是文字，是**一张烘焙好的 SDF 纹理**（`clock_sdf`，1599×515），由 `SdfShader.apply(48.dp, 45f)` 上屏。通道约定（权威来自 AGSL 源码 `SdfShaderString`，下表每个数字都是实测的）：

| 通道 | 含义 | 实测 |
| --- | --- | --- |
| `r` | 有符号距离 `sd = r/255·2 − 1`，形状外为中性 128 | 形状内占 33.6% |
| `gb` | 单位法线 `normalize(gb/255·2 − 1)` | remap 后 `\|n\|` 均值 **1.005** |
| `a` | 形状掩码 `smoothstep(0.5, 1, a)` | 全透明 54.7% / 全不透明 31.2% / 软边 14.1% |

shader 只对 `sd < 0`（内部）生效：`intensity = circleMap(1 − min(1, −sd·1.5))` 在边界处为 1、向内到 `sd = −0.667` 衰减到 0，所以有效折射带是 **R ∈ (42.5, 127.5)** —— 与 `lens()` 的 rim band 同构，只是形状不再是解析的圆角矩形。

Web 侧**不是近似，是三处精确替换**（解码在 `src/core/sdf-texture.ts`，滤镜分支是 `glass-filter.ts` 的 `spec.sdf`）：

| 原版 shader | Web | 为什么成立 |
| --- | --- | --- |
| `content.eval(refractedCoord)` | `feDisplacementMap` 读**由纹理解码出的位移图** | 位图格式与 `lens()` 那份完全相同，只换了 `sd` 与法线的来源 |
| `content.eval(...) * v.a` | lens 上 `mask-image: url(clock_sdf.webp)` | 纹理的 alpha 通道**就是** `v.a`；直指原资源，字形轮廓保持全分辨率 |
| 两段 `color.rgb *= 1 + k` | 一张 `α` 乘法图 + `feComposite arithmetic k1=1 k3=1` | `k1·map·color + k3·color = color·(1+α)`；两段合并为单个 `1+α`，交叉项恒为 0，故 `α ∈ [0, 0.5]` 不裁切 |

`onDrawBackdrop` 里那层 25% 白走 `feFlood` + `feComposite operator="over"`（`GlassSurface` 的 `backdropWash`），**必须留在滤镜图内**：上游它是被录制进同一个 graphics layer 的，会被 `* v.a` 一起裁进字形；改画到 `onDrawSurface` 就变成盖住整个 400×129 盒子的白矩形。

### 9.1 页级遮罩：`backdropScrim`

整屏压暗的那层 30% 黑（`Column(Modifier.background(Black.copy(0.3f)))`）**不在**板子采样的 backdrop 里：`BackdropDemoScaffold` 把 `layerBackdrop(backdrop)` 只挂在壁纸 `Image` 上，遮罩是它的兄弟节点、绘制在后，而 `LayerBackdropNode.draw()` 录的只有那一个 `drawContent()`。于是原版字形内折射**原始壁纸**（亮）、字形外是被压暗的壁纸（暗）—— 这才是"光透过玻璃雕的字"的来历。

`backdrop-filter` 抓的却是**物理上位于其后的一切**，遮罩在内，字形被压暗两次，整块塌成贴在壁纸上的平涂。既然污染只是一次常数乘法（`rgba(0,0,0,a)` 覆盖 `W` 得 `(1−a)·W`），就可以在采样之后精确除回去：`GlassSurface` 的 `backdropScrim` → `RefractionSpec.backdropGain = 1/(1−a)` → 链首一个**独立**的对角 `feColorMatrix`。

- 必须**最前**：污染在 blur 的输入端，而 blur 是线性的（`blur((1−a)·W) = (1−a)·blur(W)`），所以求逆放在 blur 之后仍然精确。
- 必须**独立**：wash 是 `over` 合成（要等价需要把系数变成 `0.75/0.7 > 1`，做不到），而更下面的色彩矩阵是 `colorControls` 自己的载体。
- **不会削顶**：遮罩已把值压到 `≤ 178.5`，乘 `1/0.7` 恰好回到 `≤ 255`；唯一残差是遮罩自身的 8-bit 量化（`≤ 0.7` 码值）。
- 只有声明过的目的地才生成该图元（`hasGain` 参与图结构的缓存键），其余 12 个目的地图元一个不多。

> ⚠️ **反例别混**：`ControlCenterContent` 的 `dimColor` 语义相反 —— 原版那个 dim 在 `drawWithContent { drawContent(); drawRect(dimColor) }` 里、**位于 `layerBackdrop` 之内**，是**应该**被玻璃采样的。

### 9.2 已知差异

- 时钟是**静态字形**（原版烘的就是 "12:45" 这张纹理，不是走时的钟）。要让它走时，代价按更新频率摊薄：秒针级（每秒 1 次）约 **0.13 ms/帧**，可忽略；每帧动画（数字翻滚）约 **468 ms/秒**，不可行 —— 因为 `feImage` 的 `href` 一换，整条过滤器图就要重新光栅化。
- `colorControls` 目前只在这条 SDF 路径上进滤镜（`feColorMatrix`）。**其余页面的 brightness 仍是 CSS 的乘法版**，与原版的加法语义差一个常数 25.5 —— 见 [§8](#8-已知限制与后续方向)。
---

## 10. 用户脚本（Liquid Glass Refraction）

`src/core/glass-filter.ts` 是**零依赖**模块（整个文件没有一个 `import`），因此被单独提取成了一个可直接安装的用户脚本，用于把**任意网站上的任意元素**变成液态玻璃折射透镜。

### 10.1 绝对路径

发布走本项目既有的 GitHub Pages 工作流，脚本与 Demo 同源同版本，推送到 `main` 即自动同步：

| 用途 | 绝对路径 |
| --- | --- |
| 脚本文件（安装 / `@require` / `@updateURL`） | `https://someonehx.github.io/WebLiquidGlass/liquid-glass-refract.user.js` |
| Demo 站点（部署根） | `https://someonehx.github.io/WebLiquidGlass/` |
| 源码（仓库内，随 Pages 一起发布） | `https://github.com/SomeoneHX/WebLiquidGlass/blob/main/userscript/liquid-glass-refract.user.js` |

> Pages 侧的 `@version` 由 CI 按 workflow run number 自动打版（`0.2.<run_number>`），因此每次推送都会产生一个新版本，安装过的人会在管理器下次检查时自动更新。仓库内的文件保留手写的基础版本号，`scripts/stamp-userscript.mjs` 是两者唯一允许不一致的地方。

### 10.2 三种引入方式

```js
// ① 直接安装（Tampermonkey / Violentmonkey）：打开上面的脚本地址即可，@updateURL 会自动接收更新

// ② 在你自己的用户脚本里 @require 它：
// @require      https://someonehx.github.io/WebLiquidGlass/liquid-glass-refract.user.js
// @grant        none
// 脚本执行后 API 落在 window.LiquidGlassRefract（沙箱模式下用 unsafeWindow 读取）：
const { apply, unglassify } = window.LiquidGlassRefract
apply(document.querySelector('.header'), { blur: 12, refractionAmount: 30 })

// ③ 普通网页里直接用 <script src>：
// <script src="https://someonehx.github.io/WebLiquidGlass/liquid-glass-refract.user.js"></script>
```

脚本**默认不做任何事**（没有配置就不扫描、不修改任何元素），所以 `@require` 进来是安全的；重复引入会被自身的加载守卫忽略，不会重复绑监听。它同时也是**拼接安全**的（首尾各有分号守卫，理由见 §10.6）。

### 10.3 配置：在执行脚本前赋值 `window.LiquidGlassRefractConfig`

```js
window.LiquidGlassRefractConfig = {
  selectors: ['.header', 'nav'],     // 自动应用的选择器；留空 = 什么都不做
  autoWatch: true,                   // 用 MutationObserver 跟进 SPA 动态插入的节点（rAF 合并）
  hotkeys: { glassify: 'alt+shift+g', unglassify: 'alt+shift+u' },  // 或 false 关闭
  defaults: { blur: 12, refractionHeight: 24 }   // 合并进默认参数
}
```

热键作用于**鼠标当前指向的元素**（`document.elementFromPoint`，不依赖焦点），组合键串支持 `alt` / `shift` / `ctrl` / `meta`。

### 10.4 API

| 方法 | 说明 |
| --- | --- |
| `apply(el, options?)` | 把元素变成玻璃透镜。与 `glassify` 同一函数，公开名用 `apply` |
| `glassify(el, options?)` | 同上。对**同一元素**重复调用 = 更新参数（幂等） |
| `unglassify(el)` | 撤销：恢复此前的 inline 样式、移除 `<filter>`、注销 `ResizeObserver` |
| `applyAll()` | 立即按 `selectors` 扫描一遍，返回本次新应用的元素数组 |
| `isRefractionSupported()` | 引擎探针（Chromium 才行） |
| `createGlassFilter()` | 低层：只拿 SVG 滤镜图（`{ id, update(spec, amount, zoom?, overlay?), dispose() }`），自己写宿主 |
| `activeCount()` | 当前存活的玻璃面数量 |
| `DEFAULTS` / `FILTER_PAD` / `config` / `version` | 默认参数、滤镜外扩内边距（64px）、生效配置、版本号 |

`apply` 的参数：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `blur` / `saturate` / `brightness` | `8` / `1.6` / `1.06` | 与折射同处一条 `backdrop-filter`；也必须靠前者，裸 `url()` 会被 Chromium 静默忽略 |
| `refractionHeight` | `18` | 从边缘向内多深开始弯曲（px） |
| `refractionAmount` | `22` | 边缘最大位移（px），直接进 `feDisplacementMap@scale` |
| `depthEffect` | `true` | 把向心方向混进弯折梯度 |
| `chromaticAberration` | `false` | 三分支色散：3 张位移图 + 11 段滤镜图 |
| `maxArea` | `490000` | 面积上限，超过则跳过并 warn（SDF 逐像素逐分支，大元素会卡主线程） |

### 10.5 使用前须知

- **必须自己给 tint**：脚本不改元素自身样式，元素需要有半透明背景（如 `background: rgba(255,255,255,.16)`），否则只有透镜没有磨砂色；
- **形状即 `border-radius`**：圆角从 computed style 读取，想要胶囊就写 `border-radius: 50%` 或大圆角，位移图按同一几何生成；
- **仅 Chromium**：Safari / Firefox 会把带 `url()` 的整条声明丢掉，脚本对这类引擎只写纯模糊；
- **CSP 是硬门槛**：页面若限制 `img-src` 不允许 `data:`，位移图会被拒且不报错（每个 `<feImage>` 触发一次 `securitypolicyviolation`，但控制台不会有任何报错），脚本用 1×1 PNG 探针检出后整体降级为纯磨砂并 `console.warn` 原因。**被拒时最终上屏结果与纯 `blur()` 控制组逐像素相同**（实测 0 px / 57600），所以损失的是"透镜"本身与那份被浪费的 SDF/PNG 计算，而不是画面画错；哪些站点会命中见 [§10.8](#108-实测真实站点的-csp-分布)；
- **祖先元素会截断 backdrop**：任何带 `filter` / `opacity < 1` / `mask` 的祖先都会成为 backdrop root，玻璃只能采到它内部的内容；
- **静态透镜**：这是从 `GlassSurface` 抽出的**滤镜层**，不含投影 / 高光 / 按压高光 / 形变 / 手势 / 动画驱动，强度变化需要调用方自己重设参数。

### 10.6 生成、校验与发布

```bash
npm run check:userscript    # 语法 + 拼接安全 + 版本一致性（见下）
npm run stage:userscript    # 本地按 CI 的方式打版输出到 dist/liquid-glass-refract.user.js
npm run dev                 # 浏览器里验证（把脚本粘进测试页即可，见下）
```

重新生成（若上游 `src/core/glass-filter.ts` 改动）——用项目自带 tsc 剥类型，**不要手抄算法**：

```bash
./node_modules/.bin/tsc src/core/glass-filter.ts --target es2022 --module esnext --outDir /tmp/strip
```

后处理只有两步：去掉**行首**的 `export ` 前缀（`FILTER_PAD` / `isRefractionSupported` / `createGlassFilter` 三处），以及下面那一行 `svgRoot()`。

**定位第 1 段不要写死行号**，用与探针相同的标记：从 `/** SVG refraction filter for` 之前最近的 `/*`，到 `* 2. Userscript host` 之前最近的 `/*`。拼接前先做**不变量检查**（无残留的行首 `export `、含 `svgRoot()` 那条 deviation、含 `NEUTRAL_WORD` / `buildMap` / `createGlassFilter`），不等就拒绝写入。

改完必须跑：`npm run check:userscript` + `npm run probe:band` + `npm run probe:render`。

⚠️ **核心不许依赖 `ctx.canvas`**：`probe:map` 在 Node 里用一套假 DOM 求值第 1 段，其假 canvas 的 `getContext()` 只提供 `createImageData` / `putImageData`，**没有 `canvas` 反向引用**——`ctx.canvas.toDataURL(...)` 会直接把 `npm run probe:map` 打挂（`TypeError: ... reading 'toDataURL'`）。helper 返回**元素本身**即可，不要绕道 `ctx`。

第 1 段内只有**一行**与提取源不同：`svgRoot()` 里 `document.body || document.documentElement`，以便在 `<body>` 存在之前执行（`@require` 就是这种情况）。

**拼接安全靠两处分号守卫**，它们在第 1 段之外的头部/尾部，重新同步不会碰到：

- **开头**：整个脚本是一个 IIFE，而它的第一个 token 是 `(` —— 这正是 ASI **不会**与上一行分开的那一类。上一行若是 `someCall()`，会被解析成 `someCall()(function () { … })()`，把返回值当函数调用。所以文件里写的是 `;(function () {`。
- **结尾**：`})()` 后面必须带分号，否则紧跟其后、以 `(` 开头的语句会被它吞掉。

这两种合并**在语法上都是合法的**——`node --check` 与任何解析器都分不出来，只有源码文本能。所以 `npm run check:userscript`（`scripts/check-userscript.mjs`）是按**文本**断言这两处，并顺带校验 `@version` 与 `const VERSION` 一致。

### 10.7 实测数据（无头 Chromium，320×180 / r=28 / refractionHeight=22）

| 项 | 结果 |
| --- | --- |
| 滤镜图 | 11 个 primitive，`scale 94.9 ｜ 52 ｜ 94.9`，`filterUnits=userSpaceOnUse`、`color-interpolation-filters=sRGB` |
| 位移图 | 448×308（= 元素 + `FILTER_PAD`×2），rim 17328 / 137984 px，最大偏差 111/127，`data:` URL ≈23 KB |
| 折射是否上屏 | 仅把 `refractionAmount` 从 0 改到 34：11995 px 不同、maxdelta 77、差异 bbox 恰为元素框；差异**全在 inset ≤ 19px**，≥20px 深 0 px、框外 0 px |
| CSP `img-src 'none'` | 位移图被拒（`securitypolicyviolation: img-src`，每个 map 一次），`refractionAmount` 0→30 **0 px 差异**；与同页纯 `blur()` 控制组相比 **0 px / 57600**，即"只剩磨砂、没有透镜" |
| 引入幂等 | 同一页引入两次：只有 1 个 `<filter>`、热键日志只出现 1 次 |
| SPA 跟进 | `autoWatch: true` 下动态插入的匹配节点在一个 rAF 后自动上玻璃 |

---

### 10.8 实测：真实站点的 CSP 分布

2026-09-12 抽查约 70 个站点的根路径响应头，并在其中 4 个站点上用真实浏览器跑了脚本同款探针（`new Image()` + 1×1 `data:` PNG）：

| 情况 | 站点（节选） | 透镜 |
| --- | --- | --- |
| `img-src` 不含 `data:` | **stackoverflow.com** / serverfault.com / superuser.com（均为 `img-src 'self' https://challenges.cloudflare.com`）、**pypi.org** | ❌ 静默降级 |
| `img-src` 含 `data:` | github.com（`img-src 'self' data: blob: …`）、gitlab.com、linear.app、vercel.com、nextjs.org（`img-src * blob: data:`）、apple.com、www.icloud.com、atlassian.com、stripe.com、docs.qq.com、store.steampowered.com | ✅ |
| 根路径无 CSP 头 | developer.mozilla.org、news.ycombinator.com、google.com / youtube.com、x.com、reddit.com、npmjs.com、claude.ai、chatgpt.com、figma.com、notion.so、zhihu.com、bilibili.com、taobao.com、jd.com、weibo.com、douyin.com、slack.com、discord.com、twitch.tv、wikipedia.org | ✅ |

真站探针结果（浏览器内实测）：`stackoverflow.com` → `data: 被拒`、`pypi.org` → `data: 被拒`、`github.com` → `data: 可加载`、`developer.mozilla.org` → `data: 可加载`——与头部结论一致。

三点判读说明：

- **`default-src` 是 `img-src` 的兜底**：只写 `default-src 'self'` 而没写 `img-src` 的页面同样会拒；反之 `github.com` 写着 `default-src 'none'` 却因为显式 `img-src … data: …` 而放行。
- 上表只看**根路径响应头**。`<meta http-equiv="Content-Security-Policy">` 形式、只对部分子路径下发的 CSP、以及 SPA 路由切换后新增的策略都看不到——**以脚本自己的探针为准**（它就在真实页面上跑）。
- 命中时的表现是"磨砂正常、透镜没有"，不会画错也不会报错；判断依据只有一个：位移图那张 `data:` PNG 能不能被解码。

### 10.9 位移的零点与量化：内容为什么往左上偏

`feDisplacementMap` 的偏移是 `scale × (value/255 − 0.5)`，精确零点落在 **127.5**，8 位通道表达不了它。写 128 时整幅位移图带一个常数项 **+0.5 LSB = +`scale/510` px**，取样方向朝 (+x, +y)——取样点偏右偏下，透镜里的内容（含背景）就整体往**左上**偏。Skia 的光栅实现就是这条式子（`src/effects/imagefilters/SkDisplacementMapImageFilter.cpp`）：

```cpp
const SkVector scaleForColor = SkVector::Make(scale.fX * Inv8bit, scale.fY * Inv8bit);
const SkVector scaleAdj = SkVector::Make(SK_ScalarHalf - scale.fX * SK_ScalarHalf, ...);
SkScalar displX = scaleForColor.fX * ex.getX(*displPtr) + scaleAdj.fX;  // = scale × (v/255 − 0.5) + 0.5
const int srcX = x + SkScalarTruncToInt(displX);                        // 截断 + 整数取样
```

**这个常数项要落到屏上，得先过光栅器的取整。** 线性渐变背景 + 2.4 万像素平均（位移分辨率 ≈0.02 px）实测本仓库脚本（`scale = 2 × amount`）：

| amount | ≤126 | 127 | 128 … 382 | 383 … |
| --- | --- | --- | --- | --- |
| 常数项（理论） | ≤0.494 | 0.498 | 0.502 … 1.498 | 1.502 … |
| 实测位移 | **0.000 px** | 0.63 px（刀口，仅部分像素） | **1.01 px** | **2.02 px** |

台阶步长 255（按 scale 折算 510），且同一台阶内的截图**逐字节相同**（scale 255 与 764 渲染一致，765 起跳到 2 px）——渲染结果是**整像素阶梯**，不是随 amount 线性增长的亚像素漂移。两条独立证据说明这条链没有插值：1 px 棋盘背景在任何 scale 下对比度都不变（std 110.42 / p2p 255）；整数位移的截图逐字节相同。亚像素量级的残差在屏上看不出变化，但偏移本身没有消失：`amount ≤ 126` 时透镜内部与背景逐像素相同，`amount` 越过 127 之后**整个内部会平移 1 个整像素并从此保持**。目录里没有任何组件能到这个量级，**游乐场能**——见 §10.11。

> 一个比零点项重要得多的保真度事实：本环境下 Chromium 把位移**量化到整像素、取样不插值**，而 Android 原版的 AGSL 是在浮点坐标上取样的——`float2 refractedCoord = coord + d * grad; return content.eval(refractedCoord);`（`backdrop/src/commonMain/kotlin/com/kyant/backdrop/internal/Shaders.kt` 的 `RoundedRectRefractionShaderString`）。原版既无零点偏差、位移场也是连续的；web 端受光栅器限制只能整像素跳。这才是这次移植的真实保真度上限，与 0.5 LSB 的零点项无关。（§10.10 的探针把这条从"本环境如此"坐实为**真 GPU 上同样如此**：headless 走的是 ANGLE Metal / AMD Radeon RX 570，不是软件光栅器。）

### 10.10 复现测量：量化口径是 1 设备像素，坑口高度 = `amount × √(2/bezel)`

上一节的结论可以用 `scripts/refraction-probe.mjs` 一条命令复现，它不加任何依赖（CDP 走内置 `WebSocket`，PNG 用内置 `zlib` 解），并且**直接求值已提交的用户脚本里那段核心**，不复制第二份实现：

```bash
node scripts/refraction-probe.mjs map                    # 编码层：位移图的 8 位阶梯 + 各目录参数下的整数偏移阶梯
node scripts/refraction-probe.mjs render --dpr=1         # 采样层：真实 Chromium，相位标尺测出 s(x)
node scripts/refraction-probe.mjs render --dpr=2         # 同一页面在 2 倍密度下
node scripts/refraction-probe.mjs render --bg=checker --blur=1   # 位移前 blur 对边缘接缝的 A/B
```

采样层把背景换成按设备像素线性上升的"标尺"（`(3x) mod 256`，斜率处处恰为整数级/设备像素；相位逐行错开，锯齿复位列由逐列中位数丢掉），于是每个输出列的取样位置都能反解出来。`amount = 32, refractionHeight = 18` 实测：

| dpr | 沿边框向内的整数偏移（设备 px，每项是段起点） | 段数 | 相邻最大跳 |
| --- | --- | --- | --- |
| 1 | 32@0 21@1 17@2 14@3 12@4 10@5 8@6 7@7 5@8 4@9 3@10 2@12 1@13 0@16 | 14 | **11.00 px = 11.00 CSS px** |
| 2 | 48 59 48 41 37 33 30 28 25 23 21 19 17 16 14 13 11 10 9 8 7 6 5 4 3 2 1 0 | 28 | **11.00 px = 5.50 CSS px** |

每一段都**精确**落在整数设备像素上（残差 0.000 px；`amount = 0` 时全图零位移且与无透镜参考逐像素一致），即取样被舍入到整数设备像素，而非插值。**段数与 `amount × dpr` 一起翻倍、每段跳幅随之减半**——这是高密度屏唯一的"免费"改善。dpr 2 的头三列（48 / 59 / 48）不是平台段：位移图本身是 **CSS 像素**分辨率的位图，在非整数缩放下被双线性放大，坑口会被抹到最外约 2 个设备列上；dpr 1 时图与设备栅格对齐，所以最外一列读到的是干净的 `amount`。

边框高度是唯一能压坑口的几何旋钮（`amount = 32`，实测首跳 = 平台段数）：

| refractionHeight | 6 | 12 | 18 | 24 | 48 |
| --- | --- | --- | --- | --- | --- |
| 首跳（实测） | 18.00 | 13.00 | 11.00 | 9.00 | 7.00 |
| 段数（实测） | 7 | 11 | 14 | 17 | 19 |
| `amount·√(2/bezel)` | 18.5 | 12.8 | 10.5 | 9.1 | 6.5 |

因为 `circleMap` 的 `1−√(1−t²)` 在 `t→1` 处斜率无穷，最外一列取样点必然吃到**整个** `amount`，紧邻一列只吃到 `falloff(−1) = 1−√(2/bezel − 1/bezel²)`——两者之差就是坑口。这条在原版 AGSL 里同样存在（连续取样也只是把两个相距 `amount` 的取样点连起来），所以**它不是 web 的误差，是 `Shaders.kt` 的设计**。`refractionHeight` 是 1:1 照搬 Kotlin 的参数，改它属于有意偏离原版。

位移前的 `blur` 是唯一不碰几何、却能降低可见度的杠杆。1 设备像素棋盘背景、`amount = 14/32`，量边缘一列与外侧相邻一列的对比度：

| 位移前 blur | 0 px | 0.5 px | 1 px | 2 px | 4 px |
| --- | --- | --- | --- | --- | --- |
| 边缘接缝对比度（级） | 127.5 | 84.8 | 64.0 | 64.0 | 64.0 |
| 透镜外部的背景纹理（对照） | 255.0 | 255.0 | 255.0 | 255.0 | 255.0 |

外面那行是不变量：`blur` 只作用于元素**背后**的背景，透镜外的棋盘纹理始终满对比。所以 1 px 就能拿到大部分收益、再往上饱和——这与目录里三个动画部件的写法正好相反：`LiquidToggle` / `LiquidSlider` 是 `blur(dp(8) × (1 − progress))`，**按下到最深处时 blur 归零、透镜同时最强**，恰好落在最差的一格。

### 10.11 游乐场里能看见的那个整像素：中性 128 的偏置什么时候才够得着

`GlassPlaygroundContent` 的旋钮是 `refractionAmountFraction × minDimension`，hero 卡是 `256 × 256`，所以 `amount` 一路到 **256**，`scale = 2 × amount` 在 **fraction 0.5** 就跨过 255 这条刀口——§10.9 那条零点偏置在这里是**看得见的**：

```
$ node scripts/refraction-probe.mjs render --probe=shift --bg=noise \
    --size=256x256 --radius=128 --lens=300,120 --bezel=25.6 --depth \
    --amounts=0,120,127,128,255,382,512
amount | scale | neutral bias | predicted | sample offset | content shift | rms
     0 |    0.0 |  0.0000 px |   0 px | (  0,   0) | (  0,   0) | 0.00
   120 |  240.0 |  0.4706 px |   0 px | (  0,   0) | (  0,   0) | 0.00
   127 |  254.0 |  0.4980 px |   0 px | (  1,   1) | ( -1,  -1) | 0.00
   128 |  256.0 |  0.5020 px |   1 px | (  1,   1) | ( -1,  -1) | 0.00
   255 |  510.0 |  1.0000 px |   1 px | (  1,   1) | ( -1,  -1) | 0.00
   382 |  764.0 |  1.4980 px |   1 px | (  2,   2) | ( -2,  -2) | 0.00
   512 | 1024.0 |  2.0078 px |   2 px | (  2,   2) | ( -2,  -2) | 0.00
```

`sample offset` 是"这个输出像素从哪读"，所以**内容往 (−1, −1) 跑，即左上**；`rms 0.00` 表示透镜内部与"整体平移 1 px 后的背景"**逐字节相同**——不是模糊、不是插值，是刚性整像素搬运。刀口在 `amount 127` 与 `382`（实测比理想的 127.5 / 382.5 早一个通道，属光栅器自己的取整，量级 0.002 LSB）。把它压成画像：`amount 0` 时 3×3 全格 `(0,0) rms 0.0`；`amount 128` 时**内部四格全变 `(1,1) rms 0.0`**，只有贴边的格子 `rms 80–90`（那里位移场本身在变，"刚性平移"没有意义）。

所以"看起来是平滑的"和"算术上是整像素"可以同时成立：整个滑块行程里只有 **0 → 1 → 2 三个状态**，而**整体一起跳 1 px 是看不出台阶的**——尤其在你正拖着滑块的时候。真正在"越拉越偏"的那种连续感，来自边框带（rms 80–90 的那些格子），那圈内容被往外推、幅度随 `amount` 线性增长，右下角那一侧看起来就是往右下角被拽。

### 10.12 回归验证：`probe:band` 与 `probe:fidelity`

§10.10 / §10.11 的两条口径回答"折射**看起来**是什么"，这一节的两条回答"**改动有没有偷偷改变它**"。加它们的原因很直接：`glass-filter.ts` 里所有"同输出、少做事"的优化——只扫描边缘带的位移图、跳过同值写入、滚动时不重绘装饰画布——都是关于**等价性**的断言，而没有任何一张截图能证明它们。

```bash
npm run probe:band        # 纯 Node、零依赖、不需要浏览器也不需要 dev server；可直接当 CI 门禁
npm run probe:fidelity    # 需要先 `npm run dev`；13 个目的地 × 7 个字段的渲染指纹
```

**`band`**：`buildMap` 不再遍历整个 padded 区域，只走它的 SDF 边界允许的行列。这条边界是**推理**的产物，而推理会错——带取窄了就会静默丢掉真实边缘像素，折射微妙地失真，而仓库里其它任何东西都发现不了（图照编、滤镜照跑、测试照过）。所以它拿一个**全扫描**做对照：`sdf` / `gradSdf` / `clampByte` 都取自已提交的核心（由 `loadCore` 暴露），即**只重述被测试的那部分——循环结构**，不重述数学。中性灰也一样，是**从已提交的位图里读回来**的，不是另写一遍常量，所以改了中性值也不会让两边在错误答案上"达成一致"。

12 种几何 × 光谱分支逐字节比对。这条边界有两种容易写错的方式，脚本注释里各留了一条：

| 错误 | 后果 |
| --- | --- |
| 用 `d ≥ max(qx,qy) − r` 当下界 | 该不等式成立，但推不出 `max ≥ r − bezel` → **漏掉圆角外侧的对角线** |
| 右边界用排他上界 `to = w` | `x = w` 处 `d` 恰为 0，而 0 在边缘测试之内 → **漏掉最后一列** |

把第二条重新注回脚本，`band` 立刻报 `NO` 并指出首个差异像素是 `x = 1408, y = 32`——测试有效，且能定位。

**`fidelity`**：对 13 个目的地采 7 个字段——`feImage` 的 href 哈希、图元盒、`feDisplacementMap[scale]`、`<filter>` 区域、lens 计算样式、装饰画布的 CSS 盒 + transform + blend + display、表面数。先记录，改一处，再比对：

```bash
node scripts/refraction-probe.mjs fidelity --write=/tmp/base.json
# ...改一处...
node scripts/refraction-probe.mjs fidelity --baseline=/tmp/base.json   # 有不一致则 exit 1
```

两条诚实的边界：

- 它是 **A/B 工具而非门禁**。指纹覆盖位移图的**字节**，同一构建重复跑完全一致（已验证），但它绑在渲染器版本上——浏览器升级后合理变化。所以用法是"记录基线 → 改一处 → 比对"，不是在 CI 里当恒定断言。
- 画布字段**不含 `canvas.width/height`**。那两个值是**剔除状态**：视口外的面已释放 backing store，而采样瞬间哪些面在视口外取决于帧循环跑到哪里——这被实测到过：同一构建两次运行，102 面的那一页报了不一致。CSS 盒、transform、blend、display 由布局决定、不随剔除移动，所以它们能抓到合成变化而不会连时钟一起抓。活跃画布数作为信息单独打印，**不参与比对**。

`fidelity` 每个目的地起一个**全新浏览器**：复用同一个标签页会在第三、四个页面之后让渲染进程彻底停止应答 `Runtime.evaluate`（手工挂载/卸载几个玻璃页也能复现）。冷启动两秒，相对一页指纹可以忽略。某个目的地失败会被记录、跳过，并让退出码非零——**跳过的目的地不算通过**。

## 11. 性能

一条命令复现下面所有数字（需要先 `npm run dev`）：

```bash
npm run probe:perf
```

口径：`ScrollContainer` 的 20 条整宽玻璃行，**每帧推进一次滚动**、共 30 帧。这个定义很关键——滚动只在产出帧时才前进，**所以滚完所用的时间就是帧预算**。若改成"一个时间窗里出了多少帧"，慢的构建会把整窗都花在滚动上、快的提前滚完然后空转，反而把慢的那一侧说得好听。每档跑 3 遍取中位数，极差一并打印。

| 状态 | fps（3 遍） | 滚完耗时 | 主线程占用 | 过滤器属性写入 | 画布操作 |
| --- | --- | --- | --- | --- | --- |
| 现状 | **8.5**（6.9–9.2） | 3531 ms | 2.9% | **0** | 154 |
| 去掉 `url(#…)`，只留 `blur/saturate/brightness` | **63**（62–63.1） | 476 ms | 17.1% | 0 | 154 |
| 隐藏全部玻璃层 | **63**（62.9–63.7） | 476 ms | 13.3% | 0 | 154 |

两个能直接读出来的结论：

1. **全部帧代价就是那条 SVG 位移图。** 去掉 `url(#…)` 就与"把玻璃层全隐藏"完全同速（63 = 63，滚完耗时同为 476 ms）——纯 `blur() saturate() brightness()` 在这个尺寸与数量下**基本免费**。
2. **低 fps 配低主线程占用 = 瓶颈在光栅化，不在 JS。** 现状一档只占 2.9% 主线程却只有 8.5 fps；反倒是 63 fps 的两档"主线程占用"更高（十几 %），因为墙钟时间短、同一段 JS 被摊到更小的分母上。任何"是不是 JS 太慢"的猜测，看这两列就能否掉。

（§10.10 / §10.11 讲折射**看起来**是什么，这里讲它**花多少**——共用同一套探针。）

### 11.1 每帧只做必要的事

这一链只做"同一输出、少做事"，**没有任何降级**：滚动时折射照常全速运行。

| 位置 | 做法 |
| --- | --- |
| `glassFilter.update()` | 按节点记住上次的 `feDisplacementMap[scale]`，同值不写——滚动时该值每帧完全相同（上表 `fe 写入 = 0`）。写过滤器图元属性会让过滤器失效 |
| `buildMap` | 只扫描边界允许的行列，中性灰一次 `Uint32Array.fill` 写入；12 种几何的全扫描对照见 §10.12 |
| `MAP_LIMIT` | 96（一次带色散的按压就要 18 个条目，32 会把自己淘汰掉） |
| `isRefractionSupported()` | 记忆化 |
| `GlassSurface` 的样式写入 | transform / clip-path / 遮罩梯度 / `backdrop-filter` 同值跳过 |
| 三层装饰画布 | 绘制签名不变则跳过（上表 `画布操作 = 154` / 30 帧） |

**按压的另一处代价**（同一命令的第二个场景）：`Toggle` 按住 1.5 s 会重建 15–18 张位移图，其中 **63–80 ms 花在 `canvas.toDataURL`**——主线程上的同步 PNG 编码。它分散在按压动画的十几帧里，所以帧率看不出问题（§10.12 的 `fidelity` 也不受影响），但它确实是这块屏按下时唯一接近"卡一下"的地方。要再降只有两条路，都属取舍：把编码挪出帧（`OffscreenCanvas.convertToBlob` + `URL.createObjectURL` 异步回写 `href`，但 `blob:` 的 CSP 接受面比 `data:` 窄，会影响用户脚本在部分站点的可用性），或按 `refractionHeight` 预生成阶梯。

### 11.2 没有解决的部分

`url(#…)` 的位移图每帧要被浏览器重新光栅化，**这个量级动不了**：8.5 fps 是现状，63 fps 是"不要折射"的价格。于是同屏折射面的数量与面积就是硬预算。`FILTER_PAD`（全局 64）让过滤器区域比元素本身大一圈——1408×160 的行实际按 1536×288 光栅化——按面收缩能再换回一点，但不改变量级。

要在这个载体上继续追，方向只能是"少光栅化"（减少同屏折射面、或缩小其面积），而不是"写得更快的 JS"。另一条常被想到的路——放弃 `backdrop-filter`、由应用自绘背景——能把这个量级拿回来，但它要求应用知道背景是什么，而 `backdrop` 的全部意义正是折射**真实位于其后**的内容（§3.3），不是应用自己的壁纸（它也迁移不到用户脚本面对任意站点的场景）。

---

## ⚠️ 已知 Bug（当前构建）

以下组件在当前构建中**已知存在问题**，其表现与原版不一致，**请勿用于生产或依赖其表现**：

- **Toggle（开关，`LiquidToggle`）** —— 按压时拇指玻璃要采的是"缩小的轨道副本"，而画在下层的真实轨道必须按拇指轮廓挖空（`trackClipPath` 把 `TRACK_OUTLINE` 与反向的 `thumbHolePath` 按 nonzero 规则相减）。挖孔是 `clip-path`，孔沿会被抗锯齿：半覆盖的像素仍带着轨道色，玻璃把它们一并采进来，拇指边缘因此留着一圈残留像素。

> 该组件是后续重点修复对象。

---

## 🚧 尚未完成（当前构建）

以下组件在当前构建中**尚未完成**，玻璃表现与原版不一致，**请勿依赖其表现**：

- **Magnifier / 放大镜（`MagnifierContent`）** —— 透镜放大的是**它自己后方**的内容（`backdrop-zoom` 以透镜中心为轴取 1.5×），而原版放大的是**光标附近**的区域：透镜悬在光标上方 80 dp，`onDrawBackdrop` 里的 `withTransform { scale(1.5f); translate(top = -80f.dp.toPx()) }` 把镜下内容对到光标周围，连被放大的光标一起显示。`backdrop-filter` 只能采到元素自身矩形内的像素，所以 web 端镜下取的不是同一块内容。
