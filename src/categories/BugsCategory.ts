import { BaseCategory } from "./BaseCategory";

export class BugsCategory extends BaseCategory {
  readonly id = "bugs";
  readonly label = "Report a Bug";
  readonly emoji = "🐛";
  readonly description = "Report an issue or bug";

  protected getInputLabel(): string {
    return "Describe the bug";
  }

  protected getInputPlaceholder(): string {
    return "e.g. When I try to schedule a post, the calendar doesn't load...";
  }

  protected buildPrompt(userInput: string): string {
    return `The user is reporting a bug in Postiz: "${userInput}". Search the codebase to investigate if this is a real bug. Acknowledge the issue, explain what you found, and suggest possible workarounds. Be empathetic and helpful.

IMPORTANT: If after searching the codebase you confirm this is likely a real bug, end your response with the exact marker: [BUG_CONFIRMED]`;
  }

  protected getColor(): number {
    return 0xed4245; // Red
  }
}
