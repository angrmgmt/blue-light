# Edge TTS Research Findings

## Endpoints

- **Voices List**:
  `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4`
- **WebSocket**:
  `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`

## Connection Requirements

- **Trusted Client Token**: `6A5AA1D4EAFF4E9FB37E23D68491D6F4`
- **Sec-MS-GEC**: A calculated token based on current time (rounded to 5
  minutes) and the trusted client token.
- **Sec-MS-GEC-Version**: Must match the Edge version in the User-Agent (e.g.,
  `1-143.0.3650.96`).
- **Headers**:
  - `User-Agent`: A recent Edge browser user agent (e.g.,
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.3650.96`).
  - `Origin`: `chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold`

## Protocol Flow

1. **Connect**: Establish WebSocket connection with query parameters:
   - `TrustedClientToken`
   - `Sec-MS-GEC`
   - `Sec-MS-GEC-Version` (e.g., `1-130.0.2849.68`)
   - `ConnectionId` (Random UUID)
2. **Configure**: Send a `speech.config` message in JSON format.
3. **Synthesize**: Send an `ssml` message containing the SSML text.
4. **Receive**:
   - `turn.start`: Indicates the start of a synthesis turn.
   - `audio`: Binary messages containing the audio data. These start with a text
     header followed by the raw audio bytes.
   - `turn.end`: Indicates the completion of the turn.

## Data Formats

- **Control Messages**: Text-based with custom headers (e.g.,
  `Path:speech.config`).
- **Audio Data**: Binary (often MP3 or opus depending on configuration).
- **SSML**: XML-based markup for specifying voice, rate, pitch, and text.
