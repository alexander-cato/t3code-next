import { SheetCloseButton } from "../../components/ui/SheetHeader";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import {
  deviceToolVersionLabels,
  deviceToolUpdateOwnership,
  deviceToolUpdatePolicy,
} from "@t3tools/client-runtime/state/device";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useEffect, useRef, useState, type RefObject } from "react";
import * as Haptics from "expo-haptics";
import { Accelerometer } from "expo-sensors";
import { Pressable, StatusBar, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { GlassSurface } from "../../components/ui/GlassSurface";
import {
  findAppBarMenuItem,
  menuActionsFromAppBarItems,
} from "../../components/ui/menuActionItems";
import { AppBar } from "../../components/ui/AppBar";
import { useBarOverlap } from "../../components/ui/useBarInset";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { useAppForeground } from "../../lib/appState";
import { useHardwareBack } from "../../lib/backHandler";
import { deriveBottomControlInsets } from "../../lib/reserved-regions";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { uuidv4 } from "../../lib/uuid";
import { deviceEnvironment, useDeviceHubAccess } from "../../state/device";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useVirtualMachineState, virtualMachineEnvironment } from "../../state/virtualMachines";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { VirtualMachinePreview } from "../vm/VirtualMachinePreview";
import { DeviceStreamWebView, type DeviceStreamRef } from "./DeviceStreamWebView";
import {
  selectedThreadDevicePreview,
  threadDevicePreviews,
  type ThreadDevicePreview,
} from "./threadDevicePreviews";

/** A VM preview key names a VM the user asked to open, before its session exists. */
function requestedVirtualMachine(deviceKey: string | undefined) {
  if (deviceKey === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(deviceKey);
    return Array.isArray(parsed) && parsed[0] === "vm" && typeof parsed[1] === "string"
      ? parsed[1]
      : undefined;
  } catch {
    return undefined;
  }
}
import { createShakeDetector } from "./shakeDetector";

const OVERLAY_ENTERING = FadeIn.duration(160).reduceMotion(ReduceMotion.System);
const OVERLAY_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

type DevicePreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly deviceKey?: string;
}>;

export function DevicePreviewRouteScreen({ route }: DevicePreviewRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = () => navigation.goBack();
  const { environmentId, threadId } = route.params;
  const isBlankLink = environmentId.trim().length === 0 || threadId.trim().length === 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops a deep-linked route with a blank environment or thread off the navigator
  useEffect(() => {
    if (isBlankLink) onClose();
  }, [isBlankLink, onClose]);
  if (isBlankLink) return null;
  return (
    <DevicePreviewScreen
      environmentId={EnvironmentId.make(environmentId)}
      threadId={ThreadId.make(threadId)}
      initialDeviceKey={route.params.deviceKey}
      onClose={onClose}
    />
  );
}

export function DevicePreviewScreen({
  environmentId,
  threadId,
  onClose,
  onMaximize,
  initialDeviceKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
  readonly onMaximize?: (deviceKey: string | null) => void;
  readonly initialDeviceKey?: string;
}) {
  const embedded = onMaximize !== undefined;
  const insets = useSafeAreaInsets();
  // In a pane the stream sits below the pane's bar, which content otherwise slides under.
  const barOverlap = useBarOverlap();
  // NativeColumnContent already insets the sides, so only a book fold moves the hidden-controls pill.
  const handleBounds = deriveBottomControlInsets(useNativeColumnLayoutMetrics());
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [selectedKey, setSelectedKey] = useState<string | null>(initialDeviceKey ?? null);
  const [inputConnected, setInputConnected] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [shuttingDown, setShuttingDown] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const retryHost = useAtomCommand(deviceEnvironment.list);
  const shutdown = useAtomCommand(deviceEnvironment.shutdown, { reportFailure: false });
  const closeVirtualMachine = useAtomCommand(virtualMachineEnvironment.close, {
    reportFailure: false,
  });
  const suspendVirtualMachine = useAtomCommand(virtualMachineEnvironment.stop, {
    reportFailure: false,
  });
  const streamRef = useRef<DeviceStreamRef>(null);
  const state = useEnvironmentQuery(deviceEnvironment.state({ environmentId, input: {} }));
  const virtualMachines = useVirtualMachineState(environmentId).data;
  const [requested, setRequested] = useState(() => {
    const name = requestedVirtualMachine(initialDeviceKey);
    return name === undefined
      ? undefined
      : {
          name,
          closedSessionId: virtualMachines
            ? (virtualMachines.closedSessions?.find(
                (session) => session.threadId === threadId && session.name === name,
              )?.id ?? null)
            : undefined,
        };
  });
  if (requested && requested.closedSessionId === undefined && virtualMachines) {
    setRequested({
      ...requested,
      closedSessionId:
        virtualMachines.closedSessions?.find(
          (session) => session.threadId === threadId && session.name === requested.name,
        )?.id ?? null,
    });
  }
  const pendingRequest =
    requested?.closedSessionId === undefined
      ? undefined
      : {
          name: requested.name,
          closedSessionId: requested.closedSessionId,
        };
  const previews = threadDevicePreviews(state.data, threadId, virtualMachines, pendingRequest);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- consumes a requested open once the server publishes its running session, closure, or access revocation
  useEffect(() => {
    if (!requested || !virtualMachines) return;
    const closed = virtualMachines.closedSessions?.find(
      (session) => session.threadId === threadId && session.name === requested.name,
    );
    const running = virtualMachines.machines.some(
      (machine) =>
        machine.name === requested.name &&
        (machine.status === "ready" || machine.status === "running"),
    );
    if (
      !virtualMachines.enabled ||
      (closed && closed.id !== requested.closedSessionId) ||
      (running &&
        virtualMachines.sessions.some(
          (session) => session.threadId === threadId && session.name === requested.name,
        ))
    ) {
      // oxlint-disable-next-line react/set-state-in-effect -- Server session publication consumes the route's one-time open request.
      setRequested(undefined);
    }
  }, [requested, virtualMachines, threadId]);
  const preview = selectedThreadDevicePreview(previews, selectedKey);
  const devicePreview = preview?.kind === "device" ? preview : null;
  const onInputConnected = async (connected: boolean) => {
    setInputConnected(connected);
    if (!connected) setControlsVisible(true);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the focused route through the navigator once the thread has no device previews
  useEffect(() => {
    if (
      focused &&
      state.data !== null &&
      (requested === undefined || requested.closedSessionId !== undefined) &&
      previews.length === 0
    )
      onClose();
  }, [focused, state.data, requested, previews.length, onClose]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the Accelerometer while focused to toggle controls on a shake
  useEffect(() => {
    if (!focused || !foreground || embedded) return;
    const shaken = createShakeDetector();
    Accelerometer.setUpdateInterval(50);
    const subscription = Accelerometer.addListener((sample) => {
      if (!shaken({ ...sample, timestamp: sample.timestamp * 1000 })) return;
      void Haptics.selectionAsync();
      setControlsVisible((visible) => !visible);
    });
    return () => subscription.remove();
  }, [focused, foreground, embedded]);
  useHardwareBack(!controlsVisible, () => {
    setControlsVisible(true);
    return true;
  });

  const shutDownDevice = async () => {
    if (!devicePreview || shuttingDown) return;
    setShuttingDown(true);
    const result = await shutdown({
      environmentId,
      input: {
        hostId: devicePreview.session.hostId,
        deviceId: devicePreview.session.deviceId,
        platform: devicePreview.session.platform,
      },
    }).finally(() => setShuttingDown(false));
    if (result._tag === "Failure") {
      Dialog.alert("Could not shut down device", String(Cause.squash(result.cause)));
    }
  };
  // Closing ends this thread's control of the VM; suspending also stops it for every thread.
  const releaseVirtualMachine = async (suspend: boolean) => {
    if (preview?.kind !== "vm" || shuttingDown) return;
    setShuttingDown(true);
    const result = await (
      suspend
        ? suspendVirtualMachine({ environmentId, input: { name: preview.name } })
        : closeVirtualMachine({ environmentId, input: { name: preview.name, threadId } })
    ).finally(() => setShuttingDown(false));
    if (result._tag === "Failure") {
      Dialog.alert(
        suspend ? "Could not suspend virtual machine" : "Could not close virtual machine",
        String(Cause.squash(result.cause)),
      );
      return;
    }
    if (requested?.name === preview.name) setRequested(undefined);
  };
  const virtualMachineControls: AppBarMenuItem[] = [
    {
      id: "reload",
      title: "Reconnect",
      icon: "arrow.clockwise" as const,
      disabled: shuttingDown,
      onPress: () => setStreamAttempt((attempt) => attempt + 1),
    },
    {
      id: "close-vm",
      title: "Close VM view",
      icon: "xmark",
      disabled: shuttingDown,
      onPress: () => void releaseVirtualMachine(false),
    },
    {
      id: "suspend-vm",
      title: shuttingDown ? "Suspending…" : "Suspend VM",
      icon: "power",
      disabled: shuttingDown,
      onPress: () => void releaseVirtualMachine(true),
    },
  ];

  const deviceControls: AppBarMenuItem[] = [
    ...(state.data?.hosts
      .filter(
        (host) =>
          state.data?.supportsHostRetry && state.data.hostStatuses[host.id]?.status === "failed",
      )
      .map((host) => ({
        id: `retry-${host.id}`,
        title: `Retry ${host.label}`,
        icon: "arrow.clockwise" as const,
        onPress: () => {
          void retryHost({ environmentId, input: { retryHostId: host.id } });
        },
      })) ?? []),
    ...(state.data?.supportsToolInspection
      ? [
          {
            id: "check-device-tools",
            title: "Check device tool versions",
            icon: "arrow.clockwise" as const,
            onPress: () => {
              void retryHost({ environmentId, input: { inspectOnly: true } });
            },
          },
        ]
      : []),
    {
      id: "device-tools",
      title: "Device tool versions",
      icon: "info.circle",
      onPress: () =>
        Dialog.alert(
          "Device tool versions",
          deviceToolUpdateOwnership +
            "\n\n" +
            deviceToolUpdatePolicy(
              state.data?.hosts.find((host) => host.id === devicePreview?.session.hostId)?.tools,
            ) +
            "\n\n" +
            deviceToolVersionLabels(
              state.data?.hosts.find((host) => host.id === devicePreview?.session.hostId)?.tools,
            ).join("\n") +
            "\n" +
            (state.data?.hosts.find((host) => host.id === devicePreview?.session.hostId)
              ?.toolInspectionError ??
              state.data?.hostStatuses[devicePreview?.session.hostId ?? ""]?.detail ??
              ""),
        ),
    },
    {
      id: "reload",
      title: "Reload stream",
      icon: "arrow.clockwise" as const,
      disabled: !preview || shuttingDown,
      onPress: () => {
        setInputConnected(false);
        setStreamAttempt((attempt) => attempt + 1);
      },
    },
    ...(devicePreview?.session.platform === "android"
      ? [
          {
            id: "back",
            title: "Back",
            icon: "arrow.left",
            disabled: !inputConnected,
            onPress: () => streamRef.current?.back(),
          },
        ]
      : []),
    {
      id: "app-switcher",
      title: "App switcher",
      icon: "square.on.square",
      disabled: !inputConnected,
      onPress: () => streamRef.current?.appSwitcher(),
    },
    ...(devicePreview?.session.platform === "ios"
      ? [
          {
            id: "rotate",
            title: "Rotate device",
            icon: "arrow.clockwise" as const,
            disabled: !inputConnected,
            onPress: () => streamRef.current?.rotate(),
          },
        ]
      : []),
    {
      id: "shutdown",
      title: shuttingDown ? "Shutting down…" : "Shut down device",
      icon: "power",
      disabled: !preview || shuttingDown,
      onPress: () => void shutDownDevice(),
    },
  ];
  const controls = preview?.kind === "vm" ? virtualMachineControls : deviceControls;
  const pressHome = () => streamRef.current?.home();
  const menuItems: AppBarMenuItem[] = [
    ...(previews.length > 1
      ? [
          {
            id: "devices",
            title: "Devices",
            inline: true,
            items: previews.map((device) => ({
              id: device.key,
              title: device.name,
              subtitle: device.description,
              selected: device.key === preview?.key,
              onPress: () => setSelectedKey(device.key),
            })),
          },
        ]
      : []),
    ...controls,
  ];
  return (
    <View className="flex-1" style={{ backgroundColor: themeVariables["--color-sheet-solid"] }}>
      {!embedded ? <StatusBar hidden animated /> : null}
      {embedded ? (
        <>
          <AppBar
            title={preview?.name ?? "Devices"}
            actions={[
              {
                accessibilityLabel: "Maximize device",
                icon: "arrow.up.left.and.arrow.down.right",
                onPress: () => onMaximize(preview?.key ?? null),
              },
            ]}
          />
          <View style={{ height: barOverlap }} />
        </>
      ) : null}
      {preview?.kind === "vm" && focused && foreground ? (
        <VirtualMachinePreview
          key={`${preview.key}:${streamAttempt}`}
          environmentId={environmentId}
          threadId={threadId}
          name={preview.name}
        />
      ) : devicePreview && focused && foreground ? (
        <OpenDevicePreview
          key={`${devicePreview.key}:${streamAttempt}`}
          environmentId={environmentId}
          preview={devicePreview}
          streamRef={streamRef}
          onInputConnected={onInputConnected}
        />
      ) : (
        <View className="flex-1 items-center justify-center gap-4 px-6">
          {state.error ? (
            <>
              <AppText selectable className="text-center text-sm text-foreground-muted">
                {state.error}
              </AppText>
              <View className="items-center">
                <Button label="Retry" tone="secondary" onPress={state.refresh} />
              </View>
            </>
          ) : focused && foreground ? (
            <AppActivityIndicator color={themeVariables["--color-icon"]} />
          ) : null}
        </View>
      )}
      {embedded ? (
        <View
          className="flex-row items-center justify-center gap-2 px-3 py-2"
          style={{ paddingBottom: Math.max(insets.bottom, 8) }}
        >
          {devicePreview ? (
            <ControlPill
              accessibilityLabel="Home"
              icon="house"
              disabled={!inputConnected}
              onPress={pressHome}
            />
          ) : null}
          <DeviceOptionsMenu items={menuItems} />
        </View>
      ) : controlsVisible ? (
        <Animated.View
          entering={OVERLAY_ENTERING}
          exiting={OVERLAY_EXITING}
          pointerEvents="box-none"
          className="absolute inset-0"
        >
          {inputConnected ? (
            <Pressable
              accessibilityLabel="Hide device controls"
              className="absolute inset-0 bg-black/30"
              onPress={() => setControlsVisible(false)}
            />
          ) : null}
          <View className="px-3" style={{ paddingTop: Math.max(insets.top, 12) }}>
            <GlassSurface className="flex-row items-center gap-1 p-1">
              <SheetCloseButton accessibilityLabel="Close device preview" onClose={onClose} />
              <AppText numberOfLines={1} className="flex-1 text-center font-t3-medium text-base">
                {preview?.name ?? "Devices"}
              </AppText>
              {devicePreview ? (
                <ControlPill
                  accessibilityLabel="Home"
                  icon="house"
                  disabled={!inputConnected}
                  onPress={pressHome}
                />
              ) : null}
              <DeviceOptionsMenu items={menuItems} />
            </GlassSurface>
          </View>
        </Animated.View>
      ) : (
        <View
          pointerEvents="box-none"
          className="absolute self-center"
          style={{
            top: Math.max(insets.top, 12),
            transform: [{ translateX: (handleBounds.left - handleBounds.right) / 2 }],
          }}
        >
          <GlassSurface className="flex-row items-center gap-1 p-1">
            <SheetCloseButton accessibilityLabel="Close device preview" onClose={onClose} />
            <ControlPill
              accessibilityLabel="Show device controls"
              icon="chevron.down"
              onPress={() => setControlsVisible(true)}
            />
          </GlassSurface>
        </View>
      )}
    </View>
  );
}

function DeviceOptionsMenu({ items }: { readonly items: ReadonlyArray<AppBarMenuItem> }) {
  return (
    <Menu
      actions={menuActionsFromAppBarItems(items)}
      isAnchoredToRight
      title="Device options"
      onPressAction={({ nativeEvent }) => {
        const action = findAppBarMenuItem(items, nativeEvent.event);
        if (action && !action.disabled) action.onPress();
      }}
    >
      <ControlPill icon="ellipsis" accessibilityLabel="Device options" />
    </Menu>
  );
}

function OpenDevicePreview({
  environmentId,
  preview,
  streamRef,
  onInputConnected,
}: {
  readonly environmentId: EnvironmentId;
  readonly preview: Extract<ThreadDevicePreview, { kind: "device" }>;
  readonly streamRef: RefObject<DeviceStreamRef | null>;
  readonly onInputConnected: (connected: boolean) => Promise<void>;
}) {
  const { session } = preview;
  const { themeVariables } = useAppearancePreferences();
  const [viewer] = useState(uuidv4);
  const { access, error, refresh } = useDeviceHubAccess(environmentId, session.hostId, viewer);
  const onUnauthorized = async () => refresh();
  return access ? (
    <DeviceStreamWebView
      ref={streamRef}
      access={access}
      platform={session.platform}
      deviceId={session.deviceId}
      serveSimOnly={preview.serveSimOnly}
      colors={{
        background: themeVariables["--color-sheet-solid"],
        foreground: themeVariables["--color-foreground"],
        muted: themeVariables["--color-foreground-muted"],
        buttonBackground: themeVariables["--color-secondary"],
        buttonForeground: themeVariables["--color-secondary-foreground"],
        buttonBorder: themeVariables["--color-secondary-border"],
      }}
      onUnauthorized={onUnauthorized}
      onInputConnected={onInputConnected}
    />
  ) : (
    <View className="flex-1 items-center justify-center gap-4 px-6">
      {error ? (
        <>
          <AppText selectable className="text-center text-sm text-foreground-muted">
            {error}
          </AppText>
          <View className="items-center">
            <Button label="Retry" tone="secondary" onPress={refresh} />
          </View>
        </>
      ) : (
        <>
          <AppActivityIndicator color={themeVariables["--color-icon"]} />
          <AppText className="text-sm text-foreground-muted">Connecting to device...</AppText>
        </>
      )}
    </View>
  );
}
