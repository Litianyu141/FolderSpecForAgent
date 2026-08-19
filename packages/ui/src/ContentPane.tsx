import type { FileReadResult, ViewNode } from '@folderspec/core/api'
import { highlightToHtml, languageFor } from './highlight.js'

export interface ContentPaneProps {
  node: ViewNode | null
  content: FileReadResult | null
  loading: boolean
}

export function ContentPane({ node, content, loading }: ContentPaneProps) {
  if (!node) return <div className="fs-content-empty">在左侧选中一个文件查看内容</div>

  if (node.isDir) {
    return (
      <div className="fs-content">
        <div className="fs-content-path">{node.path}</div>
        <p className="fs-content-note">
          {node.children === undefined
            ? '这是一个目录，尚未展开——点击左侧的箭头展开后可看到子项。'
            : `这是一个目录，共 ${node.children.length} 项。`}
        </p>
      </div>
    )
  }

  if (loading) return <div className="fs-content-empty">读取中…</div>
  if (!content) return <div className="fs-content-empty">在左侧选中一个文件查看内容</div>

  return (
    <div className="fs-content">
      <div className="fs-content-path">{node.path}</div>
      {content.kind === 'binary' && <p className="fs-content-note">二进制文件，不预览内容。</p>}
      {content.kind === 'too-large' && (
        <p className="fs-content-note">
          文件 {(content.size / 1024 / 1024).toFixed(2)} MB，超过预览上限，不读取内容。
        </p>
      )}
      {content.kind === 'unreadable' && (
        <p className="fs-content-note">无法读取：{content.reason}</p>
      )}
      {content.kind === 'text' && <CodeView text={content.text} fileName={node.name} />}
    </div>
  )
}

function CodeView({ text, fileName }: { text: string; fileName: string }) {
  const lang = languageFor(fileName)
  const lines = text.split('\n')
  return (
    <pre className="fs-code">
      {lines.map((line, i) => (
        <div className="fs-code-line" key={i}>
          <span className="fs-line-no">{i + 1}</span>
          <code
            className="fs-code-text"
            dangerouslySetInnerHTML={{ __html: highlightToHtml(line, lang) }}
          />
        </div>
      ))}
    </pre>
  )
}
