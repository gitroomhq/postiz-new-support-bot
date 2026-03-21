import { BotConfig } from "../config";

export class GitHubClient {
  constructor(private config: BotConfig) {}

  async createIssue(title: string, body: string, labels: string[] = ["feature-request"]): Promise<string> {
    const [owner, repo] = this.config.github.repo.split("/");

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.github.token}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, body, labels }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`GitHub API error: ${(error as any).message || response.statusText}`);
    }

    const data = (await response.json()) as { html_url: string };
    return data.html_url;
  }
}
