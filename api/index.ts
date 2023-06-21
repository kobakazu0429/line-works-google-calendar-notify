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
app.onError((error, c) => {
  console.error(error);
  return c.text("error", 500);
});

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

  console.log("watchStart: ", {
    GOOGLE_CALENDAR_ID: e.GOOGLE_CALENDAR_ID,
    webhookUrl: webhookUrl.toString(),
    WEB_HOOK_TOKEN: e.WEB_HOOK_TOKEN,
  });

  await watchStart(
    $client,
    e.GOOGLE_CALENDAR_ID,
    webhookUrl.toString(),
    e.WEB_HOOK_TOKEN
  );

  return c.text("ok");
});

app.get("/del", async (c) => {
  const isForce = c.req.query("f") === "";

  const e = refineEnv(process.env);

  const $client = client(
    e.GOOGLE_CLIENT_EMAIL,
    e.GOOGLE_PRIVATE_KEY,
    e.GOOGLE_PROJECT_NUMBER
  );

  const channelIds = await kv.keys(WATCH_ID_PREFIX + "*");

  const deletedWatchKV = [] as string[];
  const deletedKV = [] as string[];
  const failed = [] as string[];

  for await (const removeId of channelIds) {
    const channel = await kv.get<Channel>(removeId);
    if (!channel) throw new Error(`channel is not found: id=${removeId}`);
    try {
      await watchStop(
        $client,
        e.WEB_HOOK_TOKEN,
        channel.resourceId,
        channel.channelId
      );
      const result = await kv.del(removeId);
      if (result === 0) throw new Error(`Not Found: ${removeId}`);
      console.log("deleted(watch, kv): ", removeId);
      deletedWatchKV.push(removeId);
    } catch (error) {
      // @ts-expect-error
      if (isForce && error.code === 404) {
        const result = await kv.del(removeId);
        if (result === 0) throw new Error(`Not Found: ${removeId}`);
        console.log("deleted(kv): ", removeId);
        deletedKV.push(removeId);
      } else {
        console.log("delet failed: ", removeId);
        failed.push(removeId);
      }
    }
  }

  return c.json({ deletedWatchKV, deletedKV, failed });
});

app.post("/calendar", async (c) => {
  console.log(Array.from(c.req.headers.entries()));
  const e = refineEnv(process.env);

  const xGoogChannelToken = c.req.headers.get("X-Goog-Channel-Token");
  if (e.WEB_HOOK_TOKEN !== xGoogChannelToken) {
    throw new Error(`X-Goog-Channel-Token is missing: ${xGoogChannelToken}`);
  }

  const xGoogResourceState = c.req.headers.get("X-Goog-Resource-State");
  if (!validateXGoogResourceState(xGoogResourceState)) {
    throw new Error(
      `X-Goog-Resource-State is not sync or exsits: ${xGoogResourceState}`
    );
  }

  const xGoogResourceId = c.req.headers.get("X-Goog-Resource-Id");
  if (!xGoogResourceId || xGoogResourceId === "") {
    throw new Error(`X-Goog-Resource-Id is not exsits: ${xGoogResourceId}`);
  }

  const xGoogChannelExpiration = c.req.headers.get("X-Goog-Channel-Expiration");
  if (!xGoogChannelExpiration || xGoogChannelExpiration === "") {
    throw new Error(
      `X-Goog-Channel-Expiration is not exsits: ${xGoogChannelExpiration}`
    );
  }

  const xGoogChannelId = c.req.headers.get("X-Goog-Channel-Id");
  if (!xGoogChannelId || xGoogChannelId === "") {
    throw new Error(`x-goog-channel-id is not exsits: ${xGoogChannelId}`);
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
      if (!channel) throw new Error(`channel is not found: id=${removeId}`);

      await watchStop(
        $client,
        e.WEB_HOOK_TOKEN,
        channel.resourceId,
        channel.channelId
      );
      const result = await kv.del(removeId);
      if (result === 0) throw new Error(`Not Found: ${removeId}`);
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
    const nextSyncToken = await kv.get<string>(NEXT_SYNC_TOKEN_KEY);
    console.log({ nextSyncToken });

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

    console.log(JSON.stringify($list.data.items));

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
  }

  return c.text("ok");
});

export default handle(app);
