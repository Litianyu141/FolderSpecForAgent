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
  // 末尾换行不是一行内容：几乎所有文件都以 \n 结尾，不剥掉就会多出一行编号比真实末行大 1 的
  // 空行，而「行号绝对可靠」正是当初选逐行高亮而非整段高亮的全部理由。只剥一个末尾换行——
  // 文件真的以两个换行结尾时，最后那个空行是真实内容，应当渲染出来。
  // CRLF 一并在这里收口（同 parse/sections.ts 的先例）：只按 \n 拆会在每行残留 \r，
  // 污染复制粘贴的结果，也会把 \r 喂进 Prism 的逐行分词。
  const body = text.replace(/\r?\n$/, '')
  const lines = body.split(/\r\n|\n/)
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
