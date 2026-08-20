import { useEffect } from 'react'
import { useT } from './i18n.js'

/**
 * 右键菜单这一次要作用在谁身上。**在右键按下的那一刻定死，此后不再重算**——
 * 菜单和随后的新建输入框都读这一份，不去看"现在选中的是谁"。
 *
 * 理由是这个项目栽过四轮的那类缺陷：右键之后用户完全可能再点别的节点（新建输入框
 * 是非模态的，树照常能点），此时若目标跟着选中集跑，用户在输入框里敲的名字就会落到
 * 一个他从没打算过的父目录下——而契约里多出来的那条声明是给 Agent 看的，Agent 会
 * 照着它真的去建目录。冻结之后，输入框标题写着的那个目标就是最终写出去的那个。
 */
export interface ContextMenuTarget {
  /** 右键点在哪个节点上；null = 点在树的空白区域，或来自顶栏「新建」按钮 */
  path: string | null
  /**
   * 新建出来的节点挂到哪个父目录下，'' 表示工作区根。
   *
   * 右键点在**文件**节点上时它是该文件的父目录，不是文件自己：文件不可能有子节点，
   * 建在它下面必然是错的（core 的 assertCreatableParent 也会当场拒绝）。选父目录
   * 而不是把两条「新建」置灰，是因为置灰给不出任何出路——用户想在这个文件旁边加一条
   * 声明是完全正当的诉求，逼他先去点中父目录只是绕路。"我明明点的是这个文件"这层
   * 困惑由新建输入框的标题消解：它写着「在「src」下新建目录（仅契约）」，目标在按下
   * 「创建」之前就摆在眼前，不靠用户猜。
   */
  parentPath: string
  /**
   * 该节点在契约里有没有被声明过——决定「取消声明」能不能点。
   *
   * 判据是 `ViewNode.origin !== 'actual-only'`：merge() 里只有 fromActual 在找不到
   * 对应 SpecNode 时才给出 'actual-only'（merge.ts 的 `origin: s ? 'both' : 'actual-only'`），
   * 另外三种 origin（both / spec-only / unscanned）全都是"这条路径上确实有一个
   * SpecNode"的产物。所以这个判据不是近似，是等价。
   *
   * path === null（空白区域/顶栏按钮）时这一项无意义，菜单也不会渲染「取消声明」。
   */
  declared: boolean
  /**
   * 被右键点中的那个节点自己是不是目录（path === null 时是工作区根，恒为 true）。
   * 与 parentPath 是两件事：右键点在文件上时 parentPath 是它的父目录，而这一位说的
   * 是被点中的那一个。「重命名」把它原样搬进草稿——菜单一关，树上的选中/展开怎么变
   * 都不该再影响这次操作的目标（冻结的理由见本接口顶部）。
   */
  isDir: boolean
  /** 视口坐标（clientX/clientY）；菜单用 position: fixed 直接落在这里 */
  x: number
  y: number
}

export interface ContextMenuProps {
  target: ContextMenuTarget
  /** 只读态（契约解析失败 / 「原始结构」视图）：四条菜单项全部禁用 */
  disabled: boolean
  onNew(isDir: boolean): void
  onRename(path: string): void
  onRemove(path: string): void
  onClose(): void
}

export function ContextMenu({ target, disabled, onNew, onRename, onRemove, onClose }: ContextMenuProps) {
  const t = useT()

  // Esc 关菜单。挂在 window 上而不是菜单自己的 onKeyDown：菜单打开时焦点大概率还留在
  // 刚被右键点中的那一行上（右键刻意不改选中集，也就没去抢焦点），事件根本不会经过
  // 菜单的 DOM 子树。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const parentLabel = target.parentPath === '' ? t('common.workspaceRoot') : target.parentPath
  const newTitle = disabled ? t('contextMenu.disabledReadOnly') : t('contextMenu.newTarget', { parent: parentLabel })

  return (
    <>
      {/* 铺满视口的透明层：点它、或者在它上面再按一次右键，都只是关掉菜单。
          这正是所有右键菜单的既定行为——"关菜单"的那一下不应该同时穿透过去点到底下的
          东西。它也是菜单唯一的关闭入口之一（另一个是 Esc），所以别按"看不见就删掉"处理。 */}
      <div
        className="fs-menu-backdrop"
        data-testid="fs-menu-backdrop"
        onClick={onClose}
        onContextMenu={e => { e.preventDefault(); onClose() }}
      />
      <div
        className="fs-context-menu"
        role="menu"
        aria-label={t('contextMenu.ariaLabel')}
        style={{ left: target.x, top: target.y }}
      >
        {/* 目标写在菜单顶部：右键**不改选中集**（改了会把多选态收成一项，还会撞上分组
            草稿的成员锁，见 App.handleSelect），因此没有"哪一行高亮"这条线索可用，
            菜单必须自己说清楚它作用在谁身上。 */}
        <div className="fs-context-menu-header">{target.path ?? t('common.workspaceRoot')}</div>

        <button type="button" role="menuitem" disabled={disabled} title={newTitle} onClick={() => onNew(true)}>
          {t('contextMenu.newDir')}
        </button>
        <button type="button" role="menuitem" disabled={disabled} title={newTitle} onClick={() => onNew(false)}>
          {t('contextMenu.newFile')}
        </button>

        {target.path !== null && (
          <>
            <div className="fs-context-menu-sep" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              // 刻意**不看** target.declared：改名对任何节点都成立，不限于已声明过的。
              // 给一个 actual-only 节点改名等于"我声明这东西应该叫 X"，本身就是有效
              // 数据（与 spec/move 对未声明节点的既有行为、core 的 renameNode 是同一
              // 条取向）。「取消声明」那条才需要 declared——那里确实没有可取消的东西。
              disabled={disabled}
              title={
                disabled
                  ? t('contextMenu.disabledReadOnly')
                  : t('contextMenu.renameTarget', { path: target.path })
              }
              onClick={() => onRename(target.path as string)}
            >
              {t('contextMenu.rename')}
            </button>
            <button
              type="button"
              role="menuitem"
              // 未声明过的节点上禁用：core 对"契约里没有这条路径"是真空操作（提交 b82e911，
              // 不置脏、不进撤销栈），点了确实无害——但摆一个点下去什么都不会发生的菜单项，
              // 界面就是在说谎。禁用之后 title 还得写出原因，否则只是从"点了没反应"
              // 换成"灰着没理由"。
              disabled={disabled || !target.declared}
              title={
                disabled
                  ? t('contextMenu.disabledReadOnly')
                  : target.declared ? undefined : t('contextMenu.removeDisabledNotDeclared')
              }
              onClick={() => onRemove(target.path as string)}
            >
              {t('contextMenu.removeNode')}
            </button>
          </>
        )}
      </div>
    </>
  )
}
