import { Hono, type Env } from "hono";
import { logger } from "hono/logger";
import { handle } from "@hono/node-server/vercel";
import { kv } from "@vercel/kv";
import {
  client,
  list,
  format,
  watchStart,
  watchStop,
  WATCH_ID_PREFIX,
  validateXGoogResourceState,
  refineNextSyncToken,
  type Channel,
} from "../src/calendar.js";
import { getAuthToken, postCalendar } from "../src/lineworks.js";

const ENV_KEYS = [
  "HOST_URL",
  "WEB_HOOK_TOKEN",
  "GOOGLE_PRIVATE_KEY",
  "GOOGLE_CLIENT_EMAIL",
  "GOOGLE_PROJECT_NUMBER",
  "GOOGLE_CALENDAR_ID",
  "LINEWORKS_CLIENT_ID",
  "LINEWORKS_CLIENT_SECRET",
  "LINEWORKS_PRIVATE_KEY",
  "LINEWORKS_SERVICE_ACCOUNT",
  "LINEWORKS_BOT_ID",
  "LINEWORKS_CHANNEL_ID",
] as const;

interface MyEnv extends Env {
  Bindings: {
    HOST_URL: string;
    WEB_HOOK_TOKEN: string;
    GOOGLE_PRIVATE_KEY: string;
    GOOGLE_CLIENT_EMAIL: string;
    GOOGLE_PROJECT_NUMBER: string;
    GOOGLE_CALENDAR_ID: string;
    LINEWORKS_CLIENT_ID: string;
    LINEWORKS_CLIENT_SECRET: string;
    LINEWORKS_PRIVATE_KEY: string;
    LINEWORKS_SERVICE_ACCOUNT: string;
    LINEWORKS_BOT_ID: string;
    LINEWORKS_CHANNEL_ID: string;
  };
}

const NEXT_SYNC_TOKEN_KEY = "next_sync_token";

const app = new Hono<MyEnv>().basePath("/api");

app.use("*", logger());

const refineEnv = (obj: any): MyEnv["Bindings"] => {
  return Object.fromEntries(
    ENV_KEYS.map((key) => [key, obj[key]])
  ) as MyEnv["Bindings"];
};

app.get("/", (c) => c.text("Hello Hono!"));

app.get("/cron", async (c) => {
  const e = refineEnv(process.env);

  const $client = client(
    e.GOOGLE_CLIENT_EMAIL,
    e.GOOGLE_PRIVATE_KEY,
    e.GOOGLE_PROJECT_NUMBER
  );

  const base = e.HOST_URL;
  const pathname = "/api/calendar";
  const webhookUrl = new URL(pathname, base);

  await watchStart(
    $client,
    e.GOOGLE_CALENDAR_ID,
    webhookUrl.toString(),
    e.WEB_HOOK_TOKEN
  );

  return c.text("ok");
});

app.post("/calendar", async (c) => {
  console.log(Array.from(c.req.headers.entries()));
  const e = refineEnv(process.env);

  const xGoogChannelToken = c.req.headers.get("X-Goog-Channel-Token");
  if (e.WEB_HOOK_TOKEN !== xGoogChannelToken) {
    return c.text(`X-Goog-Channel-Token is missing: ${xGoogChannelToken}`, 500);
  }

  const xGoogResourceState = c.req.headers.get("X-Goog-Resource-State");
  if (!validateXGoogResourceState(xGoogResourceState)) {
    return c.text(
      `X-Goog-Resource-State is not sync or exsits: ${xGoogResourceState}`,
      500
    );
  }

  const xGoogResourceId = c.req.headers.get("X-Goog-Resource-Id");
  if (!xGoogResourceId || xGoogResourceId === "") {
    return c.text(`X-Goog-Resource-Id is not exsits: ${xGoogResourceId}`, 500);
  }
  const xGoogChannelExpiration = c.req.headers.get("X-Goog-Channel-Expiration");
  if (!xGoogChannelExpiration || xGoogChannelExpiration === "") {
    return c.text(
      `X-Goog-Channel-Expiration is not exsits: ${xGoogChannelExpiration}`,
      500
    );
  }
  const xGoogChannelId = c.req.headers.get("X-Goog-Channel-Id");
  if (!xGoogChannelId || xGoogChannelId === "") {
    return c.text(`x-goog-channel-id is not exsits: ${xGoogChannelId}`, 500);
  }

  const $client = client(
    e.GOOGLE_CLIENT_EMAIL,
    e.GOOGLE_PRIVATE_KEY,
    e.GOOGLE_PROJECT_NUMBER
  );

  if (xGoogResourceState === "sync" /* watch start */) {
    const channelIds = await kv.keys(
      WATCH_ID_PREFIX + xGoogResourceId + ":" + "*"
    );
    const newId = WATCH_ID_PREFIX + xGoogResourceId + ":" + xGoogChannelId;
    const removeIds = channelIds.filter((key) => key !== newId);
    for await (const removeId of removeIds) {
      const channel = await kv.get<Channel>(removeId);
      if (channel) {
        try {
          await watchStop(
            $client,
            e.WEB_HOOK_TOKEN,
            channel.resourceId,
            channel.channelId
          );
          const result = await kv.del(removeId);
          if (result === 0) throw new Error(`Not Found: ${removeId}`);
        } catch (error) {
          console.error(error);
        }
      }
    }
    const expiration = new Date(xGoogChannelExpiration).getTime();
    const ttlMilliseconds = expiration - Date.now();
    await kv.set(
      newId,
      JSON.stringify({
        channelId: xGoogChannelId,
        resourceId: xGoogResourceId,
        expiration,
      }),
      { px: ttlMilliseconds }
    );
  } else if (xGoogResourceState === "exists" /* web_hook */) {
    try {
      const nextSyncToken = await kv.get<string>(NEXT_SYNC_TOKEN_KEY);

      const token = getAuthToken({
        clientId: e.LINEWORKS_CLIENT_ID,
        clientSecret: e.LINEWORKS_CLIENT_SECRET,
        privateKey: e.LINEWORKS_PRIVATE_KEY,
        serviceAccount: e.LINEWORKS_SERVICE_ACCOUNT,
      });

      const $list = await list(
        $client,
        e.GOOGLE_CALENDAR_ID,
        refineNextSyncToken(nextSyncToken)
      );

      if ($list.data.items) {
        for (const event of $list.data.items) {
          await postCalendar(
            e.LINEWORKS_BOT_ID,
            e.LINEWORKS_CHANNEL_ID,
            (
              await token
            ).access_token,
            format(event)
          );
        }
      }

      await kv.set(NEXT_SYNC_TOKEN_KEY, $list.data.nextSyncToken ?? "");
      return c.text("ok");
    } catch (error) {
      console.error(error);
      return c.text("error");
    }
  }
});

export default handle(app);
