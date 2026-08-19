import { useEffect, useState } from 'react'
import type { Severity, ViewNode } from '@folderspec/core/api'
import { SEVERITY_BADGE } from './colors.js'

export interface PanelPatch {
  annotation?: string | null
  role?: string | null
  severity?: Severity | null
}

export interface AnnotationPanelProps {
  node: ViewNode | null
  disabled: boolean
  onChange(patch: PanelPatch): void
}

export function AnnotationPanel({ node, disabled, onChange }: AnnotationPanelProps) {
  const [annotation, setAnnotation] = useState('')
  const [role, setRole] = useState('')

  // 只在选中的节点变化时重置本地编辑态。
  // 不要把 annotation/role 放进依赖：本面板是这两个字段唯一的编辑者，
  // 它们的变化只可能是本面板自己那次提交的回声 —— 此时本地状态已经等于或
  // 领先于回来的值，重置只会把用户失焦后又继续输入的内容冲掉。
  useEffect(() => {
    setAnnotation(node?.annotation ?? '')
    setRole(node?.role ?? '')
  }, [node?.path])

  if (!node) {
    return <div className="fs-panel-empty">在左侧选中一个文件或目录</div>
  }

  const commit = (key: 'annotation' | 'role', local: string, original: string | undefined) => {
    const trimmed = local.trim()
    if (trimmed === (original ?? '')) return
    onChange({ [key]: trimmed === '' ? null : trimmed })
  }

  return (
    <div className="fs-panel">
      <h2 className="fs-panel-path">{node.path === '' ? '（工作区根）' : node.path}</h2>
      <p className="fs-panel-origin">
        {node.origin === 'spec-only'
          ? 'spec 中声明，磁盘上不存在——可能待创建，也可能已被删除'
          : node.origin === 'unscanned'
            ? '所在目录尚未扫描，展开后自动重新解析'
            : node.isDir ? '目录' : '文件'}
      </p>

      <label className="fs-field">
        <span>注释</span>
        <textarea
          aria-label="注释"
          rows={6}
          value={annotation}
          disabled={disabled}
          onChange={e => setAnnotation(e.target.value)}
          onBlur={() => commit('annotation', annotation, node.annotation)}
        />
      </label>

      <label className="fs-field">
        <span>语义角色</span>
        <input
          aria-label="语义角色"
          type="text"
          placeholder="例如 core-engine"
          value={role}
          disabled={disabled}
          onChange={e => setRole(e.target.value)}
          onBlur={() => commit('role', role, node.role)}
        />
      </label>

      <label className="fs-field">
        <span>约束强度</span>
        <select
          aria-label="约束强度"
          value={node.severity ?? ''}
          disabled={disabled}
          onChange={e => onChange({ severity: e.target.value === '' ? null : (e.target.value as Severity) })}
        >
          <option value="">（仅注释，不强制）</option>
          <option value="advisory">{SEVERITY_BADGE.advisory} advisory — 建议</option>
          <option value="warning">{SEVERITY_BADGE.warning} warning — 应遵守，违反须说明</option>
          <option value="error">{SEVERITY_BADGE.error} error — 必须遵守</option>
        </select>
      </label>
    </div>
  )
}
