import type { ClientType, ReceiverMode } from "./types.ts";
import type { TmuxPaneInfo } from "./tmux.ts";

export type TmuxMirrorResult = { ok: boolean; target: string | null; failedOptions: string[] };

export interface BrokerIdentityForTmux {
  id: string;
  name: string | null;
  resolved_name: string | null;
  client_type: ClientType;
  receiver_mode: ReceiverMode;
}

export interface PublishBrokerIdentityOptions {
  env?: Record<string, string | undefined>;
  updateOperatorLabel?: boolean;
  writeOperatorLabel?: boolean;
  readPaneOption?: (target: string, optionName: string) => string | null;
  setPaneOption?: (target: string, optionName: string, value: string) => boolean;
}

function cleanTmuxOptionValue(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/\0/g, "").trim();
  return cleaned ? cleaned : null;
}

function defaultReadPaneOption(target: string, optionName: string): string | null {
  try {
    const result = Bun.spawnSync(["tmux", "show-options", "-p", "-t", target, "-v", optionName], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return null;
    return cleanTmuxOptionValue(new TextDecoder().decode(result.stdout));
  } catch {
    return null;
  }
}

function defaultSetPaneOption(target: string, optionName: string, value: string): boolean {
  try {
    const result = Bun.spawnSync(["tmux", "set-option", "-p", "-t", target, optionName, value], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export function registrationTmuxPaneId(
  tmuxInfo: TmuxPaneInfo | null,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (tmuxInfo?.pane_id) return tmuxInfo.pane_id;
  if (env.TMUX_PANE) return env.TMUX_PANE;
  return null;
}

export function brokerIdentityPaneTarget(
  tmuxInfo: TmuxPaneInfo | null,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return registrationTmuxPaneId(tmuxInfo, env);
}

export function publishBrokerIdentityToTmux(
  identity: BrokerIdentityForTmux,
  tmuxInfo: TmuxPaneInfo | null,
  options: PublishBrokerIdentityOptions = {},
): TmuxMirrorResult {
  const paneTarget = brokerIdentityPaneTarget(tmuxInfo, options.env ?? process.env);
  if (!paneTarget) return { ok: true, target: null, failedOptions: [] };

  const displayLabel = identity.name || identity.resolved_name || identity.id;
  const failedOptions: string[] = [];
  const setPaneOption = options.setPaneOption ?? defaultSetPaneOption;
  const setOption = (optionName: string, value: string) => {
    if (!setPaneOption(paneTarget, optionName, value)) failedOptions.push(optionName);
  };

  if (options.writeOperatorLabel ?? true) {
    const readPaneOption = options.readPaneOption ?? defaultReadPaneOption;
    const existingOperatorLabel = readPaneOption(paneTarget, "@operator_label");
    if ((options.updateOperatorLabel || !existingOperatorLabel) && displayLabel) {
      setOption("@operator_label", displayLabel);
    }
  }
  setOption("@peer_id", identity.id);
  setOption("@peer_label", displayLabel);
  setOption("@peer_resolved_name", identity.resolved_name ?? "");
  setOption("@peer_client_type", identity.client_type);
  setOption("@peer_receiver_mode", identity.receiver_mode);

  return { ok: failedOptions.length === 0, target: paneTarget, failedOptions };
}
