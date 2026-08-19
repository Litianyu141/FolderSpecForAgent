/**
 * 把跨边界传入的相对路径归一化为工作区相对的 posix 路径，并拒绝任何逃出工作区的写法。
 *
 * 这道校验是 file/read 引入后才变成必需的：在此之前 scan 的 subPath 虽然也接受 ".."，
 * 但结果会被 findActual 丢弃、不产生可观测的越界读取。file/read 会把内容直接回传前端，
 * 于是同一个缺口变成了真实可达的路径。两个入口共用这一处实现，不在两边各写一遍。
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
