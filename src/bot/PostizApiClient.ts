import { BotConfig } from "../config";

export class PostizApiClient {
  constructor(private config: BotConfig) {}

  async askPostiz(accessToken: string, prompt: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.config.postiz.apiUrl}/public/ask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: accessToken,
        },
        body: JSON.stringify({ message: prompt }),
        // Bound the call so a hung Postiz endpoint can't wedge the AI-answer flow
        // indefinitely (IntercomClient time-boxes its calls the same way).
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error("Postiz API error: request timed out after 30s");
      }
      throw error;
    }

    if (!response.ok) {
      throw new Error(`Postiz API error: ${response.statusText}`);
    }

    const data = (await response.json()) as { response: string };
    return data.response;
  }
}
