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

export const postText = async (
  botId: string,
  channelId: string,
  token: string,
  text: string
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
        content: {
          type: "text",
          text,
        },
      }),
    }
  );
  return res.status === 201;
};
