import {
  READ_ALOUD_SPEEDS,
  READ_ALOUD_TTS_MODELS,
  type ProviderInstanceId,
  type ReadAloudSpeed,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveReadAloudModelSelection } from "@t3tools/shared/serverSettings";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../components/chat/TraitsPicker";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { useScopedModelDisabledReason } from "../components/settings/useScopedModelAvailability";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import { updateClientSettings, useClientSettings } from "../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { useEnvironmentProviders } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { EMPTY_SERVER_PROVIDERS } from "../state/server";
import { readAloudVoices } from "./readAloudCommands";
import { VoicePreviewButton, VoicePreviewScope } from "./VoicePreviewButton";

export function ReadAloudSettingsSection() {
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsSection title="Read aloud" id="read-aloud">
        <SettingsScopeNotice target="environment">
          Choose one environment to set up reading responses aloud.
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  return <ReadAloudSettingsForm key={environment.environmentId} />;
}

function ReadAloudSettingsForm() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const readAloud = settings.readAloud;
  const hasKey = readAloud.elevenLabsApiKey.length > 0;
  const [keyDraft, setKeyDraft] = useState("");
  const [voiceDraft, setVoiceDraft] = useState<string | null>(null);
  const voices = useEnvironmentQuery(
    hasKey && environmentId ? readAloudVoices({ environmentId, input: {} }) : null,
  );
  const speed = useClientSettings((client) => client.readAloudSpeed);
  const defaults = DEFAULT_UNIFIED_SETTINGS.readAloud;
  const voiceValue = voiceDraft ?? readAloud.voiceId;
  const listedVoice = voices.data?.voices.find((voice) => voice.voiceId === readAloud.voiceId);

  return (
    <SettingsSection title="Read aloud" id="read-aloud">
      <SettingsRow
        serverScoped
        settingKeys={["readAloud"]}
        {...searchableSetting("read-aloud-api-key")}
        description="Responses are voiced with ElevenLabs on this environment's host. The key stays there and is never sent to clients."
        status={hasKey ? "Saved." : null}
        control={
          hasKey ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => updateSettings({ readAloud: { elevenLabsApiKey: "" } })}
            >
              Remove key
            </Button>
          ) : (
            <form
              className="flex w-full gap-2 sm:w-80"
              onSubmit={(event) => {
                event.preventDefault();
                const value = keyDraft.trim();
                if (!value) return;
                updateSettings({ readAloud: { elevenLabsApiKey: value } });
                setKeyDraft("");
              }}
            >
              <Input
                size="sm"
                type="password"
                autoComplete="off"
                aria-label="ElevenLabs API key"
                placeholder="ElevenLabs API key"
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.target.value)}
              />
              <Button type="submit" size="sm" variant="outline" disabled={!keyDraft.trim()}>
                Save
              </Button>
            </form>
          )
        }
      />

      <SettingsRow
        serverScoped
        settingKeys={["readAloud"]}
        {...searchableSetting("read-aloud-voice")}
        description={
          voices.error
            ? `Could not list voices: ${voices.error}`
            : "Pick one of your account's voices, or paste any voice ID."
        }
        resetAction={
          readAloud.voiceId !== defaults.voiceId ? (
            <SettingResetButton
              label="voice"
              onClick={() => {
                setVoiceDraft(null);
                updateSettings({ readAloud: { voiceId: defaults.voiceId } });
              }}
            />
          ) : null
        }
        control={
          <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
            <VoicePreviewScope />
            {listedVoice?.previewUrl ? (
              <VoicePreviewButton name={listedVoice.name} previewUrl={listedVoice.previewUrl} />
            ) : null}
            {voices.data && voices.data.voices.length > 0 ? (
              <Select
                value={listedVoice ? listedVoice.voiceId : null}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  setVoiceDraft(null);
                  updateSettings({ readAloud: { voiceId: value } });
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Voice">
                  <SelectValue>
                    {(value: string | null) =>
                      voices.data?.voices.find((voice) => voice.voiceId === value)?.name ??
                      "Custom voice"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {voices.data.voices.map((voice) => (
                    <SelectItem key={voice.voiceId} hideIndicator value={voice.voiceId}>
                      <span className="flex min-w-0 items-center gap-1.5">
                        {voice.previewUrl ? (
                          <VoicePreviewButton name={voice.name} previewUrl={voice.previewUrl} />
                        ) : (
                          <span aria-hidden className="size-6 shrink-0" />
                        )}
                        <span className="min-w-0 truncate">{voice.name}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            <Input
              size="sm"
              className="w-full sm:w-52"
              aria-label="Voice ID"
              placeholder={defaults.voiceId}
              value={voiceValue}
              onChange={(event) => setVoiceDraft(event.target.value)}
              onBlur={() => {
                const value = voiceDraft?.trim();
                setVoiceDraft(null);
                if (value && value !== readAloud.voiceId) {
                  updateSettings({ readAloud: { voiceId: value } });
                }
              }}
            />
          </div>
        }
      />

      <SettingsRow
        serverScoped
        settingKeys={["readAloud"]}
        {...searchableSetting("read-aloud-voice-model")}
        description={
          READ_ALOUD_TTS_MODELS.find((model) => model.id === readAloud.ttsModel)?.description ??
          "A model ID from your ElevenLabs account."
        }
        resetAction={
          readAloud.ttsModel !== defaults.ttsModel ? (
            <SettingResetButton
              label="voice model"
              onClick={() => updateSettings({ readAloud: { ttsModel: defaults.ttsModel } })}
            />
          ) : null
        }
        control={
          <Select
            value={readAloud.ttsModel}
            onValueChange={(value) => {
              if (typeof value === "string") updateSettings({ readAloud: { ttsModel: value } });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Voice model">
              <SelectValue>
                {(value: string) =>
                  READ_ALOUD_TTS_MODELS.find((model) => model.id === value)?.label ?? value
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {READ_ALOUD_TTS_MODELS.map((model) => (
                <SelectItem key={model.id} hideIndicator value={model.id}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <NarrationModelRow />

      <SettingsRow
        serverScoped
        settingKeys={["readAloud"]}
        {...searchableSetting("read-aloud-prepare")}
        description="Write the narration as soon as each reply finishes, so playback starts at once. Uses the narration model for every reply, even ones you never play."
        control={
          <Switch
            checked={readAloud.prepareInAdvance}
            disabled={!hasKey}
            onCheckedChange={(checked) =>
              updateSettings({ readAloud: { prepareInAdvance: checked } })
            }
            aria-label="Prepare narration in advance"
          />
        }
      />

      <SettingsRow
        {...searchableSetting("read-aloud-speed")}
        description="Where playback starts. Changing speed while listening updates it."
        control={
          <Select
            value={speed}
            onValueChange={(value) => {
              if (typeof value === "number") {
                void updateClientSettings({ readAloudSpeed: value as ReadAloudSpeed });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-24" aria-label="Default speed">
              <SelectValue>{(value: number) => `${value}×`}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {READ_ALOUD_SPEEDS.map((option) => (
                <SelectItem key={option} hideIndicator value={option}>
                  {option}×
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

/** Mirrors the review guide model row: off narrates with the text generation model. */
function NarrationModelRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const providers = serverProviders.filter((provider) => provider.supportsTextGeneration !== false);
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const disabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const usesDedicatedModel = settings.readAloudModelSelection !== null;
  const fallback = resolveAppModelSelectionState(settings, providers);
  const selection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveReadAloudModelSelection(settings, providers),
    },
    providers,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection.instanceId,
    selection.model,
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const canEnable = instanceEntries.some(
    (entry) => entry.instanceId === fallback.instanceId && entry.enabled && entry.isAvailable,
  );
  const save = (instanceId: ProviderInstanceId, model: string, options = selection.options) => {
    const reason = disabledReason(instanceId, model);
    if (reason) {
      toastManager.add({ type: "error", title: "Narration model not saved", description: reason });
      return;
    }
    updateSettings({ readAloudModelSelection: createModelSelection(instanceId, model, options) });
  };

  return (
    <SettingsRow
      serverScoped
      settingKeys={["readAloudModelSelection"]}
      {...searchableSetting("read-aloud-model")}
      description="Model that turns a response into a spoken explanation. A fast model starts audio sooner. Off uses the text generation model."
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {usesDedicatedModel && canEnable ? (
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel="Narration model"
              {...(environmentId
                ? {
                    onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                      void navigate({
                        to: "/settings/providers",
                        search: { environmentId, instanceId },
                      });
                    },
                  }
                : {})}
              getModelDisabledReason={disabledReason}
              onInstanceModelChange={(instanceId, model) => save(instanceId, model, undefined)}
            />
          ) : null}
          {usesDedicatedModel && canEnable && instanceEntry ? (
            <TraitsPicker
              provider={instanceEntry.driverKind}
              models={instanceEntry.models}
              model={selection.model}
              modelOptions={selection.options ?? []}
              allowPromptInjectedEffort={false}
              planModeEnabled={settings.planModeEnabled || selectsPlanAgent(selection.options)}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onModelOptionsChange={(options) =>
                save(selection.instanceId, selection.model, options)
              }
            />
          ) : null}
          <Switch
            checked={usesDedicatedModel}
            disabled={!usesDedicatedModel && !canEnable}
            onCheckedChange={(checked) => {
              if (!checked) {
                updateSettings({ readAloudModelSelection: null });
                return;
              }
              save(fallback.instanceId, fallback.model, fallback.options);
            }}
            aria-label="Use a separate narration model"
          />
        </div>
      }
    />
  );
}
