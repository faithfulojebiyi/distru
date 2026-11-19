/** Retries `check` until it stops throwing (bun's stand-in for vitest's `vi.waitFor`). */
export async function waitFor(check: () => unknown, timeoutMs = 2_000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
}

/** Copies `init` with `duplex: "half"`, which a streamed request body needs. */
export function halfDuplex(init: RequestInit | undefined): RequestInit | undefined {
  return init?.body ? ({ ...init, duplex: "half" } as RequestInit) : init
}

/** `fn` typed as the global fetch (bun's adds `preconnect`). */
export function asGlobalFetch(
  fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(fn, { preconnect: globalThis.fetch.preconnect })
}
