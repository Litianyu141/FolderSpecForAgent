import type { Group, ViewNode } from '@folderspec/core/api'

export interface ClickMods { shift: boolean; ctrl: boolean }
export interface SelectionState { selected: string[]; anchor: string | null }

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
