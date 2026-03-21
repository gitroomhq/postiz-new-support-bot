import { BotConfig } from "../config";

export class PostizApiClient {
  constructor(private config: BotConfig) {}

  async askPostiz(accessToken: string, prompt: string): Promise<string> {
    const response = await fetch(`${this.config.postiz.apiUrl}/public/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: accessToken,
      },
      body: JSON.stringify({ message: prompt }),
    });

    if (!response.ok) {
      throw new Error(`Postiz API error: ${response.statusText}`);
    }

    const data = (await response.json()) as { response: string };
    return data.response;
  }
}
