import { BotConfig } from "../config";

export class GitHubClient {
  constructor(private config: BotConfig) {}

  async createIssue(title: string, body: string, labels: string[] = ["feature-request"], repoOverride?: string | null): Promise<string> {
    const [owner, repo] = (repoOverride || this.config.github.repo).split("/");

    // GitHub caps issue bodies at 65536 chars and titles at 256; clamp so a long
    // transcript can never make the API reject the whole request.
    const MAX_BODY = 65_536;
    if (body.length > MAX_BODY) {
      const notice = "\n\n*(truncated — GitHub length limit)*";
      body = body.slice(0, MAX_BODY - notice.length) + notice;
    }
    title = title.slice(0, 256);

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
