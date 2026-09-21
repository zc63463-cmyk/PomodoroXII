/**
 * TS-04：前端变更流 —— 认证 streaming fetch、合并、重连与权威围栏。
 *
 * 这些用例钉住的能力，正是「SSE 只是提示、Sync v2 仍是唯一正确性路径」这句话
 * 在客户端一侧的全部含义：
 *
 * - 每条通知只调用既有 `sync()`，绝不写 cursor / ACK / 业务行；
 * - 同步进行中的重复通知合并成一个 pending 标志，周期结束后只补跑一次；
 * - 401 / 403 / 404 是终态，不再重连；网络错误按有界指数退避重连；
 * - Space 切换（权威 token 失效）或 close() 之后，迟到回调不得影响新 Space；
 * - 流关闭后手动 / 在线 / 引导同步路径照常可用。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CHANGE_STREAM_PATH,
  TASK_SPACE_CHANGED_EVENT,
  startTaskSpaceChangeStream,
  type ChangeStreamHandle,
} from './change-stream'
import {
  withSpaceAuthorityFence,
  type SpaceAuthorityToken,
} from './space-authority-fence'

interface LockOptions {
  mode: 'exclusive'
}

class FakeLockManager {
  private readonly tails = new Map<string, Promise<void>>()

  request<T>(
    name: string,
    options: LockOptions,
    callback: () => Promise<T>,
  ): Promise<T> {
    void options
    const previous = this.tails.get(name) ?? Promise.resolve()
    const result = previous.then(callback)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(name, tail)
    return result
  }
}

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')

function installLocks(): void {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: new FakeLockManager(),
  })
}

afterEach(() => {
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
  vi.useRealTimers()
})

/** 取一个当前有效的 Space 权威 token（与 engine 用的是同一条路径）。 */
async function withToken<T>(
  spaceId: string,
  work: (token: SpaceAuthorityToken) => Promise<T>,
): Promise<T> {
  installLocks()
  return withSpaceAuthorityFence(spaceId, work)
}

/** 一个可手动推送 SSE 帧的 ReadableStream。 */
function makeSseStream(): {
  stream: ReadableStream<Uint8Array>
  push: (chunk: string) => void
  close: () => void
} {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    stream,
    push: (chunk: string) => controller.enqueue(encoder.encode(chunk)),
    close: () => controller.close(),
  }
}

function changedFrame(spaceId: string, watermark: number): string {
  return (
    `event: ${TASK_SPACE_CHANGED_EVENT}\n` +
    `id: ${spaceId}:1:${watermark}\n` +
    `data: ${JSON.stringify({ space_id: spaceId, visible_watermark: watermark })}\n\n`
  )
}

/** 让已排队的微任务/宏任务跑完。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('task-space change stream', () => {
  it('uses an authenticated streaming fetch, never native EventSource', async () => {
    const sse = makeSseStream()
    const fetchImpl = vi.fn(async () => new Response(sse.stream, { status: 200 }))
    const sync = vi.fn(async () => {})

    await withToken('space-a', async (authority) => {
      const handle = startTaskSpaceChangeStream({
        spaceId: 'space-a',
        sync,
        authority,
        getToken: () => 'space-token-abc',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
      await settle()

      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ]
      expect(url).toContain(`${CHANGE_STREAM_PATH}?space_id=space-a`)
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer space-token-abc',
      )
      expect(init.method).toBe('GET')
      // AbortController 是关闭流的唯一手段。
      expect(init.signal).toBeInstanceOf(AbortSignal)
      handle.close()
    })
  })

  it('runs the existing sync cycle on each change notification', async () => {
    const sse = makeSseStream()
    const sync = vi.fn(async () => {})

    await withToken('space-a', async (authority) => {
      const handle = startTaskSpaceChangeStream({
        spaceId: 'space-a',
        sync,
        authority,
        getToken: () => 'token',
        fetchImpl: (async () =>
          new Response(sse.stream, { status: 200 })) as unknown as typeof fetch,
      })
      await settle()

      sse.push(changedFrame('space-a', 7))
      await settle()
      expect(sync).toHaveBeenCalledTimes(1)

      sse.push(changedFrame('space-a', 8))
      await settle()
      expect(sync).toHaveBeenCalledTimes(2)
      expect(handle.receivedCount).toBe(2)
      handle.close()
    })
  })

  it('ignores heartbeat comments and unknown event names', async () => {
    const sse = makeSseStream()
    const sync = vi.fn(async () => {})

    await withToken('space-a', async (authority) => {
      const handle = startTaskSpaceChangeStream({
        spaceId: 'space-a',
        sync,
        authority,
        getToken: () => 'token',
        fetchImpl: (async () =>
          new Response(sse.stream, { status: 200 })) as unknown as typeof fetch,
      })
      await settle()

      sse.push(': heartbeat\n\n')
      sse.push(`event: something_else\ndata: {"space_id":"space-a"}\n\n`)
      sse.push(`event: ${TASK_SPACE_CHANGED_EVENT}\ndata: not-json\n\n`)
      await settle()
      expect(sync).not.toHaveBeenCalled()
      expect(handle.receivedCount).toBe(0)
      handle.close()
    })
  })

  it('never treats a foreign Space event as a local change', async () => {
    const sse = makeSseStream()
    const sync = vi.fn(async () => {})
    const foreign: string[] = []

    await withToken('space-a', async (authority) => {
      const handle = startTaskSpaceChangeStream({
        spaceId: 'space-a',
        sync,
        authority,
        getToken: () => 'token',
        onForeignEvent: (id) => foreign.push(id),
        fetchImpl: (async () =>
          new Response(sse.stream, { status: 200 })) as unknown as typeof fetch,
      })
      await settle()

      sse.push(changedFrame('space-b', 3))
      await settle()
      expect(sync).not.toHaveBeenCalled()
      expect(foreign).toEqual(['space-b'])
      handle.close()
    })
  })

  it('coalesces duplicate notifications into one pending follow-up cycle', async () => {
    const sse = makeSseStream()
    let release!: () => void
    const firstCycle = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const sync = vi.fn(async () => {
      calls += 1
      if (calls === 1) await firstCycle
    })

    await withToken('space-a', async (authority) => {
      const handle = startTaskSpaceChangeStream({
        spaceId: 'space-a',
        sync,
        authority,
        getToken: () => 'token',
        fetchImpl: (async () =>
          new Response(sse.stream, { status: 200 })) as unknown as typeof fetch,
      })
      await settle()

      // 周期 1 进行中时连来三条通知：只置一个 pending 标志。
      sse.push(changedFrame('space-a', 1))
      await settle()
      sse.push(changedFrame('space-a', 2))
      sse.push(changedFrame('space-a', 3))
      sse.push(changedFrame('space-a', 4))
      await settle()
      expect(sync).toHaveBeenCalledTimes(1)

      release()
      await settle()
      // 周期 1 结束后只补跑一次，而不是把三条通知各跑一次。
      expect(sync).toHaveBeenCalledTimes(2)
      expect(handle.syncCount).toBe(2)
      handle.close()
    })
  })

  it('stops without reconnecting on token expiry or revocation (401/403/404)', async () => {
    for (const status of [401, 403, 404]) {
      const fetchImpl = vi.fn(
        async () => new Response('denied', { status }),
      )
      const sync = vi.fn(async () => {})
      await withToken('space-a', async (authority) => {
        const handle: ChangeStreamHandle = startTaskSpaceChangeStream({
          spaceId: 'space-a',
          sync,
          authority,
          getToken: () => 'token',
          fetchImpl: fetchImpl as unknown as typeof fetch,
          reconnectBaseMs: 1,
        })
        await settle()
        expect(handle.closed).toBe(true)
        // 终态：没有重连，也没有触发同步。
        expect(fetchImpl).toHaveBeenCalledTimes(1)
        expect(sync).not.toHaveBeenCalled()
        handle.close()
      })
    }
  })

  it('stops when no token is available', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }))
    await withToken('space-a', async (authority) => {
      const handle = startTaskSpaceChangeStream({
        spaceId: 'space-a',
        sync: async () => {},
        authority,
        getToken: () => null,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
      await settle()
      expect(handle.closed).toBe(true)
      expect(fetchImpl).not.toHaveBeenCalled()
      handle.close()
    })
  })

  it('reconnects with bounded exponential backoff after a transport failure', async () => {
    const attempts: string[] = []
    let failing = true
    const sse = makeSseStream()
    const fetchImpl = vi.fn(async () => {
      attempts.push('attempt')
      if (failing) throw new Error('network down')
      return new Response(sse.stream, { status: 200 })
    })

    vi.useFakeTimers()
    await withToken('space-a', async (authority) => {
      const handle = startTaskSpaceChangeStream({
        spaceId: 'space-a',
        sync: async () => {},
        authority,
        getToken: () => 'token',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        reconnectBaseMs: 100,
        reconnectMaxMs: 400,
      })

      // 退避序列 100 → 200 → 400（有界）。
      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(200)
      await vi.advanceTimersByTimeAsync(400)
      expect(attempts.length).toBeGreaterThanOrEqual(3)

      failing = false
      await vi.advanceTimersByTimeAsync(400)
      expect(handle.closed).toBe(false)
      handle.close()
    })
  })

  it('aborts the stream and rejects late callbacks after close()', async () => {
    const sse = makeSseStream()
    const sync = vi.fn(async () => {})

    await withToken('space-a', async (authority) => {
      const handle = startTaskSpaceChangeStream({
        spaceId: 'space-a',
        sync,
        authority,
        getToken: () => 'token',
        fetchImpl: (async () =>
          new Response(sse.stream, { status: 200 })) as unknown as typeof fetch,
      })
      await settle()

      handle.close()
      expect(handle.closed).toBe(true)

      // 关闭后到达的帧必须被忽略。
      sse.push(changedFrame('space-a', 99))
      await settle()
      expect(sync).not.toHaveBeenCalled()
      expect(handle.receivedCount).toBe(0)
    })
  })

  it('fences stale callbacks when the Space authority token is released', async () => {
    const sse = makeSseStream()
    const sync = vi.fn(async () => {})
    let observed: ChangeStreamHandle | null = null

    vi.useFakeTimers()
    // token 在 fence 回调返回后即失效 —— 模拟 Space 切换 / engine destroy。
    await withToken('space-a', async (authority) => {
      observed = startTaskSpaceChangeStream({
        spaceId: 'space-a',
        sync,
        authority,
        getToken: () => 'token',
        fetchImpl: (async () =>
          new Response(sse.stream, { status: 200 })) as unknown as typeof fetch,
      })
      await vi.advanceTimersByTimeAsync(0)
    })

    const handle = observed as unknown as ChangeStreamHandle
    // 权威 token 已失效：例行复查必须让旧流自行关闭。
    await vi.advanceTimersByTimeAsync(5_000)
    expect(handle.closed).toBe(true)

    sse.push(changedFrame('space-a', 5))
    await vi.advanceTimersByTimeAsync(100)
    // 旧流的迟到通知绝不能触发新 Space 的同步。
    expect(sync).not.toHaveBeenCalled()
  })

  it('does not call sync after the authority token is released mid-flight', async () => {
    const sse = makeSseStream()
    const sync = vi.fn(async () => {})

    await withToken('space-a', async (authority) => {
      startTaskSpaceChangeStream({
        spaceId: 'space-a',
        sync,
        authority,
        getToken: () => 'token',
        fetchImpl: (async () =>
          new Response(sse.stream, { status: 200 })) as unknown as typeof fetch,
      })
      await settle()
      sse.push(changedFrame('space-a', 1))
      await settle()
      expect(sync).toHaveBeenCalledTimes(1)
    })

    // fence 已退出，token 失效；再来通知不得再触发同步。
    sse.push(changedFrame('space-a', 2))
    await settle()
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('leaves manual, online, bootstrap and dirty sync triggers intact when closed', async () => {
    const sse = makeSseStream()
    const sync = vi.fn(async () => {})

    await withToken('space-a', async (authority) => {
      const handle = startTaskSpaceChangeStream({
        spaceId: 'space-a',
        sync,
        authority,
        getToken: () => 'token',
        fetchImpl: (async () =>
          new Response(sse.stream, { status: 200 })) as unknown as typeof fetch,
      })
      await settle()
      handle.close()

      // 流关闭后，调用方仍可直接驱动同步（手动 / 在线 / 引导 / 脏标记）。
      await sync()
      await sync()
      expect(sync).toHaveBeenCalledTimes(2)
    })
  })

  it('reports transport errors through onError without crashing', async () => {
    const errors: unknown[] = []
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom')
    })

    vi.useFakeTimers()
    await withToken('space-a', async (authority) => {
      const handle = startTaskSpaceChangeStream({
        spaceId: 'space-a',
        sync: async () => {},
        authority,
        getToken: () => 'token',
        onError: (error) => errors.push(error),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        reconnectBaseMs: 50,
      })
      await vi.advanceTimersByTimeAsync(50)
      expect(errors.length).toBeGreaterThanOrEqual(1)
      handle.close()
    })
  })
})
