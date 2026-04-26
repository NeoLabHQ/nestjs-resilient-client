import type { AxiosRequestConfig } from "axios";
import type { AuthConfig, AuthStrategy } from "../auth.config";
import { AuthStrategyService } from "../auth-strategy.service";

/**
 * Awaitable delay helper used to model an async authentication handshake.
 * Tests rely on a small, deterministic delay (50ms) to ensure the second
 * concurrent `authenticateIfNeeded()` call lands while the first call is
 * still in flight — the precondition that exercises `@DeduplicateInflight`.
 */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Lightweight typed stub for {@link AuthStrategy}. */
interface AuthStrategyStub extends AuthStrategy {
  isAuthenticated: jest.Mock<boolean, []>;
  extendRequest: jest.Mock<AxiosRequestConfig, [AxiosRequestConfig]>;
}

/** Lightweight typed stub for {@link AuthConfig}. */
interface AuthConfigStub extends AuthConfig {
  authenticate: jest.Mock<Promise<AuthStrategy>, [unknown]>;
}

/**
 * Builds a fresh {@link AuthStrategyStub} that reports authenticated by
 * default and merges an `Authorization: Bearer X` header into any request
 * config passed to {@link AuthStrategy.extendRequest}.
 */
function createStrategyStub(): AuthStrategyStub {
  return {
    isAuthenticated: jest.fn().mockReturnValue(true),
    extendRequest: jest.fn(
      (config: AxiosRequestConfig): AxiosRequestConfig => ({
        ...config,
        headers: {
          ...((config.headers as Record<string, unknown> | undefined) ?? {}),
          Authorization: "Bearer X",
        },
      }),
    ),
  };
}

/** Builds a fresh {@link AuthConfigStub} whose `authenticate` resolves to `strategy`. */
function createAuthConfigStub(strategy: AuthStrategy): AuthConfigStub {
  return {
    authenticate: jest.fn().mockResolvedValue(strategy),
  };
}

describe("AuthStrategyService", () => {
  describe("isAuthenticated()", () => {
    it("returns false before any authentication has occurred", () => {
      const service = new AuthStrategyService(
        createAuthConfigStub(createStrategyStub()),
        {},
      );

      expect(service.isAuthenticated()).toBe(false);
    });

    it("returns true after a successful authenticateIfNeeded() when the cached strategy is valid", async () => {
      const strategy = createStrategyStub();
      const service = new AuthStrategyService(createAuthConfigStub(strategy), {});

      await service.authenticateIfNeeded();

      expect(service.isAuthenticated()).toBe(true);
      expect(strategy.isAuthenticated).toHaveBeenCalled();
    });

    it("returns false when the cached strategy reports its session has expired", async () => {
      const strategy = createStrategyStub();
      strategy.isAuthenticated.mockReturnValue(false);
      const service = new AuthStrategyService(createAuthConfigStub(strategy), {});

      await service.authenticateIfNeeded();

      expect(service.isAuthenticated()).toBe(false);
    });
  });

  describe("authenticateIfNeeded()", () => {
    it("skips performAuthenticate when already authenticated (skip-when-authed AC)", async () => {
      const strategy = createStrategyStub();
      const authConfig = createAuthConfigStub(strategy);
      const service = new AuthStrategyService(authConfig, {});

      // First call performs the handshake and caches a valid strategy.
      await service.authenticateIfNeeded();
      expect(authConfig.authenticate).toHaveBeenCalledTimes(1);

      // Subsequent call must short-circuit — strategy already authenticated.
      await service.authenticateIfNeeded();
      expect(authConfig.authenticate).toHaveBeenCalledTimes(1);
    });

    it("re-authenticates when the cached strategy reports it is no longer authenticated", async () => {
      const strategy = createStrategyStub();
      const authConfig = createAuthConfigStub(strategy);
      const service = new AuthStrategyService(authConfig, {});

      await service.authenticateIfNeeded();
      expect(authConfig.authenticate).toHaveBeenCalledTimes(1);

      // Simulate token expiry — next call must trigger a fresh handshake.
      strategy.isAuthenticated.mockReturnValue(false);
      await service.authenticateIfNeeded();
      expect(authConfig.authenticate).toHaveBeenCalledTimes(2);
    });

    it("forwards the configured client to authConfig.authenticate", async () => {
      const strategy = createStrategyStub();
      const authConfig = createAuthConfigStub(strategy);
      const client = { iAm: "the-rest-client" };
      const service = new AuthStrategyService(authConfig, client);

      await service.authenticateIfNeeded();

      expect(authConfig.authenticate).toHaveBeenCalledWith(client);
    });

    it("coalesces concurrent calls into exactly ONE authConfig.authenticate invocation (single-flight AC)", async () => {
      const strategy = createStrategyStub();
      const authenticateMock: jest.Mock<Promise<AuthStrategy>, [unknown]> = jest.fn(
        async (_client: unknown): Promise<AuthStrategy> => {
          // 50ms delay guarantees the second concurrent call lands while the
          // first call is still in flight, so @DeduplicateInflight must
          // collapse them onto the same promise.
          await delay(50);
          return strategy;
        },
      );
      const authConfig: AuthConfigStub = { authenticate: authenticateMock };
      const service = new AuthStrategyService(authConfig, {});

      const [first, second] = await Promise.all([
        service.authenticateIfNeeded(),
        service.authenticateIfNeeded(),
      ]);

      expect(first).toBeUndefined();
      expect(second).toBeUndefined();
      expect(authConfig.authenticate).toHaveBeenCalledTimes(1);
      expect(service.isAuthenticated()).toBe(true);
    });

    it("clears the inflight entry after authentication completes so the next post-clear call can re-auth", async () => {
      const strategy = createStrategyStub();
      const authConfig = createAuthConfigStub(strategy);
      const service = new AuthStrategyService(authConfig, {});

      await service.authenticateIfNeeded();

      // The DeduplicateInflight contract removes the key in `finally`.
      expect(service.inflightMap.size).toBe(0);
    });
  });

  describe("extendRequest()", () => {
    it("delegates to the cached strategy's extendRequest when authenticated", async () => {
      const strategy = createStrategyStub();
      const service = new AuthStrategyService(createAuthConfigStub(strategy), {});
      await service.authenticateIfNeeded();

      const inputConfig: AxiosRequestConfig = { headers: { foo: "bar" } };
      const extended = service.extendRequest(inputConfig);

      expect(strategy.extendRequest).toHaveBeenCalledTimes(1);
      expect(strategy.extendRequest).toHaveBeenCalledWith(inputConfig);
      expect(extended).toEqual({
        headers: { foo: "bar", Authorization: "Bearer X" },
      });
    });

    it("returns the input config untouched when no auth handle has been acquired (documented semantic)", () => {
      const strategy = createStrategyStub();
      const service = new AuthStrategyService(createAuthConfigStub(strategy), {});

      const inputConfig: AxiosRequestConfig = { url: "/u", headers: { foo: "bar" } };
      const result = service.extendRequest(inputConfig);

      // Identity guarantee: the strategy wasn't consulted, and the config
      // came back exactly as given (no headers added, no fields removed).
      expect(result).toBe(inputConfig);
      expect(strategy.extendRequest).not.toHaveBeenCalled();
    });
  });

  describe("clearAuth()", () => {
    it("resets authResult so a subsequent isAuthenticated() returns false", async () => {
      const strategy = createStrategyStub();
      const service = new AuthStrategyService(createAuthConfigStub(strategy), {});
      await service.authenticateIfNeeded();
      expect(service.isAuthenticated()).toBe(true);

      service.clearAuth();

      expect(service.isAuthenticated()).toBe(false);
    });

    it("forces the next authenticateIfNeeded() to perform a fresh authConfig.authenticate call", async () => {
      const strategy = createStrategyStub();
      const authConfig = createAuthConfigStub(strategy);
      const service = new AuthStrategyService(authConfig, {});
      await service.authenticateIfNeeded();
      expect(authConfig.authenticate).toHaveBeenCalledTimes(1);

      service.clearAuth();
      await service.authenticateIfNeeded();

      expect(authConfig.authenticate).toHaveBeenCalledTimes(2);
    });

    it("after clearAuth, extendRequest reverts to the no-handle behavior of returning config untouched", async () => {
      const strategy = createStrategyStub();
      const service = new AuthStrategyService(createAuthConfigStub(strategy), {});
      await service.authenticateIfNeeded();

      service.clearAuth();
      const inputConfig: AxiosRequestConfig = { url: "/u" };
      const result = service.extendRequest(inputConfig);

      expect(result).toBe(inputConfig);
    });
  });
});
