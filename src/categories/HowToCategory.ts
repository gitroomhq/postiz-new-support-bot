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


}
