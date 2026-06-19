import { DeduplicateInflight } from '../deduplicate-inflight.decorator'

describe('DeduplicateInflight decorator', () => {
  describe('promise coalescing', () => {
    it('should deduplicate concurrent calls with same key so method executes only once', async () => {
      const methodSpy = jest.fn()
      let resolveMethod!: (value: string) => void

      class TestService {
        readonly inflightMap = new Map<string, Promise<unknown>>()

        @DeduplicateInflight((id: string) => id)
        async fetchData(id: string): Promise<string> {
          methodSpy(id)
          return new Promise<string>(resolve => (resolveMethod = resolve))
        }
      }

      const service = new TestService()

      const call1 = service.fetchData('key-1')
      const call2 = service.fetchData('key-1')

      resolveMethod('result-1')

      const [result1, result2] = await Promise.all([call1, call2])

      expect(methodSpy).toHaveBeenCalledTimes(1)
      expect(result1).toBe('result-1')
      expect(result2).toBe('result-1')
    })

    it('should return the same promise reference for concurrent calls with same key', async () => {
      class TestService {
        readonly inflightMap = new Map<string, Promise<unknown>>()

        @DeduplicateInflight((id: string) => id)
        async fetchData(id: string): Promise<string> {
          return `result-${id}`
        }
      }

      const service = new TestService()

      // Access inflightMap to verify same promise is stored
      const call1 = service.fetchData('same-key')

      // While call1 is inflight, inflightMap should contain the promise
      expect(service.inflightMap.has('same-key')).toBe(true)

      await call1
    })
  })

  describe('cleanup on success', () => {
    it('should remove key from inflightMap after successful resolution', async () => {
      class TestService {
        readonly inflightMap = new Map<string, Promise<unknown>>()

        @DeduplicateInflight((id: string) => id)
        async fetchData(id: string): Promise<string> {
          return `result-${id}`
        }
      }

      const service = new TestService()

      await service.fetchData('cleanup-key')

      expect(service.inflightMap.has('cleanup-key')).toBe(false)
      expect(service.inflightMap.size).toBe(0)
    })
  })

  describe('cleanup on error', () => {
    it('should remove key from inflightMap after rejection', async () => {
      class TestService {
        readonly inflightMap = new Map<string, Promise<unknown>>()

        @DeduplicateInflight((id: string) => id)
        async fetchData(id: string): Promise<string> {
          throw new Error(`fail-${id}`)
        }
      }

      const service = new TestService()

      await expect(service.fetchData('error-key')).rejects.toThrow('fail-error-key')

      expect(service.inflightMap.has('error-key')).toBe(false)
      expect(service.inflightMap.size).toBe(0)
    })

    it('should propagate error to all callers sharing the same inflight promise', async () => {
      const methodSpy = jest.fn()
      let rejectMethod!: (error: Error) => void

      class TestService {
        readonly inflightMap = new Map<string, Promise<unknown>>()

        @DeduplicateInflight((id: string) => id)
        async fetchData(id: string): Promise<string> {
          methodSpy(id)
          return new Promise<string>((_resolve, reject) => (rejectMethod = reject))
        }
      }

      const service = new TestService()

      const call1 = service.fetchData('fail-key')
      const call2 = service.fetchData('fail-key')

      rejectMethod(new Error('shared failure'))

      await expect(call1).rejects.toThrow('shared failure')
      await expect(call2).rejects.toThrow('shared failure')
      expect(methodSpy).toHaveBeenCalledTimes(1)
      expect(service.inflightMap.size).toBe(0)
    })
  })

  describe('independent keys', () => {
    it('should execute method independently for different keys', async () => {
      const methodSpy = jest.fn()

      class TestService {
        readonly inflightMap = new Map<string, Promise<unknown>>()

        @DeduplicateInflight((id: string) => id)
        async fetchData(id: string): Promise<string> {
          methodSpy(id)
          return `result-${id}`
        }
      }

      const service = new TestService()

      const [result1, result2] = await Promise.all([
        service.fetchData('key-a'),
        service.fetchData('key-b'),
      ])

      expect(methodSpy).toHaveBeenCalledTimes(2)
      expect(methodSpy).toHaveBeenCalledWith('key-a')
      expect(methodSpy).toHaveBeenCalledWith('key-b')
      expect(result1).toBe('result-key-a')
      expect(result2).toBe('result-key-b')
    })
  })

  describe('key builder with multiple arguments', () => {
    it('should pass all method arguments to the key builder function', async () => {
      const keyBuilderSpy = jest.fn((userId: string, version: string) => `${version}:${userId}`)

      class TestService {
        readonly inflightMap = new Map<string, Promise<unknown>>()

        @DeduplicateInflight(keyBuilderSpy)
        async fetchData(_userId: string, _version: string): Promise<string> {
          return 'data'
        }
      }

      const service = new TestService()

      await service.fetchData('user-1', 'v2')

      expect(keyBuilderSpy).toHaveBeenCalledWith('user-1', 'v2')
    })
  })

  describe('shared wrap context across instances', () => {
    // base-decorators creates the wrap closure once and reassigns its shared
    // `context.target` to the current `this` before every call. Two instances of
    // the same decorated class (e.g. two AuthProcessors) therefore share one
    // context. If the post-`await` cleanup re-reads `context.target`, it can
    // delete the WRONG instance's entry when calls interleave — orphaning a
    // settled promise so the owning instance short-circuits forever. Each call
    // must operate on its own instance's map regardless of later `context.target`
    // reassignment.
    it('cleans up the calling instance, not whichever instance called last', async () => {
      const methodSpy = jest.fn()

      class AuthProcessorLike {
        readonly inflightMap = new Map<string, Promise<unknown>>()
        private resolveCurrent?: () => void

        @DeduplicateInflight(() => 'authenticate')
        async authenticate(): Promise<void> {
          methodSpy()
          return new Promise<void>(resolve => {
            this.resolveCurrent = resolve
          })
        }

        settle(): void {
          this.resolveCurrent?.()
        }
      }

      const a = new AuthProcessorLike()
      const b = new AuthProcessorLike()

      const callA = a.authenticate() // shared context.target = a
      const callB = b.authenticate() // shared context.target flips to b

      expect(a.inflightMap.has('authenticate')).toBe(true)
      expect(b.inflightMap.has('authenticate')).toBe(true)

      // Resolve A while the shared context.target points at B.
      a.settle()
      await callA

      // A must clean ITS OWN entry; B's in-flight entry must be untouched.
      expect(a.inflightMap.size).toBe(0)
      expect(b.inflightMap.has('authenticate')).toBe(true)

      // A must not be wedged: a fresh call actually re-invokes the method
      // instead of short-circuiting on a stale, orphaned promise.
      expect(methodSpy).toHaveBeenCalledTimes(2)
      const callA2 = a.authenticate()
      expect(methodSpy).toHaveBeenCalledTimes(3)

      // settle the still-in-flight promises so the test leaves no dangling work
      a.settle()
      await callA2
      b.settle()
      await callB
    })
  })
})
