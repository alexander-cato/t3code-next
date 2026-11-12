import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";
import { useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

export function AcpRegistryPrepareButton({
  environmentId,
  agentId,
  installed,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly agentId: string;
  readonly installed: boolean;
  readonly readOnly: boolean;
}) {
  const canPrepare = useAtomValue(
    serverEnvironment.prepareAcpRegistryAgent.permissionAtom(environmentId),
  );
  const canRefresh = useAtomValue(serverEnvironment.refreshProviders.permissionAtom(environmentId));
  const prepare = useAtomCommand(serverEnvironment.prepareAcpRegistryAgent, {
    reportFailure: false,
  });
  const refresh = useAtomCommand(serverEnvironment.refreshProviders);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  async function prepareAgent() {
    if (readOnly || !canPrepare || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const result = await prepare({ environmentId, input: { agentId } });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not prepare the agent.");
      }
    } else if (canRefresh) {
      await refresh({ environmentId, input: { refreshModels: true } });
    }
    pendingRef.current = false;
    setPending(false);
  }

  return (
    <div className="grid justify-items-start gap-2 pt-2">
      <Button
        size="sm"
        variant="outline"
        disabled={readOnly || !canPrepare || pending}
        aria-busy={pending}
        onClick={() => void prepareAgent()}
      >
        {pending ? <Spinner /> : <DownloadIcon />}
        {pending ? "Preparing…" : installed ? "Repair installation" : "Prepare agent"}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
