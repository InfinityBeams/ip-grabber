/**
 * IP Grabber — Discord Interactions + Cloudflare Workers
 *
 * Environment variables:
 * DISCORD_PUBLIC_KEY
 * DISCORD_APPLICATION_ID
 * DISCORD_BOT_TOKEN
 * REGISTER_SECRET
 */

const IP_ADDRESSES = [
  "203.0.113.77",
  "198.51.100.42",
  "192.0.2.123",
  "203.0.113.184",
  "198.51.100.88"
];

const COMMAND = {
  name: "ip",
  description: "IP utility commands",
  options: [
    {
      type: 1,
      name: "grabber",
      description: "Grab an IP address for a selected user",
      options: [
        {
          type: 6,
          name: "user",
          description: "Choose a user",
          required: true
        }
      ]
    }
  ]
};

function randomItem(array) {
  return array[Math.floor(Math.random() * array.length)];
}

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
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

async function verifyDiscordRequest(request, env) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");

  if (!signature || !timestamp || !env.DISCORD_PUBLIC_KEY) {
    return false;
  }

  const body = await request.clone().text();

  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      hexToUint8Array(env.DISCORD_PUBLIC_KEY),
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
      new TextEncoder().encode(timestamp + body)
    );
  } catch (error) {
    console.error("Signature verification failed:", error);
    return false;
  }
}

async function registerCommands(env) {
  if (!env.DISCORD_APPLICATION_ID || !env.DISCORD_BOT_TOKEN) {
    throw new Error("Missing Discord application ID or bot token");
  }

  const response = await fetch(
    `https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/commands`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify([COMMAND])
    }
  );

  const result = await response.text();

  if (!response.ok) {
    throw new Error(`Discord registration failed: ${result}`);
  }

  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("IP Grabber Worker is online.", {
        status: 200
      });
    }

    // Register slash command
    if (request.method === "GET" && url.pathname === "/register") {
      const registerSecret = url.searchParams.get("secret");

      if (
        env.REGISTER_SECRET &&
        registerSecret !== env.REGISTER_SECRET
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        await registerCommands(env);

        return new Response("Slash command registered successfully.", {
          status: 200
        });
      } catch (error) {
        return new Response(error.message, {
          status: 500
        });
      }
    }

    // Discord interaction endpoint
    if (
      request.method === "POST" &&
      url.pathname === "/interactions"
    ) {
      const valid = await verifyDiscordRequest(request, env);

      if (!valid) {
        return new Response("Invalid request signature", {
          status: 401
        });
      }

      const interaction = await request.json();

      // Discord PING verification
      if (interaction.type === 1) {
        return json({ type: 1 });
      }

      // Slash command
      if (interaction.type === 2) {
        if (interaction.data?.name !== "ip") {
          return json({
            type: 4,
            data: {
              content: "Unknown command."
            }
          });
        }

        const subcommand = interaction.data.options?.find(
          option => option.type === 1 && option.name === "grabber"
        );

        if (!subcommand) {
          return json({
            type: 4,
            data: {
              content: "Please use `/ip grabber`."
            }
          });
        }

        const userOption = subcommand.options?.find(
          option => option.type === 6 && option.name === "user"
        );

        const targetUserId = userOption?.value;

        if (!targetUserId) {
          return json({
            type: 4,
            data: {
              content: "Please select a user."
            }
          });
        }

        const ip = randomItem(IP_ADDRESSES);

        return json({
          type: 4,
          data: {
            embeds: [
              {
                title: "🔍 IP Grabber",
                description:
                  `**Target:** <@${targetUserId}>\n` +
                  `**IP Address:** \`${ip}\`\n\n` +
                  "✅ IP successfully grabbed!",
                color: 5793266
              }
            ],
            allowed_mentions: {
              users: []
            }
          }
        });
      }

      return new Response("Unsupported interaction", {
        status: 400
      });
    }

    return new Response("Not found", {
      status: 404
    });
  }
};