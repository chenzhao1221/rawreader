import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { getProcessInfo, killTree } from './win-process'

// Spawns real processes: Windows only. Both processes are our own children, killed by PID.

const PARENT_SCRIPT = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
console.log('CHILD:' + child.pid);
setInterval(() => {}, 1000);
`

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

describe('killTree (Windows)', () => {
  it('kills a process and the child it spawned, and reports both gone', async () => {
    const parent = spawn(process.execPath, ['-e', PARENT_SCRIPT], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const parentPid = parent.pid
    expect(parentPid).toBeTypeOf('number')

    const childPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child pid not reported')), 10_000)
      parent.stdout.on('data', (chunk: Buffer) => {
        const match = /CHILD:(\d+)/.exec(chunk.toString())
        if (match) {
          clearTimeout(timer)
          resolve(Number(match[1]))
        }
      })
    })

    try {
      const parentInfo = await getProcessInfo(parentPid as number)
      expect(parentInfo).not.toBeNull()
      expect(parentInfo?.exePath?.toLowerCase()).toBe(process.execPath.toLowerCase())
      expect(await getProcessInfo(childPid)).not.toBeNull()

      await killTree(parentPid as number)

      expect(await waitUntil(async () => (await getProcessInfo(parentPid as number)) === null)).toBe(true)
      expect(await waitUntil(async () => (await getProcessInfo(childPid)) === null)).toBe(true)
    } finally {
      // Safety net: only ever our own recorded PIDs.
      await killTree(parentPid as number).catch(() => {})
      await killTree(childPid).catch(() => {})
    }
  }, 40_000)

  it('treats an already-gone PID as success', async () => {
    const proc = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' })
    const pid = proc.pid as number
    await new Promise((r) => proc.once('exit', r))
    await expect(killTree(pid)).resolves.toBeUndefined()
    expect(await getProcessInfo(pid)).toBeNull()
  }, 20_000)
})
