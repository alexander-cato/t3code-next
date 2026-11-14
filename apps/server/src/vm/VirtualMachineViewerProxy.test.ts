import { expect, it } from "@effect/vitest";
import * as NodeVM from "node:vm";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpRouter, HttpServerRequest } from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as VirtualMachineService from "./VirtualMachineService.ts";
import * as VirtualMachineViewerProxy from "./VirtualMachineViewerProxy.ts";

const { makeWebSocket } = vi.hoisted(() => ({ makeWebSocket: vi.fn() }));
vi.mock("@effect/platform-node/NodeWS", () => ({
  layerWebSocketConstructor: Layer.succeed(Socket.WebSocketConstructor, makeWebSocket),
}));

const fixture = () => {
  const requests: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, headers: request.headers });
      return HttpClientResponse.fromWeb(
        request,
        new Response("guest", {
          headers: {
            "content-type": "text/html",
            "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
            "set-cookie": "guest=secret",
          },
        }),
      );
    }),
  );
  const server = HttpRouter.toWebHandler(
    VirtualMachineViewerProxy.layer.pipe(
      Layer.provideMerge(
        Layer.mock(VirtualMachineService.VirtualMachineService)({
          viewerLifetime: () => Effect.never,
          viewerUpstream: (id) =>
            Effect.succeed(id === "issued-lease" ? "http://192.168.64.2:3211" : null),
        }),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
    ),
    { disableLogger: true },
  );
  return { ...server, requests, [Symbol.asyncDispose]: server.dispose };
};

it("rejects unknown viewer leases and routes outside the guest viewer protocol", async () => {
  await using server = fixture();
  const expired = await server.handler(new Request("http://t3.test/api/vm-viewer/unknown/viewer/"));
  expect(expired.status).toBe(401);
  for (const path of ["mcp", "lume/vms", "cua.env.v1.DriverService/CallTool"]) {
    const response = await server.handler(
      new Request(`http://t3.test/api/vm-viewer/issued-lease/${path}`),
    );
    expect(response.status).toBe(404);
  }
  expect(server.requests).toEqual([]);
});

it("forwards guest authorization, strips environment credentials, and allows remote embedding", async () => {
  await using server = fixture();
  const response = await server.handler(
    new Request("http://t3.test/api/vm-viewer/issued-lease/viewer/", {
      headers: {
        cookie: "t3=private",
        authorization: "Bearer t3-secret",
        dpop: "proof",
        "x-cua-env-authorization": "Bearer guest-view-ticket",
      },
    }),
  );
  expect(await response.text()).toContain("guest");
  expect(server.requests[0]?.url).toBe("http://192.168.64.2:3211/viewer/");
  expect(server.requests[0]?.headers).toMatchObject({
    "x-cua-env-authorization": "Bearer guest-view-ticket",
  });
  expect(server.requests[0]?.headers).not.toHaveProperty("cookie");
  expect(server.requests[0]?.headers).not.toHaveProperty("authorization");
  expect(server.requests[0]?.headers).not.toHaveProperty("dpop");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors *");
  expect(response.headers.get("content-security-policy")).toContain("t3code: t3code-dev:");
  expect(response.headers.get("content-security-policy")).toContain("t3code-fork:");
  expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
  expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
  expect(response.headers.get("access-control-allow-origin")).toBe("null");
  expect(response.headers.get("cache-control")).toContain("no-transform");
});

it("answers opaque-origin preflights without forwarding them to the guest", async () => {
  await using server = fixture();
  const response = await server.handler(
    new Request("http://t3.test/api/vm-viewer/issued-lease/cua.env.v1.StreamService/OpenMedia", {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-cua-env-authorization,content-type",
      },
    }),
  );
  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe("null");
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  expect(response.headers.get("access-control-allow-headers")).toContain("x-cua-env-authorization");
  expect(server.requests).toEqual([]);
});

it("adds an isolated connection-status bridge to the guest viewer", async () => {
  await using server = fixture();
  const script = await server.handler(
    new Request("http://t3.test/api/vm-viewer/issued-lease/viewer/t3-status.js"),
  );
  expect(script.headers.get("content-type")).toContain("javascript");
  const source = await script.text();
  expect(source).toContain("t3-vm-viewer-status");
  const postMessage = vi.fn();
  const setProperty = vi.fn();
  const listeners = new Map<string, (event: unknown) => void>();
  const nativeWindow: Record<string, unknown> = {
    ReactNativeWebView: { postMessage },
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
  };
  nativeWindow.parent = nativeWindow;
  NodeVM.runInNewContext(source, {
    window: nativeWindow,
    document: {
      getElementById: () => ({
        dataset: { status: "streaming" },
        querySelector: (selector: string) =>
          selector === ".cua-stage canvas" ? { width: 1024, height: 768 } : null,
      }),
      createElement: () => ({}),
      head: { append: () => {} },
      documentElement: { style: { setProperty }, toggleAttribute: () => {} },
    },
    MutationObserver: class {
      observe() {}
    },
  });
  expect(postMessage.mock.calls.map(([data]) => JSON.parse(data))).toEqual([
    { type: "t3-vm-viewer-theme-request" },
    { type: "t3-vm-viewer-status", status: "streaming" },
    { type: "t3-vm-viewer-size", width: 1024, height: 768 },
  ]);
  listeners.get("message")?.({
    source: nativeWindow,
    data: { type: "t3-vm-viewer-theme", tokens: { background: "#123456" } },
  });
  expect(setProperty).toHaveBeenCalledWith("--t3-background", "#123456");
  expect(server.requests).toEqual([]);
  const viewer = await server.handler(
    new Request("http://t3.test/api/vm-viewer/issued-lease/viewer/"),
  );
  expect(await viewer.text()).toContain('src="./t3-status.js"');
  expect(viewer.headers.get("content-security-policy")).not.toContain("allow-same-origin");
});

class ViewerSocket implements Socket.WebSocketLike {
  readyState = 1;
  readonly listening = Promise.withResolvers<void>();
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  readonly listeners = new Map<string, Set<(event: Socket.WebSocketEvent) => void>>();
  addEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) {
    let listeners = this.listeners.get(type);
    if (!listeners) this.listeners.set(type, (listeners = new Set()));
    listeners.add(listener);
    if (type === "close") this.listening.resolve();
  }
  removeEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  close(code?: number, reason?: string) {
    this.closes.push({ code, reason });
    this.readyState = 2;
  }
  send() {}
  emitClose(code: number, reason: string) {
    this.readyState = 3;
    for (const listener of this.listeners.get("close") ?? []) listener({ code, reason });
  }
}

it.effect.each([
  [1000, 1000],
  [1001, 1001],
  [1011, 1011],
  [4401, 4401],
  [1004, 1011],
  [1005, 1011],
  [1006, 1011],
  [1015, 1011],
  [2999, 1011],
  [5000, 1011],
] as const)(
  "handles upstream close %s before the upgraded socket scope tears down",
  ([code, expectedCode]) =>
    Effect.gen(function* () {
      const guest = new ViewerSocket();
      const client = new ViewerSocket();
      makeWebSocket.mockReset().mockReturnValue(guest);
      const run = Effect.gen(function* () {
        const socket = yield* Socket.fromWebSocket(
          Effect.acquireRelease(Effect.succeed(client), (ws) => Effect.sync(() => ws.close(1011))),
        );
        const request = HttpServerRequest.fromWeb(
          new Request("http://t3.test/api/vm-viewer/lease/media?ticket=guest-ticket", {
            headers: { upgrade: "websocket" },
          }),
        );
        Object.defineProperty(request, "upgrade", { value: Effect.succeed(socket) });
        const handler = yield* HttpRouter.toHttpEffect(VirtualMachineViewerProxy.layer);
        return yield* handler.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Unexpected HTTP request")),
          ),
          Effect.provide(
            Layer.mock(VirtualMachineService.VirtualMachineService)({
              viewerUpstream: () => Effect.succeed("http://guest.test/"),
              viewerLifetime: () => Effect.never,
            }),
          ),
        );
      }).pipe(Effect.scoped);
      const fiber = yield* Effect.forkScoped(run);
      yield* Effect.raceFirst(
        Effect.promise(() => Promise.all([guest.listening.promise, client.listening.promise])),
        Fiber.join(fiber),
      );
      guest.emitClose(code, "renew media ticket");
      yield* Fiber.join(fiber);
      expect(client.closes[0]).toEqual({
        code: expectedCode,
        reason: expectedCode === code ? "renew media ticket" : undefined,
      });
    }).pipe(Effect.scoped),
);

it.effect("revokes an active HTTP stream and aborts the upstream request", () =>
  Effect.gen(function* () {
    const revoked = yield* Deferred.make<void>();
    const delivered = yield* Deferred.make<void>();
    let signal: AbortSignal | undefined;
    const http = HttpClient.make((request, _url, requestSignal) => {
      signal = requestSignal;
      const response = HttpClientResponse.fromWeb(request, new Response());
      Object.defineProperty(response, "stream", {
        value: Stream.concat(Stream.succeed(Uint8Array.of(1, 2, 3)), Stream.never),
      });
      return Effect.succeed(response);
    });
    const handler = yield* HttpRouter.toHttpEffect(VirtualMachineViewerProxy.layer);
    const response = yield* handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("http://t3.test/api/vm-viewer/lease/files/test")),
      ),
      Effect.provide(
        Layer.mock(VirtualMachineService.VirtualMachineService)({
          viewerUpstream: () => Effect.succeed("http://guest.test/"),
          viewerLifetime: () => Deferred.await(revoked),
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, http),
    );
    expect(signal?.aborted).toBe(false);
    if (response.body._tag !== "Stream") throw new Error("Expected a streaming response");
    const fiber = yield* response.body.stream.pipe(
      Stream.tap(() => Deferred.succeed(delivered, undefined)),
      Stream.orDie,
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(delivered);
    yield* Deferred.succeed(revoked, undefined);
    expect(yield* Fiber.join(fiber)).toEqual([Uint8Array.of(1, 2, 3)]);
    expect(signal?.aborted).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect.each(["headers", "html"])(
  "revokes a viewer waiting for upstream %s and aborts its scope",
  (phase) =>
    Effect.gen(function* () {
      const revoked = yield* Deferred.make<void>();
      const reading = yield* Deferred.make<void>();
      const aborted = yield* Deferred.make<void>();
      let subscribed = false;
      let signal: AbortSignal | undefined;
      const http = HttpClient.make((request, _url, requestSignal) => {
        signal = requestSignal;
        signal.addEventListener("abort", () => Deferred.doneUnsafe(aborted, Effect.void));
        const response = HttpClientResponse.fromWeb(
          request,
          new Response("guest", {
            headers: { "content-type": "text/html" },
          }),
        );
        if (phase === "html")
          Object.defineProperty(response, "text", {
            value: Effect.andThen(Deferred.succeed(reading, undefined), Effect.never),
          });
        return phase === "headers"
          ? Effect.andThen(Deferred.succeed(reading, undefined), Effect.never)
          : Effect.succeed(response);
      });
      const handler = yield* HttpRouter.toHttpEffect(VirtualMachineViewerProxy.layer);
      const fiber = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request("http://t3.test/api/vm-viewer/lease/viewer/")),
        ),
        Effect.provide(
          Layer.mock(VirtualMachineService.VirtualMachineService)({
            viewerUpstream: () => Effect.succeed("http://guest.test/"),
            viewerLifetime: () => {
              subscribed = true;
              return Deferred.await(revoked);
            },
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.forkScoped,
      );
      yield* Effect.raceFirst(Deferred.await(reading), Fiber.join(fiber));
      expect(subscribed).toBe(true);
      yield* Deferred.succeed(revoked, undefined);
      const response = yield* Fiber.join(fiber);
      expect(response.status).toBe(401);
      expect(signal?.aborted).toBe(true);
      yield* Deferred.await(aborted);
    }).pipe(Effect.scoped),
);
