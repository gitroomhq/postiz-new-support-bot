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
  const required = (key: string): string => {
    const value = process.env[key];
    return value!;
    // if (!value) {
    //   throw new Error(`Missing required environment variable: ${key}`);
    // }
    // return value;
  };

  return {
    discord: {
      token: required("DISCORD_TOKEN"),
      clientId: required("DISCORD_CLIENT_ID"),
      threadsChannelId: required("DISCORD_THREADS_CHANNEL_ID"),
      supportRoleId: required("DISCORD_SUPPORT_ROLE_ID"),
    },
    postiz: {
      frontendUrl: required("POSTIZ_FRONTEND_URL"),
      apiUrl: required("POSTIZ_API_URL"),
      clientId: required("POSTIZ_CLIENT_ID"),
      clientSecret: required("POSTIZ_CLIENT_SECRET"),
    },
    github: {
      token: required("GH_BOT_TOKEN"),
      repo: required("GH_BOT_REPO"),
    },
    stripe: {
      secretKey: required("STRIPE_SECRET_KEY"),
      discountCouponId: required("STRIPE_DISCOUNT_COUPON_ID"),
    },
    server: {
      port: parseInt(process.env.SERVER_PORT || "3000", 10),
      callbackUrl: required("POSTIZ_CALLBACK_URL"),
    },
  };
}
