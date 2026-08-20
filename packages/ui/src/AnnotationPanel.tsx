import { useEffect, useState } from 'react'
import type { Group, Severity, ViewNode } from '@folderspec/core/api'
import { SEVERITY_BADGE } from './colors.js'
import { useT } from './i18n.js'

export interface PanelPatch {
  annotation?: string | null
  role?: string | null
  severity?: Severity | null
}

export interface AnnotationPanelProps {
  node: ViewNode | null
  disabled: boolean
  onChange(patch: PanelPatch): void
  /** 该节点所属的全部分组，供底部只读入口展示；不属于任何分组时传空数组 */
  groupsOfNode: Group[]
  /** 点击某个所属分组：把选中集切到该分组的成员，由上层据此进入该分组的编辑形态 */
  onPickGroup(id: string): void
}

export function AnnotationPanel({ node, disabled, onChange, groupsOfNode, onPickGroup }: AnnotationPanelProps) {
  const [annotation, setAnnotation] = useState('')
  const [role, setRole] = useState('')
  const t = useT()

  // 只在选中的节点变化时重置本地编辑态。
  // 不要把 annotation/role 放进依赖：本面板是这两个字段唯一的编辑者，
  // 它们的变化只可能是本面板自己那次提交的回声 —— 此时本地状态已经等于或
  // 领先于回来的值，重置只会把用户失焦后又继续输入的内容冲掉。
  useEffect(() => {
    setAnnotation(node?.annotation ?? '')
    setRole(node?.role ?? '')
  }, [node?.path])

  if (!node) {
    return <div className="fs-panel-empty">{t('annotationPanel.empty')}</div>
  }

  const commit = (key: 'annotation' | 'role', local: string, original: string | undefined) => {
    const trimmed = local.trim()
    if (trimmed === (original ?? '')) return
    onChange({ [key]: trimmed === '' ? null : trimmed })
  }

  return (
    <div className="fs-panel">
      <h2 className="fs-panel-path">{node.path === '' ? t('annotationPanel.workspaceRoot') : node.path}</h2>
      <p className="fs-panel-origin">
        {node.origin === 'spec-only'
          ? t('annotationPanel.originSpecOnly')
          : node.origin === 'unscanned'
            ? t('annotationPanel.originUnscanned')
            : node.isDir ? t('annotationPanel.kindDir') : t('annotationPanel.kindFile')}
      </p>

      <label className="fs-field">
        <span>{t('annotationPanel.annotationLabel')}</span>
        <textarea
          aria-label={t('annotationPanel.annotationLabel')}
          rows={6}
          value={annotation}
          disabled={disabled}
          onChange={e => setAnnotation(e.target.value)}
          onBlur={() => commit('annotation', annotation, node.annotation)}
        />
      </label>

      <label className="fs-field">
        <span>{t('annotationPanel.roleLabel')}</span>
        <input
          aria-label={t('annotationPanel.roleLabel')}
          type="text"
          placeholder={t('annotationPanel.rolePlaceholder')}
          value={role}
          disabled={disabled}
          onChange={e => setRole(e.target.value)}
          onBlur={() => commit('role', role, node.role)}
        />
      </label>

      <label className="fs-field">
        <span>{t('common.severity')}</span>
        <select
          aria-label={t('common.severity')}
          value={node.severity ?? ''}
          disabled={disabled}
          onChange={e => onChange({ severity: e.target.value === '' ? null : (e.target.value as Severity) })}
        >
          <option value="">{t('common.severityNone')}</option>
          <option value="advisory">{SEVERITY_BADGE.advisory} {t('annotationPanel.severityAdvisory')}</option>
          <option value="warning">{SEVERITY_BADGE.warning} {t('annotationPanel.severityWarning')}</option>
          <option value="error">{SEVERITY_BADGE.error} {t('annotationPanel.severityError')}</option>
        </select>
      </label>

      {groupsOfNode.length > 0 && (
        <div className="fs-owning-groups">
          <span className="fs-field-label">{t('annotationPanel.owningGroups')}</span>
          <ul>
            {groupsOfNode.map(g => (
              <li key={g.id}>
                <button type="button" className="fs-group-link" onClick={() => onPickGroup(g.id)}>{g.id}</button>
                <span className="fs-group-text">{g.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
