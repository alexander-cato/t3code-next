import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as VirtualMachineService from "./VirtualMachineService.ts";

const allowedPath =
  /^\/(?:viewer\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]*|media|files(?:\/[^?#]*)?|cua\.env\.v1\.(?:System|Stream|Computer|Filesystem|Presence)Service\/[a-zA-Z]+)$/;

// Cua 0.4 exposes connection state on #app, but has no embedding event API.
// Status and frame size cross the opaque-origin boundary; the parent validates the source window.
// The web client draws its own controls, so Cua's toolbar shows only in the native app.
const viewerStatusScript = `
(() => {
const native = typeof window.ReactNativeWebView?.postMessage === "function" ? window.ReactNativeWebView : null;
if (window.parent === window && !native) return;
const post = (message) => native
  ? native.postMessage(JSON.stringify(message))
  : window.parent.postMessage(message,"*");
const app = document.getElementById("app");
let previous;
let size;
let railAdded = false;
const style = document.createElement("style");
// Presence assigns participant colors starting with red. Keep the reported cursor
// shape and hotspot, but use ordinary pointer colors in the embedded viewer.
style.textContent = \`
.presence-cursor-art svg path { fill:#000; stroke:#fff; }
:root:not([data-t3-native]) .cua-toolbar { display:none!important; }
:root[data-t3-native] { --t3-railWidth:72px; --t3-buttonSize:44px; }
:root[data-t3-native] .cua-stage { width:calc(100% - var(--t3-railWidth))!important; }
.cua-t3-rail { box-sizing:border-box; position:absolute; inset:0 0 0 auto; z-index:10; display:flex; width:var(--t3-railWidth); flex-direction:column; align-items:center; gap:8px; justify-content:safe center; overflow-y:auto; padding:12px 8px 12px 0; background:var(--t3-background); pointer-events:none; scrollbar-width:none; }
.cua-t3-rail .cua-toolbar { box-sizing:border-box!important; position:static!important; inset:auto!important; transform:none!important; display:flex!important; flex:none!important; flex-direction:column!important; align-items:center!important; width:auto!important; min-width:0!important; max-height:none!important; padding:8px!important; gap:4px!important; border:1px solid color-mix(in oklab,var(--t3-border) 50%,transparent)!important; border-radius:9999px!important; background:color-mix(in oklab,var(--t3-background) 80%,transparent)!important; color:var(--t3-foreground)!important; box-shadow:0 1px 3px 0 rgb(0 0 0 / .1),0 1px 2px -1px rgb(0 0 0 / .1)!important; opacity:1!important; filter:none!important; backdrop-filter:none!important; pointer-events:auto; }
.cua-t3-rail .cua-handle { display:none!important; }
.cua-t3-rail .cua-menu { display:flex!important; flex-direction:column!important; align-items:center!important; gap:4px!important; padding:0!important; }
.cua-t3-rail .cua-btn { box-sizing:border-box!important; position:relative; display:inline-flex; flex:none!important; align-items:center; justify-content:center; width:var(--t3-buttonSize)!important; height:var(--t3-buttonSize)!important; min-width:0!important; padding:0!important; border:1px solid transparent!important; border-radius:var(--t3-controlRadius)!important; background:transparent!important; color:var(--t3-icon)!important; box-shadow:none!important; outline:none; cursor:pointer; transition:box-shadow .15s,scale .15s!important; }
.cua-t3-rail .cua-btn[hidden] { display:none!important; }
.cua-t3-rail .cua-btn:is([aria-pressed="true"],.on,.active,.is-active) { background:var(--t3-secondary)!important; color:var(--t3-secondaryForeground)!important; }
.cua-t3-rail .cua-btn:active:not(:disabled) { scale:.97; }
.cua-t3-rail .cua-btn:disabled { pointer-events:none; opacity:.64; }
.cua-t3-rail .cua-btn svg { width:16px!important; height:16px!important; stroke-width:2; pointer-events:none; flex-shrink:0; }
.cua-t3-rail .cua-popover { box-sizing:border-box!important; position:fixed!important; left:auto!important; right:calc(var(--t3-railWidth) + 8px)!important; top:12px!important; transform:none!important; min-width:min(160px,calc(100vw - var(--t3-railWidth) - 20px))!important; max-width:calc(100vw - var(--t3-railWidth) - 20px)!important; max-height:calc(100dvh - 24px)!important; overflow:auto!important; background:var(--t3-popover)!important; color:var(--t3-popoverForeground)!important; border-color:var(--t3-border)!important; border-radius:var(--t3-tooltipRadius)!important; }
.cua-t3-rail .cua-item { min-height:var(--t3-buttonSize); color:var(--t3-popoverForeground); }
\`;
document.head.append(style);
document.documentElement.toggleAttribute("data-t3-native", Boolean(native));
// The host resolves its theme variables, which cannot cross the opaque iframe origin through CSS.
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.data?.type !== "t3-vm-viewer-theme") return;
  const tokens = event.data.tokens;
  if (!tokens || typeof tokens !== "object") return;
  for (const key of ["background","foreground","border","secondary","secondaryForeground","icon","popover","popoverForeground","controlRadius","tooltipRadius"]) {
    if (typeof tokens[key] === "string") document.documentElement.style.setProperty("--t3-" + key, tokens[key]);
  }
});
post({ type:"t3-vm-viewer-theme-request" });
const addRail = () => {
  const toolbar = app?.querySelector(".cua-toolbar");
  if (!native || !toolbar || railAdded) return;
  railAdded = true;
  const rail = document.createElement("aside");
  rail.className = "cua-t3-rail";
  rail.setAttribute("aria-label","Virtual machine controls");
  toolbar.before(rail);
  rail.append(toolbar);
};
const reportSize = () => {
  const canvas = app?.querySelector(".cua-stage canvas");
  if (!canvas?.width || !canvas.height || canvas.width + "x" + canvas.height === size) return;
  size = canvas.width + "x" + canvas.height;
  post({ type:"t3-vm-viewer-size", width:canvas.width, height:canvas.height });
};
const report = () => {
  addRail();
  const status = app?.dataset.status;
  if (!["connecting", "reconnecting", "streaming", "failed"].includes(status) || status === previous) return;
  previous = status;
  post({ type: "t3-vm-viewer-status", status });
};
if (app) {
  new MutationObserver(report).observe(app, { attributes: true, attributeFilter: ["data-status"] });
  new MutationObserver(reportSize).observe(app, { subtree: true, childList: true, attributes: true, attributeFilter: ["width","height"] });
}
report();
reportSize();
})();
`;

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400 });
  const tail = url.value.pathname.slice(VirtualMachineService.VM_VIEWER_PREFIX.length + 1);
  const slash = tail.indexOf("/");
  const leaseId = tail.slice(0, slash);
  const upstreamPath = tail.slice(slash);
  if (
    slash < 0 ||
    !allowedPath.test(upstreamPath) ||
    upstreamPath.split("/").some((part) => part === ".." || part === ".")
  )
    return HttpServerResponse.empty({ status: 404 });
  const vms = yield* VirtualMachineService.VirtualMachineService;
  const origin = yield* vms.viewerUpstream(leaseId);
  if (origin === null)
    return HttpServerResponse.text(
      "This VM view expired. Reopen it from the Virtual machine panel.",
      { status: 401 },
    );
  const cors = {
    "access-control-allow-origin": "null",
    "access-control-allow-methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers":
      "content-type, x-cua-env-authorization, x-grpc-web, grpc-timeout, range, x-user-agent",
    "access-control-expose-headers": "grpc-status, grpc-message, content-range, accept-ranges",
  };
  if (request.method === "OPTIONS") return HttpServerResponse.empty({ status: 204, headers: cors });
  if (request.method === "GET" && upstreamPath === "/viewer/t3-status.js")
    return HttpServerResponse.text(viewerStatusScript, {
      headers: { ...cors, "content-type": "text/javascript", "cache-control": "no-store" },
    });
  const upstreamUrl = new URL(upstreamPath.slice(1) + url.value.search, origin);
  const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
  if (upgrade) {
    if (upstreamPath !== "/media") return HttpServerResponse.empty({ status: 404 });
    upstreamUrl.protocol = "ws:";
    const client = yield* request.upgrade;
    const upstream = yield* Socket.makeWebSocket(upstreamUrl.toString(), {
      openTimeout: "10 seconds",
    }).pipe(Effect.provide(NodeWS.layerWebSocketConstructor));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const toClient = yield* client.writer;
        const toUpstream = yield* upstream.writer;
        return yield* Effect.raceFirst(
          Effect.raceFirst(pump(upstream, toClient), pump(client, toUpstream)),
          vms.viewerLifetime(leaseId),
        );
      }),
    ).pipe(Effect.ignoreCause);
    return HttpServerResponse.empty();
  }
  const method = request.method;
  if (
    !HttpMethod.isHttpMethod(method) ||
    !["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"].includes(method)
  )
    return HttpServerResponse.empty({ status: 405 });
  const headers: Record<string, string> = {};
  // Environment cookies and authorization must never reach the guest. The
  // viewer supplies its own guest-scoped authorization in this alternate header.
  for (const name of [
    "content-type",
    "x-cua-env-authorization",
    "x-grpc-web",
    "grpc-timeout",
    "range",
  ]) {
    const value = request.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const httpScope = yield* Scope.fork(yield* Effect.scope);
  const abort = Scope.close(httpScope, Exit.void);
  const response = yield* Effect.raceFirst(
    http
      .execute(
        HttpClientRequest.make(method)(upstreamUrl.toString()).pipe(
          HttpClientRequest.setHeaders(headers),
          request.method === "GET" || request.method === "HEAD"
            ? (self) => self
            : HttpClientRequest.bodyStream(request.stream, {
                contentType: request.headers["content-type"],
              }),
        ),
      )
      .pipe(
        Scope.provide(httpScope),
        Effect.onInterrupt(() => abort),
      ),
    vms.viewerLifetime(leaseId).pipe(Effect.as(null)),
  );
  if (response === null) return HttpServerResponse.empty({ status: 401 });
  const responseHeaders: Record<string, string> = {
    ...cors,
    "cache-control": "no-store, no-transform",
    "referrer-policy": "no-referrer",
  };
  for (const name of [
    "content-type",
    "content-range",
    "accept-ranges",
    "grpc-status",
    "grpc-message",
    "x-content-type-options",
  ]) {
    const value = response.headers[name];
    if (value !== undefined) responseHeaders[name] = value;
  }
  // Enforce isolation ourselves: even a compromised guest cannot choose an
  // origin-bearing sandbox policy and gain access to the environment APIs.
  // HTTP's wildcard ancestor source does not match the custom desktop schemes.
  responseHeaders["content-security-policy"] =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors * t3code: t3code-dev: t3code-fork:; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-downloads allow-pointer-lock";
  if (upstreamPath === "/viewer/" && response.headers["content-type"]?.includes("text/html")) {
    const html = yield* Effect.raceFirst(
      response.text.pipe(Effect.onInterrupt(() => abort)),
      vms.viewerLifetime(leaseId).pipe(Effect.as(null)),
    );
    yield* abort;
    if (html === null) return HttpServerResponse.empty({ status: 401 });
    const bridge = '<script src="./t3-status.js"></script>';
    return HttpServerResponse.text(
      html.includes("</body>") ? html.replace("</body>", `${bridge}</body>`) : html + bridge,
      { status: response.status, headers: responseHeaders },
    );
  }
  return HttpServerResponse.stream(
    response.stream.pipe(Stream.interruptWhen(vms.viewerLifetime(leaseId)), Stream.ensuring(abort)),
    {
      status: response.status,
      headers: responseHeaders,
    },
  );
}).pipe(
  Effect.orElseSucceed(() =>
    HttpServerResponse.text("The VM viewer is unavailable. Reopen the virtual machine.", {
      status: 502,
    }),
  ),
);

// Video and input use a long-lived socket; tracing each frame would dominate it.
const pump = Effect.fnUntraced(
  function* (source: Socket.Socket, sink: Socket.Writer) {
    const { pull } = yield* source.reader;
    while (true) yield* sink.writeAll(yield* pull);
  },
  (effect, _source, sink) =>
    Effect.catchTags(effect, {
      SocketError: (error) => {
        const reason = error.reason;
        // Readers report every close as an error. Send it before the adapter's
        // scope finalizer substitutes its own close code, including ticket expiry.
        if (
          reason._tag === "SocketCloseError" &&
          ((reason.code >= 1000 &&
            reason.code <= 1014 &&
            ![1004, 1005, 1006].includes(reason.code)) ||
            (reason.code >= 3000 && reason.code <= 4999))
        )
          return sink.write(new Socket.CloseEvent(reason.code, reason.closeReason));
        return Effect.fail(error);
      },
    }),
);

export const layer = HttpRouter.add(
  "*",
  `${VirtualMachineService.VM_VIEWER_PREFIX}/*`,
  handler,
).pipe(Layer.provide(HttpRouter.disableLogger));
