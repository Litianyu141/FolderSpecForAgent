import type { GitState, Severity, ViewNode } from '@folderspec/core/api'

export const GIT_COLOR_VAR: Record<GitState, string> = {
  ignored: '--fs-git-ignored',
  untracked: '--fs-git-untracked',
  modified: '--fs-git-modified',
  added: '--fs-git-added',
  deleted: '--fs-git-deleted',
  conflicted: '--fs-git-conflicted',
}

export const SEVERITY_BADGE: Record<Severity, string> = {
  error: '🔴',
  warning: '🟠',
  advisory: '🔵',
}

export function nodeColorVar(node: ViewNode): string | undefined {
  if (!node.gitState) return undefined
  return `var(${GIT_COLOR_VAR[node.gitState]})`
}

export function isAnnotated(node: ViewNode): boolean {
  return Boolean(node.annotation || node.role || node.severity || node.template)
}
