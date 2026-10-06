import type { CDPSession, Page } from "playwright";
import { browserTimeout } from "./browser-timeout.js";

/** Keeps only the newest Chrome frame. Reading acknowledges frames and allows
 * Chrome to render more; a hidden/disconnected viewer creates no frame backlog. */
export class LoginScreen {
  private session: CDPSession | null = null;
  private image: string | undefined;
  private version = 0;
  private readonly acknowledgements = new Set<number>();
  constructor(readonly page: Page) {}

  async start(): Promise<void> {
    await browserTimeout(this.page.bringToFront(), 5_000, "Chrome не отвечает при открытии окна. Проверьте ресурсы сервера и повторите запуск.");
    const connecting = this.page.context().newCDPSession(this.page);
    let session: CDPSession;
    try { session = await browserTimeout(connecting, 5_000, "Не удалось подключиться к Chrome за 5 секунд."); }
    catch (error) { void connecting.then(late => late.detach()).catch(() => {}); throw error; }
    this.session = session;
    session.on("Page.screencastFrame", (event: { data: string; sessionId: number }) => {
      if (this.session !== session) return;
      this.image = event.data;
      this.version++;
      this.acknowledgements.add(event.sessionId);
    });
    await browserTimeout(session.send("Page.enable"), 5_000, "Chrome не отвечает при подключении к окну.");
    await browserTimeout(session.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1120, maxHeight: 778, everyNthFrame: 1 }), 5_000, "Chrome не запустил передачу изображения. Попробуйте закрыть браузер и открыть вход снова.");
    // The first frame arrives asynchronously. Never block opening on a capture.
  }

  read(): { image?: string; version: number } {
    const session = this.session;
    for (const sessionId of this.acknowledgements) {
      void session?.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    }
    this.acknowledgements.clear();
    return { ...(this.image ? { image: this.image } : {}), version: this.version };
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.image = undefined;
    this.acknowledgements.clear();
    if (session) {
      await browserTimeout(session.send("Page.stopScreencast"), 1_000, "Остановка передачи изображения заняла слишком долго.").catch(() => {});
      await browserTimeout(session.detach(), 1_000, "Отключение от окна заняло слишком долго.").catch(() => {});
    }
  }
}
