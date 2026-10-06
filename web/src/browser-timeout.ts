import { ConnectorError } from "../../src/errors.js";

export async function browserTimeout<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ConnectorError("BROWSER_ERROR", message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
