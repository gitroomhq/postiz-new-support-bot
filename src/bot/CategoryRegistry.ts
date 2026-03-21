import { BaseCategory } from "../categories";

export class CategoryRegistry {
  private categories = new Map<string, BaseCategory>();

  register(category: BaseCategory): this {
    this.categories.set(category.id, category);
    return this;
  }

  getAll(): BaseCategory[] {
    return Array.from(this.categories.values());
  }

  findByModalId(modalId: string): BaseCategory | undefined {
    return this.getAll().find((c) => c.modalId === modalId);
  }
}
