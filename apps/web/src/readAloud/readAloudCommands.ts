import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcStreamCommand,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const readAloudPrepare = createEnvironmentRpcStreamCommand(connectionAtomRuntime, {
  label: "environment-data:read-aloud:prepare",
  tag: WS_METHODS.readAloudPrepare,
});

export const readAloudVoices = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:read-aloud:voices",
  tag: WS_METHODS.readAloudListVoices,
  staleTimeMs: 5 * 60_000,
  idleTtlMs: 10 * 60_000,
});
