import type { Group, ViewNode } from '@folderspec/core/api'

export interface ClickMods { shift: boolean; ctrl: boolean }
export interface SelectionState { selected: string[]; anchor: string | null }

/**
 * 屏幕上还剩哪些节点。搜索过滤生效时必须与 react-arborist 的 flattenAndFilterTree
 * 完全一致：命中节点连同它的**全部祖先**都留下（见 react-arborist 的 markMatch——
 * 命中时会把 parent 链一路标上）。只按 matches(n) 逐节点过滤是不够的，那会把
 * "自己不命中、但子孙里有人命中"的目录判掉，而它在屏幕上明明还在。
 */
function keptPaths(nodes: readonly ViewNode[], matches: (node: ViewNode) => boolean): Set<string> {
  const kept = new Set<string>()
  const mark = (n: ViewNode): boolean => {
    let hit = matches(n)
    // 不能短路：即使自己已命中，也要走完子树，否则子孙的命中标记会漏
    for (const c of n.children ?? []) if (mark(c)) hit = true
    if (hit) kept.add(n.path)
    return hit
  }
  for (const n of nodes) mark(n)
  return kept
}

/**
 * 当前可见的展开顺序。Shift 区间以此为准，所见即所选，而非磁盘顺序。
 *
 * `matches` 省略表示没有搜索过滤。它必须传：搜索生效时树上只剩命中的那几行，而区间
 * 是要写进用户契约文件的分组成员——按未过滤的顺序算，会把用户根本没在屏幕上见过的
 * 路径选进去、再随下一次提交落进 .folderspec.md。
 */
export function visibleOrderOf(
  nodes: readonly ViewNode[],
  isOpen: (path: string) => boolean,
  matches?: (node: ViewNode) => boolean,
): string[] {
  const kept = matches === undefined ? null : keptPaths(nodes, matches)
  const out: string[] = []
  const visit = (list: readonly ViewNode[]) => {
    for (const n of list) {
      if (kept !== null && !kept.has(n.path)) continue
      out.push(n.path)
      if (n.isDir && isOpen(n.path) && n.children) visit(n.children)
    }
  }
  visit(nodes)
  return out
}

export function applyClick(
  state: SelectionState,
  clicked: string,
  visibleOrder: readonly string[],
  mods: ClickMods,
): SelectionState {
  if (mods.ctrl) {
    const has = state.selected.includes(clicked)
    return {
      selected: has ? state.selected.filter(p => p !== clicked) : [...state.selected, clicked],
      anchor: clicked,
    }
  }

  if (mods.shift && state.anchor !== null) {
    const from = visibleOrder.indexOf(state.anchor)
    const to = visibleOrder.indexOf(clicked)
    if (from !== -1 && to !== -1) {
      const lo = from <= to ? from : to
      const hi = from <= to ? to : from
      return { selected: visibleOrder.slice(lo, hi + 1), anchor: state.anchor }
    }
  }

  return { selected: [clicked], anchor: clicked }
}

/**
 * 选中集与某个分组的成员集完全相等时，面板应编辑该分组而非新建。
 * 判定用集合相等，与顺序无关（成员在文件里按字典序存储，界面里按点击顺序产生）。
 */
export function matchingGroups(selected: readonly string[], groups: readonly Group[]): Group[] {
  if (selected.length === 0) return []
  const want = new Set(selected)
  return groups.filter(g => g.members.length === want.size && g.members.every(m => want.has(m)))
}
