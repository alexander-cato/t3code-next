import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { AppBarMenu } from "../../components/ui/AppBar.types";
import { deviceEnvironment } from "../../state/device";
import { useEnvironmentQuery } from "../../state/query";
import { useVirtualMachineState, virtualMachineEnvironment } from "../../state/virtualMachines";
import { threadDevicesMenuItems } from "./threadDevicesMenuItems";

export function useThreadDevicesMenu(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const navigation = useNavigation();
  const devices = useEnvironmentQuery(
    environmentId === null ? null : deviceEnvironment.state({ environmentId, input: {} }),
  ).data;
  const virtualMachines = useVirtualMachineState(environmentId).data;
  const canOpenVirtualMachines = useAtomValue(
    virtualMachineEnvironment.open.permissionAtom(environmentId),
  );
  if (environmentId === null || threadId === null) return null;
  const items = threadDevicesMenuItems({
    threadId,
    devices: devices ?? null,
    virtualMachines,
    canOpenVirtualMachines,
  });
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

export function threadDevicesAppBarMenu(menu: ThreadDevicesMenu): AppBarMenu {
  return {
    title: "Devices",
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
