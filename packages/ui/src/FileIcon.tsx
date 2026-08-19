export type IconKind =
  | 'folder' | 'folder-open'
  | 'ts' | 'js' | 'json' | 'md' | 'yaml' | 'css' | 'html'
  | 'py' | 'rs' | 'go' | 'sh' | 'toml' | 'lock' | 'image' | 'git' | 'file'

const BY_NAME: Record<string, IconKind> = {
  '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git',
  'pnpm-lock.yaml': 'lock', 'package-lock.json': 'lock', 'cargo.lock': 'lock',
}

const BY_EXT: Record<string, IconKind> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  json: 'json', jsonc: 'json',
  md: 'md', markdown: 'md',
  yaml: 'yaml', yml: 'yaml',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html',
  py: 'py', rs: 'rs', go: 'go',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  toml: 'toml',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image', ico: 'image',
}

export function iconKindFor(name: string, isDir: boolean, isOpen: boolean): IconKind {
  if (isDir) return isOpen ? 'folder-open' : 'folder'
  const lower = name.toLowerCase()
  const byName = BY_NAME[lower]
  if (byName) return byName
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return 'file'
  return BY_EXT[lower.slice(dot + 1)] ?? 'file'
}

/** 每个 kind 一段 path 数据，全部在 16x16 视口内。颜色由 CSS 的 currentColor 决定，
 *  因此跟着 --fs-* 主题走，深色浅色都不用额外处理。 */
const PATHS: Record<IconKind, string> = {
  'folder': 'M1.5 3h4l1.5 2h7.5v8.5h-13z',
  'folder-open': 'M1.5 3h4l1.5 2h7.5v1.5h-11l-2 7h-1z M3.5 7.5h12l-2 6h-12z',
  'ts': 'M2 2h12v12H2z',
  'js': 'M2 2h12v12H2z',
  'json': 'M5 2c-2 0-2 2-2 3s0 3-1 3 1 0 1 3 0 3 2 3 M11 2c2 0 2 2 2 3s0 3 1 3-1 0-1 3 0 3-2 3',
  'md': 'M1.5 4h13v8h-13z M3.5 10.5V6l2 2 2-2v4.5 M10 6v3l-1.5-1.5 M10 6l1.5 1.5',
  'yaml': 'M4 3l2.5 4v6 M9 3l-2.5 4 M9.5 8h4 M9.5 11h4',
  'css': 'M3 2h10l-1 11-4 1-4-1z',
  'html': 'M3 2h10l-1 11-4 1-4-1z',
  'py': 'M8 1.5c-3 0-3 1.5-3 3h6v1h-6c-2 0-3 1-3 3s1 3 3 3v-2c0-1.5 1.5-1.5 1.5-1.5h4.5c2 0 3-1 3-3v-.5c0-2-1-3-3-3z',
  'rs': 'M8 1.5l6 3.5v6l-6 3.5-6-3.5v-6z',
  'go': 'M3 6h4 M2 8h5 M3 10h4 M10.5 4a4 4 0 100 8 4 4 0 000-8z',
  'sh': 'M1.5 2.5h13v11h-13z M4 6l2.5 2L4 10 M8 10.5h4',
  'toml': 'M2.5 3h11 M8 3v10 M4 13h8',
  'lock': 'M4.5 7V5a3.5 3.5 0 017 0v2 M3 7h10v7H3z',
  'image': 'M1.5 3h13v10h-13z M4 10l3-3 2 2 2.5-2.5L14 9.5 M5 6a1 1 0 100 .01z',
  'git': 'M8 1.5l6.5 6.5L8 14.5 1.5 8z M6 8h4 M8 6v4',
  'file': 'M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3',
}

export function FileIcon({ kind }: { kind: IconKind }) {
  return (
    <svg className="fs-icon-svg" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
      <path d={PATHS[kind]} />
    </svg>
  )
}
