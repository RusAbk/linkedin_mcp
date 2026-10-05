import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ConnectorError, errorPayload } from "./errors.js";
import { SALES_PEOPLE_SEARCH_URL } from "./linkedin/selectors.js";
import { isLinkedInUrl, searchPeopleSchema } from "./linkedin/types.js";
import { createConnectorClient } from "./worker/connector-client.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "doctor";
  const client = createConnectorClient();
  try {
    if (command === "login") {
      await client.openLogin();
      const terminal = createInterface({ input, output });
      await terminal.question("Sign in and complete any LinkedIn checks in the opened browser, then press Enter here... ");
      terminal.close();
      console.log(JSON.stringify(await client.sessionStatus(), null, 2));
      return;
    }
    if (command === "inspect") {
      const inspectUrl = process.argv[3] ?? SALES_PEOPLE_SEARCH_URL;
      if (!isLinkedInUrl(inspectUrl)) {
        throw new ConnectorError("INVALID_INPUT", "inspect URL must be an HTTPS linkedin.com URL.");
      }
      console.log(JSON.stringify(await client.inspectPage(inspectUrl), null, 2));
      return;
    }
    if (command === "doctor") {
      console.log(JSON.stringify(await client.sessionStatus(), null, 2));
      return;
    }
    if (command === "search") {
      const raw = process.argv[3];
      const request = searchPeopleSchema.parse(raw ? JSON.parse(raw) : { filters: {}, limit: 5 });
      console.log(JSON.stringify(await client.searchPeople(request), null, 2));
      return;
    }
    if (command === "worker-status") {
      console.log(JSON.stringify(await client.health(), null, 2));
      return;
    }
    if (command === "worker-stop") {
      await client.stop();
      console.log(JSON.stringify({ stopped: true }, null, 2));
      return;
    }
    throw new Error(
      `Unknown command '${command}'. Use login, doctor, inspect, search, worker-status, or worker-stop.`,
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify(errorPayload(error), null, 2));
  process.exit(1);
});
