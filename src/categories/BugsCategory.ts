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


}
