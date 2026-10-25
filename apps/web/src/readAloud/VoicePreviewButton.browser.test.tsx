import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { VoicePreviewButton } from "./VoicePreviewButton";

const voices = [
  { voiceId: "a", name: "Ada", previewUrl: "https://cdn.test/ada.mp3" },
  { voiceId: "b", name: "Bea", previewUrl: "https://cdn.test/bea.mp3" },
];

describe("VoicePreviewButton", () => {
  it("plays a sample from the voice list without choosing that voice", async () => {
    const onValueChange = vi.fn();
    using play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    await using screen = await render(
      <Select value="a" onValueChange={onValueChange}>
        <SelectTrigger aria-label="Voice">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {voices.map((voice) => (
            <SelectItem key={voice.voiceId} value={voice.voiceId}>
              <VoicePreviewButton name={voice.name} previewUrl={voice.previewUrl} />
              {voice.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>,
      // Nothing here navigates.
      { router: false },
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Voice" }));
    await userEvent.click(page.getByRole("button", { name: "Play Bea sample" }));

    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.contexts[0]).toMatchObject({ src: "https://cdn.test/bea.mp3" });
    await expect.element(page.getByRole("button", { name: "Stop Bea sample" })).toBeVisible();
    expect(onValueChange).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole("button", { name: "Stop Bea sample" }));
    await expect.element(page.getByRole("button", { name: "Play Bea sample" })).toBeVisible();
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
