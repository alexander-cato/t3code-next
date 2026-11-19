import {
  AuthFilesystemReadScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useGT } from "gt-react";
import { useState } from "react";
import { m } from "~/i18n/messages";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

export function GenerateProjectScriptsButton({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const gt = useGT();
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const generate = useAtomCommand(projectEnvironment.generateScripts, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    const result = await generate({ environmentId, input: { projectId } }).finally(() =>
      setBusy(false),
    );
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not create project scripts"),
        description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
      });
    } else if (result._tag === "Success" && !result.value) {
      toastManager.add({ type: "info", title: gt("No supported project commands found") });
    }
  }
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={busy || !canRead || !canWrite}
      onClick={() => void create()}
    >
      {gt("Auto-create scripts")}
    </Button>
  );
}
