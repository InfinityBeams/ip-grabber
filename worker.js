/**
 * Discord Interactions + Cloudflare Workers
 *
 * Environment variables:
 * DISCORD_PUBLIC_KEY
 * DISCORD_APPLICATION_ID
 * DISCORD_BOT_TOKEN
 * REGISTER_SECRET
 */

/* =========================
   SLASH COMMAND
========================= */

const COMMANDS = [
  {
    name: "buttonraid",
    description: "Create a button that sends a message",
    options: [
      {
        type: 3,
        name: "message",
        description: "Message to send when the button is clicked",
        required: true,
        max_length: 60
      }
    ]
  }
];

/* =========================
   HELPERS
========================= */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function hexToUint8Array(hex) {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("Invalid hex string");
  }

  const bytes = new Uint8Array(hex.length / 2);

  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(
      hex.slice(i * 2, i * 2 + 2),
      16
    );
  }

  return bytes;
}

/* =========================
   DISCORD SIGNATURE VERIFY
========================= */

async function verifyDiscordRequest(request, env) {
  const signature =
    request.headers.get("X-Signature-Ed25519");

  const timestamp =
    request.headers.get("X-Signature-Timestamp");

  if (
    !signature ||
    !timestamp ||
    !env.DISCORD_PUBLIC_KEY
  ) {
    return false;
  }

  const body =
    await request.clone().text();

  try {
    const publicKey =
      await crypto.subtle.importKey(
        "raw",
        hexToUint8Array(
          env.DISCORD_PUBLIC_KEY
        ),
        {
          name: "Ed25519",
          namedCurve: "Ed25519"
        },
        false,
        ["verify"]
      );

    return await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      hexToUint8Array(signature),
      new TextEncoder().encode(
        timestamp + body
      )
    );
  } catch (error) {
    console.error(
      "Signature verification failed:",
      error
    );

    return false;
  }
}

/* =========================
   REGISTER COMMAND
========================= */

async function registerCommands(env) {
  if (
    !env.DISCORD_APPLICATION_ID ||
    !env.DISCORD_BOT_TOKEN
  ) {
    throw new Error(
      "Missing Discord application ID or bot token"
    );
  }

  const response = await fetch(
    `https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/commands`,
    {
      method: "PUT",

      headers: {
        "Authorization":
          `Bot ${env.DISCORD_BOT_TOKEN}`,

        "Content-Type":
          "application/json"
      },

      body: JSON.stringify(COMMANDS)
    }
  );

  const result =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Discord registration failed: ${result}`
    );
  }

  return result;
}

/* =========================
   MESSAGE ENCODING
========================= */

function encodeMessage(message) {
  return btoa(
    unescape(
      encodeURIComponent(message)
    )
  );
}

function decodeMessage(encoded) {
  return decodeURIComponent(
    escape(
      atob(encoded)
    )
  );
}

/* =========================
   WORKER
========================= */

export default {
  async fetch(request, env, ctx) {
    const url =
      new URL(request.url);

    /* =========================
       HEALTH CHECK
    ========================= */

    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      return new Response(
        "Discord Worker is online.",
        {
          status: 200
        }
      );
    }

    /* =========================
       REGISTER COMMAND
    ========================= */

    if (
      request.method === "GET" &&
      url.pathname === "/register"
    ) {
      const registerSecret =
        url.searchParams.get("secret");

      if (
        env.REGISTER_SECRET &&
        registerSecret !==
          env.REGISTER_SECRET
      ) {
        return new Response(
          "Unauthorized",
          {
            status: 401
          }
        );
      }

      try {
        await registerCommands(env);

        return new Response(
          "Slash command registered successfully.",
          {
            status: 200
          }
        );
      } catch (error) {
        return new Response(
          error.message,
          {
            status: 500
          }
        );
      }
    }

    /* =========================
       DISCORD INTERACTIONS
    ========================= */

    if (
      request.method === "POST" &&
      url.pathname === "/interactions"
    ) {
      const valid =
        await verifyDiscordRequest(
          request,
          env
        );

      if (!valid) {
        return new Response(
          "Invalid request signature",
          {
            status: 401
          }
        );
      }

      const interaction =
        await request.json();

      /* =========================
         DISCORD PING
      ========================= */

      if (interaction.type === 1) {
        return json({
          type: 1
        });
      }

      /* =========================
         /buttonraid
      ========================= */

      if (
        interaction.type === 2 &&
        interaction.data?.name ===
          "buttonraid"
      ) {
        const messageOption =
          interaction.data.options?.find(
            option =>
              option.type === 3 &&
              option.name === "message"
          );

        const message =
          messageOption?.value;

        if (!message) {
          return json({
            type: 4,

            data: {
              content:
                "Please provide a message.",
              flags: 64
            }
          });
        }

        const encoded =
          encodeMessage(message);

        /*
         * flags: 64 =
         * only the command user can see
         * the button panel.
         */

        return json({
          type: 4,

          data: {
            flags: 64,

            embeds: [
              {
                title:
                  "📨 Message Button",

                description:
                  "Click the button below to send the message.",

                color: 5793266
              }
            ],

            components: [
              {
                type: 1,

                components: [
                  {
                    type: 2,

                    style: 1,

                    label:
                      "Send Message",

                    emoji: {
                      name: "📨"
                    },

                    custom_id:
                      `buttonraid:${encoded}`
                  }
                ]
              }
            ]
          }
        });
      }

      /* =========================
         UNKNOWN SLASH COMMAND
      ========================= */

      if (interaction.type === 2) {
        return json({
          type: 4,

          data: {
            content:
              "Unknown command."
          }
        });
      }

      /* =========================
         BUTTON CLICK
      ========================= */

      if (interaction.type === 3) {
        const customId =
          interaction.data?.custom_id;

        if (
          customId &&
          customId.startsWith(
            "buttonraid:"
          )
        ) {
          const encoded =
            customId.substring(
              "buttonraid:".length
            );

          try {
            const message =
              decodeMessage(encoded);

            /*
             * Randomize how many times to send: 3, 4, or 5.
             */
            const times =
              Math.floor(Math.random() * 3) + 3;

            const applicationId =
              interaction.application_id;

            const interactionToken =
              interaction.token;

            /*
             * Send the remaining messages (times - 1)
             * as follow-up webhook messages after
             * replying with the first one.
             */
            ctx.waitUntil(
              (async () => {
                for (
                  let i = 1;
                  i < times;
                  i++
                ) {
                  try {
                    await fetch(
                      `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`,
                      {
                        method: "POST",

                        headers: {
                          "Content-Type":
                            "application/json"
                        },

                        body: JSON.stringify({
                          content: message
                        })
                      }
                    );
                  } catch (err) {
                    console.error(
                      "Follow-up message failed:",
                      err
                    );
                  }
                }
              })()
            );

            /*
             * First message goes as the immediate
             * interaction response.
             */

            return json({
              type: 4,

              data: {
                content: message
              }
            });
          } catch (error) {
            return json({
              type: 4,

              data: {
                content:
                  "Unable to read the button message."
              }
            });
          }
        }

        return json({
          type: 4,

          data: {
            content:
              "Unknown button."
          }
        });
      }

      return new Response(
        "Unsupported interaction",
        {
          status: 400
        }
      );
    }

    /* =========================
       NOT FOUND
    ========================= */

    return new Response(
      "Not found",
      {
        status: 404
      }
    );
  }
};