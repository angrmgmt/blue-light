const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const VOICES_URL =
  `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
const WSS_URL =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";

interface Voice {
  ShortName: string;
  Locale: string;
}

async function generateSecMsGec(trustedClientToken: string): Promise<string> {
  const ticks = BigInt(Math.floor(Date.now() / 1000)) + 11644473600n;
  const rounded = ticks - (ticks % 300n);
  const windowsTicks = rounded * 10000000n;

  const encoder = new TextEncoder();
  const data = encoder.encode(`${windowsTicks}${trustedClientToken}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function generateUUID(): string {
  return crypto.randomUUID();
}

async function fetchVoices(): Promise<Voice[]> {
  console.log("Fetching voices...");
  const response = await fetch(VOICES_URL);
  const voices = (await response.json()) as Voice[];
  console.log(`Found ${voices.length} voices.`);
  return voices;
}

async function synthesize(text: string, voiceName: string) {
  const connectionId = generateUUID();
  const secMsGec = await generateSecMsGec(TRUSTED_CLIENT_TOKEN);
  const url =
    `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-143.0.3650.96&ConnectionId=${connectionId}`;

  console.log("Connecting to WebSocket...");
  const ws = new WebSocket(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.3650.96",
      "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    },
  });

  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("WebSocket connected.");

    // 1. Send speech.config
    const configMessage =
      `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
      JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: {
                sentenceBoundaryEnabled: "false",
                wordBoundaryEnabled: "false",
              },
              outputFormat: "audio-24khz-48kbitrate-mono-mp3",
            },
          },
        },
      });
    ws.send(configMessage);

    // 2. Send SSML
    const ssmlMessage =
      `X-RequestId:${
        connectionId.replace(/-/g, "")
      }\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n` +
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
        <voice name="${voiceName}">
          ${text}
        </voice>
      </speak>`;
    ws.send(ssmlMessage);
  };

  let audioBuffer = new Uint8Array(0);

  ws.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (typeof data === "string") {
      const message = data;
      console.log("Received text message:", message.split("\r\n")[0]);
      if (message.includes("Path:turn.end")) {
        console.log("Synthesis finished.");
        console.log(`Total audio size: ${audioBuffer.length} bytes`);
        ws.close();
      }
    } else {
      const buffer = new Uint8Array(data as ArrayBuffer);
      const headerIndex = new TextDecoder().decode(buffer).indexOf(
        "Path:audio\r\n",
      );
      if (headerIndex !== -1) {
        const audioData = buffer.slice(
          headerIndex + "Path:audio\r\n".length + 2,
        ); // +2 for \r\n
        const newBuffer = new Uint8Array(audioBuffer.length + audioData.length);
        newBuffer.set(audioBuffer);
        newBuffer.set(audioData, audioBuffer.length);
        audioBuffer = newBuffer;
      }
    }
  };

  ws.onclose = () => {
    console.log("WebSocket closed.");
  };

  ws.onerror = (event) => {
    console.error("WebSocket error:", event);
  };

  // Wait for synthesis to complete (simple poll for this spike)
  while (ws.readyState !== WebSocket.CLOSED) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (audioBuffer.length > 0) {
    await Deno.writeFile("research/spike_output.mp3", audioBuffer);
    console.log("Saved audio to research/spike_output.mp3");
  }
}

async function main() {
  const voices = await fetchVoices();
  const usVoice = voices.find((v) => v.Locale === "en-US")?.ShortName ||
    "en-US-AndrewMultilingualNeural";
  console.log(`Using voice: ${usVoice}`);
  await synthesize(
    "Hello, this is a test of the Microsoft Edge Text to Speech API running in Deno.",
    usVoice,
  );
}

if (import.meta.main) {
  main();
}
