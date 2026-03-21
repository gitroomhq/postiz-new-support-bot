import { BaseCategory } from "./BaseCategory";

export class HowToCategory extends BaseCategory {
  readonly id = "howto";
  readonly label = "How do I do this?";
  readonly emoji = "❓";
  readonly description = "Get help with using Postiz features";

  protected getInputLabel(): string {
    return "What do you need help with?";
  }

  protected getInputPlaceholder(): string {
    return "e.g. How do I schedule a post to multiple platforms?";
  }

  protected buildPrompt(userInput: string): string {
    return `The user needs help with Postiz. They are asking: "${userInput}". Search the codebase and documentation to find the answer. Provide a clear, step-by-step answer. Be concise and helpful.

IMPORTANT: If after searching the codebase and docs you determine that this feature does NOT exist in Postiz, end your response with the exact marker: [FEATURE_NOT_FOUND]`;
  }

  protected getColor(): number {
    return 0x5865f2; // Discord blurple
  }
}
