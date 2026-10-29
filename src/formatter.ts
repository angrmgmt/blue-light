import { CollaborativeContent } from "./parser.ts";

/**
 * Formats collaborative content into a clean plain text structure.
 *
 * Each entry is formatted as:
 * [Author]: [Text]
 *
 * @param data Array of collaborative content objects.
 * @returns Formatted plain text string.
 */
export function formatToPlainText(data: CollaborativeContent[]): string {
  return data
    .map((item) => {
      const author = item.author.trim();
      const text = item.text.trim();

      // Handle potential multiline text by indenting the following lines
      const formattedText = text.replace(/\n/g, "\n  ");

      return `${author}: ${formattedText}`;
    })
    .join("\n\n");
}
