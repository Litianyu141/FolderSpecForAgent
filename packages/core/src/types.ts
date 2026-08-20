import type { SpecErrorCode, SpecErrorParams } from './errors.js'

export type Severity = 'error' | 'warning' | 'advisory'

export interface SpecNode {
  name: string
  isDir: boolean
  role?: string
  template?: string
  severity?: Severity
  annotation?: string
  children: SpecNode[]
}

export interface TemplateChild {
  name: string
  isDir: boolean
  role?: string
  required: boolean
}

export interface Template {
  name: string
  description?: string
  rootVariable?: string
  rootNaming?: string
  children: TemplateChild[]
  exemplar: string[]
}

export interface Rule {
  id: string
  severity: Severity
  scope: string
  text: string
}

export interface Group {
  id: string
  /** 工作区相对 posix 路径 */
  members: string[]
  text: string
  severity?: Severity
}

/**
 * 我们生成的样板文字（标题行、导言、四个章节标题）用哪种语言。用户写的内容——节点
 * 注释、分组说明、规则文字、模板描述、语义角色、节点名、路径——一律不受它影响。
 *
 * 存进 front-matter 而不是由宿主/UI 各自记在本地设置里：语言是「不可重算的区分」，
 * 无法从磁盘 + 契约反推出用户想要哪种，因此不违反"派生状态一律不落盘"。存进文件
 * 还让协作者拉下来看到的语言与写入时一致，两人界面语言不同也不会互相改写这个字段
 * 引发 git 里的来回拉锯（用户已裁定，见 lang-core-report.md）。
 */
export type Lang = 'zh' | 'en'

export interface Spec {
  version: number
  root: string
  ownership: string
  /** 缺失的老文件按 'zh' 处理，见 parse/index.ts 与 spec-edit.ts 的 emptySpec()。 */
  lang: Lang
  title: string
  preamble: string[]
  nodes: SpecNode[]
  templates: Template[]
  rules: Rule[]
  groups: Group[]
}

/**
 * 解析失败时报给用户的一条：**行号 + 渲染好的英文 message + 错误码 + 参数**。
 *
 * `line` 与 `message` 是原有的两个字段，`code`/`params` 是后加的——加法，不是替换：
 * 不认识码的消费者（日志、还没接线的宿主）照旧显示 `message` 一句英文人话，认识码的
 * 显示端（ui 的 translateError）按码换成另一种语言。构造请一律走 errors.ts 的
 * `parseError()`，它保证这三者不会各说各话。
 *
 * `code` 之所以可选，是留给"从进程外收来的一条 ParseError"——那是 JSON.parse 的产物，
 * 类型系统一个字都保证不了；读取端容错，不是给自己人留后门。
 */
export interface ParseError {
  line: number
  message: string
  code?: SpecErrorCode
  params?: SpecErrorParams
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: ParseError[] }

export interface Line {
  line: number
  text: string
}

export interface YamlBlock {
  text: string
  startLine: number
}

export interface RawSections {
  frontMatter: Record<string, string>
  title: string
  preamble: string[]
  structure: Line[]
  templatesYaml: YamlBlock | null
  rulesYaml: YamlBlock | null
  groupsYaml: YamlBlock | null
}

export const SEVERITIES: readonly Severity[] = ['error', 'warning', 'advisory']

export function isSeverity(v: unknown): v is Severity {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v)
}

export type FileKind = 'file' | 'dir' | 'symlink'

export interface ActualNode {
  name: string
  /** 相对工作区根的 posix 路径；根节点为 '' */
  path: string
  kind: FileKind
  /** undefined = 该目录尚未扫描（懒加载边界）；[] = 已扫描且为空 */
  children?: ActualNode[]
  /** 直接子项超过 MAX_CHILDREN，已截断 */
  truncated?: boolean
  /** readdir 失败（通常是权限） */
  unreadable?: boolean
}

export interface ScanOpts {
  /** 相对根的子路径，扫描从这里开始；默认 '' 即根本身 */
  subPath?: string
  /** 从起点往下扫几层；默认 2 */
  depth?: number
  /** 单目录最多保留多少子项，超出则截断；默认 MAX_CHILDREN。主要用于测试和对扫描量有更紧预算的调用方 */
  maxChildren?: number
}

export type GitState = 'ignored' | 'untracked' | 'modified' | 'added' | 'deleted' | 'conflicted'

/**
 * 键是相对工作区根的 posix 路径（不含尾斜杠），值是**这个路径该显示成什么 git 状态**。
 *
 * 注意它不是 `git status` 输出的逐行镜像：git 只报文件（外加被整体忽略的目录、以及
 * 子模块），而这张表里还有由 gitStatus() 一次性滚上去的祖先目录条目。对**目录**而言
 * 值的含义是「它自己或它任意一个后代的状态里，优先级最高的那个」，**不是**「这个目录
 * 自己被改了」——目录本身没有内容可改。优先级顺序与"ignored 不参与聚合"的理由见
 * git.ts 的 rollupDirStates()。
 */
export type GitStates = Map<string, GitState>

export type NodeOrigin = 'both' | 'spec-only' | 'actual-only' | 'unscanned'

/**
 * 'spec'：三源合成（默认，现有行为）——磁盘扫描 + git 状态 + 契约，契约里声明的结构生效。
 * 'disk'：只按磁盘扫描结果建树，忽略契约里的结构性重排——用于「原始结构」对比视图，
 * 让用户看清拖拽到底改了什么（拖拽本身不记录"从哪儿来"，是设计文档 §6.1 记录在案、
 * 刻意接受的限制；这个模式是四个候选方案里用户选中的补偿手段）。
 * 纯显示模式，不落盘、不进 Spec——与 hidden 同类的派生状态。
 */
export type ViewMode = 'spec' | 'disk'

export interface ViewNode {
  name: string
  path: string
  isDir: boolean
  origin: NodeOrigin
  /**
   * 对文件：这个文件自己的 git 状态。
   * 对目录：**它自己或它整棵子树的聚合状态**（见 GitStates 的注释），与 VSCode 资源
   * 管理器一致——目录里有改动，目录名就变色。别把目录上的这个值读成"这个目录自己被
   * 修改了"。
   *
   * 刻意复用同一个字段而不是另开一个 childGitState：它只喂给取色
   * （ui/src/colors.ts 的 nodeColorVar），从不作为文字显示，所以填聚合值不会让界面
   * 说假话；而多一个字段就多一处两边可能分叉的地方，UI 还得自己再实现一遍"两个字段
   * 谁优先"的规则——那正是 rollupDirStates 已经算过的东西，重算一遍只会有第二套排序。
   */
  gitState?: GitState
  annotation?: string
  role?: string
  template?: string
  severity?: Severity
  /** 该节点所属的分组 id（由 merge 从 Spec.groups 反查，不落盘） */
  groups?: string[]
  children?: ViewNode[]
  truncated?: boolean
  unreadable?: boolean
}
