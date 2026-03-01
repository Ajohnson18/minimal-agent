/**
 * Test markdown table rendering (always uses code mode)
 */
import { markdownToSlackMrkdwn } from "../lib/slack/format.js";

const testMarkdown = `
Here's a table:

| Name | Age | City |
|------|-----|------|
| John | 25  | NYC  |
| Jane | 30  | LA   |

And some regular text after.
`;

console.log("=== Table rendered as code block (default) ===");
const result = markdownToSlackMrkdwn(testMarkdown);
console.log(result);
console.log();

// Test spoiler
const spoilerMarkdown = "This is ||a spoiler|| text.";
console.log("=== Spoiler test ===");
console.log(markdownToSlackMrkdwn(spoilerMarkdown));
