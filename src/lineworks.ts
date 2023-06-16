import jwt from "jsonwebtoken";

export type AuthTokenOptions = {
  clientId: string;
  clientSecret: string;
  privateKey: string;
  serviceAccount: string;
};

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: "Bearer";
  expires_in: /* [s] */ string;
};

export const getAuthToken = async ({
  clientId,
  serviceAccount,
  privateKey,
  clientSecret,
}: AuthTokenOptions) => {
  const now = Math.trunc(Date.now() / 1000);
  const token = jwt.sign(
    {
      iss: clientId,
      sub: serviceAccount,
      iat: now,
      exp: now + 60 * 60,
    },
    privateKey,
    { algorithm: "RS256" }
  );

  const params = new URLSearchParams();
  params.append("assertion", token);
  params.append("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);
  params.append("scope", "bot");
  const res = await fetch("https://auth.worksmobile.com/oauth2/v2.0/token", {
    method: "post",
    body: params,
  });

  const data = (await res.json()) as TokenResponse;
  return data;
};

const postMessages = async (
  botId: string,
  channelId: string,
  token: string,
  content: any
) => {
  const res = await fetch(
    `https://www.worksapis.com/v1.0/bots/${botId}/channels/${channelId}/messages`,
    {
      method: "post",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        content,
      }),
    }
  );
  return res.status === 201;
};

export const postText = async (
  botId: string,
  channelId: string,
  token: string,
  text: string
) => {
  return postMessages(botId, channelId, token, { type: "text", text });
};

export const postCalendar = async (
  botId: string,
  channelId: string,
  token: string,
  event: {
    name: string;
    status: string;
    date: string;
    description: string;
    editor: string;
  }
) => {
  return postMessages(botId, channelId, token, {
    type: "flex",
    contents: {
      type: "bubble",
      size: "giga",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: `${event.name} (${event.status})`,
            wrap: true,
            weight: "bold",
            size: "xl",
            color: "#222222",
            margin: "none",
          },
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "text",
                text: "時間",
                wrap: true,
                flex: 3,
                size: "xs",
                color: "#989898",
              },
              {
                type: "text",
                text: event.date,
                wrap: true,
                size: "xs",
                margin: "md",
                flex: 7,
                color: "#222222",
                align: "start",
                style: "normal",
              },
            ],
            margin: "xxl",
          },
          {
            type: "box",
            layout: "baseline",
            contents: [
              {
                type: "text",
                text: "詳細",
                wrap: true,
                flex: 3,
                size: "xs",
                color: "#989898",
              },
              {
                type: "text",
                text: event.description,
                wrap: true,
                size: "xs",
                margin: "md",
                color: "#0E71EB",
                flex: 7,
              },
            ],
            margin: "md",
          },
          {
            type: "box",
            layout: "baseline",
            contents: [
              {
                type: "text",
                text: "編集者",
                wrap: true,
                flex: 3,
                size: "xs",
                color: "#989898",
              },
              {
                type: "text",
                text: event.editor,
                wrap: true,
                size: "xs",
                margin: "md",
                flex: 7,
                color: "#222222",
              },
            ],
            margin: "md",
          },
        ],
        spacing: "sm",
      },
    },
  });
};
