import { useState } from 'react'
import { useT } from './i18n.js'

/**
 * 一次「新建声明」的草稿。父目录与类型在菜单项被点中的那一刻定死（见
 * ContextMenuTarget 上的注释），此后无论用户在树上怎么改选中、按了几次撤销，
 * 提交出去的都还是这一份。
 */
export interface NewNodeDraft {
  /**
   * 单调递增，只用来当 React 的 key。名字是这个组件自己的本地 state——换一个目标
   * 就必须换一个组件实例，否则上一次没提交完的半个名字会留在框里，跟着新目标一起
   * 写出去。用 `parentPath + isDir` 拼 key 不行：同一个目标连开两次是常见操作
   * （建完一个 cases 紧接着再建一个 fixtures），那两次的 key 会相同。
   */
  id: number
  parentPath: string
  isDir: boolean
  /** 视口坐标；对话框接着菜单原来的位置显示，视线不用跳 */
  x: number
  y: number
}

export interface NewNodeDialogProps {
  draft: NewNodeDraft
  /** 只读态：这是本轮五个写入口里的最后一个，闸门不能漏（见 App.tsx 的 readOnly） */
  disabled: boolean
  /** 请求在途：按钮禁用，避免同一个名字发两遍（core 会以"同层同名兄弟"报错，对用户是噪声） */
  submitting: boolean
  onSubmit(name: string): void
  onCancel(): void
}

export function NewNodeDialog({ draft, disabled, submitting, onSubmit, onCancel }: NewNodeDialogProps) {
  const [name, setName] = useState('')
  const t = useT()

  const parentLabel = draft.parentPath === '' ? t('common.workspaceRoot') : draft.parentPath
  // 空名字/全空白不提交。core 的 assertValidNodeName 确实会抛"名字不能为空"，但那是一次
  // 注定失败的宿主往返，用户该看到的是"创建按钮还不能点"，不是一条本可以不出现的报错。
  // 其余非法名（反引号、"." / ".."、含 "/"）**不在这里预判**：那几条是 core 在输入边界
  // 的裁定（"悄悄改掉一个标识符比报错更糟"），UI 复述一遍就等于把同一条规则实现两遍，
  // 两处一旦分叉界面就在说谎。让它发出去、把 core 的原话显示给用户。
  const submittable = name.trim() !== '' && !disabled && !submitting

  const submit = () => { if (submittable) onSubmit(name) }

  return (
    <div
      className="fs-new-node"
      role="dialog"
      aria-label={draft.isDir ? t('newNode.titleDir', { parent: parentLabel }) : t('newNode.titleFile', { parent: parentLabel })}
      style={{ left: draft.x, top: draft.y }}
      // Esc 取消、Enter 提交都挂在容器上：输入框自动获得焦点，事件从它冒上来；
      // 焦点若已经挪到「创建」/「取消」按钮上，Esc 一样还能用。
      onKeyDown={e => {
        if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
        if (e.key === 'Enter') { e.preventDefault(); submit() }
      }}
    >
      {/* 目标必须写在这里，而不是只写在菜单上：右键点在**文件**节点上时新建落到它的
          父目录，两者不是同一个东西。这一行是用户按下「创建」之前最后一次、也是唯一
          一次看到真实写入目标的机会。 */}
      <div className="fs-new-node-title">
        {draft.isDir ? t('newNode.titleDir', { parent: parentLabel }) : t('newNode.titleFile', { parent: parentLabel })}
      </div>
      {/* 「仅契约」这三个字在菜单项里已经出现过一次，这里再用一整句展开说明。
          它防的是本工具最容易被误解的一件事：用户以为点完磁盘上会冒出一个目录。
          真正去建它的是随后读契约的 Agent（CLAUDE.md 铁律 1）。 */}
      <div className="fs-new-node-hint">{t('newNode.hint')}</div>

      <input
        aria-label={t('newNode.nameLabel')}
        type="text"
        autoFocus
        value={name}
        placeholder={t('newNode.namePlaceholder')}
        disabled={disabled || submitting}
        onChange={e => setName(e.target.value)}
      />

      <div className="fs-new-node-actions">
        <button type="button" onClick={onCancel}>{t('newNode.cancel')}</button>
        <button type="button" disabled={!submittable} onClick={submit}>{t('newNode.create')}</button>
      </div>
    </div>
  )
}
