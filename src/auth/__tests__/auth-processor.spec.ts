import type { AxiosRequestConfig } from "axios";
import type { RestClient } from "../../client/rest.client";
import { AuthProcessor } from "../auth-processor";
import type { AuthStrategy } from "../auth.config";

/**
 * Awaitable delay helper used to model an async authentication handshake.
 * Tests rely on a small, deterministic delay (50ms) to ensure the second
 * concurrent `authenticateIfNeeded()` call lands while the first call is
 * still in flight — the precondition that exercises `@DeduplicateInflight`.
 */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Strongly-typed stub matching the `AuthStrategy` interface, with each
 * method represented by a `jest.Mock` so individual tests can assert call
 * counts/arguments and override behaviour as needed.
 */
interface AuthStrategyStub extends AuthStrategy {
  authenticate: jest.Mock<Promise<void>, [RestClient]>;
  isAuthenticated: jest.Mock<Promise<boolean>, []>;
  extendRequest: jest.Mock<AxiosRequestConfig, [AxiosRequestConfig]>;
  invalidate: jest.Mock<Promise<void>, []>;
}

/**
 * Builds a fresh {@link AuthStrategyStub} for every test case. The default
 * stub reports authenticated, returns the input config untouched from
 * `extendRequest`, and resolves `authenticate` synchronously without doing
 * any work. Tests override individual mocks as needed.
 */
function createStrategyStub(): AuthStrategyStub {
  return {
    authenticate: jest.fn().mockResolvedValue(undefined),
    isAuthenticated: jest.fn().mockResolvedValue(true),
    extendRequest: jest.fn(
      (config: AxiosRequestConfig): AxiosRequestConfig => ({
        ...config,
        headers: {
          ...((config.headers as Record<string, unknown> | undefined) ?? {}),
          Authorization: "Bearer X",
        },
      }),
    ),
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
}

/**
 * Minimal `RestClient` placeholder. The processor only forwards this value
 * to `strategy.authenticate(client)`; it never inspects it. A bare object
 * cast through `unknown` keeps the tests free of transport-layer setup.
 */
const fakeClient = { iAm: "the-rest-client" } as unknown as RestClient;

describe("AuthProcessor", () => {
  describe("isAuthenticated()", () => {
    it("resolves with true when the strategy reports authenticated", async () => {
      const strategy = createStrategyStub();
      strategy.isAuthenticated.mockResolvedValue(true);
      const processor = new AuthProcessor(strategy, fakeClient);

      await expect(processor.isAuthenticated()).resolves.toBe(true);
      expect(strategy.isAuthenticated).toHaveBeenCalledTimes(1);
    });

    it("resolves with false when the strategy reports unauthenticated", async () => {
      const strategy = createStrategyStub();
      strategy.isAuthenticated.mockResolvedValue(false);
      const processor = new AuthProcessor(strategy, fakeClient);

      await expect(processor.isAuthenticated()).resolves.toBe(false);
      expect(strategy.isAuthenticated).toHaveBeenCalledTimes(1);
    });

    it("awaits the strategy's async isAuthenticated before resolving (deferred Promise ordering)", async () => {
      // Pins the awaited-delegation invariant: `AuthProcessor.isAuthenticated`
      // MUST `await this.strategy.isAuthenticated()` rather than returning the
      // raw Promise unchanged or eagerly resolving. A regression that dropped
      // the await would still type-check (the method would simply return
      // `Promise<Promise<boolean>>` flattened by the runtime). This test gates
      // the ordering with a deferred Promise that only resolves when the test
      // explicitly releases it.
      const strategy = createStrategyStub();
      let resolveIsAuth!: (value: boolean) => void;
      const deferred = new Promise<boolean>((resolve) => {
        resolveIsAuth = resolve;
      });
      strategy.isAuthenticated.mockReturnValueOnce(deferred);
      const processor = new AuthProcessor(strategy, fakeClient);

      let settled = false;
      const checkPromise = processor.isAuthenticated().then((value) => {
        settled = true;
        return value;
      });

      // Drain microtasks/macrotasks — the inner Promise is still pending, so
      // the outer Promise must NOT have settled yet. A regression that
      // bypassed the await (e.g., returning a stale cached value) would have
      // resolved before the test released the deferred.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);

      resolveIsAuth(true);
      await expect(checkPromise).resolves.toBe(true);
      expect(settled).toBe(true);
    });
  });

  describe("authenticateIfNeeded()", () => {
    it("skips strategy.authenticate when strategy.isAuthenticated() resolves with true", async () => {
      const strategy = createStrategyStub();
      strategy.isAuthenticated.mockResolvedValue(true);
      const processor = new AuthProcessor(strategy, fakeClient);

      await processor.authenticateIfNeeded();

      expect(strategy.authenticate).not.toHaveBeenCalled();
    });

    it("calls strategy.authenticate when strategy.isAuthenticated() resolves with false", async () => {
      const strategy = createStrategyStub();
      strategy.isAuthenticated.mockResolvedValue(false);
      const processor = new AuthProcessor(strategy, fakeClient);

      await processor.authenticateIfNeeded();

      expect(strategy.authenticate).toHaveBeenCalledTimes(1);
    });

    it("forwards the configured client to strategy.authenticate(client)", async () => {
      const strategy = createStrategyStub();
      strategy.isAuthenticated.mockResolvedValue(false);
      const processor = new AuthProcessor(strategy, fakeClient);

      await processor.authenticateIfNeeded();

      expect(strategy.authenticate).toHaveBeenCalledWith(fakeClient);
    });

    it("coalesces concurrent first-time callers into exactly ONE strategy.authenticate invocation (single-flight)", async () => {
      const strategy = createStrategyStub();
      strategy.isAuthenticated.mockResolvedValue(false);
      strategy.authenticate.mockImplementation(async () => {
        // 50ms delay guarantees that all concurrent callers land while
        // the first call is still in flight, so @DeduplicateInflight must
        // collapse them onto the same promise.
        await delay(50);
      });
      const processor = new AuthProcessor(strategy, fakeClient);

      const results = await Promise.all([
        processor.authenticateIfNeeded(),
        processor.authenticateIfNeeded(),
        processor.authenticateIfNeeded(),
        processor.authenticateIfNeeded(),
        processor.authenticateIfNeeded(),
      ]);

      expect(results).toEqual([undefined, undefined, undefined, undefined, undefined]);
      expect(strategy.authenticate).toHaveBeenCalledTimes(1);
      expect(strategy.authenticate).toHaveBeenCalledWith(fakeClient);
    });

    it("clears the inflight entry after the awaited promise resolves", async () => {
      const strategy = createStrategyStub();
      strategy.isAuthenticated.mockResolvedValue(false);
      const processor = new AuthProcessor(strategy, fakeClient);

      await processor.authenticateIfNeeded();

      // The DeduplicateInflight contract removes the key in `finally`.
      expect(processor.inflightMap.size).toBe(0);
    });
  });

  describe("extendRequest()", () => {
    it("delegates to strategy.extendRequest with the input config", () => {
      const strategy = createStrategyStub();
      const processor = new AuthProcessor(strategy, fakeClient);

      const inputConfig: AxiosRequestConfig = { headers: { foo: "bar" } };
      const extended = processor.extendRequest(inputConfig);

      expect(strategy.extendRequest).toHaveBeenCalledTimes(1);
      expect(strategy.extendRequest).toHaveBeenCalledWith(inputConfig);
      expect(extended).toEqual({
        headers: { foo: "bar", Authorization: "Bearer X" },
      });
    });

    it("returns whatever the strategy returns from extendRequest, untouched", () => {
      const strategy = createStrategyStub();
      const sentinel: AxiosRequestConfig = { url: "/sentinel" };
      strategy.extendRequest.mockReturnValueOnce(sentinel);
      const processor = new AuthProcessor(strategy, fakeClient);

      const result = processor.extendRequest({ url: "/in" });

      expect(result).toBe(sentinel);
    });
  });

  describe("clearAuth()", () => {
    it("calls strategy.invalidate() exactly once", async () => {
      const strategy = createStrategyStub();
      const processor = new AuthProcessor(strategy, fakeClient);

      await processor.clearAuth();

      expect(strategy.invalidate).toHaveBeenCalledTimes(1);
    });

    it("after clearAuth, isAuthenticated reports unauthenticated and the next authenticateIfNeeded triggers a fresh strategy.authenticate(client) call", async () => {
      const strategy = createStrategyStub();
      // Model a strategy whose `invalidate()` flips `isAuthenticated()` to false,
      // mirroring the contract documented on AuthStrategy.invalidate.
      let authenticated = true;
      strategy.isAuthenticated.mockImplementation(async () => authenticated);
      strategy.invalidate.mockImplementation(async () => {
        authenticated = false;
      });
      strategy.authenticate.mockImplementation(async () => {
        authenticated = true;
      });
      const processor = new AuthProcessor(strategy, fakeClient);

      // Pre-condition: starts authenticated, no handshake needed.
      await processor.authenticateIfNeeded();
      expect(strategy.authenticate).not.toHaveBeenCalled();

      // Invalidate the session — strategy now reports unauthenticated.
      await processor.clearAuth();
      expect(strategy.invalidate).toHaveBeenCalledTimes(1);
      await expect(processor.isAuthenticated()).resolves.toBe(false);

      // Next pre-flight must trigger a fresh handshake forwarded with the client.
      await processor.authenticateIfNeeded();
      expect(strategy.authenticate).toHaveBeenCalledTimes(1);
      expect(strategy.authenticate).toHaveBeenCalledWith(fakeClient);
      await expect(processor.isAuthenticated()).resolves.toBe(true);
    });
  });
});
