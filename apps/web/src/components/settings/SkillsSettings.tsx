import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  SkillCatalogBackup,
  SkillLibraryEntry,
  SkillLibraryMutation,
  SkillLibrarySnapshot,
  SkillName,
  SkillSource,
  SkillSourcePreview,
  SkillTarget,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CloudUploadIcon, DownloadIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  skillLibraryList,
  skillLibraryMutate,
  skillLibraryPreviewSource,
} from "../../state/skillLibrary";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { Toggle } from "../ui/toggle";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

type Run = (mutation: SkillLibraryMutation) => Promise<boolean>;
type Confirmation = {
  readonly title: string;
  readonly description: string;
  readonly mutation: SkillLibraryMutation;
};

export function SkillsSettingsPanel() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  return (
    <SettingsPageContainer>
      {environmentId === null ? null : (
        <SkillLibraryPanel key={environmentId} environmentId={environmentId} />
      )}
    </SettingsPageContainer>
  );
}

function SkillLibraryPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(skillLibraryList({ environmentId, input: {} }));
  const canManage = useAtomValue(skillLibraryMutate.permissionAtom(environmentId));
  const mutate = useAtomCommand(skillLibraryMutate);
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [installing, setInstalling] = useState(false);
  const [savingScenario, setSavingScenario] = useState(false);
  const section = { ...searchableSetting("skills"), title: gt("Skills") };
  const snapshot = query.data;

  const run: Run = async (mutation) => {
    setBusy(mutation._tag);
    const result = await mutate({ environmentId, input: mutation });
    setBusy(null);
    return result._tag === "Success";
  };

  if (snapshot === null) {
    return (
      <SettingsSection {...section}>
        {query.error === null ? (
          <div className="grid gap-3 px-4 py-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <SettingsRow
            title={gt("Could not load skills")}
            description={query.error}
            control={
              <Button size="xs" variant="outline" onClick={query.refresh}>
                {gt("Retry")}
              </Button>
            }
          />
        )}
      </SettingsSection>
    );
  }

  const disabled = !canManage || busy !== null;
  return (
    <>
      {snapshot.canImportSkillsManager ? (
        <SettingsSection title="skills-manager.app">
          <SettingsRow
            title={gt("Import from skills-manager.app")}
            description={gt(
              "Brings over where each skill came from and your scenarios. Links stay as they are. Quit skills-manager.app afterwards so it stops changing them.",
            )}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => void run({ _tag: "importSkillsManager" })}
              >
                {gt("Import")}
              </Button>
            }
          />
        </SettingsSection>
      ) : null}
      <ScenarioSection
        snapshot={snapshot}
        disabled={disabled}
        run={run}
        onSave={() => setSavingScenario(true)}
        onDelete={(name) =>
          setConfirmation({
            title: gt("Delete scenario {name}?", { name }),
            description: gt("The skills stay linked as they are now."),
            mutation: { _tag: "deleteScenario", name },
          })
        }
      />
      <SettingsSection
        {...section}
        headerAction={
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={disabled}
              title={
                snapshot.updatesCheckedAt
                  ? gt("Last checked {time}", {
                      time: formatRelativeTimeLabel(snapshot.updatesCheckedAt),
                    })
                  : undefined
              }
              onClick={() => void run({ _tag: "checkUpdates" })}
            >
              <RefreshCwIcon className="size-3" />
              {busy === "checkUpdates" ? gt("Checking…") : gt("Check for updates")}
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={disabled}
              onClick={() => setInstalling(true)}
            >
              <PlusIcon className="size-3" />
              {gt("Install")}
            </Button>
          </div>
        }
      >
        <SkillList
          snapshot={snapshot}
          disabled={disabled}
          run={run}
          onDelete={(skill) =>
            setConfirmation({
              title: gt("Delete {name}?", { name: skill.name }),
              description: gt(
                "This deletes {path}, its links, and its place in every scenario. Tools' own copies stay.",
                { path: skill.catalogPath ?? skill.name },
              ),
              mutation: { _tag: "delete", name: skill.name },
            })
          }
        />
      </SettingsSection>
      {snapshot.backup === null ? null : (
        <BackupSection backup={snapshot.backup} disabled={disabled} busy={busy} run={run} />
      )}
      <ConfirmDialog confirmation={confirmation} run={run} onClose={() => setConfirmation(null)} />
      <InstallDialog
        open={installing}
        environmentId={environmentId}
        run={run}
        onClose={() => setInstalling(false)}
      />
      <SaveScenarioDialog
        open={savingScenario}
        run={run}
        onClose={() => setSavingScenario(false)}
      />
    </>
  );
}

function BackupSection({
  backup,
  disabled,
  busy,
  run,
}: {
  readonly backup: SkillCatalogBackup;
  readonly disabled: boolean;
  readonly busy: string | null;
  readonly run: Run;
}) {
  const gt = useGT();
  return (
    <SettingsSection
      title={gt("Backup")}
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={disabled}
          onClick={() => void run({ _tag: "backUp" })}
        >
          <CloudUploadIcon className="size-3" />
          {busy === "backUp" ? gt("Backing up…") : gt("Back up now")}
        </Button>
      }
    >
      <SettingsRow
        title={gt("Back up to git")}
        description={gt(
          "The catalog is a git repository. Commit and push it shortly after each change, and every 12 hours for edits made elsewhere.",
        )}
        status={
          backup.error
            ? backup.error
            : backup.lastBackupAt
              ? gt("Backed up {time}", { time: formatRelativeTimeLabel(backup.lastBackupAt) })
              : undefined
        }
        control={
          <Switch
            checked={backup.enabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              void run({ _tag: "setBackup", enabled: Boolean(checked) })
            }
            aria-label={gt("Back up to git")}
          />
        }
      />
    </SettingsSection>
  );
}

function ScenarioSection({
  snapshot,
  disabled,
  run,
  onSave,
  onDelete,
}: {
  readonly snapshot: SkillLibrarySnapshot;
  readonly disabled: boolean;
  readonly run: Run;
  readonly onSave: () => void;
  readonly onDelete: (name: string) => void;
}) {
  const gt = useGT();
  const active = snapshot.activeScenario;
  return (
    <SettingsSection title={gt("Scenario")}>
      <SettingsRow
        title={gt("Active scenario")}
        description={
          active === null
            ? gt("Save the current links as a scenario to switch between sets of skills.")
            : gt(
                "Toggles below also change this scenario. Switching relinks every tool to match the one you pick.",
              )
        }
        control={
          <div className="flex items-center gap-1">
            {snapshot.scenarios.length > 0 ? (
              <Select
                value={active ?? ""}
                disabled={disabled}
                onValueChange={(name) => {
                  if (name && name !== active) void run({ _tag: "activateScenario", name });
                }}
              >
                <SelectTrigger aria-label={gt("Active scenario")} size="sm" className="w-40">
                  <SelectValue>{active ?? gt("None")}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {snapshot.scenarios.map((scenario) => (
                    <SelectItem key={scenario.name} value={scenario.name}>
                      {scenario.name} ({scenario.skillCount})
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            <Button size="xs" variant="outline" disabled={disabled} onClick={onSave}>
              {gt("Save as…")}
            </Button>
            {active !== null ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={gt("Delete scenario {name}", { name: active })}
                disabled={disabled}
                onClick={() => onDelete(active)}
              >
                <Trash2Icon />
              </Button>
            ) : null}
          </div>
        }
      />
    </SettingsSection>
  );
}

function SkillList({
  snapshot,
  disabled,
  run,
  onDelete,
}: {
  readonly snapshot: SkillLibrarySnapshot;
  readonly disabled: boolean;
  readonly run: Run;
  readonly onDelete: (skill: SkillLibraryEntry) => void;
}) {
  const gt = useGT();
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const skills = needle
    ? snapshot.skills.filter(
        (skill) =>
          skill.name.toLowerCase().includes(needle) ||
          skill.description?.toLowerCase().includes(needle),
      )
    : snapshot.skills;
  const updates = snapshot.skills.filter((skill) => skill.update?.status === "available").length;

  return (
    <>
      <SettingsRow
        title={gt("{count, plural, one {# skill in {path}} other {# skills in {path}}}", {
          count: snapshot.skills.filter((skill) => skill.catalogPath).length,
          path: snapshot.catalogDirectory,
        })}
        description={
          updates > 0
            ? gt(
                "{count, plural, one {# update available. Updating replaces local edits.} other {# updates available. Updating replaces local edits.}}",
                { count: updates },
              )
            : gt(
                "Turn a tool on to link the catalog copy into its skills folder. Locked tools hold their own copy, which T3 Code leaves alone.",
              )
        }
        control={
          <Input
            size="sm"
            type="search"
            placeholder={gt("Filter skills")}
            aria-label={gt("Filter skills")}
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          />
        }
      />
      {snapshot.skills.length === 0 ? (
        <SettingsRow
          title={gt("No skills yet")}
          description={gt(
            "Install skills from a git repository, or add folders with a SKILL.md to the catalog.",
          )}
        />
      ) : (
        skills.map((skill) => (
          <SkillRow
            key={skill.name}
            snapshot={snapshot}
            skill={skill}
            disabled={disabled}
            run={run}
            onDelete={() => onDelete(skill)}
          />
        ))
      )}
    </>
  );
}

function sourceLabel(source: SkillSource) {
  const repository = source.repository.replace(/^https:\/\/github\.com\//, "");
  return source.path ? `${repository} · ${source.path}` : repository;
}

function SkillRow({
  snapshot,
  skill,
  disabled,
  run,
  onDelete,
}: {
  readonly snapshot: SkillLibrarySnapshot;
  readonly skill: SkillLibraryEntry;
  readonly disabled: boolean;
  readonly run: Run;
  readonly onDelete: () => void;
}) {
  const gt = useGT();
  const adoptFrom = skill.catalogPath
    ? undefined
    : snapshot.targets.find((target) => skill.targets[target.id] === "external");
  let status: ReactNode = null;
  if (skill.update?.status === "available")
    status = <Badge variant="info">{gt("Update available")}</Badge>;
  if (skill.update?.status === "error")
    status = <Badge variant="warning">{gt("Update check failed")}</Badge>;

  return (
    <SettingsRow
      title={skill.name}
      status={status}
      description={
        <>
          {skill.description ? <span className="line-clamp-2">{skill.description}</span> : null}
          {skill.source ? (
            <span className="block truncate font-mono text-2xs">{sourceLabel(skill.source)}</span>
          ) : null}
        </>
      }
      control={
        <div className="flex items-center gap-1">
          {skill.update?.status === "available" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => void run({ _tag: "update", name: skill.name })}
            >
              {gt("Update")}
            </Button>
          ) : null}
          {adoptFrom ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={gt("Copy {name} from {tool} into the catalog", {
                name: skill.name,
                tool: adoptFrom.displayName,
              })}
              title={gt("Copy from {tool} into the catalog", { tool: adoptFrom.displayName })}
              disabled={disabled}
              onClick={() => void run({ _tag: "adopt", name: skill.name, target: adoptFrom.id })}
            >
              <DownloadIcon />
            </Button>
          ) : null}
          {skill.catalogPath ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={gt("Delete {name}", { name: skill.name })}
              disabled={disabled}
              onClick={onDelete}
            >
              <Trash2Icon />
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-wrap gap-1 pt-1 pb-2">
        {snapshot.targets.map((target) => (
          <TargetToggle
            key={target.id}
            skill={skill}
            target={target}
            disabled={disabled}
            run={run}
          />
        ))}
      </div>
    </SettingsRow>
  );
}

function TargetToggle({
  skill,
  target,
  disabled,
  run,
}: {
  readonly skill: SkillLibraryEntry;
  readonly target: SkillTarget;
  readonly disabled: boolean;
  readonly run: Run;
}) {
  const gt = useGT();
  const state = skill.targets[target.id] ?? "off";
  const togglable = state === "linked" || (state === "off" && skill.catalogPath !== undefined);
  return (
    <Toggle
      size="segmented"
      variant="pill"
      pressed={state !== "off"}
      disabled={disabled || !togglable}
      aria-label={
        state === "external"
          ? gt("{name} for {tool} (its own copy)", { name: skill.name, tool: target.displayName })
          : gt("{name} for {tool}", { name: skill.name, tool: target.displayName })
      }
      onPressedChange={(enabled) =>
        void run({ _tag: "setTarget", name: skill.name, target: target.id, enabled })
      }
    >
      {target.displayName}
    </Toggle>
  );
}

function ConfirmDialog({
  confirmation,
  run,
  onClose,
}: {
  readonly confirmation: Confirmation | null;
  readonly run: Run;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {confirmation ? (
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" disabled={busy} />}>
              {gt("Cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const done = await run(confirmation.mutation);
                setBusy(false);
                if (done) onClose();
              }}
            >
              {gt("Delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      ) : null}
    </AlertDialog>
  );
}

function InstallDialog({
  open,
  environmentId,
  run,
  onClose,
}: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly run: Run;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/* Remount per open so a closed dialog forgets its URL and picks. */}
      {open ? (
        <InstallDialogPopup environmentId={environmentId} run={run} onClose={onClose} />
      ) : null}
    </Dialog>
  );
}

function InstallDialogPopup({
  environmentId,
  run,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly run: Run;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const previewSource = useAtomCommand(skillLibraryPreviewSource, { reportFailure: false });
  const [url, setUrl] = useState("");
  // Install uses the URL that was previewed, so the list always matches what gets installed.
  const latestPreview = useRef(0);
  const [preview, setPreview] = useState<(SkillSourcePreview & { readonly url: string }) | null>(
    null,
  );
  const [picked, setPicked] = useState<ReadonlySet<SkillName>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const find = async () => {
    const request = ++latestPreview.current;
    setBusy(true);
    setFailure(null);
    setPreview(null);
    setPicked(new Set());
    const previewed = url.trim();
    const result = await previewSource({ environmentId, input: { url: previewed } });
    setBusy(false);
    // The URL changed while this was loading, so its result no longer matches the input.
    if (request !== latestPreview.current) return;
    if (result._tag === "Success") {
      setPreview({ ...result.value, url: previewed });
      setPicked(
        new Set(
          result.value.candidates.filter((entry) => !entry.exists).map((entry) => entry.name),
        ),
      );
      return;
    }
    const error = squashAtomCommandFailure(result);
    setFailure(error instanceof Error ? error.message : gt("The repository could not be read."));
  };

  const install = async () => {
    setBusy(true);
    if (preview === null) return;
    const done = await run({ _tag: "install", url: preview.url, names: [...picked] });
    setBusy(false);
    if (done) onClose();
  };

  return (
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>{gt("Install skills")}</DialogTitle>
        <DialogDescription>
          <T>
            Paste a git repository or a GitHub folder link. Installed skills keep their source, so
            they can be updated later.
          </T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim()) void find();
          }}
        >
          <Input
            autoFocus
            aria-label={gt("Repository URL")}
            placeholder="https://github.com/owner/repo/tree/main/skills"
            value={url}
            onChange={(event) => {
              setUrl(event.currentTarget.value);
              latestPreview.current += 1;
              setPreview(null);
              setPicked(new Set());
            }}
          />
          <Button type="submit" variant="outline" disabled={busy || !url.trim()}>
            {busy && preview === null ? gt("Finding…") : gt("Find skills")}
          </Button>
        </form>
        {failure ? <p className="text-sm text-destructive-foreground">{failure}</p> : null}
        {preview?.candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {gt("No folder with a SKILL.md was found there.")}
          </p>
        ) : null}
        {preview && preview.candidates.length > 0 ? (
          <div className="grid gap-2">
            {preview.candidates.map((candidate) => (
              <label
                key={candidate.path ?? candidate.name}
                className="flex cursor-pointer items-start gap-3"
              >
                <Checkbox
                  className="mt-0.5"
                  checked={picked.has(candidate.name)}
                  disabled={candidate.exists || busy}
                  onCheckedChange={(checked) => {
                    const next = new Set(picked);
                    if (checked) next.add(candidate.name);
                    else next.delete(candidate.name);
                    setPicked(next);
                  }}
                />
                <span className="min-w-0 text-sm">
                  <span className="font-medium">{candidate.name}</span>
                  {candidate.exists ? (
                    <span className="text-muted-foreground">
                      {" · "}
                      {gt("already in the catalog")}
                    </span>
                  ) : null}
                  {candidate.description ? (
                    <span className="block text-muted-foreground">{candidate.description}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {gt("Cancel")}
        </Button>
        <Button disabled={busy || picked.size === 0} onClick={() => void install()}>
          {picked.size > 1
            ? gt("{count, plural, one {Install # skill} other {Install # skills}}", {
                count: picked.size,
              })
            : gt("Install")}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

function SaveScenarioDialog({
  open,
  run,
  onClose,
}: {
  readonly open: boolean;
  readonly run: Run;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {open ? <SaveScenarioPopup run={run} onClose={onClose} /> : null}
    </Dialog>
  );
}

function SaveScenarioPopup({ run, onClose }: { readonly run: Run; readonly onClose: () => void }) {
  const gt = useGT();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const done = await run({ _tag: "saveScenario", name: name.trim() });
    setBusy(false);
    if (done) onClose();
  };
  return (
    <DialogPopup>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) void save();
        }}
      >
        <DialogHeader>
          <DialogTitle>{gt("Save scenario")}</DialogTitle>
          <DialogDescription>
            <T>
              Saves which tools link each skill right now. A scenario with the same name is
              replaced.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            autoFocus
            aria-label={gt("Scenario name")}
            placeholder={gt("Work")}
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {gt("Cancel")}
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {gt("Save")}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
