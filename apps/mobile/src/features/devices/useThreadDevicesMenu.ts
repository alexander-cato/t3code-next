import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { msg, useMessages } from "gt-react-native";

import type { AppBarMenu } from "../../components/ui/AppBar.types";
import { m, type MessageResolver } from "../../i18n/messages";
import { deviceEnvironment } from "../../state/device";
import { useEnvironmentQuery } from "../../state/query";
import { useVirtualMachineState, virtualMachineEnvironment } from "../../state/virtualMachines";
import { threadDevicesMenuItems } from "./threadDevicesMenuItems";

export function useThreadDevicesMenu(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const navigation = useNavigation();
  const resolve = useMessages();
  const devices = useEnvironmentQuery(
    environmentId === null ? null : deviceEnvironment.state({ environmentId, input: {} }),
  ).data;
  const virtualMachines = useVirtualMachineState(environmentId).data;
  const canOpenVirtualMachines = useAtomValue(
    virtualMachineEnvironment.open.permissionAtom(environmentId),
  );
  if (environmentId === null || threadId === null) return null;
  const items = threadDevicesMenuItems(
    {
      threadId,
      devices: devices ?? null,
      virtualMachines,
      canOpenVirtualMachines,
    },
    resolve,
  );
  if (items.length === 0) return null;
  return {
    items,
    open: (deviceKey: string) =>
      navigation.navigate("ThreadDevicePreview", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        deviceKey,
      }),
  };
}

export type ThreadDevicesMenu = NonNullable<ReturnType<typeof useThreadDevicesMenu>>;

export function threadDevicesAppBarMenu(
  menu: ThreadDevicesMenu,
  resolve: MessageResolver = m,
): AppBarMenu {
  return {
    title: resolve(msg("Devices", { $context: "device list heading" })),
    icon: "iphone",
    items: menu.items.map((item) => ({
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      icon: item.icon,
      disabled: item.disabled,
      onPress: () => menu.open(item.deviceKey),
    })),
  };
}
