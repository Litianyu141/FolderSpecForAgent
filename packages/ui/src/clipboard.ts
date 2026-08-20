/**
 * 把工作区相对路径（`ViewNode.path`，**恒用 `/`**）拼成一条平台原生的绝对路径。
 *
 * `sep` 由 core 在 `OpenResult.sep` 里如实给出，不在这里从 root 的字面量反推——
 * 反推是个启发式，POSIX 上一个名字里带反斜杠的目录就能让它判错，而判错的结果是
 * 一条看着像模像样、实际不存在的路径被静默塞进剪贴板（完整推导见 api.ts 的
 * OpenResult.sep 字段注释）。
 *
 * 尾部分隔符只在"剃掉之后还剩点东西"时才剃：root 是 `/` 或 `C:\` 时那个分隔符是
 * 路径的一部分，剃掉会把绝对路径降级成相对路径（`/` → `src/a.ts`），或者在 Windows 上
 * 指向另一个位置（`C:\` → `C:src` 是"C 盘当前目录下的 src"）。两种都是能读、
 * 却指向别处的路径。
 */
export function absolutePathOf(root: string, sep: string, relPath: string): string {
  // 先无条件剃掉尾部分隔符，拼接时再补一个——两头各判一次"要不要加斜杠"必然在某个
  // 组合上分叉。root 是 `/` 或 `C:\` 时剃完 base 是 '' 或 'C:'，补回来的那个分隔符
  // 正好把它还原成绝对路径，不需要特例。
  const base = root.endsWith(sep) ? root.slice(0, -sep.length) : root
  // 只有"工作区根自己"会走到这里。base === '' 说明 root 就是文件系统根，此时
  // 答案是那个分隔符本身，不是空串。
  if (relPath === '') return base === '' ? sep : base
  const native = sep === '/' ? relPath : relPath.split('/').join(sep)
  return `${base}${sep}${native}`
}

/**
 * 把一段文字写进系统剪贴板。**返回是否成功，不抛异常。**
 *
 * 不抛的理由：调用点在 onClick 里，抛出去就是一个没人接的 promise rejection——
 * 用户看到的是"点了没反应"，而剪贴板里还留着上一次的内容，他随后粘出去的是别的东西。
 * 这正是本功能最坏的失败形态（brief 点名的"静默失败"），所以失败必须以一个调用方
 * **必须处理的返回值**出现，由它弹错误横幅。
 *
 * 两条路，缺一不可：
 *
 * 1. `navigator.clipboard.writeText` —— 需要安全上下文。CLI 宿主是 `http://127.0.0.1`，
 *    落在浏览器的 localhost 例外里，成立（已用真实 Chromium 读回剪贴板核实）。
 * 2. 降级：临时 `<textarea>` + `document.execCommand('copy')`。它不受 Permissions
 *    Policy 管辖，因此在"第 1 条被拒"的那些环境里仍然可用——典型形态就是嵌在
 *    跨源 iframe 里、又没拿到 `allow="clipboard-write"` 的 webview，那里 writeText
 *    会以 NotAllowedError 被拒（已在同构约束下用真实 Chromium 复现）。
 *
 * 第 1 条被拒时**继续试第 2 条**，而不是直接判失败：两者的授权模型不同，前者不通
 * 完全不代表后者不通。
 */
export async function copyText(text: string): Promise<boolean> {
  const clip: Clipboard | undefined =
    typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clip && typeof clip.writeText === 'function') {
    try {
      await clip.writeText(text)
      return true
    } catch {
      // 落到降级路径。这里刻意不记录/不上报那个 DOMException：它的文案是浏览器给的
      // 英文内部信息（"Write permission denied"），对用户既不可读也不可行动，而真正
      // 该让用户看见的是"复制失败了，这是那条路径，请手动复制"——由调用方组织。
    }
  }
  return execCommandCopy(text)
}

/**
 * 老派降级路径。几处看着多余的写法各挡一种失败：
 *
 * - **必须真的挂进 document**：游离节点上 `select()` 是空操作，`execCommand('copy')`
 *   会转而复制页面上原本的选区（多半是空），于是"复制成功"却粘出个空。
 * - **不能用 `display:none` / `visibility:hidden` 藏它**：不可见元素选不中，同上。
 *   所以用 `position:fixed` + `opacity:0` + 1px——它在渲染树里，只是看不见。
 * - **`readonly`**：移动端浏览器聚焦到可编辑的 textarea 会弹出软键盘。
 * - **`top/left: 0`**：元素若落在视口外，聚焦它会把页面滚过去；这是一次"复制"，
 *   不该让界面动。
 * - **finally 里摘节点并还原焦点**：不摘，每复制一次页面上就多一个隐藏 textarea；
 *   不还原焦点，焦点会掉到 `<body>`，键盘用户丢了位置。
 */
function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false

  const active = document.activeElement as HTMLElement | null
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '0'
  ta.style.width = '1px'
  ta.style.height = '1px'
  ta.style.padding = '0'
  ta.style.border = 'none'
  ta.style.opacity = '0'
  document.body.appendChild(ta)

  try {
    ta.focus()
    ta.select()
    // iOS Safari 上 select() 对 readonly 的 textarea 不生效，setSelectionRange 才是
    // 那儿唯一管用的一条
    ta.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    ta.remove()
    if (active && typeof active.focus === 'function') active.focus()
  }
}
