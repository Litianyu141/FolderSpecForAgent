# FolderSpec MVP — 实现期决策与遗留清单

本文件记录 MVP 实现期间由执行方替维护者做出的全部裁决，以及经评审确认、但决定随车发布的遗留项。
生成时间：2026-08-19。分支 `design/folderspec-spec`，42 个提交，289 个测试。

> 为什么需要这份文件：这些决策都是在没有人类在场时做出的。每一条都写明了理由，
> 以及"如果判断错了要付什么代价"，方便你逐条复核并推翻。

## 一、裁决（按做出顺序）

- ## Pre-flight Rulings
- Ruling R1: Task 2 的 Files 列表里 `Modify: packages/core/src/index.ts` 是虚报，忽略它，index.ts 保持 T1 的内容直到 T10 整体替换 — 因为 T2 没有任何 step 触碰它，而 T10 Step 5 明确给出全量替换内容 — 若判断有误，代价是 core 的公开导出晚几个任务才补齐，T10 一定会补上，无实质损失。
- Ruling R2: 所有 `typecheck` 之前必须先跑 `pnpm -C packages/core build` — 因为 ui/cli/vscode 通过 `@folderspec/core/api` 子路径导入类型，该子路径解析到 `dist/api.d.ts`，core 未构建时 TS 找不到它；`pnpm -r typecheck` 不产出 dist，所以拓扑顺序救不了 — 具体做法：把根 package.json 的 typecheck 改为 `"pnpm -C packages/core build && pnpm -r typecheck"`，CI 在 `pnpm typecheck` 之前加一步 `pnpm -C packages/core build` — 若判断有误，代价是多跑一次无用的 tsc，几秒钟。
- Ruling R3: T15 必须为 `createWebSocketBridge` 补一个用 mock WebSocket 的单测，T16 必须为 `createVscodeBridge` 补一个用 mock acquireVsCodeApi/postMessage 的单测 — 因为这两个是 UI 与宿主之间唯一的传输适配层，计划里它们一行测试都没有；CLI 的 server 测试用的是裸 ws 客户端，绕过了 ws-bridge — 若判断有误，代价是多写两个约 40 行的测试文件。
- Ruling R4: `.superpowers/` 已加入 .gitignore 并单独提交 — 因为 SDD 工作区是本地脚手架，入库会污染仓库 — 若判断有误，代价是一行 .gitignore，随时可删。
- Ruling R5: Node 工具链装进 conda 环境 `folderspec`（Node v26.6.0 + pnpm 9.15.9），不碰系统也不碰 conda base — 因为机器上完全没有 node/npm/pnpm/nvm/volta/asdf，而 Ubuntu 24.04 的 apt 只有 Node 18（低于计划要求的 ≥20）；用户明确选择 conda 新建环境 — 若判断有误，代价是 `conda env remove -n folderspec` 一行删掉。
- Ruling R6: 用户说的"poetry lock"按"锁定依赖版本并把 lockfile 入库"执行，即 `pnpm-lock.yaml` 提交进 git、CI 用 `--frozen-lockfile` — 因为 poetry 是 Python 依赖管理器，本项目是 TypeScript，没有它的位置；计划的 CI 里本来就写了 `--frozen-lockfile` — 若判断有误（用户真的想引入 Python 工具链），代价是这部分要重做，但本项目无任何 Python 代码，可能性极低。
- Task 2: Ruling: reviewer 报的 Important（sections.ts 在 current===null 时静默丢弃非空行）标为 plan-mandated，我裁定**必须修**，不适用"计划这么写的就算了" — 因为 spec 是绑定权威，其 §8 与计划 Global Constraints 都明写"绝不静默丢数据、解析失败必须报行号"；计划 Task 2 给的代码违反了计划自己立的约束，冲突以 spec 为准。同时裁定：报错而非"保留任意游离文本"，因为保留需要把游离文本存进 Spec 并往返序列化，是明显更大的机制，而报行号已经完全满足"不丢数据"（用户文件原封不动 + 明确告知第几行）。
- Task 3: Ruling: reviewer 的 ⚠️（CRLF）经我实测确认为真 bug，裁定**立即修**并纳入 Task 3 的修复轮 — 实测 `/^( *)- (.*)$/` 对 "- `src/` — x\r" 返回 null（JS 的 `.` 不匹配 \r，无 m 标志的 `$` 也不匹配 \r 之前），且 splitSections 用 md.split('\n') 会给每行留下 \r，导致区块标题、front-matter、结构行**全部**失效；spec 需求 5 明写 Windows/Mac/Linux 跨平台，而 Windows 上 git core.autocrlf=true 检出的就是 CRLF，等于工具在 Windows 上完全不可用 — 修复点选在 splitSections 这一个入口（改 split(/\r?\n/)），因为它是全部下游解析的唯一入口，在此归一化好过在每个正则上打补丁；序列化端仍只输出 LF，换行符转换交给 git — 若判断有误，代价是多一行正则和两条测试。
- Task 4: Ruling: reviewer 的三条 Important 全部标为 plan-mandated，我逐条裁定如下（spec 为绑定权威，计划只是它的论证）：
- Task 4: parked — reviewer 的 ⚠️（index.ts 把版本错误的行号硬编码为 2，假设 folderspec 总是 front-matter 第一项）— Ruling: **不修，本轮不做**。修它需要给 RawSections 加 front-matter 逐键行号，会波及 Task 10；而错的后果只是把用户指向 front-matter 里相邻的一行，front-matter 总共就几行，用户一眼能看到。等最终评审再定是否值得。
- Task 5: minor (deferred): 空字符串字段（description/role/rootVariable/rootNaming）解析时保留、序列化时按真值丢弃，round-trip 对这类 Spec 不成立。Ruling: **本轮不修** — 空字符串不承载任何人写的内容，丢了也没丢信息；Session.save 的自校验只验"能否解析回来"而非相等，不会抛错；生成器过滤了 '' 所以 property 也照不到。建议修法（若最终评审认为值得）：在解析侧把这四个字段的 '' 归一化为 undefined，与 annotation 的既有规则对齐，约 5 行。
- Task 6: Ruling: reviewer 的两条 Important 均为 plan-mandated，裁定**都修**：
- Task 7: Ruling: reviewer 实测证明「识别重命名」这条测试不具判别力（把 i++ 删掉它照样通过，因为该 fixture 的 origPath 以 's' 开头，不是记录类型哨兵字符，会被类型分派直接 continue 掉）— 裁定**必须修**。代码本身经独立验证正确（三种记录类型的字段下标都对着 git 文档核过），但一条自称防护某个 bug 却对该 bug 不敏感的测试，比没有测试更糟：它会让人以为有保护。把 fixture 的原路径改成以哨兵字符开头即可让它真正具备判别力。代价若判断有误：一个 fixture 文件名。
- Task 7: Ruling: 顺带补两条测试覆盖 GitState 的死变体 — `deleted` 与 `conflicted` 目前无任何测试产生或断言，而 `u`（冲突）记录的字段下标是 10，与另两种都不同，完全没被钉住。reviewer 是用一次性脚本实测确认下标正确的，但那不会留在仓库里。conflicted 的 fixture 需要造一次真实合并冲突，约 8 行。代价若判断有误：两条测试。
- Task 9: Ruling R-9a（reviewer 的 Important 2，isDir 混乱产出无法解析的 Spec）: **必须修**。这是硬故障不是瑕疵：`isDir:false` 却带 children 的节点，序列化后会被 parseStructure 以「父节点不是目录，不能有子项」拒绝，于是 Task 10 的 Session.save 自校验会**抛错**，用户存不了盘。三条复现路径（穿过文件节点、把有子项的目录改成文件、mergeInto 无条件覆盖 isDir）统一用一条不变量收口：**有子项的节点一律是目录**。代价若判断有误：三处判断 + 四条测试。
- Task 9: Ruling R-9b（reviewer 的 Important 1，拖拽产生的空节点仍可能被回收）: **保持现有语义不改代码，改为纠正被夸大的说法并用测试把真实行为钉住**，同时把更好的方案记为 MVP 后的改进。理由：
- Task 9: Ruling R-9c（reviewer 的 Minor 3，findSpecNode 未被使用且与测试里的 find 重复）: 保留导出（Task 10 的 barrel 会公开它，它也是这个模块自然的公共工具），但**要求测试文件改用它**而不是自己再写一遍同样的遍历——这样既消除重复，也给它挣到覆盖。
- Task 10: Ruling R-10a（未 open 就 save 会用空 spec 覆盖用户文件，复审在真实代码上实测复现）: **必须修，无商量余地**。这是整个项目唯一真正能造成伤害的那件事，而且是可达路径而非理论风险。根因：parseErrors 初始为 null，assertWritable 只看它，于是"成功打开后"与"从未打开"两种状态无法区分。修法：显式的 opened 状态位，在 open() 成功的末尾才置位。
- Task 10: Ruling R-10b（raw() 未受保护，而 Task 16 的 VSCode 宿主设计正是用 session.raw() 去覆盖活动文档）: **必须修**。只读模式下 this.spec 是 emptySpec()，raw() 会返回空契约；Task 16 的保存路径绕过 session.save() 直接用 raw() 构造 WorkspaceEdit，一旦在只读态被触达就会把用户"解析失败但可挽救"的文件替换成空的。给 raw() 加上 assertWritable 后，Task 16 那段 try/catch 会自然中止。
- Task 10: Ruling R-10c（注释里带换行会让 save() 永久抛错、会话卡死）: **必须修，且修在 Session.annotate 边界**。注意 Task 13 的面板用的是 textarea，用户按回车是完全自然的动作，所以这不是边缘情况。裁定：注释里的换行**归一化为空格**而不是拒绝——格式上一个节点就是一行，把回车变成空格是最不意外的处理，且结果立刻可见于树行与面板，不算静默篡改；role/template 是短标识符，含反引号或 ] 会破坏标签语法，这类**直接拒绝并给出明确错误**，因为悄悄改掉一个标识符比报错更糟。
- Task 10: Ruling R-10d（hidden 临时性测试建了新 Session 而非复用同一个，因此删掉 hidden.clear() 它照样通过；reload() 零覆盖）: **必须修**。这是本项目第四次出现"回归测试无法侦测它要防的回归"。要求同前：必须做 RED/GREEN 实证。
- Task 10: Ruling: reviewer 的两条 Minor（解析失败测试未断言树内容仍反映磁盘；handle() 的分发胶水只覆盖了 7 个方法中的 2 个）一并纳入本轮 — 都极廉价，且这是 Phase A 的收口任务，公共 API 面的覆盖缺口留到后面会更贵。
- Task 14: Ruling R-14a（视口高度用魔法常量 44 且完全不计横幅高度）: **必须修**。讽刺之处在于横幅出现的时机恰好就是只读模式——本任务的头号特性——此时树拿到的高度必然溢出。修法：把工具栏与横幅包进一个 ref 容器，用 getBoundingClientRect 实测其高度，并让测量在 parseErrors/externalChange/error 变化时重跑。**不用 ResizeObserver**：jsdom 没有实现它，会让依赖树真实渲染的 App 测试全部失效；而 getBoundingClientRect 在 jsdom 里返回 0，恰好退化成 innerHeight，测试照常通过，真实浏览器里则是精确值。宽度的 320 保留为具名常量并注释指向对应的 CSS 规则。
- Task 14: Ruling R-14b（有未保存改动时点"重新载入"静默丢弃）: **必须修**，用 window.confirm 拦一道。理由：这又是"丢失人类写的东西"那一类。选 confirm 而非改造横幅 UI，是因为它在两个宿主里都可用，且**失败方向安全**——即使某些 webview 上下文屏蔽了 confirm，返回值为假 → 取消重载 → 用户必须先保存，不会丢数据。
- Task 14: Ruling: reviewer 的 Minor 3/4/6/7（if (row) 守卫、handleExpand 未捕获、未用的 vi 导入、只读模式缺 App 层断言）一并纳入本轮，都极廉价；Minor 5（flatten 未 memo）按 reviewer 判断为噪音，不做。
- Task 14: Ruling: **不复用该 agent，改派全新实现者**。技能规定第 1-3 轮应恢复原实现者，但那条规则的前提是原实现者的上下文是完整且诚实的；这里它的终局报告已被证伪，正落在技能为第 4-5 轮描述的"实现者看不见自己的问题"这一情形，处方就是换人。同模型层级（sonnet），带上 brief、report 路径与完整 findings。
- Task 15: Ruling R-15a（Critical：serveStatic 里未保护的 decodeURIComponent 崩掉整个进程）: **必须修**。复审在编译产物上用 nc 发 `GET /%E0%80%80` 现场复现，进程直接死于未捕获的 URIError。危害面是真实的：服务器监听 127.0.0.1，用户浏览器里任何一个网页都能发这种简单 GET（无需 CORS 预检即可发送），而进程一死，尚未 save 的内存中编辑全部丢失。
- Task 15: Ruling R-15b（Important：ws-bridge 不监听 error/close，pending promise 永久挂起）: **必须修**。与 R-15a 是同一条故障链的下半截——服务器崩溃会同时杀死 WS 连接，此时 UI 里所有 await 的请求既不 resolve 也不 reject，界面静默僵死且不给用户任何提示。
- Task 15: Ruling: reviewer 的 Minor 4（--port 缺值/非数字时静默退回随机端口）与 Minor 5（spawn 无 error 监听，与 R-15a 同类的崩溃风险）纳入本轮，都极廉价。Minor 3（畸形 JSON 静默丢弃）不改 —— 解析失败时根本拿不到 id，无法构造对应的结构化响应，而连接保持打开已经满足了"不崩"的要求。
- Task 15: parked — Minor 6（路径守卫用词法比较而非 realpath，uiDir 内的符号链接可指向外部）— Ruling: **本轮不修**。它要求 uiDir 本身已被攻破（构建产物或供应链），不可由用户输入触达；而 uiDir 是我们自己的构建输出。属纵深防御缺口，记入最终评审待定。
- Task 16: Ruling R-16a（Critical：VSCode 宿主首次打开就把正确 Session 换成错误的，且保存会覆盖用户真实文件）: **必须修**。根因是两处的交互：main.tsx 的 `window.__folderspecRoot ?? '.'` 占位默认值，加上 editor.ts 对它做 `nodePath.resolve('.')`——解析到扩展宿主进程的 cwd。CLI 宿主之所以没事，只是因为它**总是注入** __folderspecRoot，且两侧都相对同一个 Node 进程的 cwd 解析；VSCode 的 session.root 来自 vscode API，与 cwd 毫无关系。这是我 preflight ruling（换工作区由宿主负责）与计划里占位默认值的交互后果，不是实现者的错。
- Task 17: Ruling（reviewer 的 Important，plan-mandated，本项目第 9 次同类）: 冒烟测试名为"写注释后能存回磁盘"，但测试体从未触发保存路径——`spec/save` 只由 webview 的 onDidReceiveMessage 触发，而该测试从不与 webview 交互。把 spec/save 处理器整个删掉它照样通过。**必须修**，因为这是唯一的 E2E，本地无法执行，其内容就是 CI 之前的全部保障。
- Ruling F1（C1，Critical）: VSCode 宿主绕过了写盘自校验 —— `editor.ts` 走 `session.raw()` + WorkspaceEdit，而 serialize→parse 闸门只在 `session.save()` 里。复审实证：目录名含反引号（Linux/macOS 合法）时 raw() 产出的文本解析不回来，CLI 被拦下、VSCode 原样写盘 → 契约损坏、重开进只读、用户全部标注被锁在坏文件后面。**修**：把闸门从 save() 移进 raw()，save() 调 raw()，两个宿主自动共享同一保证。另加：annotate/move 拒绝路径段含反引号或换行的节点并给明确提示（格式当前承载不了它们；转义留二期）。
- Ruling F2（C2，Critical）: `.folderspec.md` 存在但读不了（EACCES/EPERM/EBUSY——注意 EBUSY 恰恰是"Agent 正在改写该文件"这个本工具的主用例）会被当成"没有契约文件"，随后被空契约覆盖。设计对**解析**失败守得很死，对**读取**失败完全敞开。**修**：只有 ENOENT 才算"无文件"，其余错误进入只读态并告知原因。
- Ruling F3（C3，Critical）: 同层重名节点被解析器接受，但 merge 用 Map 只留最后一条、spec-edit 用 find 只改第一条 —— 用户改屏幕上看到的那条，工具却覆盖了另一条他从未见过的。规则区已经拒绝重复 id，结构区没有。**修**：parseStructure 拒绝同层重名并报行号。
- Ruling F4（C4a，Critical）: CLI 的 WebSocket 端点无任何认证。浏览器不对 WebSocket 施加同源策略，复审实测：跨站页面成功连上、枚举任意目录、并向任意目录写 .folderspec.md。随机端口不是防护。**修**：Origin 校验 + 每次启动生成的令牌（令牌随 __folderspecRoot 一起注入，ws-bridge 附在 URL 上）。两者都要——Origin 挡浏览器，令牌挡非浏览器与 DNS rebinding。
- Ruling F5（C4b，Critical）: WebSocket 没有 'error' 监听，一帧超大消息即可让进程崩溃（复审实测 uncaughtException）。**修**：socket/wss 各加 error 监听 + 设置 maxPayload。讽刺的是同一文件八十行之下就有一段注释在讲"一次请求不能撂倒整个进程"——那是 HTTP 路径的修复，WS 路径原样敞着。
- Ruling F6（I11）: `</script>` 转义两个宿主一起修。复审把它的严重性上调了，理由成立：我原先记的"有 CSP 兜底"是 VSCode 的分析被想当然地套到了 CLI 上，而 **CLI 根本不发任何 CSP**（复审实测响应头里没有），注入的脚本会真的执行。
- Ruling F7（I1）: 补 README —— 计划自己的收尾章节就叫"MVP 已知限制（写进 README，不要假装不存在）"，而仓库里根本没有 README。且模板/规则按 MVP 限制 #3 只能手写 YAML，其 schema 除内部设计文档外无处可查。
- Ruling: I2–I10、I12、M1–M9 全部**延期到合并后第一批**，与复审的建议一致。
- Ruling: 复审对 spec 的三条意见我全部接受，将在修复浪后更新 spec 与计划：(1) "UI 永远不知道自己跑在哪个宿主"这条不变量在实现上是假的——main.tsx 就在嗅探 acquireVsCodeApi，且两个传输层都住在 ui 包里；这是计划明文规定的，应当修正 spec 措辞而非代码；(2) 已知限制 #6 的措辞掩盖了它同时丢掉了 spec §8 承诺的"不静默覆盖"；(3) spec §9 的 E2E 范围实际缩水了。
- Ruling F8（残留 Important，裁定**立即修**）: F6 的转义写对了，但 `</script>` 突破仍可达 —— 转义后的值被当作**字符串**传给 String.replace，而字符串替换会展开 `` $` ``、`$'`、`$&`，把字面 `<` 又放回去。复审用真名为 a$`b 的目录在构建产物上完整复现了突破，且 CLI 不发 CSP，注入的脚本会在持有已认证 RPC socket 的页面里执行。修法两个 token：把两处 replace 的替换参数从字符串改成函数（函数替换不做 $ 展开）。技能规定不做第二轮修复浪，但这一条属于"F6 本身未闭合"而非新增范围，且复审已把补丁写出来并跑过全套验证。
- Ruling: 残留 2-5 全部**随车发布并记录**：

## 二、遗留项（已评审，决定随车发布）

- Task 1: minor (deferred): .gitignore:224 追加的 `dist/` 与既有第 13 行重复，无行为影响
- Task 3: minor (deferred): structure.ts 的"找不到父节点"分支在现有 prevDepth/stack 不变量下不可达（plan-mandated，无害的防御性代码）
- Task 3: minor (deferred): structure.test.ts 里名为"非法 severity 报行号"的用例只断言了 message，没断言 line（plan-mandated）
- Task 3: minor (deferred): [role:]/[template:] 缺少取值的分支无测试覆盖（plan-mandated）
- Task 4: parked — reviewer 的 ⚠️（index.ts 把版本错误的行号硬编码为 2，假设 folderspec 总是 front-matter 第一项）— Ruling: **不修，本轮不做**。修它需要给 RawSections 加 front-matter 逐键行号，会波及 Task 10；而错的后果只是把用户指向 front-matter 里相邻的一行，front-matter 总共就几行，用户一眼能看到。等最终评审再定是否值得。
- Task 4: minor (deferred): pnpm add 顺带把 packages/core/package.json 的 exports/files 重排成多行，语义不变
- Task 5: minor (deferred): 空字符串字段（description/role/rootVariable/rootNaming）解析时保留、序列化时按真值丢弃，round-trip 对这类 Spec 不成立。Ruling: **本轮不修** — 空字符串不承载任何人写的内容，丢了也没丢信息；Session.save 的自校验只验"能否解析回来"而非相等，不会抛错；生成器过滤了 '' 所以 property 也照不到。建议修法（若最终评审认为值得）：在解析侧把这四个字段的 '' 归一化为 undefined，与 annotation 的既有规则对齐，约 5 行。
- Task 5: minor (deferred): parse/templates.ts 的 `const raw = doc.toJS()` 在形状检查移到 isMap 之后已近乎冗余，只剩空文档判空一个用途
- Task 5: minor (deferred): parse/templates.ts 的 nodeToJS 用结构化 cast 而非 isNode 守卫
- Task 5: minor (deferred): serialize.ts 的空 preamble 行分支与 severity 单独出现的路径无测试覆盖
- Task 5: minor (deferred): serialize.test.ts 有三条用 toContain 弱断言 YAML 区块（plan-mandated，property test 已覆盖真实结构）
- Task 6: minor (deferred): 新测试「被忽略的条目不计入截断」的判别力依赖 fs.readdir 的枚举顺序（POSIX 不保证），对"isIgnored 必须先于上限判断"这一特定顺序的回归防护弱于宣称；代码顺序本身经直读确认无误
- Task 7: minor (deferred): 重命名测试的两次 git mv 都在 try 之前，若第二次抛错第一次不会被回滚（实际风险可忽略）
- Task 8: minor (deferred): applySpecFields 用真值判断而非存在判断，annotation:'' 会被丢弃（与 Task 5 记的空字符串问题同源）
- Task 8: minor (deferred): 幂等性测试只覆盖单节点跨两次 merge 的转换，未覆盖同一次 merge 里"已扫描子树与未扫描兄弟子树并存"（复审用探针确认行为正确，只是没进测试套件）
- Task 8: minor (deferred): 无测试直接断言无 spec 孪生的节点上 annotation/role/template/severity 是"键不存在"而非"值为假"
- Task 11: minor (deferred): 变异测试里 5 个 bug 同时注入，其中 D（lastCall 正向扫描）被 A（不记录 calls）掩盖，故 test 6 对 D 的判别力未被独立证明；但其 fixture（两次不同 params、断言取第二次）按代码直读显然可判别，不值得单开一轮
- Task 12: minor (deferred): onToggle 在展开与收起时都会触发，双击尚在加载的目录可能重复请求一次扫描；controller 裁定不修（窗口窄、后果只是一次冗余扫描，且 react-arborist 的 onToggle(id) 不带方向，区分它需要额外的 tree.get(id)?.isOpen 查询，复杂度大于收益）
- Task 13: minor (deferred): severity 的 select 直接读 node.severity，无乐观本地回显，dispatch 慢时可能被无关重渲染把选项弹回旧值（纯 UX 边角）
- Task 15: parked — Minor 6（路径守卫用词法比较而非 realpath，uiDir 内的符号链接可指向外部）— Ruling: **本轮不修**。它要求 uiDir 本身已被攻破（构建产物或供应链），不可由用户输入触达；而 uiDir 是我们自己的构建输出。属纵深防御缺口，记入最终评审待定。
- Task 16: minor (deferred): CLI 的 server.ts 有同样的潜在脆弱性（若 __folderspecRoot 注入失效，'.' 同样会被 resolve），但它当前总是注入且已验证正确，本轮不动已定稿的包
- Task 16: minor (deferred): applyingOwnEdit 的抑制窗口跨越 applyEdit 与 document.save 两次 await，理论上真正的外部变更若恰好落在窗口内会被误判为自身编辑（窗口通常亚毫秒）
- Task 16: **待最终评审修复（跨两个宿主的 Minor）**: 注入 __folderspecRoot 时用的是 `JSON.stringify(root)`，它不转义 `/`，因此工作区路径若含字面量 `</script>` 会提前闭合 script 标签。危害被两道现有防线兜住（注入出来的第二个 script 无 nonce，被 CSP 拦下；且 __folderspecRoot 设置失败会回退成 '.'，正好被第 2 层的绝对路径守卫挡住），所以是静默的功能失效而非安全或数据丢失问题。**同一模式在 packages/cli/src/server.ts 里也存在**（Task 16 无权改动它）。修法：`JSON.stringify(root).replace(/</g, '\\u003c')`，两处一起改。
