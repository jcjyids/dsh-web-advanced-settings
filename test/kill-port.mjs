#!/usr/bin/env node
/**
 * kill-port.mjs —— 辅助脚本：按端口清理遗留的监听进程。
 *
 *   node test/kill-port.mjs 3098
 *
 * Windows 走 netstat -ano + taskkill；POSIX 走 lsof + SIGTERM。
 * 只处理 LISTENING 的进程，绝不按进程名乱杀。
 *
 * 注意：受限沙箱里 Node 用管道捕获子进程输出会 EPERM，所以 netstat/lsof 的
 * 输出先落到文件再读（与重启器同一套做法）。
 */
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function captureToFile(command, args) {
  const scratch = join(HERE, '.tmp')
  try {
    mkdirSync(scratch, { recursive: true })
  } catch {
    // 已存在
  }
  const tmp = join(scratch, `capture-${String(process.pid)}.txt`)
  try {
    const fd = openSync(tmp, 'w')
    const out = spawnSync(command, args, { stdio: ['ignore', fd, 'ignore'], windowsHide: true })
    closeSync(fd)
    if (out.error) return ''
    return readFileSync(tmp, 'utf8')
  } catch {
    return ''
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // 不存在
    }
  }
}

const port = Number(process.argv[2])
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('用法：node test/kill-port.mjs <port>')
  process.exit(2)
}

const win = process.platform === 'win32'
const pids = new Set()

if (win) {
  for (const line of captureToFile('netstat', ['-ano', '-p', 'tcp']).split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const parts = line.trim().split(/\s+/)
    if (!(parts[1] || '').endsWith(':' + String(port))) continue
    const pid = parts[parts.length - 1]
    if (/^\d+$/.test(pid)) pids.add(pid)
  }
} else {
  for (const pid of captureToFile('lsof', ['-ti', 'tcp:' + String(port), '-sTCP:LISTEN']).split(/\s+/)) {
    if (/^\d+$/.test(pid)) pids.add(pid)
  }
}

if (pids.size === 0) {
  console.log(`端口 ${String(port)} 上没有监听进程`)
  process.exit(0)
}

for (const pid of pids) {
  if (win) {
    const args = ['/pid', pid, '/f']
    const out = spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true })
    console.log(`taskkill ${args.join(' ')} -> ${out.error ? 'error' : 'status=' + String(out.status)}`)
  } else {
    try {
      process.kill(Number(pid), 'SIGTERM')
      console.log(`SIGTERM -> ${pid}`)
    } catch (error) {
      console.log(`SIGTERM ${pid} 失败：${String(error.message)}`)
    }
  }
}
