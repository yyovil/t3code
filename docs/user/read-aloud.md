# Read aloud

Read aloud explains an agent's reply out loud instead of making you read it. It is not a verbatim reading: a model turns the reply into a short spoken explanation, block by block, the way a teammate would walk you through it on a call. It skips over code, paths, commands, and IDs, saying what they are or do instead, and summarizes tables and long lists. It works on web and desktop.

## Set it up

Read aloud uses [ElevenLabs](https://elevenlabs.io) for the voice. In **Settings → Integrations → Read aloud**, choose the environment and add your ElevenLabs API key. The key stays on that environment's host; clients never receive it. You can also pick a voice from your account or paste any voice ID, choose the voice model (Flash is fastest to start), and set the default speed.

The explanation is written by the environment's text generation model. Turn on **Narration model** to use a different one; a fast model gets audio started sooner.

## Listen to a reply

Hover a finished reply and select the speaker button next to copy. T3 Code prepares the narration, starts playing as soon as the first part is ready, and highlights the part of the reply being explained, scrolling it into view as it goes. A bar above the composer shows the sentence being spoken, with previous, play or pause, next, speed, and stop. The speaker button pauses and resumes the reply that is playing.

Press **Escape** to stop. Switching threads also stops it, and only one reply plays at a time.

Each narration and its audio are cached on the environment, so listening to the same reply again starts immediately and spends no credits. Changing the voice, voice model, or narration model makes a new narration.
