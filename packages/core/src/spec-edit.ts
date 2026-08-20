import type { Group, Lang, Severity, Spec, SpecNode } from './types.js'

export interface AnnotationPatch {
  annotation?: string | null
  role?: string | null
  template?: string | null
  severity?: Severity | null
}

/**
 * 标题行与导言的两语言默认文案，emptySpec() 与 setLang() 共用同一份——两处各自维护
 * 一份的话，改一个字就要记得改两处，迟早会走样。
 *
 * zh 这份必须与本工具引入双语支持之前的默认值逐字相同：控制器裁定"lang === 'zh' 时
 * 序列化输出必须与今天逐字节相同"，这份文案正是那条不变量的源头（title/preamble 只
 * 在 emptySpec() 里出现一次默认值，serializeSpec 本身不认识"默认值"这个概念）。
 * en 这份用户已给定，不是自译，见 lang-core-report.md。
 */
const LANG_DEFAULTS: Record<Lang, { title: string; preamble: string[] }> = {
  zh: {
    title: '仓库结构契约',
    preamble: [
      '本文件声明本仓库的**结构意图**，是长期不变量，不是一次性操作指令。',
      'Agent 应读取本文件、对照实际仓库、自行决定如何变更磁盘。',
      'Agent 不应自行修改本文件；若认为规则不合理，请向人类提出修改建议。',
    ],
  },
  en: {
    title: 'Repository Structure Contract',
    preamble: [
      'This file declares the **structural intent** of this repository. It states long-lived invariants, not one-off operations.',
      'Agents should read this file, compare it against the actual repository, and decide for themselves how to change the disk.',
      'Agents should not modify this file themselves; if a rule seems wrong, raise it with a human.',
    ],
  },
}

export function emptySpec(lang: Lang = 'zh'): Spec {
  const d = LANG_DEFAULTS[lang]
  return {
    version: 1,
    root: '.',
    ownership: 'human',
    lang,
    title: d.title,
    preamble: [...d.preamble],
    nodes: [],
    templates: [],
    rules: [],
    groups: [],
  }
}

/**
 * 切换 Spec 展示语言的纯函数。只动 lang 字段与"未被用户改过"的样板文字（标题行、
 * 导言）；节点注释、分组说明、规则文字、模板描述与名字、语义角色、节点名、路径——
 * 这些都是用户内容，一个字都不碰（见需求原话："用户的注释保留原始语言"）。
 *
 * 判据：当前 title / preamble 是否逐字等于**切换前**那个语言的默认值。这里比较的
 * 基准是"切换前的语言"而不是目标语言——因为整个系统只有两种语言，"切换前的语言"
 * 与"目标语言之外的另一语言"永远是同一个，两种说法在语义上等价。
 *
 * 逐字相等 → 换成新语言的默认值；哪怕只改了一个字（不逐字相等）→ 当作用户内容，
 * 原样保留。preamble 按整段（三句合在一起）比较，不是逐句比较：导言是一个语义
 * 整体，用户只改了其中一句也说明他动过这段文字，不该把其余两句悄悄换到另一语言、
 * 让一段导言里混着两种语言。
 */
export function setLang(spec: Spec, lang: Lang): Spec {
  const next = structuredClone(spec)
  const from = LANG_DEFAULTS[spec.lang]
  const to = LANG_DEFAULTS[lang]

  if (next.title === from.title) next.title = to.title
  if (arraysEqual(next.preamble, from.preamble)) next.preamble = [...to.preamble]

  next.lang = lang
  return next
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function setAnnotation(spec: Spec, path: string, isDir: boolean, patch: AnnotationPatch): Spec {
  const segs = toSegments(path)
  if (segs.length === 0) throw new Error('路径不能为空')

  const next = structuredClone(spec)
  // 必须在 ensure() 改动 next.nodes 之前算：这次调用自己会新建哪些节点，只有在
  // ensure() 动手之前才分得清——见 pruneAlong 的说明。
  const keepDepth = preExistingDepth(next.nodes, segs)
  const node = ensure(next.nodes, segs, isDir)

  applyText(node, 'annotation', patch.annotation)
  applyText(node, 'role', patch.role)
  applyText(node, 'template', patch.template)
  if (patch.severity !== undefined) {
    if (patch.severity === null) delete node.severity
    else node.severity = patch.severity
  }

  pruneAlong(next.nodes, segs, keepDepth)
  return next
}

/**
 * 在契约里声明一个尚不存在的节点——"这里应该有"，不是"去创建它"（spec §3.2 声明式）。
 * 父级链条复用 setAnnotation 同一套 ensure() 逻辑按需补齐：契约是稀疏覆盖层，只含被
 * 标注节点及其祖先链，不该为了声明一个深层节点就要求调用方先手动把每一级父目录都建出来。
 *
 * 同层重名在这里就地拒绝，不是留给 save() 的自校验去发现：解析器判重的键只有 name（见
 * parse/structure.ts「同一层重名节点」的报错与其上方注释），如果放行创建，下游 merge
 * （用 name→node 的 Map，后一个覆盖前一个）与 spec-edit 的其他函数（用 list.find 命中
 * 第一个）会对"哪一个才算数"给出相反答案；serialize→parse 的自校验会在 save() 时才
 * 中止写入，那时用户已经交互过一整轮，之后再也存不了盘——必须在创建的这一刻就堵死。
 */
export function createNode(spec: Spec, parentPath: string, name: string, isDir: boolean): { spec: Spec; path: string } {
  const parentSegs = toSegments(parentPath)
  const next = structuredClone(spec)
  const siblings = parentSegs.length === 0 ? next.nodes : ensure(next.nodes, parentSegs, true).children

  if (siblings.some(n => n.name === name)) {
    throw new Error(
      `${parentSegs.length === 0 ? '根' : `\`${parentSegs.join('/')}\``} 下已经有同名节点 \`${name}\`：` +
      '同层同名兄弟是重复声明，解析器会拒绝，请换个名字',
    )
  }

  siblings.push({ name, isDir, children: [] })
  const path = parentSegs.length === 0 ? name : `${parentSegs.join('/')}/${name}`
  return { spec: next, path }
}

/**
 * 把一个节点（连同它的子树）在契约里挪到另一个父级下——"我声明它应该在那儿"，
 * 不是"去把它搬过去"（真正动磁盘的是随后读契约的 Agent，见 CLAUDE.md 铁律 1、2）。
 *
 * 红线（与 removeNode 的子树保护同源，见下面 assertNoMergeConflict）：目标层已经
 * 有同名节点时要做一次合并，合并绝不能用源节点的内容把目标已经写下的内容顶掉。
 * 两条写路径（move / removeNode）对"这次操作会不会弄丢人写的注释"必须给出同一个
 * 答案：都是**在输入边界拒绝**，都不提供"强制覆盖 / 强制级联"的旁路。
 */
export function moveNode(spec: Spec, from: string, toParent: string, isDir: boolean): Spec {
  const fromSegs = toSegments(from)
  if (fromSegs.length === 0) throw new Error('不能移动根节点')
  const toSegs = toSegments(toParent)

  const fromPrefix = `${fromSegs.join('/')}/`
  if (`${toSegs.join('/')}/`.startsWith(fromPrefix)) {
    throw new Error('不能把节点移动到它自己的子树下')
  }

  const next = structuredClone(spec)
  const name = fromSegs[fromSegs.length - 1]

  // spec 里没有该节点时，新建一个空节点——它表达"我声明它应该在这里"，本身就是有效数据
  // isDir 参数只在源节点不存在时生效；现有数据优先级高于调用者的声明
  const detached = detach(next.nodes, fromSegs) ?? { name, isDir, children: [] }
  // 不回收源路径上因此变空的祖先：detach() 只查找、从不创建，它能找到的每一级祖先
  // 都必然是"这次移动之前就已经存在的节点"（否则 detach 早就在那一级返回 null 了）。
  // 按 pruneAlong 现在的规则——只回收本次编辑自己新建的部分——这里永远是空操作，
  // 索性不调用：源路径上因为搬空而变空的目录留在原地，交给用户自己决定要不要清，
  // 而不是被这次移动顺手吃掉（它完全可能是 createNode 或更早一次编辑明确声明
  // 出来的节点，工具没有办法分辨）。
  const list = toSegs.length === 0 ? next.nodes : ensure(next.nodes, toSegs, true).children
  const existing = list.find(n => n.name === detached.name)
  if (existing) {
    // 抛在这里而不是函数开头，靠的是 next 是一份 structuredClone：上面 detach()/
    // ensure() 的就地改动全部发生在这个副本上，抛错时调用方手里的 spec 一个字节
    // 都没被碰过（removeNode 的子树保护也是同一个写法）。为了把冲突检查提到最前面
    // 而把 detach 的查找逻辑再实现一遍，只会多出第二份"源节点是谁"的判据。
    assertNoMergeConflict(existing, detached, toSegs.length === 0 ? detached.name : `${toSegs.join('/')}/${detached.name}`)
    mergeInto(existing, detached)
  } else list.push(detached)

  const movedName = fromSegs[fromSegs.length - 1]
  const movedTo = toSegs.length === 0 ? movedName : `${toSegs.join('/')}/${movedName}`
  rewriteGroupMembers(next.groups, fromSegs.join('/'), movedTo)

  return next
}

/**
 * 从契约里撤销一个节点的声明——"不再声明这里应该有它"，不是删除磁盘上的文件/目录
 * （真正动磁盘的是随后读契约的 Agent，见 CLAUDE.md 铁律 1）。对 `origin: 'both'` 的
 * 节点（磁盘上真实存在）而言，节点依旧会出现在树上（merge 按磁盘扫描结果把它物化
 * 成 actual-only），只是不再带任何标注；只有对 spec-only 节点（磁盘上不存在），移除
 * 才等于这一行彻底从树上消失——这两种情形在调用方那侧看起来不一样，但对这个函数
 * 而言是同一件事：从 spec.nodes 里去掉这一条声明。
 *
 * 子树保护（红线所在）：若目标节点的子树（不含它自己）里有任何一个后代带着用户内容
 * （annotation/role/template/severity），一律拒绝——结构区是嵌套列表，移除一个目录
 * 节点必然连带移除它在 spec.nodes 里嵌套的全部子节点，子节点的行离不开父节点的行；
 * 无条件级联等于一次点击丢掉多条用户或 Agent 已经写下的声明，正是本工具"唯一能造成
 * 的伤害是弄丢人写的注释"这条铁律要防的事。拒绝时不提供"强制级联"的旁路：想清空
 * 整棵子树，请自底向上对每个带内容的子节点分别调用一次——每一步都是一次独立、可
 * 撤销、被用户明确按下的操作，而不是一次点击的隐藏后果（"显式优于隐式"）。目标节点
 * 自己的 annotation/role/... 不受这条限制——移除它自己的声明正是本函数要做的事；
 * 限制只看**子孙**是否带内容，纯脚手架子树（没有任何一层携带内容）才允许连同收走。
 *
 * 分组成员留作悬空，不在这里一并清理：与 moveNode 的 rewriteGroupMembers 不同——
 * 那边节点还在（只是换了路径），把成员路径同步过去是维持同一个指代对象继续有效；
 * 这里节点的声明整个被撤销，不存在"该指向哪儿"这个新答案，代替调用方悄悄改掉一条
 * 分组成员是本函数被要求之外的隐式副作用。也不是什么新状况：`both` 节点移除声明后
 * 依旧出现在树上（上面已经说明），分组点位置照常显示；只有 spec-only 节点被移除后，
 * 它的分组成员才会退化成 README 已经记录、判定为可接受的已知限制——"分组成员若
 * 既不在结构区、又不在磁盘上，树上不会出现对应的行，但成员本身不会丢失，仍在
 * `.folderspec.md` 的分组区与分组面板里"。用户若想真的清掉这条成员，走 setGroup
 * 显式改 members，而不是指望删节点时顺带发生。
 *
 * 路径不存在时是空操作，不报错——与 deleteGroup 对不存在 id 的既有行为一致："撤销
 * 一个本来就不存在的声明"天然就该是幂等的，不该因为调用了两次就报错。
 */
export function removeNode(spec: Spec, path: string): Spec {
  const segs = toSegments(path)
  if (segs.length === 0) throw new Error('不能移除根节点')

  const next = structuredClone(spec)
  let list = next.nodes
  for (let i = 0; i < segs.length - 1; i++) {
    const found = list.find(n => n.name === segs[i])
    if (!found) return next // 路径不存在：空操作
    list = found.children
  }
  const idx = list.findIndex(n => n.name === segs[segs.length - 1])
  if (idx === -1) return next // 路径不存在：空操作

  const target = list[idx]
  if (target.children.some(hasContent)) {
    throw new Error(
      `\`${path}\` 下还有带注释/角色/模板/严重级别的子节点，移除会连带丢失这些声明：` +
      '请先分别移除这些子节点自己的声明，再移除该节点本身',
    )
  }

  list.splice(idx, 1)
  return next
}

/** 节点自身或其任意后代是否带有用户内容。removeNode 用它判断能不能连同子树一起
 *  收走——只有整棵子树都是"纯脚手架"（没有任何一层携带内容）才允许，否则移除一个
 *  目录会把子孙的声明一并静默吃掉，见 removeNode 上方注释里的"子树保护"。 */
function hasContent(n: SpecNode): boolean {
  if (n.annotation || n.role || n.template || n.severity) return true
  return n.children.some(hasContent)
}

export function findSpecNode(nodes: SpecNode[], path: string): SpecNode | null {
  let list = nodes
  let node: SpecNode | null = null
  for (const seg of toSegments(path)) {
    node = list.find(n => n.name === seg) ?? null
    if (!node) return null
    list = node.children
  }
  return node
}

// ---------- 内部 ----------

function toSegments(path: string): string[] {
  return path.split('/').filter(s => s !== '')
}

/** 沿路径确保节点存在；缺失的祖先一律按目录创建 */
function ensure(nodes: SpecNode[], segs: string[], lastIsDir: boolean): SpecNode {
  let list = nodes
  let node!: SpecNode
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const isLast = i === segs.length - 1
    let found = list.find(n => n.name === seg)
    if (!found) {
      found = { name: seg, isDir: isLast ? lastIsDir : true, children: [] }
      list.push(found)
    } else if (!isLast) {
      // 要从它下面穿过去，它必然是目录
      found.isDir = true
    } else if (found.isDir !== lastIsDir) {
      // 只有在没有子项时才允许把目录降级成文件
      if (lastIsDir || found.children.length === 0) found.isDir = lastIsDir
    }
    node = found
    list = found.children
  }
  return node
}

function detach(nodes: SpecNode[], segs: string[]): SpecNode | null {
  let list = nodes
  for (let i = 0; i < segs.length - 1; i++) {
    const found = list.find(n => n.name === segs[i])
    if (!found) return null
    list = found.children
  }
  const idx = list.findIndex(n => n.name === segs[segs.length - 1])
  if (idx === -1) return null
  return list.splice(idx, 1)[0]
}

/** 四个"用户内容"字段在报错文案里的中文叫法。与 hasContent 判定的是同一组字段——
 *  「什么算人写下的内容」这件事在本文件里只有一份定义，move 与 removeNode 共用。 */
const CONTENT_FIELD_LABELS: ReadonlyArray<{ key: 'annotation' | 'role' | 'template' | 'severity'; label: string }> = [
  { key: 'annotation', label: '注释' },
  { key: 'role', label: '语义角色' },
  { key: 'template', label: '模板' },
  { key: 'severity', label: '严重级别' },
]

/**
 * 红线闸门：mergeInto 会用 incoming 的内容字段覆盖 target 的同名字段，这一步不能
 * 静默发生。
 *
 * 为什么是"拒绝"而不是"把两边并起来"：role/template/severity 是单值标识符与枚举，
 * 根本不存在"并"这个操作——只能二选一，而"替调用方悄悄选一个"正是本项目一再拒绝
 * 的做法（见 session.ts 顶部"悄悄改掉一个标识符比报错更糟"）。annotation 虽然能
 * 字符串拼接，但拼出来的是"共享工具函数，勿删 旧的"这种两句互相矛盾的话——契约是
 * 给 Agent 读的长期不变量，一条自相矛盾的声明比报错有害得多。四个字段里三个没有
 * 合并语义，第四个合并出来是垃圾，于是唯一自洽的答案就是与 removeNode 对齐：拒绝，
 * 让用户自己先决定保留哪一份。
 *
 * 判据只认"两侧都非空且不相同"：
 *   - 目标侧为空 → 合并只是把内容填进一个空位，什么都没丢，必须放行（这是绝大多数
 *     真实拖拽的形状，收得再紧一点就会把正常操作挡在门外）；
 *   - 两侧逐字相同 → 覆盖与不覆盖结果一模一样，同样没有内容会消失；
 *   - 源侧为空 → mergeInto 里那几个 `if (incoming.x)` 本来就不会动目标，天然安全。
 *
 * 递归：mergeInto 自己是递归的，被拖过去的子树里每一个同名后代都会各自合并一次，
 * 冲突可能藏在任意一层——只查顶层等于只堵住最浅的那一格。
 */
function assertNoMergeConflict(target: SpecNode, incoming: SpecNode, path: string): void {
  const conflicts: string[] = []
  collectMergeConflicts(target, incoming, path, conflicts)
  if (conflicts.length === 0) return
  throw new Error(
    `目标位置已经有同名节点，这次移动会覆盖掉它已经写下的内容：${conflicts.join('；')}。` +
    '请先决定保留哪一份（把其中一侧清空，或把两侧改成相同内容），再重试这次移动',
  )
}

function collectMergeConflicts(target: SpecNode, incoming: SpecNode, path: string, out: string[]): void {
  for (const { key, label } of CONTENT_FIELD_LABELS) {
    const kept = target[key]
    const coming = incoming[key]
    if (kept && coming && kept !== coming) {
      out.push(`\`${path}\` 的${label}「${kept}」会被「${coming}」覆盖`)
    }
  }
  for (const c of incoming.children) {
    const t = target.children.find(x => x.name === c.name)
    if (t) collectMergeConflicts(t, c, `${path}/${c.name}`, out)
  }
}

function mergeInto(target: SpecNode, incoming: SpecNode): void {
  if (incoming.annotation) target.annotation = incoming.annotation
  if (incoming.role) target.role = incoming.role
  if (incoming.template) target.template = incoming.template
  if (incoming.severity) target.severity = incoming.severity
  for (const c of incoming.children) {
    const existing = target.children.find(t => t.name === c.name)
    if (existing) mergeInto(existing, c)
    else target.children.push(c)
  }
  target.isDir = target.children.length > 0 ? true : incoming.isDir
}

function applyText(node: SpecNode, key: 'annotation' | 'role' | 'template', v: string | null | undefined): void {
  if (v === undefined) return
  const text = v === null ? '' : v.trim()
  if (text === '') delete node[key]
  else node[key] = text
}

function isEmptyNode(n: SpecNode): boolean {
  return n.children.length === 0 && !n.annotation && !n.role && !n.template && !n.severity
}

/** 沿 segs 静态走一遍、不做任何修改，返回从根开始已经存在的层数——ensure() 会在
 *  它之后把缺的层补出来，补之前先测一次，才分得清"这条链上哪些是编辑前就有的，
 *  哪些是这次编辑才新补出来的"。给 pruneAlong 当 minKeepDepth 用。 */
function preExistingDepth(nodes: SpecNode[], segs: string[]): number {
  let list = nodes
  let depth = 0
  for (const seg of segs) {
    const node = list.find(n => n.name === seg)
    if (!node) break
    depth++
    list = node.children
  }
  return depth
}

/**
 * 只沿本次编辑触碰的那条路径自底向上回收空叶子，且只回收**这次编辑自己新补出来**
 * 的那一段——minKeepDepth 之前（含）的节点，哪怕清空后同样满足 isEmptyNode，也
 * 一律不动。
 *
 * 这条规则是从"沿路径无条件回收"收紧过来的，起因是一个真实会删用户内容的 bug：
 * `createNode()` 声明出来的节点天生没有注释、没有子项，与 setAnnotation 为了够到
 * 更深处顺手搭的脚手架在 Spec 里字节相同——如果谁后来（哪怕隔了好几次独立的编辑）
 * 给它写了句注释又反悔清空，旧版本的无条件回收会把这条**明确声明**当成脚手架吃掉，
 * 直接违反"spec-only 节点永远保留、永不自动删除"。工具没有办法从数据本身分辨
 * "这一段是谁、为什么创建的"，唯一能安全依赖的信息只有：它是不是**这一次调用**
 * 自己刚创建的——如果是，回收它只是撤销这次编辑自己造成的半成品；如果不是（哪怕
 * 只早一次调用），它就可能承载着调用方看不见的历史意图，宁可留着，不能吃掉。
 *
 * 代价：跨调用清理空脚手架这个便利特性不再存在了（原来演示"写注释会顺带创建祖先，
 * 清空后一并收回"的几条用例，其实展示的正是这个不安全的机制，已经按新语义改写，
 * 见那几条用例上方的说明）。多留一截没人管的空目录，远比错删一条用户或 Agent
 * 明确声明过的内容安全——这是本工具"唯一能造成的伤害是弄丢人写的注释"这条红线
 * 下必须接受的取舍。
 */
function pruneAlong(rootList: SpecNode[], segs: string[], minKeepDepth: number): void {
  const chain: Array<{ parent: SpecNode[]; node: SpecNode }> = []
  let list = rootList
  for (const seg of segs) {
    const node = list.find(n => n.name === seg)
    if (!node) break
    chain.push({ parent: list, node })
    list = node.children
  }
  for (let i = chain.length - 1; i >= minKeepDepth; i--) {
    const { parent, node } = chain[i]
    if (isEmptyNode(node)) {
      const idx = parent.indexOf(node)
      if (idx !== -1) parent.splice(idx, 1)
    }
  }
}

export interface GroupPatch {
  /** 用户手填的组名。省略或全为空白＝不改名；改名后 id 随之变化，返回的 id 是最终生效的那个。 */
  name?: string | null
  text?: string | null
  severity?: Severity | null
}

/** 取所有成员的最长公共父目录的 basename；无公共父目录时回退为 group。冲突时递增后缀。 */
export function deriveGroupId(members: readonly string[], taken: ReadonlySet<string>): string {
  return uniqueId(commonParentBasename(members), taken)
}

/** 冲突时追加 -2、-3。自动取名与用户改名共用这一条规则，两条路径的去重行为必须一致。 */
function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}

function commonParentBasename(members: readonly string[]): string {
  if (members.length === 0) return 'group'
  const parents = members.map(m => m.split('/').filter(s => s !== '').slice(0, -1))
  let common = parents[0]
  for (const p of parents.slice(1)) {
    let i = 0
    while (i < common.length && i < p.length && common[i] === p[i]) i++
    common = common.slice(0, i)
  }
  const last = common[common.length - 1]
  return last && last !== '..' ? last : 'group'
}

export function setGroup(
  spec: Spec,
  id: string | null,
  members: readonly string[],
  patch: GroupPatch,
): { spec: Spec; id: string } {
  const next = structuredClone(spec)
  const sorted = [...new Set(members)].sort((a, b) => a.localeCompare(b, 'en'))
  const taken = new Set(next.groups.map(g => g.id))
  const current = id === null ? undefined : next.groups.find(g => g.id === id)

  // 改名时自身的旧 id 不算冲突，否则每改一次名字就多一个 -2 后缀
  const wanted = patch.name?.trim()
  const others = new Set(taken)
  if (current) others.delete(current.id)

  const targetId = wanted ? uniqueId(wanted, others) : (id ?? deriveGroupId(sorted, taken))
  const existing = current ?? next.groups.find(g => g.id === targetId)

  const text = patch.text === undefined ? existing?.text : (patch.text ?? '').trim()

  // 清空 text 即删除该分组；对尚不存在的分组是空操作
  if (text === undefined || text === '') {
    if (existing) next.groups = next.groups.filter(g => g !== existing)
    return { spec: next, id: targetId }
  }

  if (existing) {
    existing.id = targetId
    existing.members = sorted
    existing.text = text
    if (patch.severity !== undefined) {
      if (patch.severity === null) delete existing.severity
      else existing.severity = patch.severity
    }
  } else {
    const g: Group = { id: targetId, members: sorted, text }
    if (patch.severity) g.severity = patch.severity
    next.groups.push(g)
  }
  return { spec: next, id: targetId }
}

export function deleteGroup(spec: Spec, id: string): Spec {
  const next = structuredClone(spec)
  next.groups = next.groups.filter(g => g.id !== id)
  return next
}

/** 节点被移动后，指向该子树的分组成员路径必须同步重写，否则分组会悄悄指向不存在的位置。 */
function rewriteGroupMembers(groups: Group[], from: string, to: string): void {
  const prefix = `${from}/`
  for (const g of groups) {
    g.members = g.members.map(m => (m === from ? to : m.startsWith(prefix) ? to + m.slice(from.length) : m))
  }
}
