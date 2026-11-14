import { useAtomValue } from "@effect/atom-react";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, VirtualMachineName, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  Monitor,
  MoreHorizontal,
  Play,
  Plus,
  Power,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { DiscoveryList } from "~/components/ui/discovery-list";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "~/components/ui/wizard";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  virtualMachineEnvironment as vm,
  useVirtualMachinesSupported,
} from "~/state/virtualMachines";
import { isRunningVirtualMachine } from "./VirtualMachineDeviceView";
import { requestVirtualMachineOpen } from "./virtualMachinePanelSession";

const isValidName = Schema.is(VirtualMachineName);

function LumeSetupGuide(props: { readonly reason: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      {props.reason}{" "}
      <a
        href="https://cua.ai/docs/lume/quickstart"
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-4"
      >
        Setup guide
      </a>
    </p>
  );
}

/** macOS VMs as a platform in device setup, beside iOS and Android. */
export function VirtualMachineSetup({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const supported = useVirtualMachinesSupported(environmentId);
  const query = useEnvironmentQuery(supported ? vm.state({ environmentId, input: {} }) : null);
  const canConfigure = useAtomValue(vm.configure.permissionAtom(environmentId));
  const configure = useAtomCommand(vm.configure, { reportFailure: false });
  const list = useAtomCommand(vm.list, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<{
    environmentId: EnvironmentId;
    checking: boolean;
    error: string | null;
  } | null>(null);
  const currentDiscovery = discovery?.environmentId === environmentId ? discovery : null;
  const checking = currentDiscovery === null || currentDiscovery.checking;
  const failure = error ?? currentDiscovery?.error ?? query.error;
  const discover = async (targetEnvironmentId = environmentId) => {
    const started = { environmentId: targetEnvironmentId, checking: true, error: null };
    setDiscovery(started);
    const result = await list({ environmentId: targetEnvironmentId, input: {} });
    setDiscovery((current) =>
      current === started
        ? {
            ...started,
            checking: false,
            error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
          }
        : current,
    );
  };
  const discoverOnMount = useEffectEvent(discover);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- setup also opens outside the Device panel, so it must discover host VM support itself
  useEffect(() => {
    if (supported) {
      // oxlint-disable-next-line react/set-state-in-effect -- Probing the host starts an RPC and shows its pending state.
      void discoverOnMount(environmentId);
    }
  }, [environmentId, supported]);
  const state = query.data;
  if (!supported || !state) return null;
  const creating = state.operations.some((operation) => operation.status === "creating");
  const ready = state.enabled && state.available;
  return (
    <section className="space-y-3 text-sm">
      <h3 className="font-medium">Check macOS VM support</h3>
      <div className="flex items-start gap-2 rounded-md border border-border/60 px-3 py-2">
        {checking ? (
          <Spinner size="sm" />
        ) : ready ? (
          <Check className="mt-0.5 size-4 shrink-0 text-success" />
        ) : (
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium">macOS virtual machines</p>
          <p className="text-xs text-muted-foreground">
            {checking
              ? "Checking Lume and Cua…"
              : ready
                ? "Lume and Cua are available. Each VM is a separate Mac that does not share host folders or your clipboard."
                : state.enabled
                  ? "macOS VM support needs attention."
                  : "Run separate Macs through Lume and Cua. The first image download is about 24 GB and needs at least 60 GB free disk space."}
          </p>
        </div>
        <Switch
          checked={state.enabled}
          disabled={!canConfigure || pending || creating}
          aria-label="Use macOS virtual machines"
          onCheckedChange={(enabled) => {
            setPending(true);
            setError(null);
            void configure({ environmentId, input: { enabled: Boolean(enabled) } })
              .then((result) => {
                if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
              })
              .finally(() => setPending(false));
          }}
        />
      </div>
      {!checking && state.unavailableReason && <LumeSetupGuide reason={state.unavailableReason} />}
      {failure && (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      )}
      {!checking && (failure || (state.enabled && !state.available)) && (
        <Button variant="outline" size="sm" onClick={() => void discover()}>
          Retry VM discovery
        </Button>
      )}
    </section>
  );
}

/** macOS VMs in the Device panel's list, beside simulators and emulators. */
export function VirtualMachineDeviceSection(props: {
  readonly threadRef: ScopedThreadRef;
  readonly discoveryError?: string | null;
}) {
  const { threadRef } = props;
  const { environmentId } = threadRef;
  const supported = useVirtualMachinesSupported(environmentId);
  const query = useEnvironmentQuery(supported ? vm.state({ environmentId, input: {} }) : null);
  const state = query.data;
  const canConfigure = useAtomValue(vm.configure.permissionAtom(environmentId));
  const canOperate = useAtomValue(vm.open.permissionAtom(environmentId));
  const configure = useAtomCommand(vm.configure, { reportFailure: false });
  const create = useAtomCommand(vm.create, { reportFailure: false });
  const stop = useAtomCommand(vm.stop, { reportFailure: false });
  const remove = useAtomCommand(vm.remove, { reportFailure: false });
  const dismiss = useAtomCommand(vm.dismiss, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [deleteName, setDeleteName] = useState<string | null>(null);
  const failure = error ?? props.discoveryError;
  if (!supported || !state) return null;

  const nameError =
    name.length > 0 && !isValidName(name)
      ? /^[a-zA-Z0-9]/.test(name)
        ? "Use only letters, numbers, hyphens, and underscores."
        : "Start the name with a letter or number."
      : state.machines.some((machine) => machine.name === name)
        ? "A virtual machine with this name already exists. Choose a different name."
        : null;
  const creationRunning = state.operations.some((entry) => entry.status === "creating");
  const run = async <A, E>(label: string, command: () => Promise<AtomCommandResult<A, E>>) => {
    setBusy(label);
    setError(null);
    const result = await command();
    setBusy(null);
    if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
    return result._tag === "Success";
  };
  const openMachine = (machineName: string) => {
    requestVirtualMachineOpen(threadRef, machineName);
    useRightPanelStore.getState().openVirtualMachine(threadRef, machineName);
  };
  const suspendMachine = async (machineName: string) => {
    if (await run(machineName, () => stop({ environmentId, input: { name: machineName } })))
      useRightPanelStore.getState().releaseVirtualMachineTabs(environmentId, machineName);
  };
  const deleteMachine = async (machineName: string) => {
    if (await run(machineName, () => remove({ environmentId, input: { name: machineName } })))
      useRightPanelStore.getState().releaseVirtualMachineTabs(environmentId, machineName);
    setDeleteName(null);
  };
  const createMachine = async () => {
    if (!isValidName(name) || nameError || !canOperate) return;
    if (await run(name, () => create({ environmentId, input: { name, cpu: 4, memoryGb: 8 } }))) {
      setCreating(false);
      setName("");
    }
  };

  const machines = state.machines
    .filter((machine) => !state.operations.some((operation) => operation.name === machine.name))
    .toSorted(
      (a, b) =>
        Number(isRunningVirtualMachine(b)) - Number(isRunningVirtualMachine(a)) ||
        a.name.localeCompare(b.name),
    );

  return (
    <section className="w-full space-y-3 text-left">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Monitor className="size-4 shrink-0" />
        <h3 className="min-w-0 flex-1 font-medium">macOS virtual machines</h3>
        {state.enabled && (
          <Button
            variant="outline"
            size="sm"
            disabled={!canOperate || !state.available || creationRunning}
            onClick={() => setCreating(true)}
          >
            <Plus /> Create VM
          </Button>
        )}
      </div>
      {failure && (
        <div role="alert" className="flex items-start gap-2 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{failure}</p>
          {error && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Dismiss virtual machine error"
              onClick={() => setError(null)}
            >
              <X />
            </Button>
          )}
        </div>
      )}
      {!state.enabled ? (
        <DiscoveryList>
          <div className="flex items-center gap-3 px-3 py-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60">
              <Monitor className="size-4" />
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm text-foreground">Off on this environment</p>
              {state.unavailableReason ? (
                <LumeSetupGuide reason={state.unavailableReason} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Separate Macs for testing apps, run through Lume and Cua.
                </p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!canConfigure || busy !== null}
              onClick={() =>
                void run("configure", () => configure({ environmentId, input: { enabled: true } }))
              }
            >
              {busy === "configure" && <Spinner size="xs" />}
              Turn on
            </Button>
          </div>
        </DiscoveryList>
      ) : !state.available ? (
        state.unavailableReason && <LumeSetupGuide reason={state.unavailableReason} />
      ) : state.machines.length === 0 && state.operations.length === 0 ? (
        <p className="text-xs text-muted-foreground">No macOS virtual machines yet.</p>
      ) : (
        <DiscoveryList>
          {state.operations.map((operation) => {
            const machine = state.machines.find((entry) => entry.name === operation.name);
            const preparingDesktop = machine !== undefined && isRunningVirtualMachine(machine);
            return (
              <div
                key={operation.name}
                role={operation.status === "creating" ? "status" : "alert"}
                className="flex items-start gap-3 px-3 py-3"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60">
                  {operation.status === "creating" ? (
                    <Spinner size="xs" />
                  ) : (
                    <Monitor className="size-4" />
                  )}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="break-words text-sm font-medium text-foreground">
                    {operation.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {operation.status === "creating"
                      ? preparingDesktop
                        ? "Preparing desktop and input…"
                        : "Downloading and preparing macOS…"
                      : operation.error}
                  </p>
                  {operation.status === "creating" && (
                    <div
                      className="flex w-24 gap-1 pt-1"
                      aria-label={
                        preparingDesktop
                          ? "Step 2 of 2: prepare desktop"
                          : "Step 1 of 2: download macOS"
                      }
                    >
                      <span className="h-1 flex-1 rounded-full bg-foreground/60" />
                      <span
                        className={cn(
                          "h-1 flex-1 rounded-full",
                          preparingDesktop ? "bg-foreground/60" : "bg-muted",
                        )}
                      />
                    </div>
                  )}
                  {operation.status === "failed" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canOperate || creationRunning}
                      onClick={() => {
                        if (machine) {
                          openMachine(operation.name);
                          return;
                        }
                        setName(operation.name);
                        setCreating(true);
                      }}
                    >
                      {machine ? (preparingDesktop ? "Open" : "Start") : "Retry setup"}
                    </Button>
                  )}
                </div>
                {operation.status === "failed" && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Dismiss failed creation of ${operation.name}`}
                    disabled={!canOperate}
                    onClick={() =>
                      void run(operation.name, () =>
                        dismiss({ environmentId, input: { name: operation.name } }),
                      )
                    }
                  >
                    <X />
                  </Button>
                )}
              </div>
            );
          })}
          {machines.map((machine) => {
            const running = isRunningVirtualMachine(machine);
            return (
              <div key={machine.name} className="flex items-center gap-3 px-3 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60">
                  <Monitor className="size-4" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          tabIndex={0}
                          className="truncate text-sm font-medium text-foreground"
                        />
                      }
                    >
                      {machine.name}
                    </TooltipTrigger>
                    <TooltipPopup>{machine.name}</TooltipPopup>
                  </Tooltip>
                  <span className="truncate text-xs text-muted-foreground">
                    This environment · macOS · {running ? "Running" : "Stopped"}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canOperate || busy === machine.name}
                  aria-label={`${running ? "Open" : "Start"} ${machine.name}`}
                  onClick={() => openMachine(machine.name)}
                >
                  {busy === machine.name ? (
                    <Spinner size="xs" />
                  ) : running ? (
                    <ArrowUpRight />
                  ) : (
                    <Play />
                  )}
                  {running ? "Open" : "Start"}
                </Button>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Actions for ${machine.name}`}
                      />
                    }
                  >
                    <MoreHorizontal />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem
                      variant="destructive"
                      disabled={!canOperate || !running}
                      onClick={() => void suspendMachine(machine.name)}
                    >
                      <Power />
                      <div className="flex max-w-60 flex-col gap-0.5 whitespace-normal">
                        <span>Suspend</span>
                        <span className="text-xs text-muted-foreground">
                          Releases CPU and memory and disconnects all open views of this VM.
                        </span>
                      </div>
                    </MenuItem>
                    <MenuItem disabled={!canOperate} onClick={() => setDeleteName(machine.name)}>
                      <Trash2 /> Delete VM
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </div>
            );
          })}
        </DiscoveryList>
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        <WizardPopup>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createMachine();
            }}
          >
            <WizardHeader
              title="Create a virtual machine"
              description="A separate Mac for testing apps and agent control."
            />
            <WizardPanel>
              <div className="space-y-3">
                <Label htmlFor="vm-name">Virtual machine name</Label>
                <Input
                  id="vm-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="native-tile-tests"
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={nameError !== null}
                  aria-describedby={nameError ? "vm-name-help vm-name-error" : "vm-name-help"}
                />
                <p id="vm-name-help" className="text-xs text-muted-foreground">
                  Start with a letter or number. Use up to 64 letters, numbers, hyphens, or
                  underscores.
                </p>
                {nameError && (
                  <p id="vm-name-error" role="alert" className="text-xs text-destructive">
                    {nameError}
                  </p>
                )}
                <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
                  <p className="font-medium">macOS Tahoe · 4 CPUs · 8 GB memory</p>
                  <p className="text-muted-foreground">
                    First download: about 24 GB. Keep at least 60 GB of disk space free.
                  </p>
                  <p className="text-muted-foreground">Up to two macOS VMs can run at once.</p>
                </div>
                {error && (
                  <p role="alert" className="text-xs text-destructive">
                    {error}
                  </p>
                )}
              </div>
            </WizardPanel>
            <WizardFooter>
              <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy !== null || !canOperate || !isValidName(name) || nameError !== null}
              >
                {busy === name && <Spinner size="xs" />}
                Create VM
              </Button>
            </WizardFooter>
          </form>
        </WizardPopup>
      </Dialog>
      <AlertDialog
        open={deleteName !== null}
        onOpenChange={(value) => {
          if (!value) setDeleteName(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the virtual machine and all files inside it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy !== null}
              onClick={() => {
                if (deleteName) void deleteMachine(deleteName);
              }}
            >
              Delete VM
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
