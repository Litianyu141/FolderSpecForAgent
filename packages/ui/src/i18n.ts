import { createContext, useContext } from 'react'
import type { Lang } from '@folderspec/core/api'

export type { Lang }

/**
 * 只翻译"操作界面"（我们自己写的按钮/标签/提示语），绝不翻译用户内容：节点注释、
 * 分组说明、规则文字、模板描述、语义角色、文件名/路径、core 抛出的报错文案、解析错误
 * 的行号与原文——这些是用户或磁盘给的数据，字典里没有它们的位置，调用点也不会替它们
 * 找一个键（判据见 i18n-brief.md：这段文字是我们写的还是用户/磁盘给的？我们写的才翻译）。
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
  'contextMenu.removeNode': '取消声明',
  /** 不叫「删除」：它不删磁盘上任何东西，对磁盘上真实存在的节点，取消声明之后那一行
   *  依旧在树上，只是不再带任何标注 */
  'contextMenu.removeDisabledNotDeclared': '这个节点在契约里还没有任何声明，没有可取消的东西',
  'contextMenu.disabledReadOnly': '当前不可编辑：契约解析失败，或正处在「原始结构」视图',

  // ---- NewNodeDialog：新建节点（仅契约） ----
  /** {parent} 是父目录路径，或 common.workspaceRoot */
  'newNode.titleDir': '在「{parent}」下新建目录（仅契约）',
  'newNode.titleFile': '在「{parent}」下新建文件（仅契约）',
  'newNode.hint': '只在契约里声明「这里应该有它」，不会在磁盘上创建任何东西——真正去建它的是随后读契约的 Agent。',
  'newNode.nameLabel': '名称',
  'newNode.namePlaceholder': '例如 cases',
  'newNode.create': '创建',
  'newNode.cancel': '取消',
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
  'contextMenu.removeNode': 'Remove declaration',
  'contextMenu.removeDisabledNotDeclared':
    'This node has no declaration in the contract yet — there is nothing to remove',
  'contextMenu.disabledReadOnly':
    'Editing is disabled right now: the contract failed to parse, or you are in the "Disk Structure" view',

  'newNode.titleDir': 'New directory under "{parent}" (contract only)',
  'newNode.titleFile': 'New file under "{parent}" (contract only)',
  'newNode.hint':
    'This only declares "there should be one here" in the contract — nothing is created on disk. The agent that reads the contract is what actually creates it.',
  'newNode.nameLabel': 'Name',
  'newNode.namePlaceholder': 'e.g. cases',
  'newNode.create': 'Create',
  'newNode.cancel': 'Cancel',
}

const dictionaries: Record<Lang, Record<TranslationKey, string>> = { zh, en }

type Interpolations = Record<string, string | number>

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
