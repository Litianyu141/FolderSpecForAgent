import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'

/**
 * 把跨边界传入的相对路径归一化为工作区相对的 posix 路径，并拒绝任何逃出工作区的写法。
 *
 * 这道校验是 file/read 引入后才变成必需的：在此之前 scan 的 subPath 虽然也接受 ".."，
 * 但结果会被 findActual 丢弃、不产生可观测的越界读取。file/read 会把内容直接回传前端，
 * 于是同一个缺口变成了真实可达的路径。两个入口共用这一处实现，不在两边各写一遍。
 *
 * 这是纯词法校验，看不见符号链接——`resolveWithinWorkspace` 在此之上补一道基于
 * realpath 的包容性校验，两者不是同一件事，见下方。
 */
export function normalizeWorkspacePath(input: string): string {
  const posix = input.split('\\').join('/')
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) {
    throw new Error(`路径必须是工作区相对路径，实际是 ${JSON.stringify(input)}`)
  }
  const segs = posix.split('/').filter(s => s !== '' && s !== '.')
  if (segs.includes('..')) {
    throw new Error(`路径不得包含 ".." 段，实际是 ${JSON.stringify(input)}`)
  }
  return segs.join('/')
}

/**
 * 在 normalizeWorkspacePath 的纯词法校验之上，再做一次基于 realpath 的包容性校验，
 * 挡住"路径本身不含 .. 段，却经由符号链接指向工作区外"的绕过。
 *
 * 纯词法校验看不见符号链接：工作区里 `ln -s /etc/passwd innocent.txt` 之后，读
 * `innocent.txt` 不含任何 ".." 字样，却读到了 /etc/passwd；`ln -s / rootlink` 更狠——
 * 符号链接在路径**中段**，逃逸对字符串匹配完全不可见，`rootlink/etc/passwd` 一眼看上去
 * 是条规规矩矩的工作区内相对路径。file/read 把内容直接回传前端，这个缺口因此从"理论
 * 风险"变成"打开一个不受信任的仓库就中招"。scan 走 subPath 时同样可能穿过符号链接去
 * 列目录——泄漏的是文件名而非内容，更轻，但同一类缺口，所以两个入口共用这一处实现，
 * 理由与共用 normalizeWorkspacePath 完全相同：不留"一处严一处松"的裂缝。
 *
 * root 自己也要 realpath 再比较——否则 root 本身是符号链接时（例如 macOS 上
 * /tmp 实际是 /private/tmp 的符号链接）会把工作区自己误判成越界。
 *
 * 目标路径不存在时 realpath 抛 ENOENT：这不是越界，是"没有"，交还给调用方
 * （file-read 的 stat、scan 的 readdir）用它们各自已有的"不存在/不可读"分支处理——
 * 这里只负责越界判断，不在"找不到"这件事上抢答。
 *
 * TOCTOU：realpath 到调用方真正读取/罗列之间，目标理论上可能被替换掉。本工具是
 * 单用户本地场景（同一个人在同一台机器上读自己正在编辑的仓库），这个窗口期不构成
 * 新的攻击面——这是权衡后接受的，不是没想到。
 */
export async function resolveWithinWorkspace(root: string, subPath: string): Promise<string> {
  const rel = normalizeWorkspacePath(subPath)
  const abs = nodePath.join(root, rel)

  const realRoot = await fs.realpath(root)

  let real: string
  try {
    real = await fs.realpath(abs)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return abs
    throw e
  }

  if (real !== realRoot && !real.startsWith(realRoot + nodePath.sep)) {
    throw new Error(`路径 ${JSON.stringify(subPath)} 解析后逃出工作区，可能经过符号链接`)
  }
  return real
}
