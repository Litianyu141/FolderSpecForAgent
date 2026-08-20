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

// 唯一的一条 import，且是 `import type`：编译后一行都不剩，本文件仍然零运行期依赖
// （index.ts 里 `export { SpecError, … }` 因此不会给任何消费者引入别的模块）。
import type { WireError } from './api.js'

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

export type SpecErrorParams = Record<string, string | number>

/**
 * 命名占位符 `{xxx}` 替换成 `params.xxx`；params 里没有这个键就**原样保留占位符**。
 *
 * 三选一的理由与 ui/src/i18n.ts 的 interpolate 完全相同，故意保持一致：抛错会把一次
 * 纯展示的文案缺陷升级成"构造一个 Error 的时候又炸了一次"（而这里正处在别人的错误
 * 路径上，炸在这儿会把真正的错因整个盖掉）；替换成空串会让缺陷肉眼不可见；留着没
 * 替换的 `{xxx}` 虽然难看，但一眼能看出"这里漏传了参数"。
 */
function interpolate(template: string, params: SpecErrorParams): string {
  return template.replace(/\{(\w+)\}/g, (raw: string, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : raw)
}

/** 按码渲染英文 message。导出是为了让宿主在只拿到 code + params 时也能自己渲染一遍。 */
export function renderEnglish(code: SpecErrorCode, params: SpecErrorParams = {}): string {
  return interpolate(EN_MESSAGES[code], params)
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
