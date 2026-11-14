import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";

import * as VirtualMachineService from "./VirtualMachineService.ts";
import * as VirtualMachineViewerProxy from "./VirtualMachineViewerProxy.ts";

it.live("preserves guest media tickets and binary desktop input through the socket proxy", () =>
  Effect.gen(function* () {
    const guest = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeWS.WebSocketServer({ port: 0 })),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const client of server.clients) client.terminate();
              server.close(() => resolve());
            }),
        ),
    );
    if (!guest.address())
      yield* Effect.promise(() => new Promise<void>((resolve) => guest.once("listening", resolve)));
    const address = guest.address();
    if (!address || typeof address === "string") throw new Error("Missing guest port");
    let guestPath: string | undefined;
    guest.on("connection", (socket, request) => {
      guestPath = request.url;
      socket.send(Uint8Array.of(0x83));
      socket.on("message", (data, binary) => socket.send(data, { binary }));
    });
    const revoked = yield* Deferred.make<void>();
    const services = yield* Layer.build(
      HttpRouter.serve(VirtualMachineViewerProxy.layer, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(
          Layer.mock(VirtualMachineService.VirtualMachineService)({
            viewerLifetime: () => Deferred.await(revoked),
            viewerUpstream: (id) =>
              Effect.succeed(id === "lease" ? `http://127.0.0.1:${address.port}/` : null),
          }),
        ),
      ),
    );
    const origin = HttpServer.formatAddress(
      Context.get(services, HttpServer.HttpServer).address,
    ).replace(/^http/, "ws");
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () => new WebSocket(`${origin}/api/vm-viewer/lease/media?ticket=guest-media-ticket`),
      ),
      (socket) => Effect.sync(() => socket.close()),
    );
    client.binaryType = "arraybuffer";
    const frames: number[][] = [];
    const received = Promise.withResolvers<void>();
    client.addEventListener("error", () => received.reject(new Error("VM proxy failed")));
    client.addEventListener("message", ({ data }) => {
      frames.push(Array.from(new Uint8Array(data as ArrayBuffer)));
      if (frames.length === 1) client.send(Uint8Array.of(0x03, 10, 20));
      else received.resolve();
    });
    yield* Effect.promise(() => received.promise);
    expect(guestPath).toBe("/media?ticket=guest-media-ticket");
    expect(frames).toEqual([[0x83], [0x03, 10, 20]]);
    const closed = Promise.withResolvers<void>();
    client.addEventListener("close", () => closed.resolve(), { once: true });
    yield* Deferred.succeed(revoked, undefined);
    yield* Effect.promise(() => closed.promise);
  }).pipe(Effect.scoped),
);
