# Read aloud

Read aloud explains an agent's reply out loud instead of making you read it. Apart from its opening sentences, which are read as written so the voice can start right away, it is not a verbatim reading: a model turns the rest of the reply into a short spoken explanation, block by block, the way a teammate would walk you through it on a call. It skips over code, paths, commands, and IDs, saying what they are or do instead, and summarizes tables and long lists. It works on web, including mobile browsers such as Safari on iPhone, and desktop. The T3 Code mobile app does not have it yet.

## Set it up

Read aloud uses [ElevenLabs](https://elevenlabs.io) for the voice. In **Settings → Integrations → Read aloud**, choose the environment and add your ElevenLabs API key. The key stays on that environment's host; clients never receive it. You can also pick a voice from your account (the play button beside each one plays a free sample) or paste any voice ID, choose the voice model (Flash is fastest to start), and set the default speed.

The explanation is written by the environment's text generation model. Turn on **Narration model** to use a different one. Turn on **Prepare narration in advance** to have each reply's narration written as soon as the reply finishes, so playback starts at once; it uses the narration model for every reply, including ones you never play. Replies from delegated tasks are skipped.

## Listen to a reply

Hover a finished reply and select the speaker button next to copy. T3 Code reads the reply's opening as written while the model explains the rest, then continues with the explanation as it is written, and highlights the part of the reply being explained, scrolling it into view as it goes. A bar above the composer shows the sentence being spoken, with previous, play or pause, next, speed, and stop. The speaker button pauses and resumes the reply that is playing.

On a phone, tap the speaker button under the reply. Narration keeps playing with the screen locked, and the lock screen and Control Center controls pause, skip, and stop it.

To listen to a markdown file, open it in the file preview and select the speaker button next to **Open in**. The explanation follows the file's sections, and a bar at the bottom of the preview holds the same controls. Opening another file or closing the preview stops it.

Press **Escape** to stop. Switching threads also stops it, and only one reply plays at a time.

Each narration and its audio are cached on the environment, so listening to the same reply again starts immediately and spends no credits. Changing the voice, voice model, or narration model makes a new narration.
