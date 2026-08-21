/**
 * 抛给用户看的报错：**错误码 + 参数**，`message` 用英文渲染。
 *
 * 为什么要有这一层：core 抛出的 Error 会原样出现在界面横幅上——用户的操作被拒时，
 * 那是他唯一能看到的解释。文案硬编码成中文时，英文用户撞上的是一整段读不懂的字；
 * 而界面本身早就有中英开关（packages/ui/src/i18n.ts），报错必须跟着它走。带上码之后
 * UI 才有可能按码查中文；带上参数之后，路径/名字这类具体值才不至于被烘焙进一句
 * 翻不动的整句里。
 *
 * 三条要点，每条都是权衡后的裁定，不是风格：
 *
 * 1. **`message` 必须是英文人话，不是错误码。** `e.message` 会进日志，也会被不做翻译
 *    的宿主直接显示（今天 cli 与 vscode 就是这么干的：`e instanceof Error ? e.message`
 *    原样过桥）。把 message 写成 `name.reserved` 这种码，等于把"翻译还没跟上"这件事
 *    升级成"谁也看不懂"——一句读得懂的英文永远好过一个码。
 *
 * 2. **英文只有一份，就在这里。** UI 侧的字典**只存中文**，按 code 查；查不到就直接
 *    显示 `e.message`。这样英文文案不会在 core 与 ui 两处各存一份、慢慢漂移，而且将来
 *    新增的错误码即使还没翻译，也会自动降级成英文，而不是把一个码甩给用户——"忘了加
 *    翻译"的代价从"界面上出现乱码般的键名"降到"这一句暂时是英文"。
 *
 * 3. **`code` 用点分命名空间**（`name.reserved`、`path.escapesWorkspace`、
 *    `copy.intoOwnSubtree`），与 ui/src/i18n.ts 的键风格逐字一致——第二轮那份中文字典
 *    要与这里的码一一对应，两边键风格不同只会平白多出一层心智映射。
 *
 * **不是所有 throw 都该变成 SpecError。** 判据：这次抛出是不是**用户的一次合法操作**
 * 能触达的？触达得到（名字非法、重名冲突、父级不可挂载、只读态……）→ SpecError，
 * 用户读得懂才有意义；只有调用方（宿主/我们自己）违反契约才可能触达的（会话没 open()
 * 就调方法、发来一个 Api 里根本没有的方法名）→ 保持普通 `Error`：那是我们自己的 bug，
 * 翻译它没有意义，用户照着做什么都改变不了，反倒会让"这是程序缺陷"看起来像"你操作
 * 错了"。
 */

// 只有两条 import，且都是 `import type`：编译后一行都不剩，本文件仍然零运行期依赖
// （index.ts 里 `export { SpecError, … }` 因此不会给任何消费者引入别的模块）。
// 与 types.ts 互相 import 类型是有意为之：ParseError 要用这里的 SpecErrorCode，
// 这里的 parseError() 要产出一个 ParseError。两边都是类型导入，编译产物里不存在
// 这条边，不构成运行期循环依赖。
import type { WireError } from './api.js'
import type { ParseError } from './types.js'

/**
 * 全部英文文案。**这是英文的唯一定义处**（要点 2）。
 *
 * 占位符写成 `{name}`，与 ui/src/i18n.ts 的约定逐字一致——第二轮的中文条目会照着
 * 同一套占位符写，两边参数名对不上就会在界面上留下没替换掉的 `{path}`。
 *
 * 措辞上刻意保留原中文文案里的"为什么"：这些句子里的下半句（"两边的注释会被揉到
 * 一起"、"契约的消费者是会照着建目录的 Agent"、"树上只会按磁盘的真实类型显示，界面
 * 看不出任何异常"）不是啰嗦，是**用户凭报错自己判断该怎么办**的全部依据。退化成
 * `Invalid name` 这种一句话，用户只知道被拒了，不知道被拒的是哪条红线。
 */
export const EN_MESSAGES = {
  // ---- 路径进入系统的边界（workspace-path.ts）----
  'path.notRelative':
    'A workspace-relative path is required, but got {path}.',
  'path.parentSegment':
    'A path may not contain a ".." segment, but got {path}.',
  'path.escapesWorkspace':
    'The path {path} resolves to a location outside the workspace — most likely through a symbolic link. Reading it is refused.',

  // ---- 路径 / 名字的可表示性（session.ts、spec-edit.ts）----
  'path.empty':
    'A path is required: an empty path does not identify any node.',
  'path.unrepresentable':
    'The path {path} contains a backtick or a line break, which the current contract format cannot represent. Please rename that file or directory.',
  'identifier.forbiddenChar':
    '{field} may not contain a backtick, "]", or whitespace — those characters would break the `[{field}:...]` tag syntax. Got {value}.',
  'name.empty':
    'A name is required: an empty name would leave a node in the contract with nothing to identify it by.',
  'name.hasSlash':
    'The name {name} may not contain "/": this field takes a single path segment, not a path.',
  'name.unrepresentable':
    'The name {name} contains a backtick or a line break, which the current contract format cannot represent.',
  'name.reserved':
    'A node may not be named "{name}": it has a special meaning in the filesystem, and an Agent reading the contract could not tell such a declaration apart from an instruction to act on the parent directory.',

  // ---- 同层重名（spec-edit.ts 的 createNode / copyNode / renameNode 共用）----
  'name.duplicateSibling':
    '`{parent}` already has a node named `{name}`. Two siblings with the same name are a duplicate declaration that the parser rejects — please pick a different name.',
  'name.duplicateSiblingAtRoot':
    'The workspace root already has a node named `{name}`. Two siblings with the same name are a duplicate declaration that the parser rejects — please pick a different name.',

  // ---- 根节点不可动 ----
  'move.rootNode': 'The workspace root cannot be moved.',
  'copy.rootNode': 'The workspace root cannot be copied.',
  'rename.rootNode': 'The workspace root cannot be renamed.',
  'remove.rootNode': 'The workspace root cannot be removed from the contract.',

  // ---- 自己套自己 ----
  'move.intoOwnSubtree':
    'A node cannot be moved into its own subtree.',
  'copy.intoOwnSubtree':
    'A node cannot be pasted into itself or into its own subtree: the contract would then declare that the node contains another copy of itself, and every further paste would double it again — and the contract is consumed by an Agent that really does create those directories.',

  // ---- 移动时的合并冲突（红线：绝不静默覆盖已经写下的内容）----
  'move.mergeConflict':
    'The destination already has a node with this name, and this move would overwrite content already written there: {conflicts}. Decide which side to keep first — clear one side, or make both sides say exactly the same thing — then retry the move.',

  // ============================================================
  // `detail.*`：**嵌进别人句子里的从句**，不是能独立成句的整句。它们经 `detail()`
  // 变成一条 ErrorDetail，塞进另一条报错的 params 里（今天只有 move.mergeConflict
  // 的 {conflicts}），由渲染器逐条代进去。
  //
  // **命名前缀是这一组的身份**：errors.test.ts 按 `detail.` 把形状断言切成两组——
  // 整句那组要求以句号或占位符收尾，这一组要求**不**以句号收尾（它后面还接着分隔符
  // 和下一条）。将来第三种明细照抄这个前缀即可，不必再发明机制。
  //
  // **为什么四个字段各占一个码，而不是往一句话里插一个 {label} 变量**：与
  // declare.typeConflictDiskDir/...File 拆成两个码、duplicateSibling 拆出根与非根
  // 是同一条裁定——那个词一旦插进 message 就固定是英文了；而且英文是 "the comment
  // of `x`"、中文是 "`x` 的注释"，词的位置本来就不同，拼装式翻译迟早在某种语言里散架。
  // params 里只放**数据**（路径、两侧的值），不放已经渲染好的措辞。
  // ============================================================
  'detail.conflictAnnotation':
    'the comment of `{path}` (“{kept}”) would be overwritten by “{coming}”',
  'detail.conflictRole':
    'the semantic role of `{path}` (“{kept}”) would be overwritten by “{coming}”',
  'detail.conflictTemplate':
    'the template of `{path}` (“{kept}”) would be overwritten by “{coming}”',
  'detail.conflictSeverity':
    'the severity of `{path}` (“{kept}”) would be overwritten by “{coming}”',

  // ---- 移除声明时的子树保护（红线：一次点击不该丢掉多条已写下的声明）----
  'remove.subtreeHasContent':
    '`{path}` still has descendants carrying a comment, semantic role, template, or severity, and removing it would take those declarations down with it. Remove each of those descendants’ own declarations first, then remove `{path}` itself.',

  // ---- 懒加载边界：还没扫到，宁可让用户展开一次也不猜 ----
  'node.unscannedKind':
    '`{path}` has not been scanned yet, so whether it is a file or a directory is still unknown. Expand the directory it lives in, then try again.',
  'rename.targetUnscanned':
    '`{path}` has not been scanned yet, so whether something with that name already exists on disk is still unknown. Expand the directory it would live in, then try again.',
  'copy.targetChildrenUnscanned':
    'The children of `{path}` have not been scanned yet, so whether something with the same name already exists on disk is still unknown. Expand that directory, then try again.',
  'parent.unscanned':
    '`{path}` has not been scanned yet, so whether it is a file or a directory on disk is still unknown. Expand that node, then try again.',

  // ---- 目标不存在 ----
  'rename.sourceMissing':
    '`{path}` is in neither the contract nor on disk, so there is no node to rename.',
  'copy.sourceMissing':
    '`{path}` is in neither the contract nor on disk, so there is no node to copy.',

  // ---- 磁盘上已经有人占着这个名字 ----
  'rename.targetOccupiedOnDisk':
    '`{path}` already exists on disk. Renaming to that name would make the contract speak of two different things as if they were one, and merge both sides’ comments together. Please pick another name — this tool never touches filenames on disk.',

  // ---- hidden：本次会话里被拖走的旧位置 ----
  'hidden.oldLocation':
    '`{path}` is the old location of something dragged away earlier in this session; neither it nor anything beneath it is shown in the tree. A declaration written there would be invisible to you and impossible to delete — use the location the node is at now.',
  'hidden.resultPath':
    '`{path}` is the old location of something dragged away earlier in this session, so a declaration created there would never appear in the tree. Use the location the node is at now.',

  // ---- 父级不可挂载 ----
  'parent.fileOnDisk':
    '`{path}` is a file on disk, so no node can be created underneath it.',
  'parent.fileInSpec':
    '`{path}` is declared as a file in the contract, so no node can be created underneath it.',

  // ---- 声明的类型与磁盘冲突。两个方向各一个码，而不是往文案里插一个 "file"/"directory"
  //      的变量：那个词插进去就再也翻不动了（中文那侧会得到"在磁盘上是一个 directory"）。
  'declare.typeConflictDiskDir':
    '`{path}` is a directory on disk, so the contract may not declare it as a file. The tree only ever shows the real type from disk, so nothing would look wrong on screen — while the contract would be left carrying a false declaration that an Agent will act on.',
  'declare.typeConflictDiskFile':
    '`{path}` is a file on disk, so the contract may not declare it as a directory. The tree only ever shows the real type from disk, so nothing would look wrong on screen — while the contract would be left carrying a false declaration that an Agent will act on.',

  // ---- 只读态 ----
  'readonly.parseFailed':
    'The contract file could not be parsed, so this session is read-only. Please fix the file first.',
  'readonly.diskView':
    'The "Disk Structure" view is read-only. Switch back to the "My Structure" view in the toolbar to edit.',

  // ---- 写盘前的自校验 ----
  'serialize.selfCheckFailed':
    'The serialize → parse self-check failed, so the write was aborted to avoid corrupting the contract file: {details}',

  // ============================================================
  // 解析层（parse/*.ts）。这一批不是 throw 出来的：它们是 `ParseError` 里的一条纯数据，
  // 带着行号成组出现在"契约解析失败 → 只读模式"的横幅上。
  //
  // **为什么和上面那批同住一张表**：显示端（ui 的 translateError）只认 code，不关心
  // 这条错误是被 throw 出来的还是被收集出来的；英文只有一份这条要点（见文件头要点 2）
  // 对两边同样成立。分成两张表只会让"新增的码有没有中文"要核对两次。
  //
  // **行号不在文案里**，它是 ParseError.line 这个独立字段，由界面自己渲染成
  // "第 N 行："/"Line N: "（ui 的 banner.parseErrorLine）。这一点必须保持：解析失败时
  // 用户唯一能做的事就是照着行号去改文件，把行号揉进某一种语言的句子里，等于让另一种
  // 语言的用户失去定位手段。
  //
  // 用户/磁盘给的原文（跑偏的那一行文本、YAML 库的原始报错、模板名、规则 id……）一律
  // 走 params，绝不揉进模板：它们是数据，两种语言下都该原样显示。
  // ============================================================

  // ---- 分区（parse/sections.ts）----
  'parse.frontMatterMissing':
    'The file must begin with a YAML front-matter block opened by a line containing only "---".',
  'parse.frontMatterLine':
    'A front-matter line must read "key: value", but got "{text}".',
  'parse.frontMatterUnclosed':
    'The front-matter block is missing its closing "---".',
  'parse.unknownSection':
    'Unknown section heading "## {title}". Only Structure, Templates, Rules and Groups are allowed (their Chinese spellings are accepted as well).',
  'parse.yamlFenceRequired':
    'The Templates, Rules and Groups sections must each hold a ```yaml fenced code block.',
  'parse.yamlBlockOnly':
    'Only a ```yaml fenced code block is allowed inside this section, but got "{text}".',
  'parse.yamlFenceUnclosed':
    'The yaml code block is missing its closing ```.',
  'parse.strayContent':
    'Content found outside every section: move it into one of ## Structure / ## Templates / ## Rules / ## Groups, or delete it. Got "{text}".',
  'parse.structureSectionMissing':
    'The "## Structure" section is missing.',

  // ---- 结构区（parse/structure.ts）----
  'parse.bulletRequired':
    'A structure line must look like "- `name`".',
  'parse.indentNotMultipleOfTwo':
    'Indentation must be a multiple of 2 spaces, but this line has {indent}.',
  'parse.indentSkipsLevel':
    'Indentation skips a level: the previous line is at depth {prev}, this one at depth {depth}.',
  'parse.nameBackticksRequired':
    'The node name must be wrapped in backticks, for example `src/`.',
  'parse.nameEmpty':
    'The node name is empty.',
  'parse.tagValueMissing':
    'The [{tag}:...] tag is missing its value.',
  'parse.severityInvalid':
    'severity must be one of error/warning/advisory, but got "{value}".',
  'parse.unknownTag':
    'Unknown tag [{tag}]. Only role/template/severity are allowed.',
  'parse.annotationSeparator':
    'A comment must be preceded by " — " (a space, an em dash, and a space).',
  'parse.parentNotFound':
    'No parent node could be found for this line.',
  'parse.parentNotDir':
    'The parent node `{name}` is not a directory, so it cannot have children.',
  'parse.duplicateSibling':
    'Duplicate sibling `{name}` (already declared above as `{other}`): two siblings with the same name are a duplicate declaration — delete one of them, or rename it.',

  // ---- YAML 三区共用（parse/templates.ts、rules.ts、groups.ts）----
  // {message} 是 yaml 库给的原始报错，本身就是英文；它是外来数据，不翻译。
  'parse.yamlSyntax':
    'YAML syntax error: {message}',

  // ---- 模板区（parse/templates.ts）----
  'parse.templatesTopLevel':
    'The Templates section must be a mapping at the top level (template name → definition).',
  'parse.templateDefNotMap':
    'The definition of template "{name}" must be a mapping.',
  'parse.templateUnknownField':
    'Template "{name}" has an unknown field "{field}". Only description/root/children/exemplar are allowed.',
  'parse.templateDescriptionType':
    'The description of template "{name}" must be a string.',
  'parse.templateRootNotMap':
    'The root of template "{name}" must be a mapping.',
  'parse.templateRootUnknownField':
    'The root of template "{name}" has an unknown field "{field}". Only variable/naming are allowed.',
  'parse.templateRootVariableType':
    'The root.variable of template "{name}" must be a string.',
  'parse.templateRootNamingType':
    'The root.naming of template "{name}" must be a string.',
  'parse.templateChildrenNotMap':
    'The children of template "{name}" must be a mapping.',
  'parse.templateChildNotMap':
    'Child "{child}" of template "{name}" must be a mapping.',
  'parse.templateChildUnknownField':
    'Child "{child}" of template "{name}" has an unknown field "{field}". Only role/required are allowed.',
  'parse.templateChildRequiredType':
    'The required of child "{child}" of template "{name}" must be true or false.',
  'parse.templateChildRoleType':
    'The role of child "{child}" of template "{name}" must be a string.',
  'parse.templateExemplarType':
    'The exemplar of template "{name}" must be an array of strings.',

  // ---- 规则区（parse/rules.ts）----
  'parse.rulesTopLevel':
    'The Rules section must be a sequence at the top level (one "- " item per rule).',
  'parse.ruleNotMap':
    'Rule #{index} must be a mapping.',
  'parse.ruleIdMissing':
    'Rule #{index} is missing a non-empty id.',
  'parse.ruleIdDuplicate':
    'The rule id "{id}" appears more than once.',
  'parse.ruleUnknownField':
    'Rule "{id}" has an unknown field "{field}". Only id/severity/scope/text are allowed.',
  'parse.ruleSeverityInvalid':
    'The severity of rule "{id}" must be one of error/warning/advisory.',
  'parse.ruleScopeMissing':
    'Rule "{id}" is missing a non-empty scope (a glob expression).',
  'parse.ruleTextMissing':
    'Rule "{id}" is missing a non-empty text.',

  // ---- 分组区（parse/groups.ts）----
  'parse.groupsTopLevel':
    'The Groups section must be a sequence at the top level (one "- " item per group).',
  'parse.groupNotMap':
    'Group #{index} must be a mapping.',
  'parse.groupIdMissing':
    'Group #{index} is missing a non-empty id.',
  'parse.groupIdDuplicate':
    'The group id "{id}" appears more than once.',
  'parse.groupUnknownField':
    'Group "{id}" has an unknown field "{field}". Only id/members/text/severity are allowed.',
  'parse.groupMembersType':
    'The members of group "{id}" must be a non-empty array of strings.',
  'parse.groupMembersParentSegment':
    'The members of group "{id}" may not contain a ".." path segment.',
  'parse.groupMembersAbsolute':
    'The members of group "{id}" may not be absolute paths; they must be workspace-relative posix paths.',
  'parse.groupMembersBackslash':
    'The members of group "{id}" may not contain a backslash "\\"; they must be posix paths separated by "/".',
  'parse.groupTextMissing':
    'Group "{id}" is missing a non-empty text.',
  'parse.groupSeverityInvalid':
    'The severity of group "{id}" must be one of error/warning/advisory.',

  // ---- 串联（parse/index.ts）----
  'parse.unsupportedVersion':
    'Unsupported folderspec version "{version}". This tool supports version {supported}.',

  // ---- 契约文件读不出来（session.ts）。归在这一批是因为它走的是同一条出口：
  //      它也是一条 ParseError，也进只读横幅。行号是 0（错的不是某一行，是整个文件）。
  'spec.unreadable':
    'The contract file {path} could not be read ({errno}): {detail}. This session is read-only so that existing content is not overwritten.',

  // ---- 读文件（file-read.ts）：中间栏「无法读取：…」后面那半句 ----
  'file.isDirectory':
    'This is a directory, not a file.',
  'file.notRegularFile':
    'This is not a regular file.',
} as const

/**
 * 码取自 EN_MESSAGES 的键，而不是裸 `string`。
 *
 * 代价是宿主/UI 拿到的线上 code 仍是 string（跨进程的数据本来就不可信，见 api.ts 的
 * WireError），收益是**core 内部拼错一个码在编译期就红**——这类错误在运行期的表现是
 * "message 变成一个谁也没见过的字符串"，而报错本身通常没有测试覆盖到那一格，很容易
 * 一路带到用户面前。
 */
export type SpecErrorCode = keyof typeof EN_MESSAGES

/**
 * 一条**尚未被渲染成任何语言**的报错：就是 SpecError 身上那对 (code, params)，
 * 只是不作为顶层错误抛出，而是嵌在另一条报错的 params 里当明细。
 *
 * 这个形状在本系统里早就存在——`ParseError` 去掉必填的行号就是它，所以那边直接
 * `extends` 过来（见 types.ts）。
 *
 * `message` 是 core 按 EN_MESSAGES 渲染好的英文，与 SpecError.message / ParseError.message
 * 是同一条已裁定的取舍（本文件顶部要点 1）：不认码的消费者——日志、还没接线的宿主、
 * ERROR_ZH 里还没有这条码的那一格——**永远先有一句读得懂的话**。它不是第二份英文
 * *定义*，是 EN_MESSAGES 的一次渲染结果，且只许由下面的 `detail()` 派生，绝不手写。
 *
 * 它带来的收益是**逐条降级**：外层有中文、某一条明细的码还没翻译时，只有那一条退回
 * 英文，其余仍是中文——比"整条句子退回英文"细得多。
 *
 * `line` 只有解析层的明细才有，**绝不写进 EN_MESSAGES 的模板**——行号由显示端拼成
 * "line N: " / "第 N 行："，两种语言下是同一个数字。这条是"解析失败 → 只读 + 报行号"
 * 里"能定位"的那一半，见下面 parseError() 的注释。
 */
export interface ErrorDetail {
  message: string
  code?: SpecErrorCode
  params?: SpecErrorParams
  line?: number
}

/**
 * params 的取值。判据与 ui/src/i18n.ts 顶部那条逐字一致——**"我们写的才翻译"**：
 *   string | number   → 数据（路径、名字、行号、用户原文），两种语言下原样显示；
 *   ErrorDetail[]     → 我们自己写的话，渲染必须推迟到显示那一刻。
 *
 * 纯数据：无类、无原型、无函数、无环，JSON round-trip 一个字段不丢——params 是要
 * 经 bridge 过 JSON 的，装一个类实例进来，跨过边界之后方法全没了。
 */
export type SpecErrorParamValue = string | number | readonly ErrorDetail[]

/**
 * 必须写成带索引签名的 interface，**不是 `Record<...>` 别名**：值类型要经 ErrorDetail
 * 递归引用自己，别名会撞上 TS2456（"类型别名循环引用自身"）；interface 的成员是延迟
 * 解析的，这条环合法。
 *
 * **不写 `| undefined`**：仓库是 strict 且没开 exactOptionalPropertyTypes，加上它会让
 * `{ path: maybeUndefined }` 从"今天就红的编译错误"变成"界面上渲染出一个字面量
 * `undefined`"——后者看着像一个真值，比 `{path}` 残留（一眼看得出漏传）更坏。
 */
export interface SpecErrorParams {
  readonly [key: string]: SpecErrorParamValue
}

/**
 * 造一条明细。与 `parseError(line, code, params)` 逐字同构，只是没有行号。
 *
 * **明细一律走这里造，不许手写字面量**：`message` 必须是 EN_MESSAGES 对这对
 * (code, params) 的渲染结果，手写就等于在 EN_MESSAGES 之外开了第二个英文定义处。
 */
export function detail(code: SpecErrorCode, params: SpecErrorParams = {}): ErrorDetail {
  return { message: renderEnglish(code, params), code, params }
}

/** 明细之间的分隔符。**这是排版，不是文案**：英文这份在这里，中文那份在
 *  ui/src/i18n.ts（中文用全角"；"）。"英文只有一份"这条要点只对**措辞**成立，
 *  不对标点成立——把它做成跨包共享的常量，等于逼中文句子里用半角分号。 */
const DETAIL_SEPARATOR = '; '

/**
 * 明细嵌套的深度上限。从进程外收来的明细可以嵌任意深（JSON 造不出环，但造得出一万层）。
 *
 * 触底**不抛错**，退回那条已经渲染好的 message——这里正处在别人的错误路径上，炸在
 * 这儿会把真正的错因整个盖掉（与下面 interpolate 对缺键不抛错是同一条裁定）。
 */
const MAX_DETAIL_DEPTH = 8

/**
 * 递归渲染器内部走的那个值域：params 里放得下的东西（`SpecErrorParamValue`），**外加
 * 数组拆开之后的单个元素**（`ErrorDetail`）。
 *
 * **只在这两个私有函数的形参上出现，绝不进 `SpecErrorParamValue`。** 往公开值域里
 * 加"单个明细"那一格，等于允许调用方写 `{ conflict: detail(...) }`——一条没有任何
 * 调用点、也就没有任何测试的第四条路径。这里要的只是"数组元素能再喂回同一个函数"，
 * 那是实现细节，不是契约。
 */
type RenderableValue = SpecErrorParamValue | ErrorDetail

/** 判据是"有一句能显示的 message"，与 ui/src/wire-error.ts 的 errorFromWire 同款：
 *  没有 message 的对象一律当数据处理，绝不会渲染出 "[object Object]"。 */
function isDetail(v: RenderableValue): v is ErrorDetail {
  return typeof v === 'object' && v !== null && typeof (v as ErrorDetail).message === 'string'
}

/**
 * 渲染一条明细。
 *
 * **按码重渲染，而不是直接用 `d.message`**：EN_MESSAGES 因此对"从线上收来的明细"
 * 也保持权威——一条 message 与 code 说的不是一件事的伪造明细，不会把假文案带进
 * 我们的句子里。
 *
 * **码不认识就退回 message，不抛错**：宿主传来一个 core 没有的码时，
 * `EN_MESSAGES[code]` 是 undefined，直接 `.replace` 会在**构造 Error 的过程中**
 * 再炸一次（见 MAX_DETAIL_DEPTH 上方那条同源裁定）。
 *
 * 行号在这里才被拼上，与 UI 侧用 `banner.parseErrorLine` 拼是同一个位置、同一个
 * 数字。**无条件拼**（不设 `line > 0` 的闸）：与 App.tsx 的只读横幅逐字一致，而
 * session.ts 确实存在 `parseError(0, 'spec.unreadable', …)`——加一道闸就会造出
 * 第二套不一致的行号策略。
 */
function renderDetail(d: ErrorDetail, depth: number): string {
  const known = d.code !== undefined && Object.prototype.hasOwnProperty.call(EN_MESSAGES, d.code)
  const body = depth >= MAX_DETAIL_DEPTH || !known
    ? d.message
    : renderEnglishAt(d.code as SpecErrorCode, d.params ?? {}, depth + 1)
  return typeof d.line === 'number' ? `line ${d.line}: ${body}` : body
}

function renderValue(v: RenderableValue, depth: number): string {
  if (Array.isArray(v)) return v.map(x => renderValue(x, depth)).join(DETAIL_SEPARATOR)
  if (isDetail(v)) return renderDetail(v, depth)
  return String(v)
}

/**
 * 命名占位符 `{xxx}` 替换成 `params.xxx`；params 里没有这个键就**原样保留占位符**。
 *
 * 三选一的理由与 ui/src/i18n.ts 的 interpolate 完全相同，故意保持一致：抛错会把一次
 * 纯展示的文案缺陷升级成"构造一个 Error 的时候又炸了一次"（而这里正处在别人的错误
 * 路径上，炸在这儿会把真正的错因整个盖掉）；替换成空串会让缺陷肉眼不可见；留着没
 * 替换的 `{xxx}` 虽然难看，但一眼能看出"这里漏传了参数"。
 *
 * **必须是函数式 replacer**（今天就是）：用户注释里出现 `$&` / `` $` `` 时不会被
 * `$` 的替换语义吃掉；替换文本也不会被二次扫描，所以用户注释里的 `{path}` 不会被
 * 再插值一次。放宽 params 值域之后这一条更要紧了——明细里带的正是用户原文。
 */
function renderEnglishAt(code: SpecErrorCode, params: SpecErrorParams, depth: number): string {
  return EN_MESSAGES[code].replace(/\{(\w+)\}/g, (raw: string, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? renderValue(params[key], depth) : raw)
}

/** 按码渲染英文 message。导出是为了让宿主在只拿到 code + params 时也能自己渲染一遍。 */
export function renderEnglish(code: SpecErrorCode, params: SpecErrorParams = {}): string {
  return renderEnglishAt(code, params, 0)
}

/**
 * 面向用户的报错。带着 code 与 params 跨边界，`message` 是渲染好的英文。
 *
 * 继承 Error 而不是另起一个类型：整条调用链（Session.handle、两个宿主的 try/catch、
 * ui 的 bridge）今天都按 `e instanceof Error ? e.message : String(e)` 处理，换成非
 * Error 会让所有既有路径退化成 `String(e)`（"[object Object]"）。带上码是**加法**，
 * 不是替换——不接码的宿主一个字都不用改，照旧显示一句英文人话（要点 1）。
 */
export class SpecError extends Error {
  constructor(readonly code: SpecErrorCode, readonly params: SpecErrorParams = {}) {
    super(renderEnglish(code, params))
    this.name = 'SpecError'
  }
}

/**
 * 跨过 bridge 之后 `instanceof` 不再成立（对象经过 JSON 序列化，原型早就没了），
 * 宿主侧只能靠形状判断。core 自己内部用 `instanceof SpecError` 就够，这个函数是给
 * 第二轮的宿主/UI 用的——放在 core 是为了让"什么形状算一个 SpecError"只有一处定义。
 */
export function isSpecError(e: unknown): e is SpecError {
  return e instanceof SpecError
}

/**
 * 把一个 catch 到的东西转成线上格式（`WireError`，定义见 api.ts）。
 *
 * **放在 core 而不是各宿主里各写一份**：这是"一个 SpecError 过桥之后长什么样"的唯一
 * 定义。cli/src/server.ts 与 vscode/src/editor.ts 是两条独立的 catch，各抄一份的话，
 * 哪天有人只改了其中一处（补个字段、换个判据），另一个宿主里的报错就悄悄退化回
 * "只有一句英文"——那条退化没有任何外部症状，界面上照样有字，只是永远翻不动了。
 *
 * `isSpecError` 用的是 `instanceof`，只在 core 与调用方**同进程**时成立——两个宿主都
 * 满足（它们直接 import core）。UI 侧不行，那边只能按形状判断，所以这个函数只给宿主用。
 *
 * 不是 SpecError 的（宿主自己的失败、core 里那两条程序员错误）只带 message：收端因此
 * **永远**先有一句能显示的话，带不带 code 只影响它能不能被翻译。
 */
export function toWireError(e: unknown): WireError {
  if (isSpecError(e)) return { message: e.message, code: e.code, params: e.params }
  return { message: e instanceof Error ? e.message : String(e) }
}

/**
 * 解析层用的那一半：一条带行号的 `ParseError`，`message` 同样是渲染好的英文。
 *
 * **为什么不是 `SpecError`**：解析错误不是抛出来的，它们是被**收集**的——一次解析要把
 * 整个文件的问题一次报全（`Result<T>` 的 errors 数组），中途 throw 只会让用户改一条、
 * 重载一次、再看到下一条。而且它要经 JSON 过 bridge 进 `OpenResult.parseErrors`，
 * Error 实例过不去（原型没了，还会丢掉 line 这个自定义字段）。所以它是纯数据。
 *
 * **`line` 单独一个字段，绝不写进文案**：解析失败时用户唯一能做的事就是照着行号去改
 * 文件——"解析失败 → 只读 + 报行号，绝不静默重写"是这个工具的红线，行号是"能定位"
 * 的那一半。揉进英文句子里，中文界面就只能连着英文一起显示；界面自己渲染行号，两种
 * 语言下拿到的才是同一个数字。
 */
export function parseError(
  line: number,
  code: SpecErrorCode,
  params: SpecErrorParams = {},
): ParseError {
  return { line, message: renderEnglish(code, params), code, params }
}
