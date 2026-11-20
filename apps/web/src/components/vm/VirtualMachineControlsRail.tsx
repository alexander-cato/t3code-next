import { Camera, MoreHorizontal, PictureInPicture2, Power, RefreshCw, X } from "lucide-react";
import { T, useGT } from "gt-react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { PreviewControlsRail, PreviewRailButton } from "../preview/PreviewControlsRail";
import type { VirtualMachineViewerControls } from "./VirtualMachineViewer";

/** The VM counterpart of DeviceControlsRail. */
export function VirtualMachineControlsRail(props: {
  readonly viewer: VirtualMachineViewerControls;
  readonly screenshotPending: boolean;
  readonly onScreenshot: () => void;
  readonly onFloat: () => void;
  readonly onClose: () => void;
  readonly onSuspend: () => void;
}) {
  const gt = useGT();
  return (
    <PreviewControlsRail label={gt("Virtual machine controls")}>
      <PreviewRailButton
        tooltipSide="left"
        label={props.screenshotPending ? gt("Capturing screenshot") : gt("Save screenshot")}
        disabled={!props.viewer.streaming || props.screenshotPending}
        onClick={props.onScreenshot}
      >
        <Camera />
      </PreviewRailButton>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={gt("More VM actions")}
              title={gt("More VM actions")}
            />
          }
        >
          <MoreHorizontal />
        </MenuTrigger>
        <MenuPopup side="left" align="end">
          <MenuItem onClick={props.onFloat}>
            <PictureInPicture2 />
            <T>Float VM over chat</T>
          </MenuItem>
          <MenuItem disabled={props.viewer.reconnecting} onClick={props.viewer.reconnect}>
            <RefreshCw />
            <T>Reconnect VM viewer</T>
          </MenuItem>
          <MenuItem onClick={props.onClose}>
            <X />
            <T>Close VM view</T>
          </MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={props.onSuspend}>
            <Power />
            <T>Suspend VM</T>
          </MenuItem>
        </MenuPopup>
      </Menu>
    </PreviewControlsRail>
  );
}
