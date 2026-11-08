import { spawn } from 'node:child_process'
import path from 'node:path/posix'

// 저장소를 Mac 로컬 디스크 대신 SSH로 원격 서버(axdc_gpu)에 둔다.
// ~/.ssh/config 의 Host 설정을 그대로 쓰고, 포트 포워딩·터널은 쓰지 않는다.
//
// 원격 셸은 명령마다 ~/.bashrc를 읽느라 1초 가까이 걸리므로, SSH로 작은 파이썬
// 도우미 프로세스 하나를 띄워 두고 stdin/stdout으로 파일 요청을 주고받는다.
// (셸 시작 비용은 처음 한 번만 든다. 도우미가 죽으면 다음 요청 때 다시 띄운다.)
//
// 환경변수로 바꿀 수 있다:
//   LABEL_STORE_HOST  (기본 axdc_gpu)
//   LABEL_STORE_ROOT  (기본 P/labeling_store — 원격 홈 기준 상대 경로)
export const REMOTE_HOST = process.env.LABEL_STORE_HOST || 'axdc_gpu'
export const REMOTE_ROOT = path.normalize(process.env.LABEL_STORE_ROOT || 'P/labeling_store')

const SSH_OPTS = [
  '-o', 'BatchMode=yes', // 비밀번호 프롬프트에서 멈추지 않도록
  '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
]

const READY = Buffer.from('\nKPAGENT_READY\n')

// 원격에서 도는 도우미. 요청: JSON 한 줄 + len 바이트 / 응답: JSON 한 줄 + len 바이트
const AGENT = String.raw`
import sys, os, json, shutil
os.chdir(os.path.expanduser('~'))
ROOT = os.path.realpath(sys.argv[2])
inp, out = sys.stdin.buffer, sys.stdout.buffer

def readn(n):
    b = bytearray()
    while len(b) < n:
        c = inp.read(n - len(b))
        if not c:
            raise EOFError
        b += c
    return bytes(b)

def inside(p):
    r = os.path.realpath(p)
    return r.startswith(ROOT + os.sep)

out.write(b'\nKPAGENT_READY\n'); out.flush()
while True:
    line = inp.readline()
    if not line:
        break
    req = json.loads(line)
    data = readn(req['len']) if req.get('len') else b''
    body, hdr = b'', {'id': req['id'], 'ok': True}
    try:
        op, p = req['op'], req.get('path')
        if not inside(p):
            raise PermissionError('outside store: ' + p)
        if op == 'read':
            with open(p, 'rb') as f:
                body = f.read()
        elif op == 'write':
            with open(p, 'wb') as f:
                f.write(data)
        elif op == 'writeAtomic':
            tmp = p + '.tmp'
            with open(tmp, 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, p)
        elif op == 'rename':
            if not inside(req['path2']):
                raise PermissionError('outside store')
            os.replace(p, req['path2'])
        elif op == 'mkdir':
            os.makedirs(p, exist_ok=True)
        elif op == 'exists':
            hdr['exists'] = os.path.exists(p)
        elif op == 'readdir':
            hdr['entries'] = [[e.name, e.is_dir()] for e in os.scandir(p)]
        elif op == 'rm':
            if os.path.isdir(p):
                shutil.rmtree(p)
            elif os.path.exists(p):
                os.remove(p)
        else:
            raise ValueError('unknown op ' + op)
    except Exception as e:
        body = b''
        hdr = {'id': req['id'], 'ok': False, 'err': type(e).__name__ + ': ' + str(e),
               'code': 'ENOENT' if isinstance(e, FileNotFoundError) else None}
    hdr['len'] = len(body)
    out.write(json.dumps(hdr).encode() + b'\n')
    out.write(body)
    out.flush()
`

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

let agent = null // { proc, pending: Map, ready: Promise }
let nextId = 1

function startAgent() {
  const b64 = Buffer.from(AGENT).toString('base64')
  const cmd = `exec python3 -u -c 'import base64,sys;exec(base64.b64decode(sys.argv[1]))' ${b64} ${sq(REMOTE_ROOT)}`
  const proc = spawn('ssh', [...SSH_OPTS, REMOTE_HOST, cmd], { stdio: ['pipe', 'pipe', 'pipe'] })
  const a = { proc, pending: new Map(), buf: Buffer.alloc(0), started: false, stderr: '' }
  let markReady, markFail
  a.ready = new Promise((res, rej) => {
    markReady = res
    markFail = rej
  })
  const timer = setTimeout(() => {
    markFail(new Error(`원격 저장소(${REMOTE_HOST}) 연결 시간 초과`))
    proc.kill()
  }, 30000)

  const fail = (err) => {
    clearTimeout(timer)
    markFail(err)
    for (const p of a.pending.values()) p.reject(err)
    a.pending.clear()
    if (agent === a) agent = null
  }

  proc.stderr.on('data', (c) => {
    a.stderr = (a.stderr + c.toString('utf8')).slice(-2000)
  })
  proc.on('error', fail)
  proc.on('close', (code) =>
    fail(new Error(`원격 저장소 연결이 끊겼습니다 (ssh exit ${code}) ${a.stderr.trim().split('\n').pop() ?? ''}`))
  )
  proc.stdin.on('error', () => {}) // 끊기면 close에서 처리

  proc.stdout.on('data', (chunk) => {
    a.buf = Buffer.concat([a.buf, chunk])
    if (!a.started) {
      // .bashrc 등이 stdout에 찍는 글자는 버리고 준비 표시부터 읽는다
      const i = a.buf.indexOf(READY)
      if (i < 0) return
      a.buf = a.buf.subarray(i + READY.length)
      a.started = true
      clearTimeout(timer)
      markReady()
    }
    for (;;) {
      const nl = a.buf.indexOf(10)
      if (nl < 0) return
      const hdr = JSON.parse(a.buf.subarray(0, nl).toString('utf8'))
      if (a.buf.length < nl + 1 + hdr.len) return
      const body = a.buf.subarray(nl + 1, nl + 1 + hdr.len)
      a.buf = a.buf.subarray(nl + 1 + hdr.len)
      const p = a.pending.get(hdr.id)
      if (!p) continue
      a.pending.delete(hdr.id)
      if (hdr.ok) p.resolve({ hdr, body: Buffer.from(body) })
      else {
        const e = new Error(hdr.err)
        if (hdr.code) e.code = hdr.code
        p.reject(e)
      }
    }
  })
  return a
}

async function call(op, p, extra = {}, data = null) {
  if (!agent) agent = startAgent()
  const a = agent
  await a.ready
  const id = nextId++
  const req = { id, op, path: p, ...extra, len: data ? data.length : 0 }
  return new Promise((resolve, reject) => {
    a.pending.set(id, { resolve, reject })
    a.proc.stdin.write(JSON.stringify(req) + '\n')
    if (data) a.proc.stdin.write(data)
  })
}

const toBuf = (data, enc) => (Buffer.isBuffer(data) ? data : Buffer.from(String(data), enc || 'utf8'))

// rm은 저장소 루트 아래 한 단계 이상 깊은 경로만 허용한다 (원격 도우미도 루트 밖은 거부)
const assertDeepInside = (p) => {
  const norm = path.normalize(p)
  if (norm.includes('..') || !norm.startsWith(`${REMOTE_ROOT}/`) || norm.split('/').length < REMOTE_ROOT.split('/').length + 2) {
    throw new Error(`refusing to remove: ${p}`)
  }
}

// node:fs/promises 중 projectApi·rawApi가 쓰는 부분만 같은 모양으로 흉내 낸다
export const remoteFs = {
  async readFile(p, enc) {
    const { body } = await call('read', p)
    return enc ? body.toString(enc) : body
  },
  async writeFile(p, data, enc) {
    await call('write', p, {}, toBuf(data, enc))
  },
  // 임시 파일에 쓰고 교체 — 저장 중 끊겨도 기존 파일이 깨지지 않는다
  async writeFileAtomic(p, data, enc) {
    await call('writeAtomic', p, {}, toBuf(data, enc))
  },
  async rename(a, b) {
    await call('rename', a, { path2: b })
  },
  async mkdir(p) {
    await call('mkdir', p)
  },
  async access(p) {
    const { hdr } = await call('exists', p)
    if (!hdr.exists) {
      const e = new Error(`ENOENT: ${p}`)
      e.code = 'ENOENT'
      throw e
    }
  },
  async readdir(p) {
    const { hdr } = await call('readdir', p)
    return hdr.entries.map(([name, dir]) => ({ name, isDirectory: () => dir }))
  },
  async rm(p) {
    assertDeepInside(p)
    await call('rm', p)
  },
}

// 한 번 올린 이미지는 덮어쓰지 않으므로 메모리에 캐시해서 다시 받지 않는다
const CACHE_LIMIT = 512 * 1024 * 1024
const cache = new Map()
let cacheBytes = 0
const remember = (p, buf) => {
  if (cache.has(p)) return
  cache.set(p, buf)
  cacheBytes += buf.length
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_LIMIT) break
    cache.delete(k)
    cacheBytes -= v.length
  }
}
export async function readCached(p) {
  const hit = cache.get(p)
  if (hit) {
    cache.delete(p)
    cache.set(p, hit) // LRU: 최근 사용으로 이동
    return hit
  }
  const buf = await remoteFs.readFile(p)
  remember(p, buf)
  return buf
}
export const putCached = remember
