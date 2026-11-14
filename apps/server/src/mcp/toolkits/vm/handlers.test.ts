import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  VirtualMachineError,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import { McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as VirtualMachineService from "../../../vm/VirtualMachineService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("vm-mcp-test");
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("vm-test-environment"),
  requestNamespace: "vm-mcp-session",
  thread: {
    threadId,
    providerSessionId: "vm-mcp-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["device"]),
  issuedAt: 0,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "vm-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vm-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
// VM tools register only on Apple silicon hosts.
const appleSilicon = Layer.mergeAll(
  Layer.succeed(HostProcess.Platform, "darwin"),
  Layer.succeed(HostProcess.Architecture, "arm64"),
);
// VMs are driven through the device tools and the VM-specific tools together.
const mockVirtualMachines = Layer.mock(VirtualMachineService.VirtualMachineService);
const layerWithVirtualMachines = (vms: Layer.Layer<VirtualMachineService.VirtualMachineService>) =>
  Layer.mergeAll(McpHttpServer.layerVmToolkit, McpHttpServer.layerDeviceToolkit).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provide(appleSilicon),
    Layer.provide(vms),
    Layer.provideMerge(ServerSettings.layerTest({ enableAgentDeviceAccess: true })),
    Layer.provide(
      Layer.mock(DeviceService.DeviceService)({
        list: Effect.succeed({
          hostStatus: "disabled",
          hostStatuses: {},
          hosts: [],
          devices: [],
          sessions: [],
          onboardingCompleted: false,
          agentAccessEnabled: true,
          hubBasePath: "/api/device-hub",
          revision: 0,
        }),
        close: () => Effect.void,
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-vm-toolkit-test-" })),
    Layer.provide(NodeServices.layer),
  );
const vmState = {
  enabled: true,
  available: true,
  unavailableReason: null,
  machines: [{ name: "native-tile", status: "ready" }],
  sessions: [{ name: "native-tile", threadId }],
  operations: [],
};
const guest = {
  macos: "26.5.2",
  cpu: 4,
  memoryGb: 8,
  diskFreeGb: 117,
  user: "lume",
  xcode: null,
  swift: "Swift 6.3.3",
  homebrew: false,
  sipEnabled: false,
  passwordlessSudo: false,
};
const hostInventory = {
  runningLimit: 2,
  machines: [
    { name: "native-tile", status: "running", cpu: 4, memoryGb: 8, managed: true },
    { name: "ci-base", status: "stopped", cpu: 12, memoryGb: 16, managed: false },
  ],
};
const encodeResult = Schema.encodeEffect(Schema.toCodecJson(McpSchema.CallToolResult));
const decodeGuestResult = Schema.decodeUnknownSync(McpSchema.CallToolResult);
const decodeGuestTools = Schema.decodeUnknownSync(Schema.Array(McpSchema.Tool));
const wireContent = [
  { type: "text", text: "mouse moved" },
  { type: "image", data: "AQID", mimeType: "image/png" },
  {
    type: "resource",
    resource: { uri: "guest:///result", text: "guest resource", mimeType: "text/plain" },
  },
  {
    type: "resource",
    resource: { uri: "guest:///binary", blob: "BAUG", mimeType: "application/octet-stream" },
  },
];

it.effect.each([false, true])(
  "forwards the guest MCP result with isError=%s through tools/call",
  (isError) => {
    let calls = 0;
    const guest = new McpSchema.CallToolResult({
      ...decodeGuestResult({
        content: wireContent,
        structuredContent: { position: { x: 10, y: 20 } },
        isError,
      }),
      _meta: undefined,
    });
    const layer = McpHttpServer.layerVmToolkit.pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provide(appleSilicon),
      Layer.provide(ServerSettings.layerTest({ enableAgentDeviceAccess: true })),
      Layer.provide(
        Layer.mock(VirtualMachineService.VirtualMachineService)({
          control: () =>
            Effect.sync(() => {
              calls++;
              return guest;
            }),
        }),
      ),
    );
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server.callTool({
        name: "vm_control",
        arguments: { name: "native-tile", tool: "move_mouse", arguments: { x: 10, y: 20 } },
      });
      const encoded = yield* encodeResult(result);
      expect(calls).toBe(1);
      expect(encoded).toMatchObject({
        content: wireContent,
        structuredContent: { position: { x: 10, y: 20 } },
        isError,
      });
    }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(layer),
    );
  },
);

it.effect("encodes decoded guest tool schemas as public MCP JSON", () => {
  const tools = decodeGuestTools([
    {
      name: "move_mouse",
      inputSchema: { type: "object", properties: { x: { type: "number" } } },
      annotations: { readOnlyHint: false },
    },
  ]).map(
    (tool) =>
      new McpSchema.Tool({
        ...tool,
        description: undefined,
        annotations: { ...tool.annotations, title: undefined },
      }),
  );
  const layer = McpHttpServer.layerVmToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provide(appleSilicon),
    Layer.provide(ServerSettings.layerTest({ enableAgentDeviceAccess: true })),
    Layer.provide(
      Layer.mock(VirtualMachineService.VirtualMachineService)({
        tools: () => Effect.succeed(tools),
      }),
    ),
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    // Without names the reply is a short index; schemas come only for the tools asked for.
    const index = yield* server.callTool({ name: "vm_tools", arguments: { name: "native-tile" } });
    expect(index.structuredContent).toEqual({ tools: [{ name: "move_mouse" }] });
    const none = yield* server.callTool({
      name: "vm_tools",
      arguments: { name: "native-tile", tools: ["hotkey"] },
    });
    expect(none.structuredContent).toEqual([]);
    const result = yield* server.callTool({
      name: "vm_tools",
      arguments: { name: "native-tile", tools: ["move_mouse"] },
    });
    const encoded = yield* encodeResult(result);
    expect(encoded).toMatchObject({
      isError: false,
      structuredContent: [
        {
          name: "move_mouse",
          inputSchema: { type: "object", properties: { x: { type: "number" } } },
          annotations: { readOnlyHint: false },
        },
      ],
    });
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provide(layer),
  );
});

it.effect.each(["vm_control", "device_screenshot"] as const)(
  "%s tells the agent why the VM call failed",
  (tool) => {
    const notOpen = new VirtualMachineError({ operation: "control", reason: "not-open" });
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server.callTool({
        name: tool,
        arguments:
          tool === "vm_control"
            ? { name: "native-tile", tool: "click", arguments: {} }
            : { virtualMachine: "native-tile" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: notOpen.message }]);
    }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(
        layerWithVirtualMachines(
          mockVirtualMachines({
            control: () => Effect.fail(notOpen),
            screenshot: () => Effect.fail(notOpen),
          }),
        ),
      ),
    );
  },
);

it.effect("lists, opens, and closes VMs through the device tools", () => {
  const calls: Array<string> = [];
  let others = 2;
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const listed = yield* server.callTool({ name: "device_list", arguments: {} });
    expect(listed.structuredContent).toMatchObject({
      devices: [],
      virtualMachines: {
        enabled: true,
        machines: vmState.machines,
        open: ["native-tile"],
        guests: { "native-tile": guest },
        openInOtherThreads: { "native-tile": 2 },
        host: hostInventory,
      },
    });
    const opened = yield* server.callTool({
      name: "device_open",
      arguments: { virtualMachine: "native-tile" },
    });
    expect(opened.structuredContent).toMatchObject({
      virtualMachine: "native-tile",
      guest,
      otherThreads: 2,
    });
    const quickStart = (opened.structuredContent as { quickStart: string }).quickStart;
    // The agent has to learn before planning that this guest cannot build an Xcode project.
    expect(quickStart).toContain("macOS 26.5.2");
    expect(quickStart).toContain("No Xcode is installed");
    expect(quickStart).toContain("2 other threads have this VM open");
    // Suspending would end the two other threads' sessions, so the agent may only close its own.
    const refused = yield* server.callTool({
      name: "device_close",
      arguments: { virtualMachine: "native-tile", shutdown: true },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("2 other threads have this VM open");
    others = 0;
    yield* server.callTool({
      name: "device_close",
      arguments: { virtualMachine: "native-tile", shutdown: true },
    });
    yield* server.callTool({ name: "device_close", arguments: {} });
    expect(calls).toEqual([
      `open native-tile ${threadId}`,
      "stop native-tile",
      "close native-tile",
    ]);
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provide(
      layerWithVirtualMachines(
        mockVirtualMachines({
          state: Effect.succeed(vmState),
          list: Effect.succeed({
            ...vmState,
            sessions: [
              ...vmState.sessions,
              { name: "native-tile", threadId: ThreadId.make("parent") },
              { name: "native-tile", threadId: ThreadId.make("sibling") },
            ],
          }),
          knownGuests: Effect.succeed({ "native-tile": guest }),
          hostInventory: Effect.succeed(hostInventory),
          inspect: () => Effect.succeed(guest),
          otherSessions: () => Effect.sync(() => others),
          open: (input) =>
            Effect.sync(() => {
              calls.push(`open ${input.name} ${input.threadId}`);
              return { name: input.name, viewerPath: "/viewer", expiresInMs: 60_000 };
            }),
          stop: (name) => Effect.sync(() => void calls.push(`stop ${name}`)),
          close: (input) => Effect.sync(() => void calls.push(`close ${input.name}`)),
        }),
      ),
    ),
  );
});

it.effect.each([
  ["vm_exec", { name: "native-tile", command: "id" }],
  ["vm_job", { name: "native-tile", jobId: "0123456789ab" }],
  ["vm_download", { name: "native-tile", guestPath: "/tmp/a.log", relativePath: "a.log" }],
  ["vm_control", { name: "native-tile", tool: "click", arguments: {} }],
  ["vm_delete", { name: "native-tile" }],
  ["vm_create", { name: "native-tile", cpu: 4, memoryGb: 8 }],
  ["vm_upload", { name: "native-tile", relativePath: "app.zip", guestPath: "/tmp/app.zip" }],
  ["vm_tools", { name: "native-tile" }],
  ["device_list", {}],
  ["device_open", { virtualMachine: "native-tile" }],
  ["device_screenshot", { virtualMachine: "native-tile" }],
  ["device_close", { virtualMachine: "native-tile" }],
] as const)("%s requires captured and current Agent device access", ([name, args]) => {
  let calls = 0;
  const called = Effect.sync(() => {
    calls++;
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const settings = yield* ServerSettings.ServerSettingsService;
    const call = server.callTool({ name, arguments: args });
    expect((yield* call).isError).toBe(false);
    expect(calls).toBe(1);

    yield* settings.updateSettings({ enableAgentDeviceAccess: false });
    const denied = yield* call;
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("Agent device access is turned off");
    expect(calls).toBe(1);

    yield* settings.updateSettings({ enableAgentDeviceAccess: true });
    const uncaptured = yield* call.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...invocation,
        capabilities: new Set<McpInvocationContext.McpCapability>(),
      }),
    );
    expect(uncaptured.isError).toBe(true);
    expect(calls).toBe(1);
    expect((yield* call).isError).toBe(false);
    expect(calls).toBe(2);
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provide(
      layerWithVirtualMachines(
        mockVirtualMachines({
          state: Effect.succeed(vmState),
          list: called.pipe(Effect.as(vmState)),
          create: () => called,
          remove: () => called,
          upload: () => called,
          exec: () => called.pipe(Effect.as({ stdout: "", stderr: "", exitCode: 0 })),
          job: () =>
            called.pipe(
              Effect.as({ state: "running" as const, exitCode: null, output: "", logPath: "/l" }),
            ),
          download: () => called.pipe(Effect.as({ bytes: 1 })),
          knownGuests: Effect.succeed({}),
          hostInventory: Effect.succeed(hostInventory),
          inspect: () => Effect.succeed(null),
          otherSessions: () => Effect.succeed(0),
          tools: () => called.pipe(Effect.as([])),
          control: () => called.pipe(Effect.as(decodeGuestResult({ content: [], isError: false }))),
          open: () =>
            called.pipe(
              Effect.as({ name: "native-tile", viewerPath: "/viewer", expiresInMs: 60_000 }),
            ),
          screenshot: () =>
            called.pipe(
              Effect.as({
                name: "native-tile",
                screenshot: { mimeType: "image/png", data: "AQID", width: 1, height: 1 },
              }),
            ),
          close: () => called,
        }),
      ),
    ),
  );
});
