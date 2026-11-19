import { useEffect, useState } from "react";
import { T, useGT, Var } from "gt-react";
import type { DesktopInstallationDataState } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { requestConfirmDialog } from "../../confirmDialog";

export function InstallationDataSettings({
  onConnect,
}: {
  readonly onConnect: (origin: string | null) => void;
}) {
  const gt = useGT();
  const bridge = window.desktopBridge;
  const [state, setState] = useState<DesktopInstallationDataState | null>(null);
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads installation metadata from the desktop filesystem
  useEffect(() => {
    if (!bridge?.getInstallationDataState) return;
    let disposed = false;
    let request = 0;
    const refresh = () => {
      request += 1;
      const current = request;
      void bridge.getInstallationDataState!().then(
        (result) => {
          if (disposed || current !== request) return;
          setState(result);
          setError(null);
        },
        (cause) => {
          if (!disposed && current === request)
            setError(
              cause instanceof Error ? cause.message : gt("Could not inspect installations."),
            );
        },
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
    };
  }, [bridge, gt]);
  if (
    !bridge?.getInstallationDataState ||
    !bridge.importInstallationData ||
    !bridge.restoreInstallationData ||
    state?.supported === false
  )
    return null;
  if (!state && bridge.getAppBranding()?.baseName !== "T3 Code Fork") return null;
  const selectedDirectory = directory || state?.installations[0]?.directory || "";
  const selected = state?.installations.find(
    (installation) => installation.directory === selectedDirectory,
  );
  const importData = async () => {
    const source = selectedDirectory || (await bridge.pickFolder());
    if (!source) return;
    if (
      !(await requestConfirmDialog(
        gt(
          "Import a separate copy of this installation's data? The fork will restart, replace its local data, and save its current data as a backup. Close the source app first. Imported scheduled tasks, PR watches, and automatic thread resumes start off. Browser sign-ins, device permissions, T3 Connect authorization, and connection credentials remain separate.",
        ),
      ))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await bridge.importInstallationData!(source);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("The import failed."));
      setBusy(false);
    }
  };
  const latestBackup = state?.backups[0];
  const restoreData = async () => {
    if (
      !latestBackup ||
      !(await requestConfirmDialog(
        gt(
          "Restore the fork data saved before the last import? The fork will restart. Its current data will be kept as another backup.",
        ),
      ))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await bridge.restoreInstallationData!(latestBackup.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("The restore failed."));
      setBusy(false);
    }
  };
  return (
    <SettingsSection id="existing-installation-data" title={gt("Existing T3 installations")}>
      <p className="text-sm text-muted-foreground">
        <T>
          Choose an independent import or connect both apps to the same environment. Connected apps
          share changes in either direction while the host is running. App preferences and browser
          sign-ins stay local.
        </T>
      </p>
      {state && (state.installations.length > 0 || directory) ? (
        <SettingsRow title={gt("Source installation")} description={selectedDirectory}>
          <Select
            value={selectedDirectory}
            onValueChange={(value) => {
              if (value) setDirectory(value);
            }}
            disabled={busy}
          >
            <SelectTrigger aria-label={gt("Source installation")}>
              <SelectValue>{selected?.label ?? gt("Custom folder")}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {state.installations.map((installation) => (
                <SelectItem key={installation.directory} value={installation.directory}>
                  {installation.running
                    ? gt("{label} · running", { label: installation.label })
                    : installation.label}
                </SelectItem>
              ))}
              {directory &&
              !state.installations.some((installation) => installation.directory === directory) ? (
                <SelectItem value={directory}>
                  <T>Custom folder</T>
                </SelectItem>
              ) : null}
            </SelectPopup>
          </Select>
        </SettingsRow>
      ) : null}
      <SettingsRow
        title={gt("Import once")}
        description={gt(
          "Copy projects, conversations, attachments, themes, portable saved secrets, provider settings, and app preferences. The fork then has independent data.",
        )}
      >
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={async () => {
              const selectedPath = await bridge.pickFolder();
              if (selectedPath) setDirectory(selectedPath);
            }}
          >
            <T>Choose folder</T>
          </Button>
          <Button
            variant="outline"
            disabled={busy || selected?.running}
            onClick={() => void importData()}
          >
            {busy ? gt("Preparing…") : gt("Import and restart")}
          </Button>
        </div>
      </SettingsRow>
      {selected?.running ? (
        <p className="text-sm text-muted-foreground">
          <T>
            Close <Var>{selected.label}</Var> before importing, or keep connected to use its live
            data.
          </T>
        </p>
      ) : null}
      <SettingsRow
        title={gt("Keep connected")}
        description={gt(
          "Pair using the host's Sharing & access settings. Both apps share projects, conversations, provider settings, tasks, and running agents. Disconnect under Environments.",
        )}
      >
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => onConnect(selected?.origin ?? null)}
        >
          <T>Connect existing environment</T>
        </Button>
      </SettingsRow>
      <p className="text-sm text-muted-foreground">
        <T>
          The connected host runs the backend. To use the fork's backend changes in both apps,
          import into the fork, then connect the other app to the fork's environment.
        </T>
      </p>
      {latestBackup ? (
        <SettingsRow
          title={gt("Restore previous fork data")}
          description={gt("Backup saved {date}", {
            date: new Date(latestBackup.createdAt).toLocaleString(),
          })}
        >
          <Button variant="outline" disabled={busy} onClick={() => void restoreData()}>
            <T>Restore and restart</T>
          </Button>
        </SettingsRow>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
