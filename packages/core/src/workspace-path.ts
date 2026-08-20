import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { SpecError } from './errors.js'

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
    throw new SpecError('path.notRelative', { path: JSON.stringify(input) })
  }
  const segs = posix.split('/').filter(s => s !== '' && s !== '.')
  if (segs.includes('..')) {
    throw new SpecError('path.parentSegment', { path: JSON.stringify(input) })
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
 * realpath(abs) 解析失败时——不管是 ENOENT（不存在）、ELOOP（符号链接环，比如
 * a -> b -> a 或 self -> self）、EACCES（某一级目录不可搜索）还是别的 errno——
 * 一律返回未解析的 abs，交还给调用方（file-read 的 stat、scan 的 readdir）用
 * 它们各自已有的"不存在/不可读"分支处理，这里只负责越界判断。**解析失败不等于
 * 越界证据**：这里如果因为"解析不出来"就直接抛错，那个抛出会越过调用方包在
 * stat/readdir 外面的 try/catch（它们包的是 stat/readdir 本身，不是这一步），
 * 把一次本该降级为 unreadable 的普通失败，错误地升级成一次未被捕获的异常——
 * 而调用方接下来对同一个 abs 做 stat/readdir，本就会撞上同一个 errno，照样能
 * 走进那些分支得到 unreadable，不需要在这里抢答。
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
  } catch {
    return abs
  }

  // 用 nodePath.relative 而不是手工拼 `realRoot + sep` 做前缀比较：工作区根是
  // 文件系统根 '/' 时，`realRoot + sep` 会变成 '//'，导致任何子路径都比不出前缀、
  // 被误判成越界。relative() 对 '/' 这个边界天然正确：任何路径相对 '/' 的结果
  // 都不会以 '..' 开头。
  if (real !== realRoot) {
    const rel2 = nodePath.relative(realRoot, real)
    const escapes = rel2 === '..' || rel2.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel2)
    if (escapes) {
      throw new SpecError('path.escapesWorkspace', { path: JSON.stringify(subPath) })
    }
  }
  return real
}
