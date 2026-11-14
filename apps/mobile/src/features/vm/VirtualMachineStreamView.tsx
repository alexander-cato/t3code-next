import { useEffect, useEffectEvent, useRef, useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

// Only the current viewer page may post messages; retired pages and other URLs are ignored.
function readViewerMessage(uri: string, event: { readonly url: string; readonly data: string }) {
  try {
    const expected = new URL(uri);
    const sender = new URL(event.url);
    if (sender.origin !== expected.origin || sender.pathname !== expected.pathname) return null;
    return JSON.parse(event.data) as unknown;
  } catch {
    return null;
  }
}

export function VirtualMachineStreamView(props: {
  readonly uri: string;
  readonly onFailure: (message: string) => void;
}) {
  const view = useRef<WebView<object>>(null);
  const [status, setStatus] = useState("connecting");
  const { themeVariables: colors } = useAppearancePreferences();
  const theme = JSON.stringify({
    type: "t3-vm-viewer-theme",
    tokens: {
      background: colors["--color-screen"],
      foreground: colors["--color-foreground"],
      border: colors["--color-border"],
      secondary: colors["--color-secondary"],
      secondaryForeground: colors["--color-secondary-foreground"],
      icon: colors["--color-foreground-muted"],
      popover: colors["--color-card"],
      popoverForeground: colors["--color-foreground"],
      controlRadius: "6px",
      tooltipRadius: "8px",
    },
  });
  const shareTheme = () =>
    view.current?.injectJavaScript(`window.postMessage(${theme}, "*"); true;`);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- updates the isolated native WebView when the app theme changes
  useEffect(() => {
    view.current?.injectJavaScript(`window.postMessage(${theme}, "*"); true;`);
  }, [theme]);
  const streaming = status === "streaming";
  const expireStartup = useEffectEvent(() =>
    props.onFailure("The desktop has not connected yet. Reconnect to try again."),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- bounds startup and reconnect waiting without extending it for status chatter
  useEffect(() => {
    if (streaming) return;
    const timeout = setTimeout(expireStartup, 45_000);
    return () => clearTimeout(timeout);
  }, [streaming]);
  return (
    <View className="flex-1">
      <WebView
        ref={view}
        source={{ uri: props.uri }}
        className="flex-1"
        allowsFullscreenVideo
        javaScriptEnabled
        accessibilityElementsHidden={!streaming}
        importantForAccessibility={streaming ? "auto" : "no-hide-descendants"}
        onMessage={({ nativeEvent }) => {
          const message = readViewerMessage(props.uri, nativeEvent);
          if (typeof message !== "object" || message === null || !("type" in message)) return;
          if (message.type === "t3-vm-viewer-theme-request") shareTheme();
          else if (message.type === "t3-vm-viewer-status" && "status" in message) {
            if (
              message.status === "streaming" ||
              message.status === "connecting" ||
              message.status === "reconnecting" ||
              message.status === "failed"
            ) {
              if (message.status === "failed" && streaming) {
                props.onFailure("The desktop connection stopped. Reconnect to try again.");
              } else setStatus(message.status);
            }
          }
        }}
        onError={() => props.onFailure("The VM view could not connect. Reconnect to try again.")}
        onHttpError={({ nativeEvent }) =>
          props.onFailure(
            `The VM view could not load (HTTP ${nativeEvent.statusCode}). Reconnect to try again.`,
          )
        }
        onContentProcessDidTerminate={() =>
          props.onFailure("The VM view stopped. Reconnect to try again.")
        }
        onRenderProcessGone={() => props.onFailure("The VM view stopped. Reconnect to try again.")}
      />
      {!streaming ? (
        <View className="absolute inset-0 bg-background">
          <ScreenScrollView
            className="flex-1"
            contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}
          >
            <View className="items-center gap-3 px-6 py-8">
              <AppActivityIndicator />
              <AppText accessibilityLiveRegion="polite" className="text-center">
                {status === "reconnecting"
                  ? "Reconnecting to desktop…"
                  : "Connecting to desktop and preparing input…"}
              </AppText>
              <AppText className="text-center text-foreground-muted">
                You can leave this view while the desktop starts.
              </AppText>
            </View>
          </ScreenScrollView>
        </View>
      ) : null}
    </View>
  );
}
