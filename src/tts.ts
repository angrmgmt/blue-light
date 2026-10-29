import { EdgeTTS } from "@andresaya/edge-tts";
import { StorySegment } from "./parser.ts";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const VOICES_URL =
  `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

export interface VoiceTag {
  ContentCategories?: string[];
  VoicePersonalities?: string[];
}

export interface Voice {
  Name: string;
  ShortName: string;
  Gender: string;
  Locale: string;
  SuggestedCodec: string;
  FriendlyName: string;
  Status: string;
  VoiceTag?: VoiceTag;
}

export interface VoiceMapping {
  [character: string]: string; // character name to Voice ShortName
}

export async function fetchVoices(): Promise<Voice[]> {
  const response = await fetch(VOICES_URL);
  return await response.json();
}

export async function synthesize(
  text: string,
  voiceName: string,
  timeoutMs = 30000,
): Promise<Uint8Array> {
  const tts = new EdgeTTS({ timeout: timeoutMs });
  const result = await tts.generate(text, voiceName);
  return new Uint8Array(result.audio);
}

/**
 * Maximum number of attempts (1 initial + retries) per segment.
 */
const MAX_ATTEMPTS = 3;
/**
 * Backoff waits between retry attempts (milliseconds).
 */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/** Sleep for `ms` milliseconds. Exposed for tests via module export. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Synthesizes one segment with bounded retry on failure.
 *
 * Retries on:
 *   - thrown errors from `synthesizeFn` (timeouts, websocket errors)
 *   - empty audio buffer returned without an error (connection dropped early)
 *
 * Returns the audio from the first successful attempt, or `null` after the
 * final attempt has failed. Callers should record a placeholder empty buffer
 * for `null` so segment ordering in the merged output stays aligned.
 */
async function synthesizeWithRetry(
  text: string,
  voice: string,
  index: number,
  _total: number,
  speaker: string,
  synthesizeFn: (text: string, voice: string) => Promise<Uint8Array>,
): Promise<Uint8Array | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const audio = await synthesizeFn(text, voice);
      if (audio.length > 0) return audio;
      console.error(
        `Error synthesizing segment ${
          index + 1
        } (attempt ${attempt}/${MAX_ATTEMPTS}): empty audio returned`,
      );
    } catch (err) {
      console.error(
        `Error synthesizing segment ${
          index + 1
        } (attempt ${attempt}/${MAX_ATTEMPTS}):`,
        err,
      );
    }

    if (attempt < MAX_ATTEMPTS) {
      const wait = RETRY_DELAYS_MS[attempt - 1] ?? 4000;
      console.log(
        `Retrying segment ${index + 1} in ${wait}ms...`,
      );
      await sleep(wait);
    }
  }
  console.error(
    `Giving up on segment ${
      index + 1
    } (${speaker}) after ${MAX_ATTEMPTS} attempts.`,
  );
  return null;
}

/**
 * Synthesizes multiple segments into a single audio file.
 * Uses parallel synthesis with a worker pool; each segment is retried up to
 * `MAX_ATTEMPTS` times on transient errors before being skipped.
 *
 * `synthesizeFn` is injectable for tests; production callers can omit it.
 */
export async function synthesizeStory(
  segments: StorySegment[],
  mapping: VoiceMapping,
  concurrency = 5,
  synthesizeFn: (
    text: string,
    voice: string,
  ) => Promise<Uint8Array> = synthesize,
): Promise<Uint8Array> {
  const results = new Array<Uint8Array>(segments.length);
  const queue = segments.map((s, i) => ({ segment: s, index: i }));

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      const { segment, index } = item;
      const voice = mapping[segment.speaker] || mapping["Narrator"];

      if (!voice) {
        console.warn(`No voice mapped for ${segment.speaker}, skipping.`);
        results[index] = new Uint8Array(0);
        continue;
      }

      console.log(
        `Synthesizing [${segment.speaker}] (${index + 1}/${segments.length}): ${
          segment.text.slice(0, 30)
        }...`,
      );

      const audio = await synthesizeWithRetry(
        segment.text,
        voice,
        index,
        segments.length,
        segment.speaker,
        synthesizeFn,
      );

      if (audio) {
        results[index] = audio;
        console.log(
          `Completed [${segment.speaker}] (${
            index + 1
          }/${segments.length}): ${audio.length} bytes`,
        );
      } else {
        // Preserve segment ordering by inserting an empty placeholder.
        results[index] = new Uint8Array(0);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, segments.length) },
    () => worker(),
  );
  await Promise.all(workers);

  // Merge results
  const totalLength = results.reduce((acc, r) => acc + r.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const r of results) {
    result.set(r, offset);
    offset += r.length;
  }

  return result;
}

/** Extracts the short display name from a ShortName, e.g. "en-US-AvaNeural" → "Ava". */
export function voiceDisplayName(voice: Voice): string {
  const match = voice.ShortName.match(/-([A-Za-z]+?)(?:Neural|Multilingual)*$/);
  return match ? match[1] : voice.ShortName;
}

/** True if the voice's tags suit long-form narration (news / audiobook style). */
function isNarrationVoice(voice: Voice): boolean {
  const cats = voice.VoiceTag?.ContentCategories ?? [];
  return cats.some((c) => /news|novel|narration|audiobook/i.test(c));
}

/** Rough score of how expressive/characterful a voice is, for dialogue roles. */
function expressivenessScore(voice: Voice): number {
  const traits = voice.VoiceTag?.VoicePersonalities ?? [];
  const desirable =
    /expressive|caring|pleasant|cheerful|warm|friendly|confident|bright/i;
  return traits.filter((t) => desirable.test(t)).length;
}

/**
 * Returns en-US voices, optionally narrowing by gender ("Male"/"Female").
 * Falls back to all en-US voices if the gender filter is empty.
 */
function enUsVoicePool(voices: Voice[], gender?: string): Voice[] {
  const enUs = voices.filter((v) => v.Locale.startsWith("en-US"));
  if (!gender) return enUs;
  const filtered = enUs.filter((v) => v.Gender === gender);
  return filtered.length > 0 ? filtered : enUs;
}

/**
 * Auto-assigns a distinct voice to each character using the voice metadata.
 *
 * - The Narrator gets a narration-suited voice (news/novel content category).
 * - Each character gets a distinct, expressive voice; a character whose name
 *   matches a voice's own name (e.g. "Ava") is paired with that voice.
 * - Assignment alternates female/male voices for variety. Natural (Multilingual)
 *   voices are preferred and candidates are shuffled on every run.
 */
export async function autoAssignVoices(
  characters: string[],
): Promise<VoiceMapping> {
  return assignVoices(characters, await fetchVoices());
}

/** Fisher–Yates shuffle returning a new array. */
function shuffled<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Pure voice assignment. Prefers natural (Multilingual) en-US voices, falling
 * back to all en-US voices if there are none. Candidates are shuffled with
 * `rng` (stable sort keeps expressiveness as a bias) so runs vary.
 */
export function assignVoices(
  characters: string[],
  voices: Voice[],
  rng: () => number = Math.random,
): VoiceMapping {
  const allEnUs = enUsVoicePool(voices);
  const natural = allEnUs.filter((v) => v.ShortName.includes("Multilingual"));
  const enUs = shuffled(natural.length > 0 ? natural : allEnUs, rng);
  const mapping: VoiceMapping = {};
  const used = new Set<string>();

  // Narrator: prefer a narration-suited voice, else the most expressive one.
  const narrator = enUs.find(isNarrationVoice) ??
    [...enUs].sort((a, b) =>
      expressivenessScore(b) - expressivenessScore(a)
    )[0];
  if (narrator) {
    mapping["Narrator"] = narrator.ShortName;
    used.add(narrator.ShortName);
  }

  // Character voice pools (already shuffled), split by gender.
  const byExpr = enUs;
  const genderPools: Record<string, Voice[]> = {
    Female: byExpr.filter((v) => v.Gender === "Female"),
    Male: byExpr.filter((v) => v.Gender === "Male"),
  };
  const genderOrder = ["Female", "Male"];
  let genderIdx = 0;

  const nextVoice = (): Voice | undefined => {
    for (let tries = 0; tries < genderOrder.length; tries++) {
      const pool =
        genderPools[genderOrder[(genderIdx + tries) % genderOrder.length]];
      const pick = pool.find((v) => !used.has(v.ShortName));
      if (pick) {
        genderIdx = (genderIdx + tries + 1) % genderOrder.length;
        return pick;
      }
    }
    // All distinct voices exhausted — reuse from the full expressive list.
    return byExpr.find((v) => v.ShortName !== narrator?.ShortName) ?? enUs[0];
  };

  for (const char of characters) {
    if (char === "Narrator" || mapping[char]) continue;

    // Name match: character "Ava" → the Ava voice.
    const named = enUs.find(
      (v) => voiceDisplayName(v).toLowerCase() === char.toLowerCase(),
    );
    const voice = named && !used.has(named.ShortName) ? named : nextVoice();
    if (!voice) continue;
    mapping[char] = voice.ShortName;
    used.add(voice.ShortName);
  }

  return mapping;
}

/** One-line human-readable summary of a voice, for browsing/prompts. */
export function formatVoiceLine(voice: Voice): string {
  const traits = voice.VoiceTag?.VoicePersonalities?.join(", ") || "—";
  const cats = voice.VoiceTag?.ContentCategories?.join(", ") || "—";
  const ml = voice.ShortName.includes("Multilingual") ? " (ML)" : "";
  const label = `${voiceDisplayName(voice)}${ml}`;
  return `${label.padEnd(16)} ${voice.Gender.padEnd(6)} ` +
    `[${cats}] traits: ${traits}`;
}

/**
 * Fetches the available voices for browsing. By default, returns en-US voices;
 * pass a locale prefix (e.g. "en", "fr-FR") to widen or change the selection,
 * or "all" for every voice.
 */
export async function listVoices(localePrefix = "en-US"): Promise<Voice[]> {
  const voices = await fetchVoices();
  if (localePrefix === "all") return voices;
  return voices.filter((v) => v.Locale.startsWith(localePrefix));
}

/**
 * Prompts the user to assign voices to characters.
 * (Simple CLI version)
 */
export async function promptAssignVoices(
  characters: string[],
): Promise<VoiceMapping> {
  const voices = await fetchVoices();
  const enUsVoices = enUsVoicePool(voices);
  const mapping: VoiceMapping = {};

  console.log("\n--- Voice Assignment ---");
  enUsVoices.forEach((v, i) => {
    console.log(`  ${String(i).padStart(2)}: ${formatVoiceLine(v)}`);
  });

  for (const char of characters) {
    const response = prompt(
      `\nChoose voice index for "${char}" (default 0):`,
    );
    const index = parseInt(response || "0");
    const voice = enUsVoices[index % enUsVoices.length];
    mapping[char] = voice.ShortName;
    console.log(`  → ${char}: ${voiceDisplayName(voice)}`);
  }

  return mapping;
}
