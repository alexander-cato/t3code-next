import { Camera, MoreHorizontal, PictureInPicture2, Power, RefreshCw, X } from "lucide-react";

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
  return (
    <PreviewControlsRail label="Virtual machine controls">
      <PreviewRailButton
        tooltipSide="left"
        label={props.screenshotPending ? "Capturing screenshot" : "Save screenshot"}
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
              aria-label="More VM actions"
              title="More VM actions"
            />
          }
        >
          <MoreHorizontal />
        </MenuTrigger>
        <MenuPopup side="left" align="end">
          <MenuItem onClick={props.onFloat}>
            <PictureInPicture2 />
            Float VM over chat
          </MenuItem>
          <MenuItem disabled={props.viewer.reconnecting} onClick={props.viewer.reconnect}>
            <RefreshCw />
            Reconnect VM viewer
          </MenuItem>
          <MenuItem onClick={props.onClose}>
            <X />
            Close VM view
          </MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={props.onSuspend}>
            <Power />
            Suspend VM
          </MenuItem>
        </MenuPopup>
      </Menu>
    </PreviewControlsRail>
  );
}
