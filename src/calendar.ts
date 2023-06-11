import { google } from "googleapis";
import { type calendar_v3 } from "googleapis/build/src/apis/calendar";

type Client = calendar_v3.Calendar;
type Events = calendar_v3.Schema$Events;

// 7 days
export const DEFAULT_EXPIRES_DURATION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

export type XGoogResourceState = "sync" | "exists";

export type Channel = {
  channelId: string;
  resourceId: string;
  expiration: number;
};

export const validateXGoogResourceState = (
  header: string | null
): header is XGoogResourceState => {
  if (header === "sync" || header === "exists") return true;
  return false;
};

export const refineNextSyncToken = (
  nextSyncToken: string | null | undefined | unknown
) => {
  if (typeof nextSyncToken === "string" && nextSyncToken !== "") {
    return nextSyncToken;
  }
  return undefined;
};

export const client = (email: string, key: string, project: string) => {
  // @ts-expect-error
  const auth = new google.auth.JWT(email, null, key, [
    "https://www.googleapis.com/auth/calendar.readonly",
  ]);

  // @ts-expect-error
  const client = google.calendar({
    version: "v3",
    auth,
    project,
  });

  return client;
};

export const list = async (
  client: Client,
  calendarId: string,
  syncToken?: string
) => {
  const list = await client.events.list({
    calendarId,
    syncToken,
    showDeleted: true,
  });
  return list;
};

export const WATCH_ID_PREFIX = "watch-";

export const watchStart = async (
  client: Client,
  calendarId: string,
  webhookUrl: string,
  webhookToken: string
) => {
  const result = await client.events.watch({
    calendarId,
    requestBody: {
      id: Date.now().toString(),
      type: "web_hook",
      address: webhookUrl,
      token: webhookToken,
    },
  });

  return result;
};

export const watchStop = async (
  client: Client,
  token: string,
  resourceId: string,
  id: string
) => {
  await client.channels.stop({
    requestBody: {
      resourceId,
      id,
      token,
    },
  });
};

const dateFormatter = new Intl.DateTimeFormat("ja", {
  dateStyle: "medium",
  timeStyle: "medium",
});

export const format = (events: Events): string => {
  return events
    .items!.map((event) => {
      const status = event.status === "cancelled" ? "キャンセル" : "作成/更新";

      const start = (() => {
        if (event.start?.date) {
          return event.start?.date;
        } else {
          const d = new Date(event.start?.dateTime!);
          d.setHours(d.getHours() + 9);
          return dateFormatter.format(d);
        }
      })();

      const end = (() => {
        if (event.end?.date) {
          const d = new Date(event.end?.date);
          d.setDate(d.getDate() - 1);
          return d.toISOString().slice(0, 10);
        } else {
          const d = new Date(event.end?.dateTime!);
          d.setHours(d.getHours() + 9);
          return dateFormatter.format(d);
        }
      })();

      return `「${event.summary}」が${status}されました
時間: ${start} 〜 ${end}
詳細: ${event.description ?? "無し"}
編集者: ${event.creator?.displayName ?? event.creator?.email}`;
    })
    .join("\n\n");
};
