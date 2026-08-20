import { createContext, useContext } from 'react'
import type { Lang } from '@folderspec/core/api'
// `import type`，编译后一行不剩：ui 对 core 只允许类型依赖，运行期一个符号都不引入。
import type { SpecErrorCode } from '@folderspec/core'

export type { Lang }

/**
 * 只翻译"我们自己写的字"（按钮/标签/提示语/报错），绝不翻译用户或磁盘给的内容：
 * 节点注释、分组说明、规则文字、模板描述、语义角色、文件名/路径、解析错误里的行号与
 * 原文——字典里没有它们的位置，调用点也不会替它们找一个键（判据见 i18n-brief.md：
 * 这段文字是我们写的还是用户/磁盘给的？我们写的才翻译）。
 *
 * **`core` 抛出的报错曾被划在"不翻译"那一侧，那是一次错划，本轮已纠正。** 双语那一轮
 * 定这条规矩时，core 的报错还是硬编码的中文整句：UI 拿到的只有一句话，除了原样显示
 * 别无办法，于是它被顺手归进了"外面给的数据"。但它其实是**我们自己写的界面文案**，
 * 只是写在另一个包里——用户的操作被拒时，那句话是他唯一能看到的解释，界面切了语言而
 * 它不切，等于没切。提交 985501e 之后 core 改抛 `SpecError(code, params)`，`message` 是
 * 渲染好的英文，UI 因此能按**码**查一份中文模板、把 params 代回去。注意翻译的对象是
 * **码**，不是文案：那句英文 message 一个字都没有被"翻译"，它只是在查不到码时被原样
 * 显示（英文的唯一定义处始终在 core 的 EN_MESSAGES）。判据本身一个字没变，变的只是
 * 这一类文字被归到了正确的一侧。**下面的 ERROR_ZH 不是漏网的用户数据，别照着这段注释
 * 的旧版本把它删回去。**
 *
 * "导出的 folderspec 里的结构化内容"（标题行、导言、四个章节标题）不归这份字典管——
 * 那是 core 侧 `spec/setLang`（提交 9ce8b86）的地盘，本文件只管界面 chrome。
 *
 * 键名用点分命名空间的字符串（如 'toolbar.load'）铺平成一层，不用嵌套对象：
 * 一是让 `en` 能直接赋值成 `Record<TranslationKey, string>`，靠 TS 的"对象字面量
 * 赋值给具名类型"做键集校验（下面 en 声明处的注释展开讲）；二是所有调用点都是
 * `t('a.b.c')` 这种字符串字面量，IDE 补全/跳转对拍平的键一样好使，没必要再多一层
 * `zh.toolbar.load` 式的属性访问。
 *
 * 按"哪个组件在用"分区块写，不按字母序——字母序对"这个键是不是该有对应的英文"这件事
 * 毫无帮助，真正要做的核对是逐个组件过一遍，分区块正好对应这个核对顺序。
 */
export const zh = {
  // ---- Toolbar：顶栏 ----
  'toolbar.workspacePath': '工作区路径',
  'toolbar.load': '载入',
  'toolbar.structureView': '结构视图',
  'toolbar.myStructure': '我的结构',
  'toolbar.diskStructure': '原始结构',
  'toolbar.search': '搜索',
  'toolbar.searchPlaceholder': '按名称或注释筛选',
  'toolbar.undo': '撤销',
  'toolbar.redo': '重做',
  'toolbar.save': '保存',
  /** 顶栏的「新建」按钮：等价于在树的空白区域右键，目标是工作区根 */
  'toolbar.newNode': '新建',
  /** 语言开关分段控件外层 role="group" 的 aria-label。两个按钮自己的文案
   *  （"中文" / "English"）刻意不经过字典，见 Toolbar.tsx 里那段注释。 */
  'toolbar.language': '界面语言',

  // ---- App：横幅与确认框 ----
  'banner.parseErrorPrefix': '契约文件解析失败，当前为',
  'banner.parseErrorReadOnly': '只读模式',
  'banner.parseErrorSuffix': '。已保留你的原文件未做任何改动，请修复后重新载入。',
  /** {line} 后面紧跟着 core 给的原始错误文案（数据，不翻译），所以这条只到"："为止 */
  'banner.parseErrorLine': '第 {line} 行：',
  'banner.diskViewPrefix': '当前为',
  'banner.diskViewLabel': '「原始结构」',
  'banner.diskViewSuffix':
    '视图：只按磁盘扫描结果显示，忽略契约里的结构性调整，因此暂时无法编辑。 点击顶栏「我的结构」切换回可编辑视图。',
  'banner.externalChange': '契约文件已在外部修改。',
  /**
   * {text} 是那条本该进剪贴板的路径（数据，不翻译）。**必须原样摆在横幅里**：
   * 复制失败时用户唯一的出路就是从横幅上选中它手动复制，只说"失败了"等于把人
   * 扔在原地。而静默失败更糟——用户以为复制成功，粘出来是上一次的内容。
   */
  'banner.copyFailed': '复制失败：浏览器拒绝了剪贴板写入。请手动复制：{text}',
  'banner.reload': '重新载入',
  'dialog.reloadConfirm': '有未保存的改动，重新载入会丢弃它们。确定要继续吗？',

  // ---- AnnotationPanel 与 GroupPanel 共用（两处文案原本就逐字节相同） ----
  'common.severity': '约束强度',
  'common.severityNone': '（仅注释，不强制）',
  /**
   * 右键菜单与新建对话框里"父目录是工作区根"的说法。
   * 刻意**不**复用 annotationPanel.workspaceRoot：那一条是面板顶部单独占一行的标题
   * （'（工作区根）'，自带括号），这一条要嵌进「在「{parent}」下新建…」这种句子里，
   * 带括号会变成「在「（工作区根）」下」。两处取值本来就不同，不是重复。
   */
  'common.workspaceRoot': '工作区根',

  // ---- AnnotationPanel：单节点注释面板 ----
  'annotationPanel.empty': '在左侧选中一个文件或目录',
  'annotationPanel.workspaceRoot': '（工作区根）',
  'annotationPanel.originSpecOnly': 'spec 中声明，磁盘上不存在——可能待创建，也可能已被删除',
  'annotationPanel.originUnscanned': '所在目录尚未扫描，展开后自动重新解析',
  'annotationPanel.kindDir': '目录',
  'annotationPanel.kindFile': '文件',
  'annotationPanel.annotationLabel': '注释',
  'annotationPanel.roleLabel': '语义角色',
  'annotationPanel.rolePlaceholder': '例如 core-engine',
  'annotationPanel.severityAdvisory': 'advisory — 建议',
  'annotationPanel.severityWarning': 'warning — 应遵守，违反须说明',
  'annotationPanel.severityError': 'error — 必须遵守',
  'annotationPanel.owningGroups': '所属分组',

  // ---- GroupPanel：多选分组面板 ----
  'groupPanel.selectedCount': '已选中 {count} 项',
  'groupPanel.sameMembersNote': '有 {count} 个分组的成员完全相同，当前编辑的是 {currentId}',
  /** {id} 是分组 id，用户取的标识符，不翻译 */
  'groupPanel.editGroupAriaLabel': '改为编辑分组 {id}',
  'groupPanel.name': '分组名',
  'groupPanel.namePlaceholder': '留空则自动取名',
  'groupPanel.text': '分组注释',
  'groupPanel.membersLocked': '成员（编辑中已锁定）',
  'groupPanel.membersUnlocked': '成员（点击 × 移出选中集）',
  'groupPanel.lockHint':
    '编辑尚未提交，成员暂不可增减。点输入框以外任意处即提交并解锁——包括树上的节点，本工具没有“放弃”入口。',
  /** {path} 是文件/目录路径，数据，不翻译 */
  'groupPanel.removeMemberAriaLabel': '从选中集移除 {path}',
  'groupPanel.removeMemberLockedTitle': '编辑尚未提交，成员暂不可增减',

  // ---- ContentPane：中间栏文件预览 ----
  'contentPane.empty': '在左侧选中一个文件查看内容',
  'contentPane.dirNotExpanded': '这是一个目录，尚未展开——点击左侧的箭头展开后可看到子项。',
  'contentPane.dirCount': '这是一个目录，共 {count} 项。',
  'contentPane.loading': '读取中…',
  'contentPane.binary': '二进制文件，不预览内容。',
  'contentPane.tooLarge': '文件 {size} MB，超过预览上限，不读取内容。',
  /** 后面紧跟 content.reason（fs 读取失败的原始原因，数据，不翻译） */
  'contentPane.unreadablePrefix': '无法读取：',

  // ---- NodeRow：树的每一行 ----
  'nodeRow.truncated': '子项过多，已截断显示',
  'nodeRow.unreadableDir': '无法读取该目录（通常是权限不足）',
  /** {group} 是分组 id，用户取的标识符，不翻译 */
  'nodeRow.groupDotTitle': '属于分组 {group}',
  'nodeRow.groupDotAriaLabel': '选中分组 {group} 的全部成员',

  // ---- ContextMenu：树上的右键菜单 ----
  'contextMenu.ariaLabel': '节点操作菜单',
  /**
   * 「仅契约」这三个字是用户点名要的，不是可有可无的润色：它就是在防止用户以为点完
   * 磁盘上会冒出一个目录。改这两条文案前先读 ui-final-brief.md 甲节。
   */
  'contextMenu.newDir': '新建目录（仅契约）',
  'contextMenu.newFile': '新建文件（仅契约）',
  /** {parent} 是路径或"工作区根"，数据/另一条字典项，不再翻译 */
  'contextMenu.newTarget': '将建在「{parent}」下',
  /** 位置在「新建…」与「取消声明」之间。同样带「仅契约」：它一个字都不会改磁盘上的
   *  文件名，真正改名的是随后读契约的 Agent。 */
  'contextMenu.rename': '重命名（仅契约）',
  /** {path} 是被改名节点的路径，数据，不翻译 */
  'contextMenu.renameTarget': '只改契约里「{path}」的名字，不动磁盘上的文件',
  'contextMenu.removeNode': '取消声明',
  /** 不叫「删除」：它不删磁盘上任何东西，对磁盘上真实存在的节点，取消声明之后那一行
   *  依旧在树上，只是不再带任何标注 */
  'contextMenu.removeDisabledNotDeclared': '这个节点在契约里还没有任何声明，没有可取消的东西',
  'contextMenu.disabledReadOnly': '当前不可编辑：契约解析失败，或正处在「原始结构」视图',
  /**
   * 复制那两项**不带「仅契约」**，也不该带：上面四项都会改写契约，那三个字是在
   * 提醒"磁盘不会跟着变"；复制什么都不改，加上反而在暗示它跟契约有关系。
   * 文案逐字对齐 VSCode 资源管理器的 Copy Path / Copy Relative Path——用户是拿
   * 那个菜单来要这条功能的，换个说法只会让人怀疑是不是同一件事。
   * 两项的 title 是将被复制的那条路径本身（数据，不进字典）。
   */
  'contextMenu.copyPath': '复制路径',
  'contextMenu.copyRelPath': '复制相对路径',
  /**
   * 「复制」**不带「仅契约」**，「粘贴」带。不是随手的不一致：
   * 「仅契约」三个字是在提醒"磁盘不会跟着变"，只有真的会往契约里写下一条声明的那些项
   * 才需要它。复制什么都不改（只是记下源路径），加上反而在暗示它会动契约；粘贴恰恰
   * 是用户最容易以为"磁盘上会真的多出一份拷贝"的那一项，一个字都不能省。
   * 也不叫「复制节点」「复制声明」：用户是拿文件管理器的心智来要这条功能的，
   * 「复制」两个字就是他要找的那个词；它到底复制了什么由 title 那句话讲清楚。
   */
  'contextMenu.copyNode': '复制',
  'contextMenu.paste': '粘贴（仅契约）',
  /** {path} 是被复制节点的路径，数据，不翻译 */
  'contextMenu.copyNodeTarget': '把「{path}」在契约里的声明记进剪贴板，稍后可粘到别处',
  /** {from} 是源路径，{parent} 是落点路径或"工作区根"，都是数据/另一条字典项 */
  'contextMenu.pasteTarget': '把「{from}」的契约声明粘到「{parent}」下（不会在磁盘上创建任何东西）',
  /** 剪贴板为空时「粘贴」置灰的理由。灰着不给理由，只是把"点了没反应"换成"灰着没理由"
   *  （与 removeDisabledNotDeclared 同一条模式） */
  'contextMenu.pasteDisabledEmpty': '剪贴板是空的：先在某个节点上点「复制」',

  // ---- NewNodeDialog：新建节点（仅契约） ----
  /** {parent} 是父目录路径，或 common.workspaceRoot */
  'newNode.titleDir': '在「{parent}」下新建目录（仅契约）',
  'newNode.titleFile': '在「{parent}」下新建文件（仅契约）',
  'newNode.hint': '只在契约里声明「这里应该有它」，不会在磁盘上创建任何东西——真正去建它的是随后读契约的 Agent。',
  'newNode.nameLabel': '名称',
  'newNode.namePlaceholder': '例如 cases',
  'newNode.create': '创建',
  'newNode.cancel': '取消',

  // ---- 重命名：与新建共用同一个输入框，只有这几条文案分叉 ----
  /** {path} 是被改名节点的完整路径，数据，不翻译 */
  'rename.title': '重命名「{path}」（仅契约）',
  'rename.hint': '只改契约里声明的名字，不会重命名磁盘上的任何文件或目录——真正去改名的是随后读契约的 Agent。',
  'rename.nameLabel': '新名称',
  'rename.submit': '重命名',
} as const

export type TranslationKey = keyof typeof zh

/**
 * 写成 `Record<TranslationKey, string>` 而不是又一个 `as const` 字面量：赋值给一个
 * 具名类型的对象字面量，TS 会同时做"缺失属性检查"和"多余属性检查"（excess property
 * check）——en 少一个键或多打一个键，`tsc --noEmit` 当场报错，"键集不一致"在类型层面
 * 直接不可能，不需要等运行时才发现（i18n-brief.md 点名"类型层面挡住更好"）。
 *
 * 但 `pnpm -C packages/ui test` 跑的是 vitest：它用 esbuild 转译 TS，esbuild 只做
 * 语法转换、不做类型检查。这层类型保护在"单跑 vitest、没跑 tsc"这条路径上并不生效——
 * esbuild 会放过一个漏了某个键的 en 字面量，那个键在运行时就是 undefined。所以
 * i18n.test.ts 里仍然补了一条运行时的键集遍历比较：tsc 那道闸管"本地/CI 跑了
 * typecheck"的路径，这条运行时断言管"只跑了测试没跑 typecheck"的路径，两道闸各堵
 * 一条不同的路，缺一道都可能被绕过。
 */
export const en: Record<TranslationKey, string> = {
  'toolbar.workspacePath': 'Workspace path',
  'toolbar.load': 'Load',
  'toolbar.structureView': 'Structure view',
  'toolbar.myStructure': 'My Structure',
  'toolbar.diskStructure': 'Disk Structure',
  'toolbar.search': 'Search',
  'toolbar.searchPlaceholder': 'Filter by name or annotation',
  'toolbar.undo': 'Undo',
  'toolbar.redo': 'Redo',
  'toolbar.save': 'Save',
  'toolbar.newNode': 'New',
  'toolbar.language': 'Interface language',

  'banner.parseErrorPrefix': 'Failed to parse the contract file — currently in ',
  'banner.parseErrorReadOnly': 'read-only mode',
  'banner.parseErrorSuffix': '. Your original file has been left untouched; fix the error(s) below and reload.',
  'banner.parseErrorLine': 'Line {line}: ',
  'banner.diskViewPrefix': 'Currently viewing the ',
  'banner.diskViewLabel': '"Disk Structure"',
  'banner.diskViewSuffix':
    ' view — showing only the raw disk scan and ignoring structural changes from the contract, so editing is disabled for now. Click "My Structure" in the toolbar to switch back to the editable view.',
  'banner.externalChange': 'The contract file was modified outside this app.',
  'banner.copyFailed': 'Copy failed: the browser denied clipboard access. Copy it manually: {text}',
  'banner.reload': 'Reload',
  'dialog.reloadConfirm': 'You have unsaved changes — reloading will discard them. Continue anyway?',

  'common.severity': 'Constraint level',
  'common.severityNone': '(annotation only, not enforced)',
  'common.workspaceRoot': 'the workspace root',

  'annotationPanel.empty': 'Select a file or directory on the left',
  'annotationPanel.workspaceRoot': '(workspace root)',
  'annotationPanel.originSpecOnly':
    'Declared in the spec but missing on disk — may be pending creation, or already deleted',
  'annotationPanel.originUnscanned': 'This directory has not been scanned yet — expand it to parse',
  'annotationPanel.kindDir': 'Directory',
  'annotationPanel.kindFile': 'File',
  'annotationPanel.annotationLabel': 'Annotation',
  'annotationPanel.roleLabel': 'Semantic role',
  'annotationPanel.rolePlaceholder': 'e.g. core-engine',
  'annotationPanel.severityAdvisory': 'advisory — recommended',
  'annotationPanel.severityWarning': 'warning — should be followed; violations must be explained',
  'annotationPanel.severityError': 'error — must be followed',
  'annotationPanel.owningGroups': 'Belongs to groups',

  'groupPanel.selectedCount': '{count} selected',
  'groupPanel.sameMembersNote': '{count} groups share the exact same members — currently editing {currentId}',
  'groupPanel.editGroupAriaLabel': 'Switch to editing group {id}',
  'groupPanel.name': 'Group name',
  'groupPanel.namePlaceholder': 'Leave blank to auto-generate',
  'groupPanel.text': 'Group annotation',
  'groupPanel.membersLocked': 'Members (locked while editing)',
  'groupPanel.membersUnlocked': 'Members (click × to remove from selection)',
  'groupPanel.lockHint':
    'This edit has not been submitted yet, so members can’t be added or removed. Click anywhere outside the inputs to submit and unlock — including nodes in the tree; this tool has no "discard" action.',
  'groupPanel.removeMemberAriaLabel': 'Remove {path} from the selection',
  'groupPanel.removeMemberLockedTitle': 'This edit has not been submitted yet, so members can’t be added or removed',

  'contentPane.empty': 'Select a file on the left to view its content',
  'contentPane.dirNotExpanded':
    'This is a directory that has not been expanded yet — click the arrow on the left to expand it.',
  'contentPane.dirCount': 'This is a directory with {count} item(s).',
  'contentPane.loading': 'Loading…',
  'contentPane.binary': 'Binary file — content preview is not available.',
  'contentPane.tooLarge': 'File is {size} MB, over the preview limit — content was not loaded.',
  'contentPane.unreadablePrefix': 'Unable to read: ',

  'nodeRow.truncated': 'Too many items, truncated',
  'nodeRow.unreadableDir': 'Unable to read this directory (usually a permissions issue)',
  'nodeRow.groupDotTitle': 'Belongs to group {group}',
  'nodeRow.groupDotAriaLabel': 'Select all members of group {group}',

  'contextMenu.ariaLabel': 'Node actions',
  'contextMenu.newDir': 'New directory (contract only)',
  'contextMenu.newFile': 'New file (contract only)',
  'contextMenu.newTarget': 'Will be declared under "{parent}"',
  'contextMenu.rename': 'Rename (contract only)',
  'contextMenu.renameTarget': 'Only renames "{path}" in the contract; nothing on disk is touched',
  'contextMenu.removeNode': 'Remove declaration',
  'contextMenu.removeDisabledNotDeclared':
    'This node has no declaration in the contract yet — there is nothing to remove',
  'contextMenu.disabledReadOnly':
    'Editing is disabled right now: the contract failed to parse, or you are in the "Disk Structure" view',
  'contextMenu.copyPath': 'Copy Path',
  'contextMenu.copyRelPath': 'Copy Relative Path',
  'contextMenu.copyNode': 'Copy',
  'contextMenu.paste': 'Paste (contract only)',
  'contextMenu.copyNodeTarget':
    'Records the contract declaration of "{path}" to the clipboard, ready to paste elsewhere',
  'contextMenu.pasteTarget':
    'Pastes the contract declaration of "{from}" under "{parent}" (nothing is created on disk)',
  'contextMenu.pasteDisabledEmpty': 'Clipboard is empty — click "Copy" on a node first',

  'newNode.titleDir': 'New directory under "{parent}" (contract only)',
  'newNode.titleFile': 'New file under "{parent}" (contract only)',
  'newNode.hint':
    'This only declares "there should be one here" in the contract — nothing is created on disk. The agent that reads the contract is what actually creates it.',
  'newNode.nameLabel': 'Name',
  'newNode.namePlaceholder': 'e.g. cases',
  'newNode.create': 'Create',
  'newNode.cancel': 'Cancel',

  'rename.title': 'Rename "{path}" (contract only)',
  'rename.hint':
    'This only changes the name declared in the contract — no file or directory on disk is renamed. The agent that reads the contract is what actually renames it.',
  'rename.nameLabel': 'New name',
  'rename.submit': 'Rename',
}

const dictionaries: Record<Lang, Record<TranslationKey, string>> = { zh, en }

export type Interpolations = Record<string, string | number>

/**
 * 命名占位符 `{xxx}` 替换成 `params.xxx`；params 里没有这个键就原样保留占位符——
 * 不抛错、不静默吞掉。抛错会把一次纯展示的翻译缺陷升级成整个面板崩溃，静默吞掉
 * （替换成空串）会让缺陷肉眼不可见；留着没替换的 `{xxx}` 虽然难看，但一眼能看出
 * "这里漏传了参数"，比另外两种选择更容易在评审或使用中被发现。
 */
function interpolate(template: string, params?: Interpolations): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (raw: string, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : raw)
}

export function translate(lang: Lang, key: TranslationKey, params?: Interpolations): string {
  return interpolate(dictionaries[lang][key], params)
}

export interface I18n {
  lang: Lang
  t(key: TranslationKey, params?: Interpolations): string
}

/**
 * 用 Context 而不是一路用 props 往下传：AnnotationPanel/GroupPanel/ContentPane
 * 离 App 只隔一两层，props 传得动；但 NodeRow 是 react-arborist 通过它自己的
 * renderNode 回调渲染的，中间隔着 Tree.tsx——把 t 塞进这条链路得连带改 TreeProps 和
 * NodeRowExtraProps 两层类型契约，只为传一个跟树的业务逻辑（拖拽/展开/选中）毫无关系
 * 的函数。NodeRow 返回的 JSX 仍然是 App 组件树的一部分（react-arborist 只是决定
 * "这一帧渲染哪些节点"，不改变它们在 React 树里的位置），所以 Context 能直接够到它，
 * 不必绕路。这是本项目目前唯一一处用 Context 的地方，只因为这一条链路 props 穿不透。
 *
 * 默认值给一份"退化到 zh"的实现，不是摆设：AnnotationPanel/GroupPanel/ContentPane/
 * NodeRow 各自的独立单测（对应的 *.test.tsx）都是直接渲染该组件本身，不会包一层
 * `<I18nContext.Provider>`——没有默认值，这些测试会在 useContext 处读到 undefined 而
 * 崩溃。默认值等于"没被 Provider 包裹时按中文渲染"，与那批测试今天断言的中文文案天然
 * 一致，因此它们一行都不用改——这正是"默认语言下渲染结果必须与今天完全一致"这条安全
 * 属性在测试基础设施层面的体现，不只是 App 整体渲染时的表现。
 */
export const I18nContext = createContext<I18n>({
  lang: 'zh',
  t: (key, params) => translate('zh', key, params),
})

export function useT(): I18n['t'] {
  return useContext(I18nContext).t
}

export function useLang(): Lang {
  return useContext(I18nContext).lang
}

// ---------------------------------------------------------------------------
// 报错的翻译。**与上面的 t() 字典是两张表，刻意分开。**
// ---------------------------------------------------------------------------

/**
 * 错误码 → 中文。**这张表只有中文，没有英文，而且必须一直只有中文。**
 *
 * 英文的唯一定义处是 core 的 `EN_MESSAGES`（core/src/errors.ts），`SpecError.message`
 * 就是它渲染好的结果，一路带过 bridge 到这里。在这儿再存一份英文，等于同一句话在两个
 * 包里各有一份，从此开始漂移；而查不到码时直接显示 message，新增的码即使还没翻译也会
 * **自动降级成英文**，而不是把一个码甩给用户。
 *
 * **为什么不并进上面的 zh/en 字典**：那两张表有一条测试强制键集完全一致（i18n.test.ts
 * 第一条），而这张表故意只有一侧。并进去只有两种结局——要么补一份英文（正是上一段说的
 * 漂移），要么把那条校验放松（它守的是"界面文案少了一个语言"这类真缺陷）。两张表各有
 * 各的不变量，合并会让两条都变松。
 *
 * 类型是 `Partial<Record<SpecErrorCode, string>>` 而不是 `Record<string, string>`：
 * `Partial` 允许"这个码还没翻译"（降级路径靠的就是这个），但键名拼错、或者 core 那侧
 * 删掉/改名了一个码，`tsc` 当场就红。这类错误的运行期表现是"这一句永远是英文"——界面上
 * 看着完全正常，没有任何症状能让人发现它，只能靠编译期。
 *
 * 文案直接取自 core 改造之前那批中文原文（第一轮报告 §4 的对照表），不是重新翻译一遍：
 * 重译只会引入与 core 英文措辞不一致的第三种说法。两处例外，各有理由，见下面的行内注释。
 *
 * 占位符名字必须与 core 的 params 键**逐字**一致（`interpolate` 对缺键是原样保留，
 * 写错会在界面上留下一个显眼的 `{path}`）。`path.*` / `name.*` 系列的参数值在 core 侧
 * 已经 `JSON.stringify` 过（自带引号），中文句子里不要再套一层引号。
 */
export const ERROR_ZH: Partial<Record<SpecErrorCode, string>> = {
  // ---- 路径进入系统的边界 ----
  'path.notRelative': '路径必须是工作区相对路径，实际是 {path}',
  'path.parentSegment': '路径不得包含 ".." 段，实际是 {path}',
  'path.escapesWorkspace': '路径 {path} 解析后逃出工作区，可能经过符号链接，拒绝读取',

  // ---- 路径 / 名字的可表示性 ----
  'path.empty': '路径不能为空',
  'path.unrepresentable': '路径 {path} 含有反引号或换行，当前契约格式无法表示；请重命名该文件或目录',
  // {field} 是 role / template 这两个标识符本身（core 侧原样传过来），不是可翻译的词：
  // 它指的就是 `[role:x]` 标签里的那个字面量，翻成"角色"反而对不上用户看到的语法。
  'identifier.forbiddenChar':
    '{field} 不能包含反引号、"]" 或空白字符（会破坏 `[{field}:...]` 标签语法）：{value}',
  'name.empty': '名字不能为空',
  'name.hasSlash': '名字 {name} 不能包含 "/"：这里只接受单个路径段，不是路径',
  'name.unrepresentable': '名字 {name} 含有反引号或换行，当前契约格式无法表示',
  // 例外之一：原中文只有前半句"在文件系统里有特殊含义"，后半句"为什么"当时只写在
  // session.ts 的代码注释里，英文版把它提进了文案。这里照着**那条已有的中文注释**补齐，
  // 不是新译——否则中文用户拿到的解释比英文用户少一半，而这半句正是他判断该怎么办的依据。
  'name.reserved':
    '名字不能是 "{name}"：它在文件系统里有特殊含义，'
    + 'Agent 读到这样一条声明时分不清是笔误，还是真要对上级目录动手',

  // ---- 同层重名 ----
  'name.duplicateSibling':
    '`{parent}` 下已经有同名节点 `{name}`：同层同名兄弟是重复声明，解析器会拒绝，请换个名字',
  'name.duplicateSiblingAtRoot':
    '工作区根下已经有同名节点 `{name}`：同层同名兄弟是重复声明，解析器会拒绝，请换个名字',

  // ---- 根节点不可动 ----
  'move.rootNode': '不能移动根节点',
  'copy.rootNode': '不能复制根节点',
  'rename.rootNode': '不能重命名根节点',
  'remove.rootNode': '不能移除根节点',

  // ---- 自己套自己 ----
  'move.intoOwnSubtree': '不能把节点移动到它自己的子树下',
  // 这个码覆盖 core 里的两处 throw，原本有长短两版中文；一个码只能有一条中文，
  // 取带"为什么"的那一版（与英文侧的取舍一致，见第一轮报告 §4 的 #9/#28）。
  'copy.intoOwnSubtree':
    '不能把节点粘贴到它自己或它的子树下：那会让这个节点声明自己内部还有一份自己，'
    + '再粘一次又翻一倍，而契约的消费者是会照着它真去建目录的 Agent',

  // ---- 移动时的合并冲突 ----
  // 例外之二：{conflicts} 是 core 已经渲染好的**英文**明细（每条冲突自带字段名、路径和
  // 两侧的值），params 装不下"可翻译的子句数组"，翻不动——这是第一轮报告 §10 顾虑 1 记下的
  // 已知缺口。这里用上 core 特意多给的 {count}，让中文这侧至少能说清"一共几处"，
  // 而不是把冲突截断成第一条（少报一条就等于把一条会被覆盖的注释藏起来）。
  'move.mergeConflict':
    '目标位置已经有同名节点，这次移动会覆盖掉它已经写下的内容（共 {count} 处）：{conflicts}。'
    + '请先决定保留哪一份（把其中一侧清空，或把两侧改成相同内容），再重试这次移动',

  // ---- 移除声明时的子树保护 ----
  'remove.subtreeHasContent':
    '`{path}` 下还有带注释/角色/模板/严重级别的子节点，移除会连带丢失这些声明：'
    + '请先分别移除这些子节点自己的声明，再移除该节点本身',

  // ---- 懒加载边界 ----
  'node.unscannedKind': '`{path}` 尚未扫描到，无法确认它是文件还是目录；请先展开它所在的目录再重试',
  'rename.targetUnscanned': '`{path}` 尚未扫描到，无法确认磁盘上有没有同名的东西；请先展开它所在的目录再重试',
  'copy.targetChildrenUnscanned': '`{path}` 的子项尚未扫描，无法确认磁盘上有没有同名的东西；请先展开该目录再重试',
  'parent.unscanned': '`{path}` 尚未扫描到，无法确认磁盘上是文件还是目录；请先展开该节点再重试',

  // ---- 目标不存在 ----
  'rename.sourceMissing': '契约里和磁盘上都没有 `{path}`，没有可以重命名的节点',
  'copy.sourceMissing': '契约里和磁盘上都没有 `{path}`，没有可以复制的节点',

  // ---- 磁盘上已经有人占着这个名字 ----
  'rename.targetOccupiedOnDisk':
    '`{path}` 在磁盘上已经存在：改成这个名字会让契约把两个不同的东西说成同一个，'
    + '两边的注释也会被揉到一起。请换一个名字（本工具不会去动磁盘上的文件名）',

  // ---- hidden：本次会话里被拖走的旧位置 ----
  'hidden.oldLocation':
    '`{path}` 是本次会话里刚被拖走的旧位置，它和它下面的一切在树上都不显示；'
    + '在这里写下的声明你既看不见也删不掉，请改用它现在所在的位置',
  'hidden.resultPath':
    '`{path}` 是本次会话里刚被拖走的旧位置，在这里新建的声明不会显示在树上；请改用它现在所在的位置',

  // ---- 父级不可挂载 ----
  'parent.fileOnDisk': '`{path}` 在磁盘上是一个文件，不能在它下面新建节点',
  'parent.fileInSpec': '`{path}` 在契约里被声明为文件，不能在它下面新建节点',

  // ---- 声明的类型与磁盘冲突。两个方向各一个码——"目录"/"文件"这两个词是句子的一部分，
  //      不是参数；当参数传的话中文这侧会得到"在磁盘上是一个 directory"。
  'declare.typeConflictDiskDir':
    '`{path}` 在磁盘上是一个目录，不能在契约里把它声明成文件：树上只会按磁盘上的真实类型显示，'
    + '界面看不出任何异常，而契约里留下的是一条 Agent 会照做的假声明',
  'declare.typeConflictDiskFile':
    '`{path}` 在磁盘上是一个文件，不能在契约里把它声明成目录：树上只会按磁盘上的真实类型显示，'
    + '界面看不出任何异常，而契约里留下的是一条 Agent 会照做的假声明',

  // ---- 只读态 ----
  'readonly.parseFailed': '契约文件解析失败，当前为只读模式，请先修复文件',
  'readonly.diskView': '当前处于「原始结构」视图，为只读模式；切回「我的结构」视图后即可编辑',

  // ---- 写盘前的自校验 ----
  // {details} 是解析器给的行号 + 原因。解析层的报错第三轮才配码，在那之前它是中文原文，
  // 英文界面下会在这一句里嵌一段中文——已知，见本轮报告"未覆盖"一节。
  'serialize.selfCheckFailed': '序列化自校验失败，已中止以免损坏契约文件：{details}',
}

/**
 * 我们自己在界面里生成的一条报错（不是 core 抛的），带的是**字典键**而不是渲染好的字符串。
 *
 * 为什么不直接 `setError(t('banner.copyFailed', …))`：横幅要跟着语言开关走，存进 state 的
 * 就必须是"还没渲染的东西"，渲染推迟到显示那一刻。存字符串等于把语言烘焙进去——用户切了
 * 语言，横幅还停在旧语言上，而他切语言的目的恰恰是看懂它。
 */
export interface UiMessage {
  uiKey: TranslationKey
  uiParams?: Interpolations
}

/** `e` 是不是一条我们自己生成的界面报错。按形状判断，理由同 translateError。 */
function isUiMessage(e: unknown): e is UiMessage {
  return typeof e === 'object' && e !== null && typeof (e as UiMessage).uiKey === 'string'
}

/**
 * 把一个 catch 到的东西按当前语言渲染成横幅上的那句话。
 *
 * 规则只有两条：
 * 1. `lang === 'zh'` 且这个码在 ERROR_ZH 里 → 用中文模板，params 代回占位符；
 * 2. 其余一切 → 用 `message`（core 给的英文，或宿主自己那句话）。非 Error 的值退化成
 *    `String(e)`，与接线之前 `e instanceof Error ? e.message : String(e)` 逐字一致。
 *
 * **按形状判断，不用 instanceof。** core 导出了 `isSpecError()`，但那是 `instanceof
 * SpecError`——错误跨过 bridge 是走 JSON 的，原型早就没了，那个函数只对与 core 同进程的
 * 宿主成立。ui 对 core 也只允许 `import type`，运行期符号根本不该出现在这一侧。
 */
export function translateError(e: unknown, lang: Lang): string {
  if (isUiMessage(e)) return translate(lang, e.uiKey, e.uiParams)

  const message = e instanceof Error ? e.message : String(e)
  if (lang !== 'zh') return message

  const wire = typeof e === 'object' && e !== null
    ? e as { code?: unknown; params?: unknown }
    : null
  if (wire === null || typeof wire.code !== 'string') return message

  // 从进程外收来的 code 本来就不可信，这里只是一次运行期查表：查不到就是 undefined，
  // 走的正是"还没翻译的码降级成英文"那条路，而不是把码甩给用户。
  const template = ERROR_ZH[wire.code as SpecErrorCode]
  if (template === undefined) return message

  const params = typeof wire.params === 'object' && wire.params !== null
    ? wire.params as Interpolations
    : undefined
  return interpolate(template, params)
}
