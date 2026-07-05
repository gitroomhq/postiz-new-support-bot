import { log } from "../util/logger";

export interface BotConfig {
  discord: {
    token: string;
    clientId: string;
    threadsChannelId: string;
    supportRoleId: string;
  };
  postiz: {
    frontendUrl: string;
    apiUrl: string;
    clientId: string;
    clientSecret: string;
  };
  github: {
    token: string;
    repo: string; // "owner/repo"
  };
  stripe: {
    secretKey: string;
    discountCouponId: string;
  };
  server: {
    port: number;
    callbackUrl: string;
  };
}

export function loadConfig(): BotConfig {
  // Hard requirements: the bot cannot run at all without these, so fail at
  // boot with a clear message instead of a cryptic error at first use.
  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  };

  // Everything else degrades gracefully (feature disabled / DB-seeded later);
  // warn once at boot so a misconfiguration is still visible.
  const optional = (key: string, fallback = ""): string => {
    const value = process.env[key];
    if (!value) {
      // Boot-time, pre-Sentry: this reaches stderr only, which is fine.
      log.child("config").warn("optional environment variable not set", { "config.key": key });
      return fallback;
    }
    return value;
  };

  return {
    discord: {
      token: required("DISCORD_TOKEN"),
      clientId: required("DISCORD_CLIENT_ID"),
      // threadsChannelId / supportRoleId are deprecated here: they only seed the
      // DB on first run (see SettingsStore). Runtime reads come from /config.
      threadsChannelId: optional("DISCORD_THREADS_CHANNEL_ID"),
      supportRoleId: optional("DISCORD_SUPPORT_ROLE_ID"),
    },
    postiz: {
      frontendUrl: optional("POSTIZ_FRONTEND_URL"),
      apiUrl: optional("POSTIZ_API_URL"),
      clientId: optional("POSTIZ_CLIENT_ID"),
      clientSecret: optional("POSTIZ_CLIENT_SECRET"),
    },
    github: {
      token: optional("GH_BOT_TOKEN"),
      repo: optional("GH_BOT_REPO"),
    },
    stripe: {
      secretKey: required("STRIPE_SECRET_KEY"),
      discountCouponId: optional("STRIPE_DISCOUNT_COUPON_ID"),
    },
    server: {
      port: parseInt(process.env.SERVER_PORT || "3000", 10),
      callbackUrl: optional("POSTIZ_CALLBACK_URL"),
    },
  };
}
