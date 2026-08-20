import { useEffect } from 'react'
import { useT } from './i18n.js'
import { absolutePathOf } from './clipboard.js'

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
  /**
   * 只读态（契约解析失败 /「原始结构」视图）：**四条写操作**菜单项全部禁用。
   *
   * 管辖范围到此为止——「复制路径」「复制相对路径」两项**不看这个值**。它俩是纯读，
   * 一个字节都不碰 Spec，跟"现在允不允许写"没有任何关系；而只读态恰恰是最需要它们的
   * 时候：契约解析失败时用户要把那个文件的路径复制到终端里去修，「原始结构」视图的
   * 意义是"让你对比"，对比的下一步往往就是把路径贴到别处。跟着一起灰掉，等于因为
   * 写不了就连看都不让看。
   */
  disabled: boolean
  /**
   * 工作区根的绝对路径（平台原生写法）与本平台的路径分隔符，来自 `OpenResult.root`
   * / `OpenResult.sep`。只用于把 `target.path`（工作区相对、恒 `/` 分隔）拼成
   * 「复制路径」那条绝对路径——分隔符为什么必须由 core 给、不能从 root 反推，
   * 见 api.ts 的 OpenResult.sep。
   */
  root: string
  sep: string
  onNew(isDir: boolean): void
  onRename(path: string): void
  onRemove(path: string): void
  /** 把这段文字送进剪贴板。菜单只负责算出"复制什么"，怎么复制、失败了怎么报是 App 的事 */
  onCopy(text: string): void
  onClose(): void
}

export function ContextMenu(
  { target, disabled, root, sep, onNew, onRename, onRemove, onCopy, onClose }: ContextMenuProps,
) {
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

  // 绝对路径**只算这一次**，title 与 onCopy 用的是同一个变量。两处各算一遍的话，
  // 用户悬停看到的和真正进剪贴板的可以是两条不同的路径，而这种分歧没有任何别的信号——
  // 唯一的发现方式是他粘出去之后发现指错了地方（与 App.tsx 里 PendingGroup
  // "显示与写入共用同一个真源"是同一条判据）。
  // path === null（空白区域/顶栏按钮，目标是工作区根）时这两项根本不渲染，见下方
  // 那个 `target.path !== null &&`；这里的 null 分支只是为了不把 null 传进去，
  // 不代表"复制工作区根"是一条可达的路径。
  const absPath = target.path === null ? root : absolutePathOf(root, sep, target.path)

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

            {/* 复制两项排在最底部、与上面四条写操作之间再隔一条分隔线——对齐 VSCode
                资源管理器的排布，也是因为它们是**另一类东西**：上面四条会改写契约，
                这两条什么都不改。 */}
            <div className="fs-context-menu-sep" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              // 刻意**不传** disabled：纯读操作不归只读闸门管，理由见 ContextMenuProps.disabled。
              // title 就是将被复制的那条路径本身——它同时是"复制前先看一眼对不对"的
              // 唯一机会（复制成功是静默的，事后没有任何地方能核对）。
              title={absPath}
              onClick={() => onCopy(absPath)}
            >
              {t('contextMenu.copyPath')}
            </button>
            <button
              type="button"
              role="menuitem"
              // 相对路径就是 target.path 原样：它是**契约自己的**标识符，.folderspec.md
              // 里逐字就是这个串，Agent 也拿它匹配节点。所以即便在 Windows 上也不换成
              // '\'（VSCode 的 Copy Relative Path 会换）——换了就得到一条在我们自己的
              // 产物里根本不存在的字符串，粘回契约里对不上。绝对路径那条相反：它的
              // 消费者是操作系统，必须用原生分隔符。
              title={target.path}
              onClick={() => onCopy(target.path as string)}
            >
              {t('contextMenu.copyRelPath')}
            </button>
          </>
        )}
      </div>
    </>
  )
}
