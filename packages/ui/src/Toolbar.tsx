import { useEffect, useState } from 'react'
import type { ViewMode } from '@folderspec/core/api'
import { useT } from './i18n.js'
import type { Lang } from './i18n.js'

export interface ToolbarProps {
  root: string
  searchTerm: string
  dirty: boolean
  /** 当前是否不可编辑（只读态：契约解析失败，或「原始结构」视图）。同时管保存/撤销/重做三个按钮。 */
  disabled: boolean
  viewMode: ViewMode
  canUndo: boolean
  canRedo: boolean
  lang: Lang
  onOpenRoot(path: string): void
  onSearch(term: string): void
  onSave(): void
  onSetViewMode(mode: ViewMode): void
  onUndo(): void
  onRedo(): void
  onSetLang(lang: Lang): void
  /** 顶栏「新建」：在工作区根下新建声明，等价于在树的空白区域右键。坐标供菜单定位 */
  onNewNode(x: number, y: number): void
}

export function Toolbar({
  root, searchTerm, dirty, disabled, viewMode, canUndo, canRedo, lang,
  onOpenRoot, onSearch, onSave, onSetViewMode, onUndo, onRedo, onSetLang, onNewNode,
}: ToolbarProps) {
  const [draft, setDraft] = useState(root)
  useEffect(() => { setDraft(root) }, [root])
  const t = useT()

  return (
    <div className="fs-toolbar">
      <input
        aria-label={t('toolbar.workspacePath')}
        type="text"
        value={draft}
        placeholder={t('toolbar.workspacePath')}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onOpenRoot(draft) }}
      />
      <button type="button" onClick={() => onOpenRoot(draft)}>{t('toolbar.load')}</button>

      {/* 分段控件而非下拉：判据是"来回对比时一眼能看出当前在哪个视图"，下拉框收起来
          之后当前值不在视野里，来回切换还得先点开才知道切没切成功。
          两个按钮全程可点（包括点当前已激活的那个——上层会把它当空操作短路掉），
          不用 disabled 属性表达"当前态"：那是禁用语义，会被误读成"这个视图进不去"。 */}
      <div className="fs-viewmode" role="group" aria-label={t('toolbar.structureView')}>
        <button
          type="button" aria-pressed={viewMode === 'spec'}
          className={viewMode === 'spec' ? 'fs-viewmode-active' : undefined}
          onClick={() => onSetViewMode('spec')}
        >
          {t('toolbar.myStructure')}
        </button>
        <button
          type="button" aria-pressed={viewMode === 'disk'}
          className={viewMode === 'disk' ? 'fs-viewmode-active' : undefined}
          onClick={() => onSetViewMode('disk')}
        >
          {t('toolbar.diskStructure')}
        </button>
      </div>

      <input
        aria-label={t('toolbar.search')}
        type="search"
        value={searchTerm}
        placeholder={t('toolbar.searchPlaceholder')}
        onChange={e => onSearch(e.target.value)}
      />

      {/* 「新建」与撤销/重做/保存同属写操作，所以挨着它们放，共用同一个 disabled 闸门。
          点它弹出的是与树上右键完全同一个菜单（目标写死为工作区根），不是另一套控件：
          "顶部按钮 = 在根下建"是用户拍板的语义，用同一个菜单才能保证"新建目录/新建文件"
          两条路径在两个入口下逐字一致。 */}
      <button
        type="button"
        disabled={disabled}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          onNewNode(r.left, r.bottom)
        }}
      >
        {t('toolbar.newNode')}
      </button>

      {/* 禁用条件必须是 canUndo && 可编辑，不能只判 canUndo：core 的 canUndo 只表示
          "栈非空"，故意不重复实现只读判断（见 EditResult.canUndo 上的注释）。
          "可编辑"就是这里的 disabled 取反——与保存按钮同一个闸门，disk 视图或契约
          解析失败时一并禁用，否则点下去会撞上 core 的 assertWritable() 报错。 */}
      <button type="button" disabled={disabled || !canUndo} onClick={onUndo}>{t('toolbar.undo')}</button>
      <button type="button" disabled={disabled || !canRedo} onClick={onRedo}>{t('toolbar.redo')}</button>

      <button type="button" disabled={disabled || !dirty} onClick={onSave}>
        {t('toolbar.save')}{dirty ? <span aria-hidden="true"> •</span> : null}
      </button>

      {/* 语言开关：右上角（用户原话点名的位置）——toolbar 是一整行 flex 布局，两个
          input 用 flex:1 1 auto 吃掉多余宽度（见 styles.css），这个控件放在最后一个
          子节点天然贴到行的最右端。
          这个开关同时管两件事，两条线都在 App.handleSetLang 里（那里有完整推导）：
          1) 界面文案的语言——纯前端状态，**无条件**跟着点击走；
          2) 契约 front-matter 里的 `lang` 字段——经 `spec/setLang` 落到 core，
             只在可写时调用（那个方法走 assertWritable()）。
          所以这两个按钮**不进 disabled 闸门**：只读态下界面语言照样能切。看不懂界面
          与契约此刻能不能写是两回事，把它们绑在一起等于让一个读不懂中文的人在解析
          失败时永远出不去。
          "中文"/"English" 两个按钮的文案本身刻意不经过 t()：这是语言自己的名字
          （人类语言的自称，类似系统语言选择器里"中文"永远显示"中文"，不会因为系统
          当前是英文就变成"Chinese"），不属于会随当前界面语言改变的那类 chrome 文案——
          用户不管当前卡在哪种他看不懂的语言里，都得能一眼认出自己认识的那个词，
          这跟"原始结构/我的结构"这类真正的界面文案不是一回事。 */}
      <div className="fs-lang-toggle" role="group" aria-label={t('toolbar.language')}>
        <button
          type="button" aria-pressed={lang === 'zh'}
          className={lang === 'zh' ? 'fs-lang-toggle-active' : undefined}
          onClick={() => onSetLang('zh')}
        >
          中文
        </button>
        <button
          type="button" aria-pressed={lang === 'en'}
          className={lang === 'en' ? 'fs-lang-toggle-active' : undefined}
          onClick={() => onSetLang('en')}
        >
          English
        </button>
      </div>
    </div>
  )
}
