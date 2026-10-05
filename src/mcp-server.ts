import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { errorPayload } from "./errors.js";
import {
  getProfileSchema,
  getProfilesSchema,
  searchPeopleSchema,
  sendConnectionSchema,
  sendMessageSchema,
} from "./linkedin/types.js";
import { createConnectorClient } from "./worker/connector-client.js";
import type { ConnectorClient } from "./worker/protocol.js";

const operationIdSchema = z.object({ operationId: z.string().trim().min(8).max(128) }).strict();

function success(value: unknown) {
  const structured = { ok: true, data: value };
  return { content: [{ type: "text" as const, text: JSON.stringify(structured) }], structuredContent: structured };
}

function failure(error: unknown) {
  const structured = errorPayload(error);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: true,
  };
}

export function createMcpServer(client: ConnectorClient = createConnectorClient()) {
  const server = new McpServer({ name: "linkedin-sales-navigator", version: "0.1.0" });

  server.registerTool(
    "linkedin_worker_status",
    {
      description: "Check the long-lived browser worker process, uptime, and warm browser tabs.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      try {
        return success(await client.health());
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "linkedin_session_status",
    {
      description: "Check the LinkedIn login, Sales Navigator access, and connector action mode.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      try {
        return success(await client.sessionStatus());
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "linkedin_search_people",
    {
      description:
        "Search Sales Navigator people with scripted filters. Returns structured profile summaries and a page cursor.",
      inputSchema: searchPeopleSchema,
    },
    async (input) => {
      try {
        return success(await client.searchPeople(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "linkedin_get_profile",
    {
      description: "Read the visible structured information from one LinkedIn or Sales Navigator profile.",
      inputSchema: getProfileSchema,
    },
    async ({ profileUrl }) => {
      try {
        return success(await client.getProfile(profileUrl));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "linkedin_get_profiles",
    {
      description: "Read visible structured information from up to 25 profiles in one browser-worker call.",
      inputSchema: getProfilesSchema,
    },
    async ({ profileUrls }) => {
      try {
        return success(await client.getProfiles(profileUrls));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "linkedin_send_message",
    {
      description:
        "Preview or send a message/InMail. Use a stable unique operationId. commit=false only previews; commit=true requires execute mode.",
      inputSchema: sendMessageSchema,
    },
    async (input) => {
      try {
        return success(await client.sendMessage(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "linkedin_send_connection",
    {
      description:
        "Preview or send a connection invitation. Use a stable unique operationId. commit=false only previews; commit=true requires execute mode.",
      inputSchema: sendConnectionSchema,
    },
    async (input) => {
      try {
        return success(
          await client.sendConnection({
            operationId: input.operationId,
            profileUrl: input.profileUrl,
            commit: input.commit,
            ...(input.note ? { note: input.note } : {}),
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "linkedin_get_operation",
    {
      description: "Read the durable status and result of a message or connection operation.",
      inputSchema: operationIdSchema,
    },
    async ({ operationId }) => {
      try {
        return success(await client.getOperation(operationId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return { server, client };
}

async function main(): Promise<void> {
  const { server, client } = createMcpServer();
  const shutdown = async () => {
    await client.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  void client.health().catch((error) => console.error("Browser worker warm-up failed:", error));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
